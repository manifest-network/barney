/**
 * Deploy/update argument parsing + manifest building.
 *
 * Extracted verbatim from compositeTransactions.ts (ENG-576 refactor split).
 * Pure code motion — the deploy/update executors import these helpers.
 */

import { buildManifest, getServiceNames, validateServiceName, resolveGeneratedPassword, type ServiceConfig, type HealthCheckConfig } from '../manifest';
import { findKnownImage, KNOWN_STACKS } from '../knownImages';
import { sha256, toHex } from '../../utils/hash';
import { MANIFEST_NOTICE_KEY } from '../../config/constants';
import { logError } from '../../utils/errors';
import { BACKEND_SERVICE_NAMES } from './helpers';
import type { PayloadAttachment } from './types';

/** Env var names that could compromise the container runtime or host. */
const BLOCKED_ENV_NAMES = new Set([
  // Linker injection
  'PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT',
  'LD_PROFILE', 'LD_DEBUG', 'LD_DYNAMIC_WEAK',
  'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH',
  // Shell initialization / auto-exec
  'BASH_ENV', 'ENV', 'PROMPT_COMMAND', 'SHELLOPTS', 'BASHOPTS', 'CDPATH',
  // Language runtime injection
  'PYTHONPATH', 'PYTHONSTARTUP', 'NODE_OPTIONS', 'NODE_PATH',
  'PERL5LIB', 'PERL5OPT', 'RUBYLIB', 'CLASSPATH',
  'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS',
  // Git command injection
  'GIT_SSH_COMMAND', 'GIT_PROXY_COMMAND', 'GIT_SSH',
  // glibc / DNS hijacking
  'GCONV_PATH', 'HOSTALIASES',
  // Shell / process environment
  'HOME', 'SHELL', 'IFS',
  // Temp directory redirection
  'TMPDIR', 'TMP', 'TEMP',
  // TLS trust redirection
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE',
  // Proxy / infrastructure
  'http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY',
  'no_proxy', 'NO_PROXY',
  'DOCKER_HOST', 'DOCKER_CONFIG', 'KUBECONFIG',
  'BUILDKIT_HOST', 'COMPOSE_FILE',
]);

/**
 * Validate env var names against the blocklist.
 * Returns an error string if any blocked names are found, null otherwise.
 */
function validateEnvNames(env: Record<string, string>): string | null {
  const blocked = Object.keys(env).filter((k) => BLOCKED_ENV_NAMES.has(k));
  if (blocked.length > 0) {
    return `Blocked env variable(s): ${blocked.join(', ')}. These variables could compromise the runtime environment.`;
  }
  return null;
}

/**
 * Shape-aware env-name blocklist check for a parsed manifest object.
 * Handles both the single-service shape (top-level `env`) and the stack shape
 * (`{ services: { name: { env } } }`), the latter prefixing any error with the
 * offending service name. Returns null when nothing is blocked (or the input
 * isn't a manifest object). Applied to file-uploaded manifests, whose env is
 * otherwise never run through the image-arg / stack-string blocklist paths.
 */
export function validateManifestEnvNames(manifest: unknown): string | null {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) return null;
  const serviceNames = getServiceNames(manifest); // non-empty only for { services: {...} }
  if (serviceNames.length > 0) {
    const services = (manifest as { services: Record<string, unknown> }).services;
    for (const svcName of serviceNames) {
      const svc = services[svcName];
      if (svc && typeof svc === 'object' && !Array.isArray(svc)) {
        const env = (svc as Record<string, unknown>).env;
        if (env && typeof env === 'object' && !Array.isArray(env)) {
          const err = validateEnvNames(env as Record<string, string>);
          if (err) return `Service "${svcName}": ${err}`;
        }
      }
    }
    return null;
  }
  const env = (manifest as Record<string, unknown>).env;
  if (env && typeof env === 'object' && !Array.isArray(env)) {
    return validateEnvNames(env as Record<string, string>);
  }
  return null;
}

/**
 * Extract service names from a JSON stack-manifest payload.
 * Deploy payloads are JSON — the plan-phase `JSON.parse` guard rejects non-JSON
 * uploads before this runs, and batch payloads are internally-generated JSON.
 * Non-JSON or single-service manifests yield an empty list.
 */
export function extractServiceNamesFromPayload(bytes: Uint8Array): string[] {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return []; // Not valid UTF-8 — cannot extract names
  }

  let raw: string[] = [];

  // Parse JSON and pull the stack's service names (non-JSON → no names)
  try {
    const parsed: unknown = JSON.parse(text);
    const names = getServiceNames(parsed);
    if (names.length > 0) raw = names;
  } catch {
    // Not JSON — no service names to extract
  }

  // Validate and deduplicate
  const seen = new Set<string>();
  const valid: string[] = [];
  const dropped: string[] = [];
  for (const name of raw) {
    if (validateServiceName(name) !== null) {
      dropped.push(name);
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    valid.push(name);
  }

  if (dropped.length > 0) {
    logError('extractServiceNamesFromPayload', new Error(
      `Dropped ${dropped.length} invalid service name(s): ${dropped.join(', ')}`
    ));
  }

  return valid;
}

/** Coerce a string-or-number tool arg to string; reject objects/arrays/booleans. */
function coerceStringArg(value: unknown, fieldName: string, context?: string): { value?: string; error?: string } {
  if (value == null) return {};
  if (typeof value === 'string') return { value };
  if (typeof value === 'number' && isFinite(value)) return { value: String(value) };
  const prefix = context ? `${context}: ` : '';
  return { error: `${prefix}${fieldName} must be a string, got ${typeof value}.` };
}

/** Coerce a tmpfs arg (string or string[]) to a comma-separated string. */
function coerceTmpfsArg(value: unknown, context?: string): { value?: string; error?: string } {
  if (value == null) return {};
  if (typeof value === 'string') return { value };
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (typeof value[i] !== 'string') {
        const prefix = context ? `${context}: ` : '';
        return { error: `${prefix}tmpfs array element ${i} must be a string, got ${typeof value[i]}.` };
      }
    }
    return { value: (value as string[]).join(',') };
  }
  const prefix = context ? `${context}: ` : '';
  return { error: `${prefix}tmpfs must be a string or array of strings, got ${typeof value}.` };
}

/**
 * Build a PayloadAttachment from a manifest JSON string.
 * Shared by deploy_app, update_app, and batch merge in toolExecution.
 */
export async function buildPayloadFromManifest(manifestJson: string): Promise<PayloadAttachment> {
  // Strip UI-only sideband fields before encoding for upload
  let cleanJson = manifestJson;
  try {
    const parsed = JSON.parse(manifestJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && MANIFEST_NOTICE_KEY in parsed) {
      delete parsed[MANIFEST_NOTICE_KEY];
      cleanJson = JSON.stringify(parsed, null, 2);
    }
  } catch (err) {
    // Input should always be JSON; re-throw unexpected errors, ignore parse failures gracefully.
    if (!(err instanceof SyntaxError)) throw err;
  }
  const bytes = new TextEncoder().encode(cleanJson);
  const hash = toHex(await sha256(cleanJson));
  return { bytes, filename: 'manifest.json', size: bytes.length, hash };
}

/**
 * Validate internal stack service names persisted in pending action args.
 * These values are runtime-unknown and must be revalidated before use.
 */
export function validateInternalServiceNames(
  serviceNames: unknown,
  toolName: 'deploy_app' | 'update_app'
): { serviceNames?: string[]; error?: string } {
  if (serviceNames === undefined) {
    return {};
  }

  if (!Array.isArray(serviceNames)) {
    return { error: `Invalid stack service metadata. Please run ${toolName} again with a valid services definition.` };
  }

  const validated: string[] = [];
  for (const serviceName of serviceNames) {
    if (typeof serviceName !== 'string' || !serviceName) {
      return { error: `Invalid stack service metadata. Please run ${toolName} again with a valid services definition.` };
    }
    const nameError = validateServiceName(serviceName);
    if (nameError !== null) {
      return { error: `Invalid stack service metadata. Please run ${toolName} again with a valid services definition.` };
    }
    validated.push(serviceName);
  }

  return { serviceNames: validated };
}

interface ParseStackServicesResult {
  services: Record<string, ServiceConfig>;
  serviceNames: string[];
}

/**
 * Parse and validate a stack services JSON string into typed ServiceConfig map.
 * Shared between executeDeployApp and executeUpdateApp to eliminate duplication.
 *
 * @param applyEnvDefaults - If true, apply known image env defaults (deploy path).
 *   For updates, env defaults are skipped since the old manifest merge handles carry-forward.
 */
export function parseAndValidateStackServices(
  servicesJson: string,
  applyEnvDefaults: boolean,
  logContext: string
): ParseStackServicesResult | { error: string } {
  let parsedServices: Record<string, Record<string, unknown>>;
  try {
    parsedServices = JSON.parse(servicesJson);
    if (typeof parsedServices !== 'object' || parsedServices === null || Array.isArray(parsedServices)) {
      return { error: 'services must be a JSON object mapping service names to configs.' };
    }
  } catch (error) {
    logError(logContext, error);
    return { error: 'Invalid services JSON. Expected format: \'{"web":{"image":"nginx","port":"80"},"db":{"image":"postgres","port":"5432"}}\'.' };
  }

  const serviceNames = Object.keys(parsedServices);
  if (serviceNames.length === 0) {
    return { error: 'services must contain at least one service.' };
  }

  const stackServices: Record<string, ServiceConfig> = {};

  for (const [svcName, svcRaw] of Object.entries(parsedServices)) {
    const nameError = validateServiceName(svcName);
    if (nameError) return { error: `Invalid service name "${svcName}": ${nameError}` };

    if (typeof svcRaw !== 'object' || svcRaw === null || Array.isArray(svcRaw)) {
      return { error: `Service "${svcName}" config must be an object.` };
    }

    const cfg = svcRaw as Record<string, unknown>;
    if (typeof cfg.image !== 'string' || !cfg.image) {
      return { error: `Service "${svcName}" requires an "image" field.` };
    }

    let env: Record<string, string> | undefined;
    if (cfg.env && typeof cfg.env === 'object' && !Array.isArray(cfg.env)) {
      env = cfg.env as Record<string, string>;
      for (const [k, v] of Object.entries(env)) {
        if (typeof v !== 'string') {
          return { error: `Service "${svcName}": env var "${k}" must have a string value, got ${typeof v}.` };
        }
      }
      const envError = validateEnvNames(env);
      if (envError) return { error: `Service "${svcName}": ${envError}` };
    }

    let command: string[] | undefined;
    if (cfg.command) {
      if (!Array.isArray(cfg.command) || !(cfg.command as unknown[]).every((s) => typeof s === 'string')) {
        return { error: `Service "${svcName}": command must be an array of strings.` };
      }
      command = cfg.command as string[];
    }

    let svcArgs: string[] | undefined;
    if (cfg.args) {
      if (!Array.isArray(cfg.args) || !(cfg.args as unknown[]).every((s) => typeof s === 'string')) {
        return { error: `Service "${svcName}": args must be an array of strings.` };
      }
      svcArgs = cfg.args as string[];
    }

    // Extract new compose fields from raw config
    let healthCheck: HealthCheckConfig | undefined;
    if (cfg.health_check && typeof cfg.health_check === 'object' && !Array.isArray(cfg.health_check)) {
      const hc = cfg.health_check as Record<string, unknown>;
      if (!Array.isArray(hc.test) || hc.test.length < 2 || !hc.test.every(el => typeof el === 'string')) {
        return { error: `Service "${svcName}": health_check.test must be an array of strings with at least 2 elements (e.g. ["CMD-SHELL", "pg_isready"]).` };
      }
      healthCheck = cfg.health_check as HealthCheckConfig;
    }
    const stopGracePeriod = typeof cfg.stop_grace_period === 'string' ? cfg.stop_grace_period : undefined;
    const init = typeof cfg.init === 'boolean' ? cfg.init : undefined;
    const expose = typeof cfg.expose === 'string' ? cfg.expose : undefined;
    let labels: Record<string, string> | undefined;
    if (cfg.labels && typeof cfg.labels === 'object' && !Array.isArray(cfg.labels)) {
      for (const [k, v] of Object.entries(cfg.labels as Record<string, unknown>)) {
        if (typeof v !== 'string') {
          return { error: `Service "${svcName}": label "${k}" must have a string value, got ${typeof v}.` };
        }
      }
      labels = cfg.labels as Record<string, string>;
    }
    let dependsOn: Record<string, { condition: string }> | undefined;
    if (cfg.depends_on && typeof cfg.depends_on === 'object' && !Array.isArray(cfg.depends_on)) {
      dependsOn = cfg.depends_on as Record<string, { condition: string }>;
    }

    // Known image safety net per service
    const knownConfig = findKnownImage(cfg.image as string);
    if (knownConfig) {
      if (!cfg.port && knownConfig.port && !BACKEND_SERVICE_NAMES.has(svcName)) cfg.port = knownConfig.port;
      if (applyEnvDefaults) {
        if (!env && knownConfig.env) env = { ...knownConfig.env };
        else if (knownConfig.env) env = { ...knownConfig.env, ...env };
      }
      if (!cfg.user && knownConfig.user) cfg.user = knownConfig.user;
      if (!cfg.tmpfs && knownConfig.tmpfs) cfg.tmpfs = knownConfig.tmpfs;
      if (!command && knownConfig.command) command = [...knownConfig.command];
      if (!svcArgs && knownConfig.args) svcArgs = [...knownConfig.args];
      if (!healthCheck && knownConfig.health_check) healthCheck = { ...knownConfig.health_check };
    }

    // Coerce port/user/tmpfs — LLMs frequently produce numbers instead of strings
    const svcCtx = `Service "${svcName}"`;
    const portResult = coerceStringArg(cfg.port, 'port', svcCtx);
    if (portResult.error) return { error: portResult.error };
    const userResult = coerceStringArg(cfg.user, 'user', svcCtx);
    if (userResult.error) return { error: userResult.error };
    const tmpfsResult = coerceTmpfsArg(cfg.tmpfs, svcCtx);
    if (tmpfsResult.error) return { error: tmpfsResult.error };

    stackServices[svcName] = {
      image: cfg.image as string,
      port: portResult.value,
      env,
      user: userResult.value,
      tmpfs: tmpfsResult.value,
      command,
      args: svcArgs,
      health_check: healthCheck,
      stop_grace_period: stopGracePeriod,
      init,
      expose,
      labels,
      depends_on: dependsOn,
    };
  }

  // Apply known stack depends_on defaults
  for (const ks of KNOWN_STACKS) {
    const ksNames = Object.keys(ks.services);
    if (ksNames.length === serviceNames.length && ksNames.every(n => serviceNames.includes(n))) {
      for (const [sName, sCfg] of Object.entries(ks.services)) {
        if (sCfg.depends_on && stackServices[sName] && !stackServices[sName].depends_on) {
          stackServices[sName].depends_on = sCfg.depends_on;
        }
      }
      break;
    }
  }

  return { services: stackServices, serviceNames };
}

/**
 * Derive an app name from a filename.
 * Strip extension, lowercase, replace invalid chars with hyphens, truncate to 32.
 */
export function deriveAppName(filename: string): string {
  return filename
    .replace(/\.[^.]+$/, '') // strip extension
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-') // replace invalid chars
    .replace(/-+/g, '-') // collapse consecutive hyphens
    .replace(/^-|-$/g, '') // trim leading/trailing hyphens
    .slice(0, 32)
    || 'app';
}

/**
 * Options controlling how {@link buildImageManifestFromArgs} differs between the
 * deploy and update image paths. Encoding the differences as explicit flags
 * (rather than two hand-maintained copies) keeps the shell-injection-safe token
 * append and the validateEnvNames blocklist in exactly one place (ENG-575).
 */
interface ImageManifestBuildOptions {
  /** deploy=true / update=false — on update the old-manifest merge carries env forward. */
  applyEnvDefaults: boolean;
  /**
   * deploy=true / update=false — same rationale as env: on update the old
   * manifest's health_check carries forward via mergeManifest, so the generic
   * KNOWN_IMAGES default must not clobber it here.
   */
  applyHealthCheckDefault: boolean;
  /** deploy=true / update=false — update targets an existing app, so no derive. */
  deriveAppName: boolean;
  /** logError label prefix, e.g. 'executeDeployApp'. */
  errorContext: string;
}

/**
 * Build a single-service manifest from image-based tool args — the shared spine
 * of the deploy and update image paths. Parses/validates env, command, args,
 * health_check, and labels JSON; merges KNOWN_IMAGES defaults; resolves
 * generated passwords; applies the shell-injection-safe OPENCLAW_GATEWAY_TOKEN
 * append; coerces port/user/tmpfs; and builds the manifest.
 *
 * Mutates `args` in place exactly as the inline blocks did: fills
 * port/user/tmpfs from known defaults, stores `_generatedManifest`, and (when
 * `deriveAppName`) fills `app_name`. Returns the built payload or an error
 * string for the caller to surface as a ToolResult.
 */
export async function buildImageManifestFromArgs(
  args: Record<string, unknown>,
  opts: ImageManifestBuildOptions,
): Promise<{ error: string } | { payload: PayloadAttachment }> {
  // Callers gate on truthy args.image, but the model can emit a non-string
  // (number/object). findKnownImage/buildManifest call string methods on it, so
  // reject upfront with a clear message rather than surfacing a raw TypeError.
  if (typeof args.image !== 'string' || !args.image) {
    return { error: 'image must be a non-empty string (e.g. "redis:8.4").' };
  }

  let env: Record<string, string> | undefined;
  if (typeof args.env === 'string' && args.env) {
    try {
      env = JSON.parse(args.env);
      if (typeof env !== 'object' || env === null || Array.isArray(env)) {
        return { error: 'env must be a JSON object (e.g. \'{"KEY":"value"}\').' };
      }
    } catch (error) {
      logError(`deployArgs.${opts.errorContext}.parseEnv`, error);
      return { error: 'Invalid env JSON string. Expected format: \'{"KEY":"value"}\'.' };
    }
  }

  if (env) {
    for (const [k, v] of Object.entries(env)) {
      if (typeof v !== 'string') {
        return { error: `Env var "${k}" must have a string value, got ${typeof v}.` };
      }
    }
    const envError = validateEnvNames(env);
    if (envError) return { error: envError };
  }

  // Parse command/args JSON arrays
  let command: string[] | undefined;
  if (typeof args.command === 'string' && args.command) {
    try {
      command = JSON.parse(args.command);
      if (!Array.isArray(command) || !command.every((s) => typeof s === 'string')) {
        return { error: 'command must be a JSON array of strings (e.g. \'["sh", "-c"]\').' };
      }
    } catch {
      return { error: 'Invalid command JSON. Expected a JSON array of strings (e.g. \'["sh", "-c"]\').' };
    }
  }

  let cmdArgs: string[] | undefined;
  if (typeof args.args === 'string' && args.args) {
    try {
      cmdArgs = JSON.parse(args.args);
      if (!Array.isArray(cmdArgs) || !cmdArgs.every((s) => typeof s === 'string')) {
        return { error: 'args must be a JSON array of strings (e.g. \'["echo hello"]\').' };
      }
    } catch {
      return { error: 'Invalid args JSON. Expected a JSON array of strings (e.g. \'["echo hello"]\').' };
    }
  }

  // Parse health_check from JSON string
  let healthCheck: HealthCheckConfig | undefined;
  if (typeof args.health_check === 'string' && args.health_check) {
    try {
      healthCheck = JSON.parse(args.health_check);
      if (typeof healthCheck !== 'object' || healthCheck === null || Array.isArray(healthCheck)) {
        return { error: 'health_check must be a JSON object.' };
      }
      if (!Array.isArray(healthCheck.test) || healthCheck.test.length < 2 || !healthCheck.test.every(el => typeof el === 'string')) {
        return { error: 'health_check.test must be an array of strings with at least 2 elements (e.g. ["CMD-SHELL", "curl -f http://localhost"]).' };
      }
    } catch {
      return { error: 'Invalid health_check JSON.' };
    }
  }

  // Parse labels from JSON string
  let labels: Record<string, string> | undefined;
  if (typeof args.labels === 'string' && args.labels) {
    try {
      labels = JSON.parse(args.labels);
      if (typeof labels !== 'object' || labels === null || Array.isArray(labels)) {
        return { error: 'labels must be a JSON object.' };
      }
      for (const [k, v] of Object.entries(labels)) {
        if (typeof v !== 'string') {
          return { error: `Label "${k}" must have a string value, got ${typeof v}.` };
        }
      }
    } catch {
      return { error: 'Invalid labels JSON.' };
    }
  }

  // Known image safety net: merge defaults for port, user, tmpfs, command, args
  // (and, gated by opts, env + health_check — see ImageManifestBuildOptions).
  const knownConfig = findKnownImage(args.image as string);
  if (knownConfig) {
    if (!args.port && knownConfig.port) args.port = knownConfig.port;
    if (opts.applyEnvDefaults && knownConfig.env) {
      env = env ? { ...knownConfig.env, ...env } : { ...knownConfig.env };
    }
    if (!args.user && knownConfig.user) args.user = knownConfig.user;
    if (!args.tmpfs && knownConfig.tmpfs) args.tmpfs = knownConfig.tmpfs;
    if (!command && knownConfig.command) command = [...knownConfig.command];
    if (!cmdArgs && knownConfig.args) cmdArgs = [...knownConfig.args];
    if (opts.applyHealthCheckDefault && !healthCheck && knownConfig.health_check) {
      healthCheck = { ...knownConfig.health_check };
    }
  }

  // Pre-generate env passwords so the same value can be shared with args
  if (env) {
    for (const key of Object.keys(env)) {
      env[key] = resolveGeneratedPassword(env[key]);
    }
  }

  // Append --token to the shell command string for openclaw.
  // Use shell variable expansion instead of interpolating the raw value to prevent
  // shell injection if the token contains metacharacters.
  if (env?.OPENCLAW_GATEWAY_TOKEN && cmdArgs?.length === 1 && command?.[0] === '/bin/sh') {
    cmdArgs[0] += ' --token "$OPENCLAW_GATEWAY_TOKEN"';
  }

  // Coerce port/user/tmpfs — LLMs frequently produce numbers instead of strings
  const portResult = coerceStringArg(args.port, 'port');
  if (portResult.error) return { error: portResult.error };
  const userResult = coerceStringArg(args.user, 'user');
  if (userResult.error) return { error: userResult.error };
  const tmpfsResult = coerceTmpfsArg(args.tmpfs);
  if (tmpfsResult.error) return { error: tmpfsResult.error };

  let manifestResult;
  try {
    manifestResult = await buildManifest({
      image: args.image as string,
      port: portResult.value,
      env,
      user: userResult.value,
      tmpfs: tmpfsResult.value,
      command,
      args: cmdArgs,
      health_check: healthCheck,
      stop_grace_period: args.stop_grace_period as string | undefined,
      init: typeof args.init === 'boolean' ? args.init : undefined,
      expose: args.expose as string | undefined,
      labels,
    });
  } catch (error) {
    logError(`deployArgs.${opts.errorContext}.buildManifest`, error);
    return { error: error instanceof Error ? error.message : 'Failed to build manifest' };
  }

  if (opts.deriveAppName && !args.app_name) {
    args.app_name = manifestResult.derivedAppName;
  }
  // Store generated manifest JSON for the confirmation round-trip
  args._generatedManifest = manifestResult.json;
  return { payload: manifestResult.payload };
}

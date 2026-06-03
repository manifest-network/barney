/**
 * Composite transaction tool executors.
 * These return requiresConfirmation first, then execute after user approval.
 */

import type { CosmosClientManager } from '@manifest-network/manifest-mcp-core';
import { cosmosTx, fundCredits, setItemCustomDomain as monoSetItemCustomDomain } from '@manifest-network/manifest-mcp-core';
import { getCreditAccount, getLease, LeaseState } from '../../api/billing';
import { getProviders } from '../../api/sku';
import { resolveSizeOrCheapest } from '../../api/skuTiers';
import { getLeaseConnectionInfo, ProviderApiError, type ConnectionDetails } from '../../api/provider-api';
import { waitForLeaseReady, getLeaseLogs, getLeaseProvision, type FredLeaseStatus, type TerminalChainState } from '../../api/fred';
import { restartApp, updateApp } from '@manifest-network/manifest-mcp-fred';
import { providerFetch } from '../../api/providerFetchAdapter';
import { makeFredAuthTokens, getFredQueryClient } from './fredAuth';
import { DENOMS } from '../../api/config';
import { fromBaseUnits, parseJsonStringArray } from '../../utils/format';
import { logError, normalizeErrorPunctuation } from '../../utils/errors';
import { withTimeout } from '../../api/utils';
import { AI_DEPLOY_PROVISION_TIMEOUT_MS, FRED_POLL_INTERVAL_MS } from '../../config/constants';
import { extractLeaseUuidFromTxResult, uploadPayloadToProvider, getProviderAuthToken } from './utils';
import { BACKEND_SERVICE_NAMES, extractPrimaryServicePorts, formatConnectionUrl, TCP_ONLY_PORTS, parseContainerPort } from './helpers';
import { isValidFqdn, normalizeFqdn, resolveExpectedCnameTarget } from '../../utils/connection';
import { getLeaseItemsForLease } from '../../api/leaseItems';
import { queryLeaseByCustomDomain } from '../../api/leaseByCustomDomain';
import { getDomainForService } from '../../api/leaseDomains';
import { validateAll, apexRecordKindLabel } from '../../utils/customDomainValidation';
import { validateAppName, sanitizeManifestForStorage, type AppEntry } from '../../registry/appRegistry';
import { extractYamlServiceNames } from '../../utils/fileValidation';
import { buildManifest, buildStackManifest, mergeManifest, validateServiceName, getServiceNames, type ServiceConfig, type HealthCheckConfig } from '../manifest';
import { MANIFEST_NOTICE_KEY } from '../../config/constants';
import { findKnownImage, KNOWN_STACKS } from '../knownImages';
import { sha256, toHex, generatePassword } from '../../utils/hash';
import type { ToolResult, ToolExecutorOptions, PayloadAttachment } from './types';
import { createSigningMutex, runBatchWithConcurrency, summarizeBatchResult } from './batchRunner';

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
 * Parse a multi-app app_name value into resolved AppEntry[].
 * Supports "all" (all matching apps), comma-separated names, or a single name.
 * `filter` selects which apps are eligible (e.g. running-only for restart).
 */
type ResolveResult =
  | { mode: 'single'; name: string }
  | { mode: 'multi'; apps: AppEntry[]; skipped?: string[] }
  | { mode: 'error'; error: string };

function resolveMultiAppNames(
  name: string,
  address: string,
  appRegistry: ToolExecutorOptions['appRegistry'] & object,
  filter: (a: AppEntry) => boolean,
  verb: string
): ResolveResult {
  const trimmed = name.trim();
  const allApps = appRegistry.getApps(address);
  const eligible = allApps.filter(filter);

  if (trimmed.toLowerCase() === 'all') {
    if (eligible.length === 0) return { mode: 'error', error: `No eligible apps to ${verb}.` };
    return { mode: 'multi', apps: eligible };
  }

  // Comma-separated names
  const names = trimmed.split(',').map((n) => n.trim()).filter(Boolean);
  if (names.length <= 1) return { mode: 'single', name: names[0] ?? trimmed };

  const resolved: AppEntry[] = [];
  const notFound: string[] = [];
  const notEligible: string[] = [];

  for (const n of names) {
    const app = appRegistry.findApp(address, n);
    if (!app) {
      notFound.push(n);
    } else if (!filter(app)) {
      notEligible.push(app.name);
    } else {
      // Deduplicate (same app referenced multiple ways)
      if (!resolved.some((r) => r.leaseUuid === app.leaseUuid)) {
        resolved.push(app);
      }
    }
  }

  if (notFound.length > 0) {
    return { mode: 'error', error: `App${notFound.length > 1 ? 's' : ''} not found: ${notFound.join(', ')}` };
  }
  if (resolved.length === 0) {
    return { mode: 'error', error: `No eligible apps to ${verb}: ${notEligible.join(', ')}` };
  }
  return { mode: 'multi', apps: resolved, skipped: notEligible.length > 0 ? notEligible : undefined };
}

/**
 * Extract service names from a payload that may be JSON or YAML.
 * Tries JSON.parse first (via getServiceNames), then falls back to
 * lightweight YAML extraction for .yaml/.yml uploads.
 */
export function extractServiceNamesFromPayload(bytes: Uint8Array): string[] {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return []; // Not valid UTF-8 — cannot extract names
  }

  let raw: string[] = [];

  // Try JSON first
  try {
    const parsed: unknown = JSON.parse(text);
    const names = getServiceNames(parsed);
    if (names.length > 0) raw = names;
  } catch {
    // Not JSON — try YAML extraction below
  }

  // YAML fallback: use shared extraction from fileValidation
  if (raw.length === 0) {
    raw = extractYamlServiceNames(text);
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

/**
 * Format lease items for create-lease command.
 * Single-service: ['sku-uuid:1']
 * Stack (multi-service): ['sku-uuid:1:web', 'sku-uuid:1:db', ...]
 */
export function formatLeaseItems(skuUuid: string, serviceNames?: string[]): string[] {
  if (!serviceNames || serviceNames.length === 0) {
    return [`${skuUuid}:1`];
  }
  for (const name of serviceNames) {
    if (typeof name !== 'string' || !name) {
      throw new Error(`Invalid service name in lease items: ${JSON.stringify(name)}`);
    }
  }
  return serviceNames.map(name => `${skuUuid}:1:${name}`);
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
function validateInternalServiceNames(
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


/** True if the hostname looks like a DNS name (not a bare IPv4 address). */
function isDnsHostname(hostname: string): boolean {
  return isValidFqdn(hostname) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

/**
 * Rewrite a Fred endpoint URL based on container port type and hostname.
 *
 * - FQDN + HTTP port  → `https://fqdn` (Traefik TLS termination)
 * - FQDN + TCP port   → `fqdn:port`    (direct TCP, no protocol)
 * - IP (any port)      → `ip:port`      (bare, no protocol)
 */
function rewriteFredEndpoint(endpointUrl: string, portKey: string): string {
  try {
    const parsed = new URL(endpointUrl);
    const hostPort = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;

    if (!isDnsHostname(parsed.hostname)) return hostPort;

    const containerPort = parseContainerPort(portKey);
    if (containerPort != null && TCP_ONLY_PORTS.has(containerPort)) {
      return hostPort;
    }
    // HTTP service: https://fqdn (Traefik on 443)
    return `https://${parsed.hostname}`;
  } catch { /* not a valid URL — return as-is */ }
  return endpointUrl;
}

/**
 * Extract URL from fred status data (endpoints or instances).
 * This data is already available from polling — no extra API call needed.
 * Returns the first endpoint URL, or constructs one from instance ports + host.
 */
export function extractUrlFromFredStatus(
  fredStatus: FredLeaseStatus,
  host?: string
): string | undefined {
  // endpoints: Record<string, string> — full URLs like "http://host:port"
  if (fredStatus.endpoints) {
    const firstKey = Object.keys(fredStatus.endpoints)[0];
    const firstEndpoint = firstKey ? fredStatus.endpoints[firstKey] : undefined;
    if (firstKey && firstEndpoint) return rewriteFredEndpoint(firstEndpoint, firstKey);
  }

  // instances: ports as Record<string, number> — just port numbers
  if (fredStatus.instances && host) {
    for (const instance of fredStatus.instances) {
      if (instance.ports) {
        const firstPort = Object.values(instance.ports)[0];
        if (typeof firstPort === 'number') {
          return `${host}:${firstPort}`;
        }
      }
    }
  }

  // Stack services: extract primary service port
  if (fredStatus.services && host) {
    const primary = extractPrimaryServicePorts(fredStatus.services);
    if (primary) {
      const firstPort = Object.values(primary.ports)[0];
      if (typeof firstPort === 'number') {
        return `${host}:${firstPort}`;
      }
    }
  }

  return undefined;
}

/**
 * Resolve the app URL after successful deployment.
 * Priority: info endpoint (has port mappings) > fred status > connection endpoint.
 */
async function resolveAppUrl(
  providerUrl: string,
  leaseUuid: string,
  fredStatus: FredLeaseStatus,
  address: string,
  signArbitrary: ToolExecutorOptions['signArbitrary'],
  logContext: string
): Promise<{ url?: string; connection?: ConnectionDetails }> {
  // 1. Try connection endpoint (has proper host + port mappings)
  if (signArbitrary) {
    try {
      const token = await getProviderAuthToken(address, leaseUuid, signArbitrary);
      const connResponse = await getLeaseConnectionInfo(providerUrl, leaseUuid, token);
      if (connResponse.connection) {
        const connection = connResponse.connection;
        // Ports may be at top level or nested inside instances[0].ports
        let ports: Record<string, unknown> | undefined =
          connection.ports ?? connection.instances?.[0]?.ports;

        // Stack deployments: ports nested under services.<name>.instances[0].ports
        let fqdn = connection.fqdn;
        if (!ports && connection.services) {
          const primary = extractPrimaryServicePorts(connection.services);
          if (primary) {
            ports = primary.ports;
            // Promote primary service's FQDN to top-level for formatConnectionUrl
            if (!fqdn) {
              const svc = connection.services[primary.serviceName];
              fqdn = svc?.fqdn ?? svc?.instances?.[0]?.fqdn;
            }
          }
        }

        const withPorts = { ...connection, ports, fqdn };
        const url = formatConnectionUrl(connection.host, withPorts);
        if (url || withPorts.ports) return { url, connection: withPorts };
      }
    } catch (error) {
      logError(`${logContext}.connection`, error);
    }
  }

  // 2. Fall back to fred status data (endpoints/instances)
  // extractUrlFromFredStatus already rewrites FQDN HTTP endpoints to https://fqdn
  const fredUrl = extractUrlFromFredStatus(fredStatus);
  if (fredUrl) {
    return { url: fredUrl };
  }

  return {};
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
 * Best-effort fetch of provider logs and provision status for failed deploys.
 * Creates a fresh auth token since the original may be stale after long polling.
 * Never throws — failure to get logs must not mask the deploy error.
 */
async function fetchFailureLogs(
  providerUrl: string,
  leaseUuid: string,
  address: string,
  signArbitrary: ToolExecutorOptions['signArbitrary']
): Promise<string | null> {
  if (!signArbitrary) return null;

  try {
    const authToken = await getProviderAuthToken(address, leaseUuid, signArbitrary);

    const parts: string[] = [];

    // Fetch provision status first — more structured than raw logs
    try {
      const provision = await getLeaseProvision(providerUrl, leaseUuid, authToken);
      if (provision.last_error) {
        parts.push(`Provision error (fail_count=${provision.fail_count}): ${provision.last_error}`);
      }
    } catch (error) {
      logError('compositeTransactions.fetchFailureLogs.provision', error);
    }

    // Fetch container logs
    try {
      const response = await getLeaseLogs(providerUrl, leaseUuid, authToken, 100);
      const logEntries = Object.entries(response.logs ?? {});
      if (logEntries.length > 0) {
        const logText = logEntries
          .map(([service, text]) => `[${service}]\n${typeof text === 'string' ? text : JSON.stringify(text)}`)
          .join('\n');
        parts.push(`Container logs:\n${logText}`);
      }
    } catch (error) {
      logError('compositeTransactions.fetchFailureLogs.logs', error);
    }

    if (parts.length === 0) return null;

    const combined = parts.join('\n\n');
    // Truncate to last ~2000 chars to avoid bloating LLM context
    if (combined.length > 2000) {
      return '...' + combined.slice(-2000);
    }
    return combined;
  } catch (error) {
    logError('compositeTransactions.fetchFailureLogs', error);
    return null;
  }
}

// ============================================================================
// deploy_app
// ============================================================================

/**
 * Pre-validation for deploy_app. Returns confirmation result or error.
 */
export async function executeDeployApp(
  args: Record<string, unknown>,
  options: ToolExecutorOptions,
  payload?: PayloadAttachment
): Promise<ToolResult> {
  const { address, appRegistry } = options;
  if (!address) return { success: false, error: 'Wallet not connected' };
  if (!appRegistry) return { success: false, error: 'App registry not available' };

  // Stack-based deploy: build stack manifest from services param
  if (!payload && typeof args.services === 'string' && args.services) {
    if (args.image) {
      return { success: false, error: '"image" and "services" are mutually exclusive. Use "image" for single-service or "services" for multi-service stack.' };
    }

    const parsed = parseAndValidateStackServices(
      args.services as string, true, 'compositeTransactions.executeDeployApp.parseServices'
    );
    if ('error' in parsed) return { success: false, error: parsed.error };

    // Pre-generate a shared password for all auto-generated env vars in the stack.
    // This ensures cross-service credentials match (e.g., WORDPRESS_DB_PASSWORD matches MYSQL_PASSWORD).
    const sharedPassword = generatePassword();
    for (const svc of Object.values(parsed.services)) {
      if (svc.env) {
        for (const key of Object.keys(svc.env)) {
          if (svc.env[key] === '') svc.env[key] = sharedPassword;
          else if (svc.env[key].endsWith('/')) svc.env[key] += sharedPassword;
        }
      }
    }

    let manifestResult;
    try {
      manifestResult = await buildStackManifest({ services: parsed.services });
    } catch (error) {
      logError('compositeTransactions.executeDeployApp.buildStackManifest', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to build stack manifest' };
    }

    payload = manifestResult.payload;
    if (!args.app_name) {
      args.app_name = manifestResult.derivedAppName;
    }
    args._generatedManifest = manifestResult.json;
    args._serviceNames = parsed.serviceNames;
  }

  // Image-based deploy: build manifest from args when no file is attached
  if (!payload && args.image) {
    let env: Record<string, string> | undefined;
    if (typeof args.env === 'string' && args.env) {
      try {
        env = JSON.parse(args.env);
        if (typeof env !== 'object' || env === null || Array.isArray(env)) {
          return { success: false, error: 'env must be a JSON object (e.g. \'{"KEY":"value"}\').' };
        }
      } catch (error) {
        logError('compositeTransactions.executeDeployApp.parseEnv', error);
        return { success: false, error: 'Invalid env JSON string. Expected format: \'{"KEY":"value"}\'.' };
      }
    }

    if (env) {
      for (const [k, v] of Object.entries(env)) {
        if (typeof v !== 'string') {
          return { success: false, error: `Env var "${k}" must have a string value, got ${typeof v}.` };
        }
      }
      const envError = validateEnvNames(env);
      if (envError) return { success: false, error: envError };
    }

    // Parse command/args JSON arrays
    let command: string[] | undefined;
    if (typeof args.command === 'string' && args.command) {
      try {
        command = JSON.parse(args.command);
        if (!Array.isArray(command) || !command.every((s) => typeof s === 'string')) {
          return { success: false, error: 'command must be a JSON array of strings (e.g. \'["sh", "-c"]\').' };
        }
      } catch {
        return { success: false, error: 'Invalid command JSON. Expected a JSON array of strings (e.g. \'["sh", "-c"]\').' };
      }
    }

    let cmdArgs: string[] | undefined;
    if (typeof args.args === 'string' && args.args) {
      try {
        cmdArgs = JSON.parse(args.args);
        if (!Array.isArray(cmdArgs) || !cmdArgs.every((s) => typeof s === 'string')) {
          return { success: false, error: 'args must be a JSON array of strings (e.g. \'["echo hello"]\').' };
        }
      } catch {
        return { success: false, error: 'Invalid args JSON. Expected a JSON array of strings (e.g. \'["echo hello"]\').' };
      }
    }

    // Parse health_check from JSON string
    let healthCheck: HealthCheckConfig | undefined;
    if (typeof args.health_check === 'string' && args.health_check) {
      try {
        healthCheck = JSON.parse(args.health_check);
        if (typeof healthCheck !== 'object' || healthCheck === null || Array.isArray(healthCheck)) {
          return { success: false, error: 'health_check must be a JSON object.' };
        }
        if (!Array.isArray(healthCheck.test) || healthCheck.test.length < 2 || !healthCheck.test.every(el => typeof el === 'string')) {
          return { success: false, error: 'health_check.test must be an array of strings with at least 2 elements (e.g. ["CMD-SHELL", "curl -f http://localhost"]).' };
        }
      } catch {
        return { success: false, error: 'Invalid health_check JSON.' };
      }
    }

    // Parse labels from JSON string
    let labels: Record<string, string> | undefined;
    if (typeof args.labels === 'string' && args.labels) {
      try {
        labels = JSON.parse(args.labels);
        if (typeof labels !== 'object' || labels === null || Array.isArray(labels)) {
          return { success: false, error: 'labels must be a JSON object.' };
        }
        for (const [k, v] of Object.entries(labels)) {
          if (typeof v !== 'string') {
            return { success: false, error: `Label "${k}" must have a string value, got ${typeof v}.` };
          }
        }
      } catch {
        return { success: false, error: 'Invalid labels JSON.' };
      }
    }

    // Known image safety net: merge defaults for port, env, user, tmpfs, command, args, health_check
    const knownConfig = findKnownImage(args.image as string);
    if (knownConfig) {
      if (!args.port && knownConfig.port) args.port = knownConfig.port;
      if (!env && knownConfig.env) env = { ...knownConfig.env };
      else if (knownConfig.env) env = { ...knownConfig.env, ...env };
      if (!args.user && knownConfig.user) args.user = knownConfig.user;
      if (!args.tmpfs && knownConfig.tmpfs) args.tmpfs = knownConfig.tmpfs;
      if (!command && knownConfig.command) command = [...knownConfig.command];
      if (!cmdArgs && knownConfig.args) cmdArgs = [...knownConfig.args];
      if (!healthCheck && knownConfig.health_check) healthCheck = { ...knownConfig.health_check };
    }

    // Pre-generate env passwords so the same value can be shared with args
    if (env) {
      for (const key of Object.keys(env)) {
        if (env[key] === '') env[key] = generatePassword();
        else if (env[key].endsWith('/')) env[key] += generatePassword();
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
    if (portResult.error) return { success: false, error: portResult.error };
    const userResult = coerceStringArg(args.user, 'user');
    if (userResult.error) return { success: false, error: userResult.error };
    const tmpfsResult = coerceTmpfsArg(args.tmpfs);
    if (tmpfsResult.error) return { success: false, error: tmpfsResult.error };

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
      logError('compositeTransactions.executeDeployApp.buildManifest', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to build manifest' };
    }

    payload = manifestResult.payload;
    if (!args.app_name) {
      args.app_name = manifestResult.derivedAppName;
    }
    // Store generated manifest JSON for the confirmation round-trip
    args._generatedManifest = manifestResult.json;
  }

  if (!payload) {
    return { success: false, error: 'No file attached and no image specified. Attach a manifest file or specify a Docker image (e.g. deploy_app(image="redis:8.4")).' };
  }

  // Make file-attached JSON manifests editable in the confirmation card
  if (!args._generatedManifest && payload.filename?.endsWith('.json')) {
    try {
      const json = new TextDecoder().decode(payload.bytes);
      JSON.parse(json); // validate it's valid JSON
      args._generatedManifest = json;
    } catch {
      // Not valid JSON — fall through to read-only display
    }
  }

  // Extract service names from file-uploaded stack manifests (JSON or YAML)
  if (!args._serviceNames) {
    const names = extractServiceNamesFromPayload(payload.bytes);
    if (names.length > 0) {
      args._serviceNames = names;
    }
  }

  // Resolve name
  let name = args.app_name as string | undefined;
  if (!name && payload.filename) {
    name = deriveAppName(payload.filename);
  }
  if (!name) {
    name = `app-${Date.now().toString(36)}`;
  }

  // Validate name — auto-suffix on collision with running/deploying apps
  let nameError = validateAppName(name, address);
  if (nameError) {
    const baseName = name;
    let suffix = 2;
    while (nameError && suffix <= 99) {
      const candidate = `${baseName}-${suffix}`.slice(0, 32);
      nameError = validateAppName(candidate, address);
      if (!nameError) {
        name = candidate;
      }
      suffix++;
    }
    if (nameError) {
      return { success: false, error: nameError };
    }
  }

  // Resolve size from the AI store's resolved tier list. No chain round-trip
  // needed — the tier list already has SKU UUID, provider UUID, and normalized
  // $/hour price baked in. An omitted or unavailable size falls back to the
  // cheapest tier (resolveSizeOrCheapest); an empty catalog is the only hard
  // failure. The ConfirmationCard calls the same resolver so its price/specs
  // row and any substitution note match exactly what deploys here.
  const { tiers } = options;
  const resolution = resolveSizeOrCheapest(args.size as string | undefined, tiers);
  if (!resolution) {
    return { success: false, error: 'Tier catalog unavailable — try again in a moment.' };
  }
  const matched = resolution.tier;
  const size = matched.skuName;  // canonical SKU name
  const skuUuid = matched.skuUuid;

  // Find provider — still need apiUrl, which isn't in ResolvedSkuTier.
  let providers;
  try {
    providers = await withTimeout(getProviders(true), undefined, 'Fetch providers');
  } catch (error) {
    logError('compositeTransactions.deploy.fetchProviders', error);
    return { success: false, error: 'Failed to fetch providers. Please try again.' };
  }

  const provider = providers.find((p) => p.uuid === matched.providerUuid);

  if (!provider || !provider.apiUrl) {
    return { success: false, error: 'No available provider found for this tier.' };
  }

  // Pricing is normalized to $/hour at the source (`resolveSkuTiers`).
  // Pass-11 invariant: every resolved tier has `basePrice`, so
  // `pricePerHour === 0` is a genuinely-free tier (`basePrice.amount === '0'`),
  // NOT a missing-price candidate. Format unconditionally so free tiers
  // surface "0.0000 .../hr" on the confirmation card instead of going blank
  // (billing-transparency — same category as pass 5).
  const skuHourlyCost = matched.pricePerHour;
  const priceDisplay = `${skuHourlyCost.toFixed(4)} ${matched.denomSymbol}/hr`;

  // Stack deploys multiply cost by service count
  const serviceNamesResult = validateInternalServiceNames(args._serviceNames, 'deploy_app');
  if (serviceNamesResult.error) {
    return { success: false, error: serviceNamesResult.error };
  }
  const serviceNames = serviceNamesResult.serviceNames;
  const serviceCount = serviceNames && serviceNames.length > 0 ? serviceNames.length : 1;

  // Check credits - verify user can afford at least 1 hour of this SKU
  let creditWarning = '';
  try {
    const creditAccount = await withTimeout(getCreditAccount(address), undefined, 'Credit check');
    if (creditAccount?.balances) {
      // Find PWR balance
      let credits = 0;
      for (const bal of creditAccount.balances) {
        if (bal.denom === DENOMS.PWR || bal.denom.includes('upwr')) {
          credits = fromBaseUnits(bal.amount, bal.denom);
          break;
        }
      }

      // Check if user can afford at least 1 hour (multiplied by service count for stacks)
      const totalHourlyCost = skuHourlyCost * serviceCount;
      if (totalHourlyCost > 0 && credits < totalHourlyCost) {
        return {
          success: false,
          error: `Insufficient credits. You have ${Math.round(credits * 100) / 100} credits but need at least ${Math.round(totalHourlyCost * 100) / 100} for 1 hour${serviceCount > 1 ? ` (${serviceCount} services)` : ''}. Selected: ${size} tier on ${provider.uuid} (${priceDisplay}). Use fund_credits to add more credits.`,
        };
      }

      // Warn if less than 24 hours of runway for this SKU
      if (totalHourlyCost > 0) {
        const hoursAffordable = credits / totalHourlyCost;
        if (hoursAffordable < 24) {
          creditWarning = ` Warning: only ~${Math.floor(hoursAffordable)}h of credits remaining at this rate.`;
        }
      }
    }
  } catch (error) {
    logError('compositeTransactions.executeDeployApp.creditCheck', error);
    creditWarning = ' Warning: could not verify credit balance — proceed with caution.';
  }

  const stackInfo = serviceCount > 1 ? ` (${serviceCount} services)` : '';
  // priceDisplay is always non-empty (pass-16 invariant) — no need for a
  // truthy guard around the ` (~…)` wrapper anymore.
  const priceInfo = ` (~${priceDisplay}${serviceCount > 1 ? ` × ${serviceCount}` : ''})`;

  // Optional custom domain: validate up front so the user gets fast feedback
  // before any TX. The set-domain TX will be broadcast in the confirmed-deploy
  // path, between create-lease and manifest upload.
  let customDomain = '';
  let customDomainServiceName = '';
  let customDomainWarning: string | undefined;
  if (typeof args.custom_domain === 'string' && args.custom_domain.trim() !== '') {
    customDomain = normalizeFqdn(args.custom_domain);
    const validation = await validateAll(customDomain);
    if (validation.error) return { success: false, error: validation.error };
    customDomainWarning = validation.warning;

    // Uniqueness pre-check. The set_custom_domain path does this at line ~2997;
    // without it, a deploy can confirm and pay for a lease before the post-
    // broadcast MsgSetItemCustomDomain is chain-rejected as duplicate, leaving
    // the user charged for a non-functional deploy. Wrap in withTimeout to
    // bound the latency cost — consistent with other LCD calls in this
    // executor (compositeQueries.ts:52,54 and billingParams.ts).
    // On error/timeout: fall through, chain remains authoritative.
    // See PR #93 Copilot 3248436488.
    try {
      const existing = await withTimeout(
        queryLeaseByCustomDomain(customDomain),
        undefined,
        'queryLeaseByCustomDomain',
      );
      if (existing) {
        const heldByApp = appRegistry.getAppByLease(address, existing.leaseUuid);
        const friendly = heldByApp ? `"${heldByApp.name}"` : 'another lease';
        return {
          success: false,
          error: `"${customDomain}" is already attached to ${friendly}. Pick a different domain or detach it first.`,
        };
      }
    } catch (err) {
      logError('compositeTransactions.executeDeployApp.queryLeaseByCustomDomain', err);
      // Don't block — chain remains authoritative.
    }

    if (serviceNames && serviceNames.length > 1) {
      const explicit = typeof args.service_name === 'string' ? args.service_name.trim() : '';
      if (!explicit) {
        return {
          success: false,
          error: `"${name}" is a multi-service stack — pass service_name to attach the custom domain to one of: ${serviceNames.join(', ')}.`,
        };
      }
      if (!serviceNames.includes(explicit)) {
        return {
          success: false,
          error: `Service "${explicit}" not found in stack. Available: ${serviceNames.join(', ')}.`,
        };
      }
      customDomainServiceName = explicit;
    } else if (serviceNames && serviceNames.length === 1) {
      // Single-service stack — auto-select.
      customDomainServiceName = serviceNames[0];
    } else {
      // Image+port single-item legacy lease — chain wants serviceName=''.
      customDomainServiceName = '';
    }
  }

  return {
    success: true,
    requiresConfirmation: true,
    confirmationMessage: `Deploy "${name}"${stackInfo} on ${size} tier${priceInfo}?${creditWarning}`,
    pendingAction: {
      toolName: 'deploy_app',
      args: {
        app_name: name,
        size,
        skuUuid,
        providerUuid: provider.uuid,
        providerUrl: provider.apiUrl,
        ...(args._generatedManifest ? { _generatedManifest: args._generatedManifest } : {}),
        ...(serviceNames && serviceNames.length > 0 ? { _serviceNames: serviceNames } : {}),
        ...(customDomain ? {
          customDomain,
          customDomainServiceName,
          ...(customDomainWarning ? { customDomainWarning } : {}),
        } : {}),
      },
    },
  };
}

/**
 * Execute deploy_app after user confirmation.
 */
export async function executeConfirmedDeployApp(
  args: Record<string, unknown>,
  clientManager: CosmosClientManager,
  options: ToolExecutorOptions,
  payload?: PayloadAttachment
): Promise<ToolResult> {
  const { address, appRegistry, signArbitrary, onProgress, signal } = options;
  if (!address) return { success: false, error: 'Wallet not connected' };
  if (!appRegistry) return { success: false, error: 'App registry not available' };

  // Reconstruct payload from stored manifest JSON (image-based deploy)
  if (!payload && typeof args._generatedManifest === 'string') {
    payload = await buildPayloadFromManifest(args._generatedManifest);
  }

  if (!payload) return { success: false, error: 'Payload missing' };
  if (!signArbitrary) return { success: false, error: 'Wallet does not support message signing' };

  const name = args.app_name as string;
  const size = args.size as string;
  const skuUuid = args.skuUuid as string;
  const providerUuid = args.providerUuid as string;
  const providerUrl = args.providerUrl as string;
  const metaHashHex = payload.hash;

  // Create lease
  onProgress?.({ phase: 'creating_lease', detail: 'Creating lease on-chain...' });

  const serviceNamesResult = validateInternalServiceNames(args._serviceNames, 'deploy_app');
  if (serviceNamesResult.error) {
    onProgress?.({ phase: 'failed', detail: serviceNamesResult.error });
    return { success: false, error: serviceNamesResult.error };
  }
  const leaseItems = formatLeaseItems(skuUuid, serviceNamesResult.serviceNames);
  const cmdArgs = ['--meta-hash', metaHashHex, ...leaseItems];
  const result = await cosmosTx(clientManager, 'billing', 'create-lease', cmdArgs, true);

  if (result.code !== 0) {
    onProgress?.({ phase: 'failed', detail: result.rawLog ?? 'Transaction failed' });
    return { success: false, error: result.rawLog ?? 'Failed to create lease' };
  }

  const leaseUuid = extractLeaseUuidFromTxResult(result);
  if (!leaseUuid) {
    onProgress?.({ phase: 'failed', detail: 'Could not extract lease UUID from transaction' });
    return { success: false, error: 'Lease created but could not extract UUID. Check your leases manually.' };
  }

  // Add to registry (store manifest for re-deploy, secrets stripped)
  const manifestJson = new TextDecoder().decode(payload.bytes);
  try {
    appRegistry.addApp(address, {
      name,
      leaseUuid,
      size,
      providerUuid,
      providerUrl,
      createdAt: Date.now(),
      status: 'deploying',
      manifest: sanitizeManifestForStorage(manifestJson),
    });
  } catch (error) {
    // Lease already created on-chain — log but don't abort the deploy flow
    logError('compositeTransactions.executeConfirmedDeployApp.addApp', error);
  }

  // Optional: attach custom domain BEFORE manifest upload so Traefik picks
  // up the per-item custom_domain label as soon as the container is up.
  // A failure here is non-fatal: the deploy proceeds, the user is left in
  // the existing 2-step state and can retry set_custom_domain standalone.
  // Type is module-scoped (`DomainAttachResult`) so the batch path and
  // `fallbackToChainState` can use the same shape.
  const customDomainArg = typeof args.customDomain === 'string' ? args.customDomain : '';
  let domainAttach: DomainAttachResult = { kind: 'none' };
  if (customDomainArg !== '') {
    const customDomainServiceName = typeof args.customDomainServiceName === 'string' ? args.customDomainServiceName : '';
    try {
      const domainResult = await monoSetItemCustomDomain(
        clientManager,
        leaseUuid,
        customDomainArg,
        customDomainServiceName !== '' ? { serviceName: customDomainServiceName } : {},
      );
      domainAttach = domainResult.code === 0
        ? { kind: 'attached', customDomain: customDomainArg, serviceName: customDomainServiceName }
        : { kind: 'failed', error: `chain rejected with code ${domainResult.code}` };
    } catch (err) {
      logError('compositeTransactions.executeConfirmedDeployApp.setItemCustomDomain', err);
      domainAttach = { kind: 'failed', error: err instanceof Error ? err.message : 'unknown error' };
    }
  }

  // Upload payload
  onProgress?.({ phase: 'uploading', detail: 'Uploading manifest to provider...' });

  const uploadResult = await uploadPayloadToProvider(
    providerUrl,
    leaseUuid,
    metaHashHex,
    payload.bytes,
    address,
    signArbitrary
  );

  if (!uploadResult.success) {
    onProgress?.({ phase: 'failed', detail: `Upload failed: ${uploadResult.error}` });
    appRegistry.updateApp(address, leaseUuid, { status: 'failed' });
    return {
      success: false,
      error: `Lease created but upload failed: ${normalizeErrorPunctuation(uploadResult.error)}. The lease ${leaseUuid} is active — you may need to stop it.`,
    };
  }

  // Poll fred for readiness
  onProgress?.({ phase: 'provisioning', detail: 'Waiting for deployment...' });

  try {
    const refreshAuthToken = () => getProviderAuthToken(address, leaseUuid, signArbitrary);
    const authToken = await refreshAuthToken();

    const fredStatus = await waitForLeaseReady(providerUrl, leaseUuid, authToken, {
      maxAttempts: Math.ceil(AI_DEPLOY_PROVISION_TIMEOUT_MS / FRED_POLL_INTERVAL_MS),
      intervalMs: FRED_POLL_INTERVAL_MS,
      abortSignal: signal,
      onProgress: (status) => {
        onProgress?.({
          phase: 'provisioning',
          detail: status.phase || 'Provisioning...',
          fredStatus: status,
        });
      },
      getAuthToken: refreshAuthToken,
      // Check chain state to detect rejected/closed leases
      checkChainState: async (): Promise<TerminalChainState | null> => {
        const lease = await getLease(leaseUuid);
        if (!lease) return { state: 'closed' };
        if (lease.state === LeaseState.LEASE_STATE_CLOSED) return { state: 'closed' };
        if (lease.state === LeaseState.LEASE_STATE_REJECTED) return { state: 'rejected' };
        if (lease.state === LeaseState.LEASE_STATE_EXPIRED) return { state: 'expired' };
        return null;
      },
    });

    if (fredStatus.state === LeaseState.LEASE_STATE_ACTIVE && fredStatus.provision_status !== 'failed') {
      const { url: connectionUrl, connection } = await resolveAppUrl(
        providerUrl, leaseUuid, fredStatus, address, signArbitrary,
        'compositeTransactions.executeConfirmedDeployApp'
      );

      // Cache the just-attached custom domain so the DNS polling driver
      // (mounted in MainLayout) sees it without waiting for the user to run
      // `app_status`. Merge against existing entries — multi-service stacks
      // can have N domains.
      let customDomainsUpdate: { customDomains: { serviceName: string; customDomain: string }[] } | object = {};
      if (domainAttach.kind === 'attached') {
        const prior = appRegistry.getAppByLease(address, leaseUuid)?.customDomains ?? [];
        const others = prior.filter((d) => d.serviceName !== domainAttach.serviceName);
        customDomainsUpdate = {
          customDomains: [...others, { serviceName: domainAttach.serviceName, customDomain: domainAttach.customDomain }],
        };
      }
      appRegistry.updateApp(address, leaseUuid, {
        status: 'running',
        url: connectionUrl,
        connection: connection ? JSON.parse(JSON.stringify(connection)) : undefined,
        ...customDomainsUpdate,
      });
      onProgress?.({ phase: 'ready', detail: 'App is live!' });

      // No CustomDomainCard auto-emission on the deploy path. The deploy result
      // is the primary surface here. DNS progress (4-state polling) is available
      // by running app_status (chat or sidebar click), which surfaces the
      // CustomDomainCard for the now-attached domain — same component, just
      // discovered separately to keep the deploy success surface uncluttered.

      const expectedCnameTarget = domainAttach.kind === 'attached'
        ? resolveExpectedCnameTarget(connection, domainAttach.serviceName)
        : undefined;
      const isApexAttached = typeof args.customDomainWarning === 'string' && args.customDomainWarning.length > 0;
      const recordKind = isApexAttached
        ? `an ${apexRecordKindLabel(true)} record (apex domains cannot use CNAME)`
        : `a ${apexRecordKindLabel(false)}`;

      let message: string;
      switch (domainAttach.kind) {
        case 'failed':
          message = `App "${name}" is live, but the custom-domain attach failed (${domainAttach.error}). Run \`set_custom_domain\` to try again.`;
          break;
        case 'attached': {
          const target = expectedCnameTarget ?? '<provider FQDN>';
          message = `App "${name}" is live. Custom domain "${domainAttach.customDomain}" attached — add ${recordKind} at your registrar pointing at ${target}.`;
          break;
        }
        case 'none':
          message = `App "${name}" is live!`;
          break;
      }

      // Emit a single rich `app` displayCard. When a custom domain attached,
      // the AppCard embeds a DomainRow that reads its live DNS status from
      // the shared `dnsStatuses` slice (no per-card polling).
      const displayCard = {
        type: 'app' as const,
        data: {
          name,
          url: connectionUrl,
          status: 'running',
          connection: connection ? JSON.parse(JSON.stringify(connection)) : undefined,
          ...(domainAttach.kind === 'attached'
            ? {
                customDomain: {
                  fqdn: domainAttach.customDomain,
                  leaseUuid,
                  serviceName: domainAttach.serviceName,
                  expectedCnameTarget,
                  isApex: isApexAttached,
                },
              }
            : {}),
        },
      };

      return {
        success: true,
        data: {
          message,
          name,
          url: connectionUrl,
          status: 'running',
          ...(domainAttach.kind === 'attached' ? {
            custom_domain: domainAttach.customDomain,
            service_name: domainAttach.serviceName,
            expected_cname_target: expectedCnameTarget,
            is_apex: isApexAttached,
          } : {}),
          ...(domainAttach.kind === 'failed' ? { custom_domain_error: domainAttach.error } : {}),
        },
        displayCard,
      };
    }

    if (
      fredStatus.state === LeaseState.LEASE_STATE_CLOSED ||
      fredStatus.state === LeaseState.LEASE_STATE_REJECTED ||
      fredStatus.state === LeaseState.LEASE_STATE_EXPIRED ||
      fredStatus.provision_status === 'failed'
    ) {
      appRegistry.updateApp(address, leaseUuid, { status: 'failed' });
      onProgress?.({ phase: 'failed', detail: fredStatus.last_error || 'Deployment failed' });

      const diagnostics = await fetchFailureLogs(providerUrl, leaseUuid, address, signArbitrary);
      const errorMsg = diagnostics
        ? `Deployment failed: ${fredStatus.last_error || 'Unknown error'}\n\n${diagnostics}`
        : `Deployment failed: ${fredStatus.last_error || 'Unknown error'}`;

      return {
        success: false,
        error: errorMsg,
      };
    }

    // Fred didn't confirm — fall back to chain state. Thread domainAttach so
    // the fallback can preserve customDomains cache + message detail.
    return await fallbackToChainState(name, leaseUuid, appRegistry, address, onProgress, domainAttach);
  } catch (error) {
    logError('compositeTransactions.executeConfirmedDeployApp.polling', error);
    // Polling failed but lease+upload succeeded — check chain state to determine actual status.
    // Don't use diagnostics alone to decide failure: they may describe a still-running app.
    return await fallbackToChainState(name, leaseUuid, appRegistry, address, onProgress, domainAttach);
  }
}

/**
 * Custom-domain attach outcome carried from the deploy executor through to
 * `fallbackToChainState`. The success branch (line :1233+) reads this to
 * tailor the result message and registry write; the fallback path mirrors
 * that behavior so a fred-times-out + chain-ACTIVE case doesn't silently
 * drop the customDomains cache (sidebar dot would go blank).
 */
type DomainAttachResult =
  | { kind: 'none' }
  | { kind: 'attached'; customDomain: string; serviceName: string }
  | { kind: 'failed'; error: string };

/**
 * When fred polling doesn't confirm readiness, check the chain state.
 * If the lease is ACTIVE on chain, trust it and mark the app as running.
 *
 * `domainAttach` is threaded from the caller so this path preserves the
 * customDomains cache (DNS polling driver + sidebar dot need it) and the
 * "domain attached" message detail. Without it, fred-times-out becomes a
 * silent UX loss: the user sees "live!" with no clue the domain attached.
 * Defaults to `{ kind: 'none' }` so future callers don't have to thread it
 * if they have no domain to preserve.
 */
async function fallbackToChainState(
  name: string,
  leaseUuid: string,
  appRegistry: ToolExecutorOptions['appRegistry'],
  address: string,
  onProgress?: ToolExecutorOptions['onProgress'],
  domainAttach: DomainAttachResult = { kind: 'none' },
): Promise<ToolResult> {
  try {
    const lease = await getLease(leaseUuid);
    if (lease && lease.state === LeaseState.LEASE_STATE_ACTIVE) {
      // Chain says ACTIVE — trust it. When a custom domain attached on the
      // way in, mirror the success-branch behavior at :1243-1255: keep the
      // customDomains cache populated so the DNS polling driver and the
      // sidebar dot see the attached domain. Without this, fred-timeout
      // silently drops customDomains and the user sees "live app" with no
      // sign the domain attached.
      let customDomainsUpdate: object = {};
      if (domainAttach.kind === 'attached' && appRegistry) {
        const prior = appRegistry.getAppByLease(address, leaseUuid)?.customDomains ?? [];
        const others = prior.filter((d) => d.serviceName !== domainAttach.serviceName);
        customDomainsUpdate = {
          customDomains: [
            ...others,
            { serviceName: domainAttach.serviceName, customDomain: domainAttach.customDomain },
          ],
        };
      }
      appRegistry?.updateApp(address, leaseUuid, { status: 'running', ...customDomainsUpdate });
      onProgress?.({ phase: 'ready', detail: 'App is live!' });

      let message: string;
      switch (domainAttach.kind) {
        case 'attached':
          message = `App "${name}" is live. Custom domain "${domainAttach.customDomain}" attached — check the sidebar for DNS status, or run app_status for record details.`;
          break;
        case 'failed':
          message = `App "${name}" is live, but the custom-domain attach failed (${domainAttach.error}). Run \`set_custom_domain\` to try again.`;
          break;
        case 'none':
          message = `App "${name}" is live!`;
          break;
      }

      return {
        success: true,
        data: {
          message,
          name,
          status: 'running',
          ...(domainAttach.kind === 'attached' ? {
            custom_domain: domainAttach.customDomain,
            service_name: domainAttach.serviceName,
          } : {}),
          ...(domainAttach.kind === 'failed' ? { custom_domain_error: domainAttach.error } : {}),
        },
      };
    }
  } catch (error) {
    logError('compositeTransactions.fallbackToChainState', error);
  }

  // Chain state unknown or not active — keep as deploying. Domain attach
  // outcome doesn't surface here: the deploy itself didn't conclude, so
  // surfacing "attached!" would mislead.
  appRegistry?.updateApp(address, leaseUuid, { status: 'deploying' });
  onProgress?.({ phase: 'failed', detail: `Provisioning timed out. Use app_status("${name}") to check progress.` });
  return {
    success: true,
    data: {
      message: `App "${name}" is still deploying. Use app_status("${name}") to check progress.`,
      name,
      status: 'deploying',
    },
  };
}

// ============================================================================
// deploy_app — single-app core helper (shared by single & batch paths)
// ============================================================================

export interface SingleDeployEntry {
  app_name: string;
  size: string;
  skuUuid: string;
  providerUuid: string;
  providerUrl: string;
  payload: PayloadAttachment;
  serviceNames?: string[];
  // Per-LeaseItem custom domain attached between create-lease and payload
  // upload, mirroring the single-deploy contract (see :1154-1180). Missing
  // or empty `customDomain` = no attach. `customDomainServiceName` selects
  // the target LeaseItem in a multi-service stack; empty string = the
  // single-item-lease default. `customDomainWarning` is the apex warning
  // surfaced post-broadcast (computed at deploy_app validation time).
  customDomain?: string;
  customDomainServiceName?: string;
  customDomainWarning?: string;
}

// ============================================================================
// batch_deploy
// ============================================================================

export interface BatchDeployEntry {
  app_name: string;
  payload: PayloadAttachment;
}

/**
 * Pre-validation for batch deploy. Resolves SKU/provider once,
 * checks total credits, validates all names.
 * Returns a single ToolResultConfirmation with args.entries.
 */
export async function executeBatchDeploy(
  entries: BatchDeployEntry[],
  options: ToolExecutorOptions,
  size?: string
): Promise<ToolResult> {
  const { address, appRegistry, tiers } = options;
  if (!address) return { success: false, error: 'Wallet not connected' };
  if (!appRegistry) return { success: false, error: 'App registry not available' };
  if (entries.length === 0) return { success: false, error: 'No apps to deploy' };
  // Resolve size once for the whole batch. Omitted/unavailable falls back to the
  // cheapest tier (resolveSizeOrCheapest); an empty catalog is the only hard
  // failure. Mirrors the single-deploy path.
  const resolution = resolveSizeOrCheapest(size, tiers);
  if (!resolution) {
    return { success: false, error: 'Tier catalog unavailable — try again in a moment.' };
  }
  const matched = resolution.tier;
  const skuUuid = matched.skuUuid;
  const normalizedSize = matched.skuName;  // canonical SKU name

  // Find provider — still need apiUrl, which isn't in ResolvedSkuTier.
  let providers;
  try {
    providers = await withTimeout(getProviders(true), undefined, 'Fetch providers');
  } catch (error) {
    logError('compositeTransactions.update.fetchProviders', error);
    return { success: false, error: 'Failed to fetch providers. Please try again.' };
  }

  const provider = providers.find((p) => p.uuid === matched.providerUuid);

  if (!provider || !provider.apiUrl) {
    return { success: false, error: 'No available provider found for this tier.' };
  }

  // Validate all names (auto-suffix on collision)
  const resolvedEntries: Array<SingleDeployEntry> = [];
  const usedNames = new Set<string>();

  for (const entry of entries) {
    let name = entry.app_name;

    // Auto-suffix for duplicates within the batch
    let nameError = validateAppName(name, address);
    if (nameError || usedNames.has(name)) {
      const baseName = name;
      let suffix = 2;
      while ((nameError || usedNames.has(name)) && suffix <= 99) {
        const candidate = `${baseName}-${suffix}`.slice(0, 32);
        nameError = validateAppName(candidate, address);
        if (!nameError && !usedNames.has(candidate)) {
          name = candidate;
          nameError = null;
        }
        suffix++;
      }
      if (nameError) {
        return { success: false, error: `Cannot deploy "${entry.app_name}": ${nameError}` };
      }
    }

    usedNames.add(name);

    // Extract service names from stack manifests (JSON or YAML)
    const extractedNames = extractServiceNamesFromPayload(entry.payload.bytes);
    const serviceNames = extractedNames.length > 0 ? extractedNames : undefined;

    resolvedEntries.push({
      app_name: name,
      size: normalizedSize,
      skuUuid,
      providerUuid: provider.uuid,
      providerUrl: provider.apiUrl,
      payload: entry.payload,
      serviceNames,
    });
  }

  // Pricing is already normalized to $/hour at the source (`resolveSkuTiers`).
  // Pass-11 invariant: every resolved tier has `basePrice`, so
  // `pricePerHour === 0` is a genuinely-free tier (`basePrice.amount === '0'`),
  // NOT a missing-price candidate. Format unconditionally so free tiers
  // surface "0.0000 .../hr" on the confirmation card instead of going blank
  // (billing-transparency — same category as pass 5).
  const skuHourlyCost = matched.pricePerHour;
  const priceDisplay = `${skuHourlyCost.toFixed(4)} ${matched.denomSymbol}/hr`;

  // Count total services across all entries (stacks contribute multiple services)
  const totalServiceCount = resolvedEntries.reduce(
    (sum, e) => sum + (e.serviceNames && e.serviceNames.length > 0 ? e.serviceNames.length : 1),
    0
  );
  const totalHourlyCost = skuHourlyCost * totalServiceCount;
  let creditWarning = '';

  try {
    const creditAccount = await withTimeout(getCreditAccount(address), undefined, 'Credit check');
    if (creditAccount?.balances) {
      let credits = 0;
      for (const bal of creditAccount.balances) {
        if (bal.denom === DENOMS.PWR || bal.denom.includes('upwr')) {
          credits = fromBaseUnits(bal.amount, bal.denom);
          break;
        }
      }

      if (totalHourlyCost > 0 && credits < totalHourlyCost) {
        return {
          success: false,
          error: `Insufficient credits. You have ${Math.round(credits * 100) / 100} credits but need at least ${Math.round(totalHourlyCost * 100) / 100} for 1 hour of ${totalServiceCount} services across ${entries.length} apps.`,
        };
      }

      if (totalHourlyCost > 0) {
        const hoursAffordable = credits / totalHourlyCost;
        if (hoursAffordable < 24) {
          creditWarning = ` Warning: only ~${Math.floor(hoursAffordable)}h of credits remaining at this rate.`;
        }
      }
    }
  } catch (error) {
    logError('compositeTransactions.executeBatchDeploy.creditCheck', error);
    creditWarning = ' Warning: could not verify credit balance — proceed with caution.';
  }

  const names = resolvedEntries.map((e) => e.app_name);
  // priceDisplay is always non-empty (pass-16 invariant) — no need for a
  // truthy guard around the ` (~… each)` wrapper.
  const confirmationMessage = `Deploy ${entries.length} apps (${names.join(', ')}) on ${normalizedSize} tier (~${priceDisplay} each)?${creditWarning}`;

  return {
    success: true,
    requiresConfirmation: true,
    confirmationMessage,
    pendingAction: {
      toolName: 'batch_deploy',
      args: { entries: resolvedEntries },
    },
  };
}

/**
 * Execute batch deploy after user confirmation.
 *
 * Runs per-app deploy pipelines concurrently (bounded by AI_BATCH_DEPLOY_CONCURRENCY).
 * A signing mutex serializes wallet operations (cosmosTx, signArbitrary) to avoid
 * nonce collisions, while non-signing work (HTTP uploads, WS waits, status checks)
 * runs in parallel.
 */
export async function executeConfirmedBatchDeploy(
  args: Record<string, unknown>,
  clientManager: CosmosClientManager,
  options: ToolExecutorOptions
): Promise<ToolResult> {
  const entries = args.entries as SingleDeployEntry[] | undefined;
  if (!entries || entries.length === 0) {
    return { success: false, error: 'No entries to deploy' };
  }

  const { address, appRegistry, signArbitrary, onProgress, signal } = options;
  if (!address) return { success: false, error: 'Wallet not connected' };
  if (!appRegistry) return { success: false, error: 'App registry not available' };
  if (!signArbitrary) return { success: false, error: 'Wallet does not support message signing' };

  const { withSign, signArbitraryWithMutex } = createSigningMutex(signArbitrary);

  const batchEntries = entries.map((e) => ({ ...e, name: e.app_name }));

  const { succeeded, failed, batchProgress } = await runBatchWithConcurrency({
    entries: batchEntries,
    intermediatePhases: ['provisioning', 'uploading', 'creating_lease'],
    initialPhase: 'creating_lease',
    signal,
    onProgress,
    executeOne: async (entry, _i, updateProgress) => {
      const name = entry.app_name;

      // ---- Create lease (signing) ----
      updateProgress('creating_lease', 'Creating lease on-chain...');

      const cmdArgs = ['--meta-hash', entry.payload.hash, ...formatLeaseItems(entry.skuUuid, entry.serviceNames)];
      const txResult = await withSign(() => cosmosTx(clientManager, 'billing', 'create-lease', cmdArgs, true));

      if (txResult.code !== 0) {
        updateProgress('failed', txResult.rawLog ?? 'Transaction failed');
        return null;
      }

      const leaseUuid = extractLeaseUuidFromTxResult(txResult);
      if (!leaseUuid) {
        updateProgress('failed', 'Could not extract lease UUID');
        return null;
      }

      try {
        appRegistry.addApp(address, {
          name,
          leaseUuid,
          size: entry.size,
          providerUuid: entry.providerUuid,
          providerUrl: entry.providerUrl,
          createdAt: Date.now(),
          status: 'deploying',
          manifest: sanitizeManifestForStorage(new TextDecoder().decode(entry.payload.bytes)),
        });
      } catch (error) {
        logError('compositeTransactions.executeConfirmedBatchDeploy.addApp', error);
      }

      // ---- Attach custom domain (signing) ----
      // Mirrors single-deploy ordering at :1154-1180. Attach BEFORE upload so
      // Traefik picks up the per-item custom_domain label as soon as the
      // container comes up. Failure is non-fatal: the deploy proceeds and
      // the failure surfaces via `customDomainError` on the returned
      // BatchSuccessItem (rendered in summary by summarizeBatchResult).
      // `domainAttach` is also threaded into the fallback path below so a
      // fred-times-out + chain-ACTIVE case preserves the customDomains
      // cache (same shape as the single-deploy attach outcome at :1163).
      let domainAttach: DomainAttachResult = { kind: 'none' };
      if (entry.customDomain) {
        const requestedDomain = entry.customDomain;
        const requestedService = entry.customDomainServiceName ?? '';
        try {
          const domainResult = await withSign(() => monoSetItemCustomDomain(
            clientManager,
            leaseUuid,
            requestedDomain,
            requestedService !== '' ? { serviceName: requestedService } : {},
          ));
          if (domainResult.code === 0) {
            domainAttach = { kind: 'attached', customDomain: requestedDomain, serviceName: requestedService };
            // Cache the just-attached domain so the DNS polling driver sees
            // it without waiting for the user to run `app_status`. Merge
            // against existing entries — multi-service stacks can have
            // N domains. Mirrors single-deploy at :1243-1255.
            //
            // This happy-path write is mutually exclusive with the new
            // customDomains merge in `fallbackToChainState`: that path only
            // fires when fred doesn't confirm, at which point the cache
            // here is already correct and the fallback's write is
            // idempotent against it.
            try {
              const prior = appRegistry.getAppByLease(address, leaseUuid)?.customDomains ?? [];
              const others = prior.filter((d) => d.serviceName !== requestedService);
              appRegistry.updateApp(address, leaseUuid, {
                customDomains: [...others, { serviceName: requestedService, customDomain: requestedDomain }],
              });
            } catch (error) {
              logError('compositeTransactions.executeConfirmedBatchDeploy.cacheCustomDomain', error);
            }
          } else {
            domainAttach = { kind: 'failed', error: `chain rejected with code ${domainResult.code}` };
          }
        } catch (err) {
          logError('compositeTransactions.executeConfirmedBatchDeploy.setItemCustomDomain', err);
          domainAttach = { kind: 'failed', error: err instanceof Error ? err.message : 'unknown error' };
        }
      }

      // ---- Upload payload (signing) ----
      updateProgress('uploading', 'Uploading manifest...');

      const uploadResult = await uploadPayloadToProvider(
        entry.providerUrl,
        leaseUuid,
        entry.payload.hash,
        entry.payload.bytes,
        address,
        signArbitraryWithMutex
      );

      if (!uploadResult.success) {
        updateProgress('failed', `Upload failed: ${uploadResult.error}`);
        appRegistry.updateApp(address, leaseUuid, { status: 'failed' });
        return null;
      }

      // ---- Wait for ready (no signing except auth refresh) ----
      updateProgress('provisioning', 'Waiting for deployment...');

      try {
        const refreshAuthToken = () => getProviderAuthToken(address, leaseUuid, signArbitraryWithMutex);
        const authToken = await refreshAuthToken();

        const fredStatus = await waitForLeaseReady(entry.providerUrl, leaseUuid, authToken, {
          maxAttempts: Math.ceil(AI_DEPLOY_PROVISION_TIMEOUT_MS / FRED_POLL_INTERVAL_MS),
          intervalMs: FRED_POLL_INTERVAL_MS,
          abortSignal: signal,
          onProgress: (status) => {
            updateProgress('provisioning', status.phase || 'Provisioning...');
          },
          getAuthToken: refreshAuthToken,
          checkChainState: async (): Promise<TerminalChainState | null> => {
            const lease = await getLease(leaseUuid);
            if (!lease) return { state: 'closed' };
            if (lease.state === LeaseState.LEASE_STATE_CLOSED) return { state: 'closed' };
            if (lease.state === LeaseState.LEASE_STATE_REJECTED) return { state: 'rejected' };
            if (lease.state === LeaseState.LEASE_STATE_EXPIRED) return { state: 'expired' };
            return null;
          },
        });

        if (fredStatus.state === LeaseState.LEASE_STATE_ACTIVE && fredStatus.provision_status !== 'failed') {
          const { url: connectionUrl, connection } = await resolveAppUrl(
            entry.providerUrl, leaseUuid, fredStatus, address, signArbitraryWithMutex,
            'executeConfirmedBatchDeploy'
          );

          appRegistry.updateApp(address, leaseUuid, { status: 'running', url: connectionUrl, connection: connection ? JSON.parse(JSON.stringify(connection)) : undefined });
          updateProgress('ready', 'App is live!');
          return {
            name,
            url: connectionUrl,
            ...(domainAttach.kind === 'failed' ? { customDomainError: domainAttach.error } : {}),
          };
        }

        if (
          fredStatus.state === LeaseState.LEASE_STATE_CLOSED ||
          fredStatus.state === LeaseState.LEASE_STATE_REJECTED ||
          fredStatus.state === LeaseState.LEASE_STATE_EXPIRED ||
          fredStatus.provision_status === 'failed'
        ) {
          appRegistry.updateApp(address, leaseUuid, { status: 'failed' });
          updateProgress('failed', fredStatus.last_error || 'Deployment failed');
          return null;
        }

        const fbResult = await fallbackToChainState(name, leaseUuid, appRegistry, address, (p) => {
          updateProgress(p.phase, p.detail);
        }, domainAttach);
        return fbResult.success ? {
          name,
          ...(domainAttach.kind === 'failed' ? { customDomainError: domainAttach.error } : {}),
        } : null;
      } catch (error) {
        logError('executeConfirmedBatchDeploy.poll', error);
        const fbResult = await fallbackToChainState(name, leaseUuid, appRegistry, address, (p) => {
          updateProgress(p.phase, p.detail);
        }, domainAttach);
        return fbResult.success ? {
          name,
          ...(domainAttach.kind === 'failed' ? { customDomainError: domainAttach.error } : {}),
        } : null;
      }
    },
  });

  return summarizeBatchResult({
    succeeded,
    failed,
    dataKey: 'deployed',
    verb: 'Deployed',
    failedNoun: 'deploys',
    batchProgress,
    onProgress,
  });
}

// ============================================================================
// stop_app
// ============================================================================

/**
 * Pre-validation for stop_app. Returns confirmation result or error.
 * Supports app_name="all" to stop every running/deploying app at once.
 */
export async function executeStopApp(
  args: Record<string, unknown>,
  options: ToolExecutorOptions
): Promise<ToolResult> {
  const { address, appRegistry } = options;
  if (!address) return { success: false, error: 'Wallet not connected' };
  if (!appRegistry) return { success: false, error: 'App registry not available' };

  const name = args.app_name as string;
  if (!name) return { success: false, error: 'App name is required' };

  // Multi-app stop: "all" or comma-separated names
  const stopFilter = (a: AppEntry) => a.status === 'running' || a.status === 'deploying';
  const multi = resolveMultiAppNames(name, address, appRegistry, stopFilter, 'stop');
  if (multi.mode === 'error') return { success: false, error: multi.error };

  if (multi.mode === 'multi') {
    const names = multi.apps.map((a) => a.name);
    const entries = multi.apps.map((a) => ({ app_name: a.name, leaseUuid: a.leaseUuid }));
    const skippedNote = multi.skipped ? ` (skipped: ${multi.skipped.join(', ')})` : '';
    return {
      success: true,
      requiresConfirmation: true,
      confirmationMessage: `Stop ${multi.apps.length} app${multi.apps.length > 1 ? 's' : ''} (${names.join(', ')})? This will terminate all deployments and stop billing.${skippedNote}`,
      pendingAction: {
        toolName: 'stop_app',
        args: { app_name: name, entries },
      },
    };
  }

  // Single app — use normalized name from resolveMultiAppNames
  const singleName = multi.name;
  const app = appRegistry.findApp(address, singleName);
  if (!app) return { success: false, error: `No unique app found matching "${singleName}"` };

  if (app.status === 'stopped') {
    return { success: false, error: `App "${app.name}" is already stopped.` };
  }

  return {
    success: true,
    requiresConfirmation: true,
    confirmationMessage: `Stop app "${app.name}"? This will terminate the deployment and stop billing.`,
    pendingAction: {
      toolName: 'stop_app',
      args: { app_name: app.name, leaseUuid: app.leaseUuid },
    },
  };
}

/**
 * Execute stop_app after user confirmation.
 * Supports bulk stop when args.entries is present (from app_name="all").
 */
export async function executeConfirmedStopApp(
  args: Record<string, unknown>,
  clientManager: CosmosClientManager,
  options: ToolExecutorOptions
): Promise<ToolResult> {
  const { address, appRegistry } = options;
  if (!address) return { success: false, error: 'Wallet not connected' };
  if (!appRegistry) return { success: false, error: 'App registry not available' };

  // ENG-279: stop_app deliberately stays on cosmosTx('billing','close-lease') rather
  // than core.stopApp. core.stopApp drops the tx rawLog (breaking the "lease not active"
  // already-stopped idempotent detection below) and forces waitForConfirmation=true,
  // which would kill the bulk fast-path's fire-and-forget (false) behavior. cosmosTx is
  // itself a core capability, so this still routes through mono.

  // Bulk stop — fire close-lease TXs without waiting for on-chain
  // confirmation (waitForConfirmation=false). This sends all TXs in
  // quick succession (~100ms each for signing + broadcast) instead of
  // waiting ~6s per TX for block inclusion. Registry is updated
  // optimistically; reconcileWithChain corrects any discrepancies later.
  const entries = args.entries as Array<{ app_name: string; leaseUuid: string }> | undefined;
  if (entries && entries.length > 0) {
    const stopped: string[] = [];
    const failed: string[] = [];

    for (const entry of entries) {
      const result = await cosmosTx(clientManager, 'billing', 'close-lease', [entry.leaseUuid], false);
      if (result.code === 0 || result.rawLog?.includes('lease not active')) {
        appRegistry.updateApp(address, entry.leaseUuid, { status: 'stopped' });
        stopped.push(entry.app_name);
      } else {
        failed.push(entry.app_name);
      }
    }

    if (failed.length > 0 && stopped.length === 0) {
      return { success: false, error: `Failed to stop: ${failed.join(', ')}` };
    }

    const parts: string[] = [];
    if (stopped.length > 0) parts.push(`Stopped: ${stopped.join(', ')}.`);
    if (failed.length > 0) parts.push(`Failed to stop: ${failed.join(', ')}.`);

    return {
      success: true,
      data: {
        message: parts.join(' '),
        stopped,
        failed,
        status: 'stopped',
      },
    };
  }

  // Single stop
  const name = args.app_name as string;
  const leaseUuid = args.leaseUuid as string;

  const result = await cosmosTx(clientManager, 'billing', 'close-lease', [leaseUuid], true);

  if (result.code !== 0) {
    // If the lease is already not active on-chain, treat as successfully stopped
    if (result.rawLog?.includes('lease not active')) {
      appRegistry.updateApp(address, leaseUuid, { status: 'stopped' });
      return {
        success: true,
        data: {
          message: `App "${name}" has been stopped (lease was already inactive).`,
          app_name: name,
          status: 'stopped',
        },
      };
    }
    return { success: false, error: result.rawLog ?? 'Failed to stop app' };
  }

  appRegistry.updateApp(address, leaseUuid, { status: 'stopped' });

  return {
    success: true,
    data: {
      message: `App "${name}" has been stopped.`,
      app_name: name,
      status: 'stopped',
    },
  };
}

// ============================================================================
// fund_credits
// ============================================================================

/**
 * Pre-validation for fund_credits. Returns confirmation result or error.
 */
export function executeFundCredits(
  args: Record<string, unknown>,
  options: ToolExecutorOptions
): ToolResult {
  const { address } = options;
  if (!address) return { success: false, error: 'Wallet not connected' };

  const amount = args.amount;
  if (typeof amount !== 'number' || amount <= 0 || !Number.isFinite(amount)) {
    return { success: false, error: 'Amount must be a positive number.' };
  }

  const microAmount = Math.floor(amount * 1_000_000);
  const denomString = `${microAmount}${DENOMS.PWR}`;

  return {
    success: true,
    requiresConfirmation: true,
    confirmationMessage: `Add ${amount} credits to your account?`,
    pendingAction: {
      toolName: 'fund_credits',
      args: { amount, microAmount, denomString, address },
    },
  };
}

/**
 * Execute fund_credits after user confirmation.
 */
export async function executeConfirmedFundCredits(
  args: Record<string, unknown>,
  clientManager: CosmosClientManager
): Promise<ToolResult> {
  const denomString = args.denomString as string;
  const amount = args.amount as number;

  // core.fundCredits wraps cosmosTx('billing','fund-credit',[tenant, amount],true);
  // tenant defaults to the signer (the connected wallet), matching barney's prior
  // `[address, denomString]` where address was always the signer's own address.
  const result = await fundCredits(clientManager, denomString);

  if (result.code !== 0) {
    return { success: false, error: result.rawLog ?? 'Failed to fund credits' };
  }

  return {
    success: true,
    data: {
      message: `Added ${amount} credits to your account.`,
      amount,
      transactionHash: result.transactionHash,
    },
  };
}

// ============================================================================
// cosmos_tx (escape hatch)
// ============================================================================

/** Allowed module+subcommand pairs for the cosmos_tx escape hatch. */
const ALLOWED_TX_COMMANDS: Record<string, Set<string>> = {
  billing: new Set(['create-lease', 'close-lease', 'fund-credit', 'withdraw-credit']),
  bank: new Set(['send']),
  staking: new Set(['delegate', 'redelegate', 'unbond']),
  gov: new Set(['vote', 'submit-proposal']),
};

/**
 * Pre-validation for cosmos_tx. Returns confirmation result or error.
 * Restricted to an allowlist of safe module+subcommand pairs.
 */
export function executeCosmosTransaction(
  args: Record<string, unknown>,
  options: ToolExecutorOptions
): ToolResult {
  const { address } = options;
  if (!address) return { success: false, error: 'Wallet not connected' };

  const module = args.module as string;
  const subcommand = args.subcommand as string;
  if (!module) return { success: false, error: 'module is required' };
  if (!subcommand) return { success: false, error: 'subcommand is required' };

  const allowedSubs = ALLOWED_TX_COMMANDS[module];
  if (!allowedSubs || !allowedSubs.has(subcommand)) {
    const allowed = Object.entries(ALLOWED_TX_COMMANDS)
      .map(([m, subs]) => `${m}: ${[...subs].join(', ')}`)
      .join('; ');
    return { success: false, error: `"${module} ${subcommand}" is not allowed. Allowed transactions: ${allowed}` };
  }

  const parseResult = parseJsonStringArray(args.args);
  if (parseResult.error) {
    return { success: false, error: parseResult.error };
  }

  // Safe: parseResult.error was checked above, so data is always defined here
  const parsedArgs = parseResult.data!;
  const argsSummary = parsedArgs.length > 0 ? ` with args: ${parsedArgs.join(', ')}` : '';
  return {
    success: true,
    requiresConfirmation: true,
    confirmationMessage: `Execute ${module} ${subcommand}${argsSummary}?`,
    pendingAction: {
      toolName: 'cosmos_tx',
      args: { module, subcommand, parsedArgs },
    },
  };
}

/**
 * Execute cosmos_tx after user confirmation.
 */
export async function executeConfirmedCosmosTx(
  args: Record<string, unknown>,
  clientManager: CosmosClientManager
): Promise<ToolResult> {
  const module = args.module as string;
  const subcommand = args.subcommand as string;
  const parsedArgs = (args.parsedArgs as string[]) ?? [];

  const result = await cosmosTx(clientManager, module, subcommand, parsedArgs, true);

  if (result.code !== 0) {
    return { success: false, error: result.rawLog ?? 'Transaction failed' };
  }

  return {
    success: true,
    data: {
      message: `Executed ${module} ${subcommand}.`,
      transactionHash: result.transactionHash,
    },
  };
}

// ============================================================================
// restart_app
// ============================================================================

/**
 * Pre-validation for restart_app. Returns confirmation result or error.
 */
export async function executeRestartApp(
  args: Record<string, unknown>,
  options: ToolExecutorOptions
): Promise<ToolResult> {
  const { address, appRegistry } = options;
  if (!address) return { success: false, error: 'Wallet not connected' };
  if (!appRegistry) return { success: false, error: 'App registry not available' };

  const name = args.app_name as string;
  if (!name) return { success: false, error: 'App name is required' };

  // Multi-app restart: "all" or comma-separated names
  const restartFilter = (a: AppEntry) => a.status === 'running' && !!a.providerUrl;
  const multi = resolveMultiAppNames(name, address, appRegistry, restartFilter, 'restart');
  if (multi.mode === 'error') return { success: false, error: multi.error };

  if (multi.mode === 'multi') {
    const names = multi.apps.map((a) => a.name);
    const entries = multi.apps.map((a) => ({
      app_name: a.name,
      leaseUuid: a.leaseUuid,
      providerUrl: a.providerUrl!,
    }));
    const skippedNote = multi.skipped ? ` (skipped: ${multi.skipped.join(', ')})` : '';
    return {
      success: true,
      requiresConfirmation: true,
      confirmationMessage: `Restart ${multi.apps.length} app${multi.apps.length > 1 ? 's' : ''} (${names.join(', ')})? All apps will be briefly unavailable during restart.${skippedNote}`,
      pendingAction: {
        toolName: 'restart_app',
        args: { app_name: name, entries },
      },
    };
  }

  // Single app — use normalized name from resolveMultiAppNames
  const singleName = multi.name;
  const app = appRegistry.findApp(address, singleName);
  if (!app) return { success: false, error: `No unique app found matching "${singleName}"` };

  if (app.status !== 'running') {
    return { success: false, error: `App "${app.name}" is not running (status: ${app.status}). Only running apps can be restarted.` };
  }

  if (!app.providerUrl) {
    return { success: false, error: `App "${app.name}" has no provider URL.` };
  }

  return {
    success: true,
    requiresConfirmation: true,
    confirmationMessage: `Restart app "${app.name}"? The app will be briefly unavailable during restart.`,
    pendingAction: {
      toolName: 'restart_app',
      args: {
        app_name: app.name,
        leaseUuid: app.leaseUuid,
        providerUrl: app.providerUrl,
      },
    },
  };
}

/**
 * Execute restart_app after user confirmation.
 * Supports batch restart when args.entries is present (from app_name="all" or comma-separated).
 */
export async function executeConfirmedRestartApp(
  args: Record<string, unknown>,
  clientManager: CosmosClientManager,
  options: ToolExecutorOptions
): Promise<ToolResult> {
  const { address, appRegistry, signArbitrary, onProgress, signal } = options;
  if (!address) return { success: false, error: 'Wallet not connected' };
  if (!appRegistry) return { success: false, error: 'App registry not available' };
  if (!signArbitrary) return { success: false, error: 'Wallet does not support message signing' };

  // Batch restart
  const entries = args.entries as Array<{ app_name: string; leaseUuid: string; providerUrl: string }> | undefined;
  if (entries && entries.length > 0) {
    return executeConfirmedBatchRestart(entries, clientManager, address, appRegistry, signArbitrary, onProgress, signal);
  }

  // Single restart
  const name = args.app_name as string;
  const leaseUuid = args.leaseUuid as string;
  const providerUrl = args.providerUrl as string;

  onProgress?.({ phase: 'restarting', detail: 'Restarting app...', operation: 'restart' });

  // fred.restartApp issues the restart (resolving the provider from chain + minting
  // the ADR-036 token via getAuthToken). It does NOT poll — barney keeps its own
  // waitForLeaseReady poll below. refreshAuthToken is reused for the poll's token refresh.
  const { getAuthToken } = makeFredAuthTokens(signArbitrary);
  const refreshAuthToken = () => getAuthToken(address, leaseUuid);

  try {
    const queryClient = await getFredQueryClient(clientManager);
    await restartApp(queryClient, address, leaseUuid, getAuthToken, providerFetch);
  } catch (error) {
    logError('compositeTransactions.executeConfirmedRestartApp', error);
    // 409 = lease is not in the right state for restart; don't mark as failed
    // because the app may still be running — only the restart was rejected.
    if (error instanceof ProviderApiError && error.status === 409) {
      onProgress?.({ phase: 'failed', detail: 'App is not in a restartable state', operation: 'restart' });
      return { success: false, error: `Cannot restart "${name}": app is not in a restartable state.` };
    }
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    onProgress?.({ phase: 'failed', detail: `Restart failed: ${errorMsg}`, operation: 'restart' });
    appRegistry.updateApp(address, leaseUuid, { status: 'failed' });
    return { success: false, error: `Restart failed: ${errorMsg}` };
  }

  // Poll for readiness
  onProgress?.({ phase: 'provisioning', detail: 'Waiting for app to come back up...', operation: 'restart' });

  try {
    const authToken = await refreshAuthToken();
    const fredStatus = await waitForLeaseReady(providerUrl, leaseUuid, authToken, {
      maxAttempts: Math.ceil(AI_DEPLOY_PROVISION_TIMEOUT_MS / FRED_POLL_INTERVAL_MS),
      intervalMs: FRED_POLL_INTERVAL_MS,
      abortSignal: signal,
      onProgress: (status) => {
        onProgress?.({
          phase: 'provisioning',
          detail: status.phase || 'Waiting for restart...',
          fredStatus: status,
          operation: 'restart',
        });
      },
      getAuthToken: refreshAuthToken,
    });

    if (fredStatus.state === LeaseState.LEASE_STATE_ACTIVE && fredStatus.provision_status !== 'failed') {
      const { url: connectionUrl, connection } = await resolveAppUrl(
        providerUrl, leaseUuid, fredStatus, address, signArbitrary,
        'compositeTransactions.executeConfirmedRestartApp'
      );

      appRegistry.updateApp(address, leaseUuid, {
        status: 'running',
        url: connectionUrl,
        connection: connection ? JSON.parse(JSON.stringify(connection)) : undefined,
      });
      onProgress?.({ phase: 'ready', operation: 'restart' });

      return {
        success: true,
        data: {
          message: `App "${name}" has been restarted.`,
          name,
          url: connectionUrl,
          status: 'running',
        },
      };
    }

    // Non-active terminal state or failed provision
    appRegistry.updateApp(address, leaseUuid, { status: 'failed' });
    onProgress?.({ phase: 'failed', detail: fredStatus.last_error || 'Restart failed', operation: 'restart' });
    return { success: false, error: `Restart failed: ${fredStatus.last_error || 'App did not come back up'}` };
  } catch (error) {
    logError('compositeTransactions.executeConfirmedRestartApp.polling', error);
    onProgress?.({ phase: 'failed', detail: 'Restart polling failed', operation: 'restart' });
    return { success: false, error: `Restart may still be in progress. Use app_status("${name}") to check.` };
  }
}

/**
 * Batch restart: restart multiple apps concurrently with bounded concurrency.
 * Uses a signing mutex to serialize signArbitrary calls (shared wallet sequence numbers).
 */
async function executeConfirmedBatchRestart(
  entries: Array<{ app_name: string; leaseUuid: string; providerUrl: string }>,
  clientManager: CosmosClientManager,
  address: string,
  appRegistry: ToolExecutorOptions['appRegistry'] & object,
  signArbitrary: (address: string, data: string) => Promise<{ pub_key: { type: string; value: string }; signature: string }>,
  onProgress: ToolExecutorOptions['onProgress'],
  signal: AbortSignal | undefined
): Promise<ToolResult> {
  const { signArbitraryWithMutex } = createSigningMutex(signArbitrary);
  // Mint provider-auth tokens through the mutex so concurrent restarts serialize
  // their signing (fred.restartApp calls getAuthToken internally).
  const { getAuthToken } = makeFredAuthTokens(signArbitraryWithMutex);
  const queryClient = await getFredQueryClient(clientManager);

  const batchEntries = entries.map((e) => ({ ...e, name: e.app_name }));

  const { succeeded, failed, batchProgress } = await runBatchWithConcurrency({
    entries: batchEntries,
    intermediatePhases: ['provisioning', 'restarting'],
    initialPhase: 'restarting',
    operation: 'restart',
    signal,
    onProgress,
    executeOne: async (entry, _i, updateProgress) => {
      const name = entry.app_name;

      updateProgress('restarting', 'Restarting...');

      const refreshAuthToken = () => getAuthToken(address, entry.leaseUuid);

      // Issue restart command (fred.restartApp; does not poll — barney polls below)
      try {
        await restartApp(queryClient, address, entry.leaseUuid, getAuthToken, providerFetch);
      } catch (error) {
        logError('executeConfirmedBatchRestart.restart', error);
        if (error instanceof ProviderApiError && error.status === 409) {
          updateProgress('failed', 'Not in a restartable state');
          return null;
        }
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        updateProgress('failed', `Restart failed: ${errorMsg}`);
        appRegistry.updateApp(address, entry.leaseUuid, { status: 'failed' });
        return null;
      }

      // Poll for readiness
      updateProgress('provisioning', 'Waiting for app to come back up...');

      try {
        const authToken = await refreshAuthToken();
        const fredStatus = await waitForLeaseReady(entry.providerUrl, entry.leaseUuid, authToken, {
          maxAttempts: Math.ceil(AI_DEPLOY_PROVISION_TIMEOUT_MS / FRED_POLL_INTERVAL_MS),
          intervalMs: FRED_POLL_INTERVAL_MS,
          abortSignal: signal,
          onProgress: (status) => {
            updateProgress('provisioning', status.phase || 'Restarting...');
          },
          getAuthToken: refreshAuthToken,
        });

        if (fredStatus.state === LeaseState.LEASE_STATE_ACTIVE && fredStatus.provision_status !== 'failed') {
          const { url: connectionUrl, connection } = await resolveAppUrl(
            entry.providerUrl, entry.leaseUuid, fredStatus, address, signArbitraryWithMutex,
            'executeConfirmedBatchRestart'
          );

          appRegistry.updateApp(address, entry.leaseUuid, {
            status: 'running',
            url: connectionUrl,
            connection: connection ? JSON.parse(JSON.stringify(connection)) : undefined,
          });
          updateProgress('ready', 'App is live!');
          return { name, url: connectionUrl };
        }

        appRegistry.updateApp(address, entry.leaseUuid, { status: 'failed' });
        updateProgress('failed', fredStatus.last_error || 'Restart failed');
        return null;
      } catch (error) {
        logError('executeConfirmedBatchRestart.poll', error);
        appRegistry.updateApp(address, entry.leaseUuid, { status: 'failed' });
        updateProgress('failed', `Restart polling failed for "${name}". Use app_status("${name}") to check.`);
        return null;
      }
    },
  });

  return summarizeBatchResult({
    succeeded,
    failed,
    dataKey: 'restarted',
    verb: 'Restarted',
    failedNoun: 'restarts',
    batchProgress,
    operation: 'restart',
    onProgress,
  });
}

// ============================================================================
// update_app
// ============================================================================

/**
 * Pre-validation for update_app. Returns confirmation result or error.
 */
export async function executeUpdateApp(
  args: Record<string, unknown>,
  options: ToolExecutorOptions,
  payload?: PayloadAttachment
): Promise<ToolResult> {
  const { address, appRegistry } = options;
  if (!address) return { success: false, error: 'Wallet not connected' };
  if (!appRegistry) return { success: false, error: 'App registry not available' };

  // Stack-based update: build stack manifest from services param
  if (!payload && typeof args.services === 'string' && args.services) {
    if (args.image) {
      return { success: false, error: '"image" and "services" are mutually exclusive.' };
    }

    const parsed = parseAndValidateStackServices(
      args.services as string, false, 'compositeTransactions.executeUpdateApp.parseServices'
    );
    if ('error' in parsed) return { success: false, error: parsed.error };

    // Pre-generate a shared password for all auto-generated env vars in the stack.
    const sharedPassword = generatePassword();
    for (const svc of Object.values(parsed.services)) {
      if (svc.env) {
        for (const key of Object.keys(svc.env)) {
          if (svc.env[key] === '') svc.env[key] = sharedPassword;
          else if (svc.env[key].endsWith('/')) svc.env[key] += sharedPassword;
        }
      }
    }

    let manifestResult;
    try {
      manifestResult = await buildStackManifest({ services: parsed.services });
    } catch (error) {
      logError('compositeTransactions.executeUpdateApp.buildStackManifest', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to build stack manifest' };
    }

    payload = manifestResult.payload;
    args._generatedManifest = manifestResult.json;
    args._isStack = true;
    args._serviceNames = parsed.serviceNames;
  }

  // Image-based update: build manifest from args when no file is attached
  if (!payload && args.image) {
    let env: Record<string, string> | undefined;
    if (typeof args.env === 'string' && args.env) {
      try {
        env = JSON.parse(args.env);
        if (typeof env !== 'object' || env === null || Array.isArray(env)) {
          return { success: false, error: 'env must be a JSON object (e.g. \'{"KEY":"value"}\').' };
        }
      } catch (error) {
        logError('compositeTransactions.executeUpdateApp.parseEnv', error);
        return { success: false, error: 'Invalid env JSON string. Expected format: \'{"KEY":"value"}\'.' };
      }
    }

    if (env) {
      for (const [k, v] of Object.entries(env)) {
        if (typeof v !== 'string') {
          return { success: false, error: `Env var "${k}" must have a string value, got ${typeof v}.` };
        }
      }
      const envError = validateEnvNames(env);
      if (envError) return { success: false, error: envError };
    }

    // Parse command/args JSON arrays
    let command: string[] | undefined;
    if (typeof args.command === 'string' && args.command) {
      try {
        command = JSON.parse(args.command);
        if (!Array.isArray(command) || !command.every((s) => typeof s === 'string')) {
          return { success: false, error: 'command must be a JSON array of strings (e.g. \'["sh", "-c"]\').' };
        }
      } catch {
        return { success: false, error: 'Invalid command JSON. Expected a JSON array of strings (e.g. \'["sh", "-c"]\').' };
      }
    }

    let cmdArgs: string[] | undefined;
    if (typeof args.args === 'string' && args.args) {
      try {
        cmdArgs = JSON.parse(args.args);
        if (!Array.isArray(cmdArgs) || !cmdArgs.every((s) => typeof s === 'string')) {
          return { success: false, error: 'args must be a JSON array of strings (e.g. \'["echo hello"]\').' };
        }
      } catch {
        return { success: false, error: 'Invalid args JSON. Expected a JSON array of strings (e.g. \'["echo hello"]\').' };
      }
    }

    // Parse health_check from JSON string
    let healthCheck: HealthCheckConfig | undefined;
    if (typeof args.health_check === 'string' && args.health_check) {
      try {
        healthCheck = JSON.parse(args.health_check);
        if (typeof healthCheck !== 'object' || healthCheck === null || Array.isArray(healthCheck)) {
          return { success: false, error: 'health_check must be a JSON object.' };
        }
        if (!Array.isArray(healthCheck.test) || healthCheck.test.length < 2 || !healthCheck.test.every(el => typeof el === 'string')) {
          return { success: false, error: 'health_check.test must be an array of strings with at least 2 elements (e.g. ["CMD-SHELL", "curl -f http://localhost"]).' };
        }
      } catch {
        return { success: false, error: 'Invalid health_check JSON.' };
      }
    }

    // Parse labels from JSON string
    let labels: Record<string, string> | undefined;
    if (typeof args.labels === 'string' && args.labels) {
      try {
        labels = JSON.parse(args.labels);
        if (typeof labels !== 'object' || labels === null || Array.isArray(labels)) {
          return { success: false, error: 'labels must be a JSON object.' };
        }
        for (const [k, v] of Object.entries(labels)) {
          if (typeof v !== 'string') {
            return { success: false, error: `Label "${k}" must have a string value, got ${typeof v}.` };
          }
        }
      } catch {
        return { success: false, error: 'Invalid labels JSON.' };
      }
    }

    // Known image safety net: merge defaults for port, user, tmpfs, command, args.
    // Env defaults are skipped for updates — the old manifest merge handles env carry-forward.
    const knownConfig = findKnownImage(args.image as string);
    if (knownConfig) {
      if (!args.port && knownConfig.port) args.port = knownConfig.port;
      if (!args.user && knownConfig.user) args.user = knownConfig.user;
      if (!args.tmpfs && knownConfig.tmpfs) args.tmpfs = knownConfig.tmpfs;
      if (!command && knownConfig.command) command = [...knownConfig.command];
      if (!cmdArgs && knownConfig.args) cmdArgs = [...knownConfig.args];
    }

    // Pre-generate env passwords so the same value can be shared with args
    if (env) {
      for (const key of Object.keys(env)) {
        if (env[key] === '') env[key] = generatePassword();
        else if (env[key].endsWith('/')) env[key] += generatePassword();
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
    if (portResult.error) return { success: false, error: portResult.error };
    const userResult = coerceStringArg(args.user, 'user');
    if (userResult.error) return { success: false, error: userResult.error };
    const tmpfsResult = coerceTmpfsArg(args.tmpfs);
    if (tmpfsResult.error) return { success: false, error: tmpfsResult.error };

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
      logError('compositeTransactions.executeUpdateApp.buildManifest', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to build manifest' };
    }

    payload = manifestResult.payload;
    args._generatedManifest = manifestResult.json;
  }

  if (!payload) {
    return { success: false, error: 'No file attached and no image specified. Attach a manifest file or specify a Docker image (e.g. update_app(app_name="my-app", image="redis:8")).' };
  }

  // Make file-attached JSON manifests editable in the confirmation card
  if (!args._generatedManifest && payload.filename?.endsWith('.json')) {
    try {
      const json = new TextDecoder().decode(payload.bytes);
      JSON.parse(json); // validate it's valid JSON
      args._generatedManifest = json;
    } catch {
      // Not valid JSON — fall through to read-only display
    }
  }

  const name = args.app_name as string;
  if (!name) return { success: false, error: 'App name is required' };

  const app = appRegistry.findApp(address, name);
  if (!app) return { success: false, error: `No unique app found matching "${name}"` };

  if (app.status !== 'running' && app.status !== 'failed') {
    return { success: false, error: `App "${app.name}" cannot be updated (status: ${app.status}). Only running or failed apps can be updated.` };
  }

  if (!app.providerUrl) {
    return { success: false, error: `App "${app.name}" has no provider URL.` };
  }

  // Merge old manifest values (env, ports, user, tmpfs) as defaults
  // Stack updates use full manifest replacement — no partial merge
  if (app.manifest && !args._isStack) {
    try {
      const currentJson = typeof args._generatedManifest === 'string'
        ? args._generatedManifest
        : new TextDecoder().decode(payload.bytes);

      const currentManifest = JSON.parse(currentJson);
      const merged = mergeManifest(currentManifest, app.manifest);
      const mergedJson = JSON.stringify(merged, null, 2);

      if (mergedJson !== currentJson) {
        const bytes = new TextEncoder().encode(mergedJson);
        const hash = toHex(await sha256(mergedJson));
        payload = { bytes, filename: payload.filename, size: bytes.length, hash };
        args._generatedManifest = mergedJson;
      }
    } catch (error) {
      // Merge is best-effort — proceed with original manifest if it fails
      // (e.g., YAML payloads or invalid old manifest)
      logError('compositeTransactions.executeUpdateApp.mergeManifest', error);
    }
  }

  let stackServiceCount = 0;
  if (args._isStack) {
    const serviceNamesResult = validateInternalServiceNames(args._serviceNames, 'update_app');
    if (serviceNamesResult.error || !serviceNamesResult.serviceNames || serviceNamesResult.serviceNames.length === 0) {
      return {
        success: false,
        error: serviceNamesResult.error ?? 'Invalid stack service metadata. Please run update_app again with a valid services definition.',
      };
    }
    stackServiceCount = serviceNamesResult.serviceNames.length;
  }

  return {
    success: true,
    requiresConfirmation: true,
    confirmationMessage: args._isStack
      ? `Update stack "${app.name}" with ${stackServiceCount} services (new manifest)?`
      : `Update app "${app.name}" with ${args._generatedManifest ? `image ${args.image}` : 'new manifest'}?`,
    pendingAction: {
      toolName: 'update_app',
      args: {
        app_name: app.name,
        leaseUuid: app.leaseUuid,
        providerUrl: app.providerUrl,
        ...(args._generatedManifest ? { _generatedManifest: args._generatedManifest } : {}),
        ...(args._isStack ? { _isStack: true } : {}),
      },
    },
  };
}

/**
 * Execute update_app after user confirmation.
 */
export async function executeConfirmedUpdateApp(
  args: Record<string, unknown>,
  clientManager: CosmosClientManager,
  options: ToolExecutorOptions,
  payload?: PayloadAttachment
): Promise<ToolResult> {
  const { address, appRegistry, signArbitrary, onProgress, signal } = options;
  if (!address) return { success: false, error: 'Wallet not connected' };
  if (!appRegistry) return { success: false, error: 'App registry not available' };
  if (!signArbitrary) return { success: false, error: 'Wallet does not support message signing' };

  // Reconstruct payload from stored manifest JSON (image-based update)
  if (!payload && typeof args._generatedManifest === 'string') {
    payload = await buildPayloadFromManifest(args._generatedManifest);
  }

  if (!payload) return { success: false, error: 'Payload missing' };

  const name = args.app_name as string;
  const leaseUuid = args.leaseUuid as string;
  const providerUrl = args.providerUrl as string;

  // fred.updateApp uploads the manifest as a STRING (barney already built/merged it).
  const manifestJson = typeof args._generatedManifest === 'string'
    ? args._generatedManifest
    : new TextDecoder().decode(payload.bytes);

  onProgress?.({ phase: 'updating', detail: 'Updating app with new manifest...', operation: 'update' });

  // fred.updateApp does the provider upload but does NOT poll — barney keeps its
  // waitForLeaseReady poll + rollback detection below. refreshAuthToken feeds the poll.
  const { getAuthToken } = makeFredAuthTokens(signArbitrary);
  const refreshAuthToken = () => getAuthToken(address, leaseUuid);

  try {
    const queryClient = await getFredQueryClient(clientManager);
    await updateApp(queryClient, address, leaseUuid, getAuthToken, manifestJson, undefined, providerFetch);
  } catch (error) {
    logError('compositeTransactions.executeConfirmedUpdateApp', error);
    // 409 = lease is not in the right state for update; don't mark as failed
    // because the app may still be running — only the update was rejected.
    if (error instanceof ProviderApiError && error.status === 409) {
      onProgress?.({ phase: 'failed', detail: 'App is not in an updatable state', operation: 'update' });
      return { success: false, error: `Cannot update "${name}": app is not in an updatable state.` };
    }
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    onProgress?.({ phase: 'failed', detail: `Update failed: ${errorMsg}`, operation: 'update' });
    appRegistry.updateApp(address, leaseUuid, { status: 'failed' });
    return { success: false, error: `Update failed: ${errorMsg}` };
  }

  // Snapshot existing app state before overwriting — needed for rollback detection.
  const existingApp = appRegistry.getAppByLease(address, leaseUuid);
  const previousUrl = existingApp?.url;
  const previousManifest = existingApp?.manifest;

  // Update registry with new manifest content (secrets stripped)
  appRegistry.updateApp(address, leaseUuid, { manifest: sanitizeManifestForStorage(manifestJson) });

  // Poll for readiness
  onProgress?.({ phase: 'provisioning', detail: 'Waiting for app to come back up...', operation: 'update' });

  try {
    const authToken = await refreshAuthToken();
    const fredStatus = await waitForLeaseReady(providerUrl, leaseUuid, authToken, {
      maxAttempts: Math.ceil(AI_DEPLOY_PROVISION_TIMEOUT_MS / FRED_POLL_INTERVAL_MS),
      intervalMs: FRED_POLL_INTERVAL_MS,
      abortSignal: signal,
      onProgress: (status) => {
        onProgress?.({
          phase: 'provisioning',
          detail: status.phase || 'Waiting for update...',
          fredStatus: status,
          operation: 'update',
        });
      },
      getAuthToken: refreshAuthToken,
    });

    if (fredStatus.state === LeaseState.LEASE_STATE_ACTIVE && fredStatus.provision_status !== 'failed') {
      // Rollback detection: check /provision for last_error.
      // Fred settles the rollback before emitting the terminal WS event or
      // transitioning provision out of a transient state, so by the time we
      // reach here the provision endpoint is authoritative:
      //   - Rollback OK:     provision.status="ready",  provision.last_error="<why>"
      //   - Rollback failed: provision.status="failed",  provision.last_error="<why>"
      //   - Update OK:       provision.status="ready",  provision.last_error=""
      try {
        const provisionToken = await refreshAuthToken();
        const provision = await getLeaseProvision(providerUrl, leaseUuid, provisionToken);
        if (provision.last_error) {
          const rollbackOk = provision.status === 'ready';
          appRegistry.updateApp(address, leaseUuid, {
            status: rollbackOk ? 'running' : 'failed',
            ...(previousManifest ? { manifest: previousManifest } : {}),
          });
          onProgress?.({
            phase: 'failed',
            detail: rollbackOk
              ? 'Update failed, previous version restored.'
              : 'Update failed and rollback failed.',
            operation: 'update',
          });
          return {
            success: false,
            error: rollbackOk
              ? `Update failed, previous version restored. Last error: ${provision.last_error}`
              : `Update failed and rollback failed. Last error: ${normalizeErrorPunctuation(provision.last_error)}. Use app_status("${name}") to check.`,
          };
        }
      } catch (error) {
        // Provision check is best-effort — if it fails, proceed with the success path.
        logError('compositeTransactions.executeConfirmedUpdateApp.provisionCheck', error);
      }

      const { url: connectionUrl, connection } = await resolveAppUrl(
        providerUrl, leaseUuid, fredStatus, address, signArbitrary,
        'compositeTransactions.executeConfirmedUpdateApp'
      );

      // If resolved URL lost port info, fall back to the previous URL
      const hasPort = connectionUrl != null && /:\d+/.test(connectionUrl.replace(/^https?:\/\//, ''));
      const finalUrl = (hasPort ? connectionUrl : previousUrl) ?? connectionUrl;

      appRegistry.updateApp(address, leaseUuid, {
        status: 'running',
        url: finalUrl,
        connection: connection ? JSON.parse(JSON.stringify(connection)) : undefined,
      });
      onProgress?.({ phase: 'ready', operation: 'update' });

      return {
        success: true,
        data: {
          message: `App "${name}" has been updated.`,
          name,
          url: finalUrl,
          status: 'running',
        },
      };
    }

    // Non-active terminal state or failed provision
    appRegistry.updateApp(address, leaseUuid, { status: 'failed' });
    onProgress?.({ phase: 'failed', detail: fredStatus.last_error || 'Update failed', operation: 'update' });
    return { success: false, error: `Update failed: ${fredStatus.last_error || 'App did not come back up'}` };
  } catch (error) {
    logError('compositeTransactions.executeConfirmedUpdateApp.polling', error);
    onProgress?.({ phase: 'failed', detail: 'Update polling failed', operation: 'update' });
    return { success: false, error: `Update may still be in progress. Use app_status("${name}") to check.` };
  }
}

// ============================================================================
// set_custom_domain
// ============================================================================

/**
 * Pre-validation for set_custom_domain. Returns confirmation result or error.
 *
 * **Single-domain-per-LeaseItem assumption.** The chain currently enforces a
 * single `custom_domain` string per `LeaseItem`, and the empty string is the
 * sentinel for "clear" (see `MsgSetItemCustomDomain` in proto). This function,
 * the `CustomDomainCardData` shape, the AI tool schema, the success-message
 * wording, and the `ConfirmationCard` clear/attach branching all bake that
 * cardinality in. If the chain ever moves to `customDomains: string[]` (SAN
 * certs, multiple aliases per service), the entry points to revisit are:
 *   - this function (`executeSetCustomDomain`) and `executeConfirmedSetCustomDomain`
 *   - `executeDeployApp` and `executeConfirmedDeployApp` (the `customDomain` /
 *     `customDomainServiceName` pre-attach path added in Pass B)
 *   - the `set_custom_domain` and `deploy_app` schemas in `ai/tools.ts`
 *   - the `MessageCard` discriminated union and `CustomDomainCardData`
 *   - the chat success messages in `executeConfirmedSetCustomDomain` and
 *     `executeConfirmedDeployApp`
 *   - the `ConfirmationCard` `CustomDomainBranch` and `deployWithCustomDomain`
 *     sections (clear/attach branching, DNS table)
 */
export async function executeSetCustomDomain(
  args: Record<string, unknown>,
  options: ToolExecutorOptions,
): Promise<ToolResult> {
  const { address, appRegistry } = options;
  if (!address) return { success: false, error: 'Wallet not connected' };
  if (!appRegistry) return { success: false, error: 'App registry not available' };

  const appName = String(args.app_name ?? '').trim();
  if (typeof args.custom_domain !== 'string') {
    return { success: false, error: 'custom_domain must be a string (use "" to clear).' };
  }
  const customDomain = normalizeFqdn(args.custom_domain);
  const explicitServiceName = typeof args.service_name === 'string' ? args.service_name.trim() : '';

  if (!appName) return { success: false, error: 'app_name is required.' };

  const app = appRegistry.findApp(address, appName);
  if (!app) return { success: false, error: `No app found matching "${appName}".` };

  // Validate format/apex/reserved when not clearing
  let warning: string | undefined;
  if (customDomain !== '') {
    const validation = await validateAll(customDomain);
    if (validation.error) return { success: false, error: validation.error };
    warning = validation.warning;
  }

  // Resolve service_name from chain LeaseItems
  let leaseItems: Awaited<ReturnType<typeof getLeaseItemsForLease>>;
  try {
    leaseItems = await getLeaseItemsForLease(app.leaseUuid);
  } catch (err) {
    logError('compositeTransactions.executeSetCustomDomain.getLeaseItems', err);
    return { success: false, error: 'Failed to read lease items from chain. Try again.' };
  }

  if (leaseItems.length === 0) {
    return { success: false, error: `No lease items found for "${appName}". The lease may have been closed.` };
  }

  let serviceName = '';
  const namedItems = leaseItems.filter(i => i.serviceName !== '');
  const unnamedItems = leaseItems.filter(i => i.serviceName === '');

  if (leaseItems.length === 1 && unnamedItems.length === 1) {
    // Legacy single-item lease: serviceName must be "" on chain.
    if (explicitServiceName !== '') {
      return {
        success: false,
        error: `"${appName}" is a single-service app — drop the service_name argument.`,
      };
    }
    serviceName = '';
  } else if (unnamedItems.length > 0 && namedItems.length === 0) {
    // Multi-item legacy lease — chain rejects these for custom_domain.
    return {
      success: false,
      error: `"${appName}" predates per-service domains and has multiple items without service names. Re-deploy with explicit service names to use custom domains.`,
    };
  } else {
    // Modern lease(s) with per-service names. Auto-select when there's only one
    // (no ambiguity); only require service_name for true multi-service stacks.
    if (!explicitServiceName) {
      if (namedItems.length === 1) {
        serviceName = namedItems[0].serviceName;
      } else {
        const available = namedItems.map(i => i.serviceName).join(', ');
        return {
          success: false,
          error: `"${appName}" is a multi-service stack — pass service_name. Available services: ${available}.`,
        };
      }
    } else {
      const match = namedItems.find(i => i.serviceName === explicitServiceName);
      if (!match) {
        const available = namedItems.map(i => i.serviceName).join(', ');
        return {
          success: false,
          error: `Service "${explicitServiceName}" not found in "${appName}". Available: ${available}.`,
        };
      }
      serviceName = explicitServiceName;
    }
  }

  // Find current domain on the matched item (for change-detection)
  const currentDomain = getDomainForService(leaseItems, serviceName);

  if (customDomain === currentDomain) {
    if (customDomain === '') {
      return { success: false, error: `"${appName}" has no custom domain to clear.` };
    }
    return { success: false, error: `"${appName}" already has "${customDomain}" attached.` };
  }

  // Uniqueness pre-check (not authoritative — chain still verifies on TX).
  // Two reject cases:
  //  1. The domain is on a *different* lease entirely.
  //  2. The domain is on this same lease but a *different* service. The chain
  //     also rejects this; we surface a friendlier message that names the
  //     service currently holding it.
  if (customDomain !== '') {
    try {
      const existing = await queryLeaseByCustomDomain(customDomain);
      if (existing) {
        if (existing.leaseUuid !== app.leaseUuid) {
          return {
            success: false,
            error: `"${customDomain}" is already attached to another lease. Pick a different domain.`,
          };
        }
        if (existing.serviceName !== serviceName) {
          const heldBy = existing.serviceName === ''
            ? 'this app'
            : `service "${existing.serviceName}" on this app`;
          return {
            success: false,
            error: `"${customDomain}" is already attached to ${heldBy}. Clear it from there first, or pick a different domain.`,
          };
        }
      }
    } catch (err) {
      logError('compositeTransactions.executeSetCustomDomain.queryLeaseByCustomDomain', err);
      // Don't block — chain will reject if duplicate.
    }
  }

  const expectedCnameTarget = resolveExpectedCnameTarget(app.connection, serviceName);

  let confirmationMessage: string;
  if (customDomain === '') {
    confirmationMessage = `Clear custom domain "${currentDomain}" from "${appName}"?`;
  } else if (currentDomain === '') {
    confirmationMessage = `Attach "${customDomain}" to "${appName}"?`;
  } else {
    confirmationMessage = `Change "${appName}" custom domain from "${currentDomain}" to "${customDomain}"?`;
  }

  return {
    success: true,
    requiresConfirmation: true,
    confirmationMessage,
    pendingAction: {
      toolName: 'set_custom_domain',
      args: {
        app_name: app.name,
        leaseUuid: app.leaseUuid,
        serviceName,
        customDomain,
        currentDomain,
        expectedCnameTarget,
        warning,
        address,
      },
    },
  };
}

/**
 * Execute set_custom_domain after user confirmation.
 *
 * Delegates the broadcast to mono's `core.setItemCustomDomain` helper (which
 * routes through `cosmosTx` + `set-item-custom-domain` CLI form) so validation,
 * canonicalization, and the result shape stay consistent with the MCP surface
 * and direct-CLI users.
 */
export async function executeConfirmedSetCustomDomain(
  args: Record<string, unknown>,
  clientManager: CosmosClientManager,
  options: ToolExecutorOptions,
): Promise<ToolResult> {
  const { address, appRegistry } = options;
  if (!address) return { success: false, error: 'Wallet not connected.' };

  const appName = args.app_name as string;
  const leaseUuid = args.leaseUuid as string;
  const serviceName = typeof args.serviceName === 'string' ? args.serviceName : '';
  if (typeof args.customDomain !== 'string') {
    return { success: false, error: 'customDomain must be a string (use "" to clear).' };
  }
  const customDomain = args.customDomain;
  const expectedCnameTarget = typeof args.expectedCnameTarget === 'string' ? args.expectedCnameTarget : undefined;
  const isApexWarning = typeof args.warning === 'string' && args.warning.length > 0;
  const clearing = customDomain === '';

  let result: Awaited<ReturnType<typeof monoSetItemCustomDomain>>;
  try {
    result = await monoSetItemCustomDomain(
      clientManager,
      leaseUuid,
      clearing ? '' : customDomain,
      {
        ...(serviceName !== '' ? { serviceName } : {}),
        ...(clearing ? { clear: true } : {}),
      },
    );
  } catch (err) {
    logError('compositeTransactions.executeConfirmedSetCustomDomain', err);
    return { success: false, error: err instanceof Error ? err.message : 'Failed to set custom domain.' };
  }

  if (result.code !== 0) {
    return { success: false, error: `Transaction failed with code ${result.code}.` };
  }

  // Refresh the AppEntry's customDomains cache so the polling driver can pick
  // up the new state without waiting for the next `app_status` call. Mirrors
  // the cache write in executeConfirmedDeployApp. Merge against the existing
  // cache: in a multi-service stack, attaching a domain to one service must
  // not clobber a domain previously attached to a different service.
  if (appRegistry) {
    const app = appRegistry.getAppByLease(address, leaseUuid);
    const prior = app?.customDomains ?? [];
    const others = prior.filter((d) => d.serviceName !== serviceName);
    const customDomains = clearing
      ? others
      : [...others, { serviceName, customDomain }];
    appRegistry.updateApp(address, leaseUuid, { customDomains });
  }

  if (clearing) {
    return {
      success: true,
      data: {
        message: `Custom domain cleared for "${appName}".`,
        app_name: appName,
        custom_domain: null,
        transactionHash: result.transactionHash,
      },
    };
  }

  const recordKind = isApexWarning
    ? `an ${apexRecordKindLabel(true)} record (apex domains cannot use CNAME)`
    : `a ${apexRecordKindLabel(false)}`;
  const target = expectedCnameTarget ?? '<provider FQDN>';

  return {
    success: true,
    data: {
      message: `Custom domain "${customDomain}" attached to "${appName}". Add ${recordKind} at your registrar pointing at ${target}.`,
      app_name: appName,
      custom_domain: customDomain,
      service_name: serviceName,
      expected_cname_target: expectedCnameTarget,
      is_apex: isApexWarning,
      transactionHash: result.transactionHash,
    },
    displayCard: {
      type: 'custom_domain',
      data: {
        appName,
        fqdn: customDomain,
        leaseUuid,
        serviceName,
        expectedCnameTarget,
        expectedAddress: address,
      },
    },
  };
}

import { AI_DEPLOY_LOG_PREVIEW_CHARS } from '../../config/constants';
import { sanitizeForDisplay } from '../../utils/sanitizeText';
import { allocateDiagnosticBudgets } from './diagnosticBudget';

/** Internal presentation data; never duplicate these excerpts in tool results. */
export interface DeployFailureDiagnostic {
  lead: string;
  appName: string;
  failure?: string;
  failCount?: number;
  nextStep?: string;
  logs: Array<{ service: string; text: string }>;
  omittedServices?: number;
}

/** Scan trailing noise once from the end, then normalize only a bounded tail.
 * Long whitespace/control suffixes cannot hide the last useful log line. */
export function logPreviewTail(raw: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  let end = raw.length;
  while (end > 0) {
    const last = raw.charCodeAt(end - 1);
    // Fast path for ASCII whitespace, C0 and C1 controls. The Unicode test
    // below sees one code point only, so it cannot backtrack over a log body.
    if (last <= 0x20 || (last >= 0x7f && last <= 0x9f)) { end -= 1; continue; }
    if (last < 0x7f) break;
    let start = end - 1;
    if (last >= 0xdc00 && last <= 0xdfff && start > 0) {
      const prior = raw.charCodeAt(start - 1);
      if (prior >= 0xd800 && prior <= 0xdbff) start -= 1;
    }
    if (!/^[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]$/u.test(raw.slice(start, end))) break;
    end = start;
  }
  if (end === 0) return '';
  const start = Math.max(0, end - 2 * maxChars);
  const bounded = raw.slice(start, end);
  const aligned = start > 0 ? bounded.replace(/^[\uDC00-\uDFFF]/u, '') : bounded;
  const clean = aligned.normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (point) => point === '\n' ? '\n' : ' ')
    .replace(/[^\S\n]+/g, ' ').trim();
  const window = clean.slice(-2 * maxChars).replace(/^[\uDC00-\uDFFF]/u, '');
  const points = Array.from(window);
  const shortened = start > 0 || window.length < clean.length || points.length > maxChars;
  const retained = shortened ? maxChars - 1 : maxChars;
  const tail = retained > 0 ? points.slice(-retained).join('').trim() : '';
  return tail ? `${shortened ? '…' : ''}${tail}` : '';
}

/** Keep bounded independent tails, so a chatty worker cannot hide web's panic. */
export function previewServiceLogs(logs: Record<string, unknown>): Pick<DeployFailureDiagnostic, 'logs' | 'omittedServices'> {
  // Reserve useful room per service; unusually large stacks use explicit get_logs.
  const maxServices = Math.max(1, Math.floor(AI_DEPLOY_LOG_PREVIEW_CHARS / 64));
  const selected: Array<[string, unknown]> = [];
  let serviceCount = 0;
  for (const service in logs) {
    if (!Object.hasOwn(logs, service)) continue;
    serviceCount += 1;
    if (selected.length < maxServices) selected.push([service, logs[service]]);
  }
  const perService = Math.floor(AI_DEPLOY_LOG_PREVIEW_CHARS / Math.max(1, selected.length));
  return {
    logs: selected.map(([service, value]) => ({
      service: sanitizeForDisplay(service.slice(0, 128), 32),
      text: typeof value === 'string' ? logPreviewTail(value, perService) : '',
    })),
    ...(selected.length < serviceCount && { omittedServices: serviceCount - selected.length }),
  };
}

/** Re-render at the actual summary budget instead of cutting a formatted row's
 * beginning. Compact summaries retain the reason, log lookup and service tails. */
export function renderDeployDiagnostic(diagnostic: DeployFailureDiagnostic, budget?: number, serialized = false): string {
  const separator = serialized ? ' ' : '\n\n';
  const lineBreak = serialized ? ' ' : '\n';
  const measure = (text: string) => {
    if (serialized) return JSON.stringify(text).length - 2;
    let count = 0;
    for (let index = 0; index < text.length; count += 1) index += text.codePointAt(index)! > 0xffff ? 2 : 1;
    return count;
  };
  const fit = (text: string, limit: number, tail = false): string => {
    if (measure(text) <= limit) return text;
    let remaining = limit - 1;
    if (remaining < 0) return '';
    let result = '';
    const points = Array.from(text);
    if (tail) points.reverse();
    for (const point of points) {
      const size = measure(point);
      if (size > remaining) break;
      result = tail ? point + result : result + point;
      remaining -= size;
    }
    return result ? tail ? `…${result}` : `${result}…` : '';
  };
  const lookup = `Use get_logs(app_name="${diagnostic.appName}", tail=200) for more:`;
  const failure = diagnostic.failure ? `Provision error (fail_count=${diagnostic.failCount}): ${diagnostic.failure}` : '';
  const full = [diagnostic.lead, failure, diagnostic.nextStep,
    diagnostic.logs.length > 0 ? `Container logs (preview). ${lookup}` : ''].filter(Boolean).join(separator);
  const limit = budget === undefined ? measure(full) + 1 + AI_DEPLOY_LOG_PREVIEW_CHARS : Math.max(0, budget - (serialized ? 2 : 0));
  const logs = diagnostic.logs.map((entry) => ({ ...entry,
    text: serialized ? sanitizeForDisplay(entry.text, AI_DEPLOY_LOG_PREVIEW_CHARS, '') : entry.text,
  }));
  // Service count must not displace the provider verdict or curated next step.
  // Only a genuinely smaller aggregate-summary budget needs the compact form.
  const compact = measure(full) > limit;
  const compactFailure = diagnostic.failure
    ? `Provision error (fail_count=${diagnostic.failCount}): ${fit(diagnostic.failure, Math.min(96, Math.floor(limit / 4)))}`
    : fit(diagnostic.lead, Math.min(96, Math.floor(limit / 4)));
  const prefix = compact && logs.length > 0
    ? ['Deployment failed.', compactFailure, lookup].filter(Boolean).join(separator)
    : full;
  if (logs.length === 0 || measure(prefix) >= limit) return fit(prefix, limit);
  const remaining = limit - measure(prefix) - measure(lineBreak);
  const headers = logs.map((entry) => `[${entry.service}]${lineBreak}`);
  const omissionFor = (selected: number) => {
    const omitted = (diagnostic.omittedServices ?? 0) + logs.length - selected;
    return omitted > 0 ? `${selected > 0 ? lineBreak : ''}(${omitted} more services; use get_logs.)` : '';
  };
  let selectedCount = 0;
  let minimumCost = 0;
  for (let index = 0; index < logs.length; index += 1) {
    minimumCost += measure(headers[index]) + (index > 0 ? measure(lineBreak) : 0)
      + Math.min(48, measure(logs[index].text || '(no visible log output)'));
    if (minimumCost + measure(omissionFor(index + 1)) <= remaining) selectedCount = index + 1;
  }
  const selected = logs.slice(0, selectedCount);
  const omission = omissionFor(selectedCount);
  const headerCost = selected.reduce((total, _entry, index) => total + measure(headers[index]) + (index > 0 ? measure(lineBreak) : 0), 0);
  const tailBudget = Math.max(0, remaining - measure(omission) - headerCost);
  const shares = allocateDiagnosticBudgets(selected.map((entry) => ({ size: measure(entry.text || '(no visible log output)'), copies: 1 })), tailBudget);
  const excerpts = selected.map((entry, index) => `${headers[index]}${fit(entry.text || '(no visible log output)', shares[index], true)}`);
  return fit(`${prefix}${lineBreak}${excerpts.join(lineBreak)}${omission}`, limit);
}

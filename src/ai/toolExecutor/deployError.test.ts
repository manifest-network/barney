/**
 * Deploy-throw classification — the SDK 0.22 structured discriminants.
 *
 * The chain-verdict half of `handleDeployManifestError` is covered by the
 * `handleDeployManifestError` / `classifyLeaseChainState` describes in
 * compositeTransactions.test.ts. THIS file covers the branches that run BEFORE
 * the chain check: `deployManifest` stamps `partial` / `readiness_unconfirmed`
 * / `poll_reason` / `failedStep` on every post-lease throw, and the chain lease
 * is ACTIVE for the whole provisioning window by construction — so without
 * these branches a poll deadline, an unreachable provider, a cancelled deploy
 * and an upload that never landed all came out as "App is live!".
 *
 * Every error fixture below is shaped exactly as
 * node_modules/@manifest-network/manifest-mcp-fred/dist/tools/deployManifest.js
 * throws it (both `throw` sites read at the 0.22.0 pin), including the SDK's
 * real prose — which is what lets the tests assert that `close_lease` and
 * `wait_for_app_ready` never reach chat.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleDeployManifestError } from './deployError';
import { makeRegistry } from './testHelpers';
import { LeaseState } from '../../api/billing';
import type { AppEntry } from '../../registry/appRegistry';
import { AI_BATCH_DIAGNOSTIC_CHARS, AI_BATCH_GUIDANCE_CHARS, AI_DEPLOY_LOG_PREVIEW_CHARS } from '../../config/constants';
import { nextStepFor } from './failureGuidance';
import { runBatchWithConcurrency, summarizeBatchResult } from './batchRunner';
import type { DeployFailureDiagnostic } from './deployDiagnostic';

vi.mock('../../api/billing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/billing')>()),
  getLease: vi.fn(),
}));

vi.mock('../../api/fred', () => ({
  getLeaseProvision: vi.fn(),
  getLeaseLogs: vi.fn(),
}));

vi.mock('../../api/provider-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/provider-api')>()),
  getLeaseConnectionInfo: vi.fn(),
}));

vi.mock('../../utils/errors', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/errors')>()),
  logError: vi.fn(),
}));

import { getLease } from '../../api/billing';
import { getLeaseProvision, getLeaseLogs } from '../../api/fred';
import { ManifestMCPError, ManifestMCPErrorCode } from '@manifest-network/manifest-sdk';
import { FRED_REASON_GUIDANCE, TerminalChainStateError } from '@manifest-network/manifest-sdk/deploy';

const ADDRESS = 'manifest1abc';
const LEASE = 'lease-1';
const PROVIDER_URL = 'https://fred.example.com';

/**
 * The literal message deployManifest builds for a partial throw. Copied from
 * the 0.22.0 dist so the "barney never echoes this" assertions test the real
 * text, not a paraphrase of it.
 */
const SDK_READINESS_PROSE =
  `Deploy partially succeeded: lease ${LEASE} was created but its readiness could not be confirmed. ` +
  'This is NOT a confirmed failure — the provider never reported the deployment as failed, so the app ' +
  `may still be starting. Re-check with app_status({ lease_uuid: "${LEASE}" }), or keep waiting with ` +
  `wait_for_app_ready({ lease_uuid: "${LEASE}", timeout_seconds: 600 }). Close this lease with ` +
  'close_lease ONLY if the provider reports a failed provision_status, or you have decided to abandon ' +
  'the deploy. Error: poll deadline exceeded';

const SDK_PARTIAL_PROSE =
  `Deploy partially succeeded: lease ${LEASE} was created but subsequent steps failed. ` +
  'Close this lease with close_lease if needed. Error: HTTP 413 payload too large';

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    name: 'test-app',
    leaseUuid: LEASE,
    providerUrl: PROVIDER_URL,
    address: ADDRESS,
    signing: {
      providerAuth: { providerToken: vi.fn(), leaseDataToken: vi.fn() },
      authTokens: {
        getAuthToken: vi.fn().mockResolvedValue('mock-auth-token'),
        getLeaseDataAuthToken: vi.fn().mockResolvedValue('mock-lease-data-token'),
      },
      relayAuth: { signChallenge: vi.fn() },
    },
    appRegistry: makeRegistry([
      { name: 'test-app', leaseUuid: LEASE, size: 'small', providerUuid: 'p1', providerUrl: PROVIDER_URL, createdAt: 0, status: 'deploying' } as AppEntry,
    ]),
    onProgress: vi.fn(),
    ...overrides,
  } as never as Parameters<typeof handleDeployManifestError>[1] & {
    onProgress: ReturnType<typeof vi.fn>;
    appRegistry: ReturnType<typeof makeRegistry>;
  };
}

/** The readiness-unconfirmed throw, exactly as deployManifest builds it. */
function readinessUnconfirmedError(
  extra: Record<string, unknown> = {},
  code: ManifestMCPErrorCode = ManifestMCPErrorCode.DEPLOY_READINESS_UNCONFIRMED,
) {
  return new ManifestMCPError(code, SDK_READINESS_PROSE, {
    partial: true,
    readiness_unconfirmed: true,
    poll_reason: 'deadline',
    failedStep: 'poll',
    lease_uuid: LEASE,
    provider_uuid: 'p1',
    provider_url: PROVIDER_URL,
    ...extra,
  });
}

/** The non-readiness partial throw (2nd throw site): `partial` + `failedStep`, NO readiness flag. */
function partialError(failedStep: string, code: ManifestMCPErrorCode = ManifestMCPErrorCode.QUERY_FAILED) {
  return new ManifestMCPError(code, SDK_PARTIAL_PROSE, {
    partial: true,
    failedStep,
    lease_uuid: LEASE,
    provider_uuid: 'p1',
    provider_url: PROVIDER_URL,
  });
}

/**
 * Asserts none of the SDK's own tool prose reached chat.
 *
 * `lease_uuid` is checked BARE, not as `lease_uuid:`. The SDK's curated
 * `ContainerExited` / `Unknown` next steps spell the call
 * `get_logs({ lease_uuid, tail: 200 })` — no colon — so the narrower probe let
 * that sentence through, and barney's `get_logs` takes `app_name`. `restore_app`
 * is a tool barney does not have at all (`RestoreFailed`'s next step). See
 * failureGuidance.ts.
 */
function expectNoSdkProse(text: string) {
  expect(text).not.toContain('close_lease');
  expect(text).not.toContain('wait_for_app_ready');
  expect(text).not.toContain('lease_uuid');
  expect(text).not.toContain('restore_app');
}

describe('handleDeployManifestError — readiness unconfirmed (SDK 0.22)', () => {
  // resetAllMocks, not clearAllMocks: clearAllMocks keeps a configured
  // mockResolvedValue, so a `getLease` set by one test leaks into the next and
  // silently changes which branch it exercises.
  beforeEach(() => vi.resetAllMocks());

  it('reports a poll-deadline deploy as still deploying, never as live', async () => {
    // The chain lease is ACTIVE — which is exactly why the chain verdict can't
    // be trusted here: it says ACTIVE for the whole provisioning window.
    vi.mocked(getLease).mockResolvedValue({ state: LeaseState.LEASE_STATE_ACTIVE } as never);
    const c = ctx();

    const result = await handleDeployManifestError(readinessUnconfirmedError(), c);

    expect(result.success).toBe(true);
    expect((result.data as { status: string }).status).toBe('deploying');
    // No AppCard: there is no confirmed app and no URL to link to.
    expect(result.success && !result.requiresConfirmation && result.displayCard).toBeUndefined();
    // The OBSERVATION, not a summary: the manifest reached the provider and the
    // poll ended with no readiness verdict. `status` is derived from it.
    expect(c.appRegistry.updateApp).toHaveBeenCalledWith(ADDRESS, LEASE, { provisionState: 'unconfirmed' });

    const message = (result.data as { message: string }).message;
    expect(message).not.toContain('is live');
    expect(message).toContain('may still be starting');
    expect(message).toContain('we never found out');
    expect(message).toContain('cold image pull');
    expect(message).toContain('app_status("test-app")');
    expectNoSdkProse(message);
  });

  it('does not consult the chain at all on a readiness-unconfirmed throw', async () => {
    // The whole point of the discriminant: an ACTIVE chain lease is what USED
    // to route this into the "App is live!" arm, so the branch must be taken
    // before (and instead of) the chain read.
    const c = ctx();

    await handleDeployManifestError(readinessUnconfirmedError(), c);

    expect(getLease).not.toHaveBeenCalled();
  });

  it('distinguishes an unreachable provider from a blown deadline', async () => {
    vi.mocked(getLease).mockResolvedValue({ state: LeaseState.LEASE_STATE_ACTIVE } as never);
    const c = ctx();

    const result = await handleDeployManifestError(
      readinessUnconfirmedError({ poll_reason: 'provider_unreachable' }), c);

    const message = (result.data as { message: string }).message;
    expect((result.data as { status: string }).status).toBe('deploying');
    expect(message).toContain('status endpoint was unreachable');
    expect(message).not.toContain('cold image pull');
    expect(message).toContain('we never found out');
  });

  it('relays an unrecognized poll_reason with neutral wording instead of rejecting it', async () => {
    // `poll_reason` is an open set (ReadinessUnconfirmedReason can gain values);
    // an unknown one must still land on the still-deploying outcome.
    const c = ctx();

    const result = await handleDeployManifestError(
      readinessUnconfirmedError({ poll_reason: 'some_future_reason' }), c);

    expect(result.success).toBe(true);
    expect((result.data as { status: string }).status).toBe('deploying');
    expect((result.data as { message: string }).message).toContain('we never found out');
  });

  it('treats a cancelled readiness-unconfirmed throw as cancelled, not as live', async () => {
    // deployManifest codes a cancel-during-poll OPERATION_CANCELLED but still
    // stamps readiness_unconfirmed — so the DETAILS FLAG is the discriminant
    // and the code only shapes the copy.
    vi.mocked(getLease).mockResolvedValue({ state: LeaseState.LEASE_STATE_ACTIVE } as never);
    const c = ctx();

    const result = await handleDeployManifestError(
      readinessUnconfirmedError({}, ManifestMCPErrorCode.OPERATION_CANCELLED), c);

    const message = (result.data as { message: string }).message;
    expect(message).not.toContain('is live');
    expect(message).toContain('You cancelled the deploy');
    expect((result.data as { status: string }).status).toBe('deploying');
    // A cancel DURING the poll still observed something — "we stopped listening"
    // — so it records 'unconfirmed'. Contrast the restart/update POST-site
    // cancels, which observed nothing and write no observation at all.
    expect(c.appRegistry.updateApp).toHaveBeenCalledWith(ADDRESS, LEASE, { provisionState: 'unconfirmed' });
    expectNoSdkProse(message);
  });

  it('takes the branch on the error CODE even without the details flag', async () => {
    // Belt-and-braces for an SDK build that sets one without the other.
    const c = ctx();

    const result = await handleDeployManifestError(
      new ManifestMCPError(ManifestMCPErrorCode.DEPLOY_READINESS_UNCONFIRMED, SDK_READINESS_PROSE, {
        partial: true, failedStep: 'poll', lease_uuid: LEASE,
      }), c);

    expect((result.data as { status: string }).status).toBe('deploying');
    expect(getLease).not.toHaveBeenCalled();
  });

  it('surfaces the last provision_status the provider did report', async () => {
    const c = ctx();

    const result = await handleDeployManifestError(
      readinessUnconfirmedError({ last_provision_status: 'provisioning' }), c);

    expect((result.data as { message: string }).message).toContain('provision_status "provisioning"');
  });

  it('never suggests tearing the lease down on a readiness signal alone', async () => {
    const c = ctx();

    const result = await handleDeployManifestError(readinessUnconfirmedError(), c);

    const message = (result.data as { message: string }).message;
    // The only sentence containing "failed" must be the DENIAL of one.
    expect(message).toContain('this is not a failed deployment');
    expect(message).not.toContain('Deployment failed');
    // stop_app is named only as an explicit opt-in, never as the recommendation.
    expect(message).toContain('Only stop_app("test-app") if you have decided to abandon it');
  });

  it('fires a terminal progress update so the ProgressCard stops spinning', async () => {
    const c = ctx();

    await handleDeployManifestError(readinessUnconfirmedError(), c);

    expect(c.onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'failed', detail: expect.stringContaining('cold image pull') }),
    );
  });

  it('does not fetch failure logs for a deploy that never got a verdict', async () => {
    // getLease unavailable — the chain path would call this 'failed' and go
    // fetch diagnostics for a lease that never reported one.
    vi.mocked(getLease).mockResolvedValue(null as never);
    const c = ctx();

    await handleDeployManifestError(readinessUnconfirmedError(), c);

    expect(getLeaseProvision).not.toHaveBeenCalled();
    expect(getLeaseLogs).not.toHaveBeenCalled();
  });
});

describe('handleDeployManifestError — partial deploy, no manifest uploaded', () => {
  // resetAllMocks, not clearAllMocks: clearAllMocks keeps a configured
  // mockResolvedValue, so a `getLease` set by one test leaks into the next and
  // silently changes which branch it exercises.
  beforeEach(() => vi.resetAllMocks());

  it('reports an upload failure as a failure even while the chain lease is ACTIVE', async () => {
    vi.mocked(getLease).mockResolvedValue({ state: LeaseState.LEASE_STATE_ACTIVE } as never);
    const c = ctx();

    const result = await handleDeployManifestError(partialError('upload'), c);

    expect(result.success).toBe(false);
    expect(c.appRegistry.updateApp).toHaveBeenCalledWith(ADDRESS, LEASE, { provisionState: 'failed' });
    expect(result.error).toContain('the manifest never reached the provider');
    expect(result.error).toContain('nothing is running');
    expect(result.error).toContain('stop_app("test-app")');
    expectNoSdkProse(result.error ?? '');
  });

  it('reports a set_domain failure with its own cause', async () => {
    const c = ctx();

    const result = await handleDeployManifestError(partialError('set_domain'), c);

    expect(result.success).toBe(false);
    expect(result.error).toContain('custom domain could not be attached');
    expect(c.appRegistry.updateApp).toHaveBeenCalledWith(ADDRESS, LEASE, { provisionState: 'failed' });
  });

  it('does not chain-check or fetch logs — the provider holds no manifest', async () => {
    const c = ctx();

    await handleDeployManifestError(partialError('upload'), c);

    expect(getLease).not.toHaveBeenCalled();
    expect(getLeaseProvision).not.toHaveBeenCalled();
    expect(getLeaseLogs).not.toHaveBeenCalled();
  });

  it('names a cancel as a cancel when the upload was the step that was interrupted', async () => {
    const c = ctx();

    const result = await handleDeployManifestError(
      partialError('upload', ManifestMCPErrorCode.OPERATION_CANCELLED), c);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Deploy cancelled');
  });

  it('reports a cancel in the instant after lease creation as a failure, not as live', async () => {
    // The post-creation throwIfAborted() runs before set_domain/upload. The chain lease is
    // ACTIVE, so without this arm the deploy reported "App is live!".
    vi.mocked(getLease).mockResolvedValue({ state: LeaseState.LEASE_STATE_ACTIVE } as never);
    const c = ctx();

    const result = await handleDeployManifestError(
      new ManifestMCPError(ManifestMCPErrorCode.OPERATION_CANCELLED, SDK_PARTIAL_PROSE, {
        partial: true, lease_uuid: LEASE, provider_uuid: 'p1', provider_url: PROVIDER_URL,
      }), c);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Deploy cancelled');
    expect(result.error).toContain('stopped immediately after the lease was created');
    expect(c.appRegistry.updateApp).toHaveBeenCalledWith(ADDRESS, LEASE, { provisionState: 'failed' });
    expectNoSdkProse(result.error ?? '');
  });

  it('reports a callback failure before upload as failed even with an ACTIVE lease', async () => {
    // SDK 0.22 catches onLeaseCreated before assigning a step.
    vi.mocked(getLease).mockResolvedValue({ state: LeaseState.LEASE_STATE_ACTIVE } as never);
    const c = ctx();

    const result = await handleDeployManifestError(
      new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, SDK_PARTIAL_PROSE, {
        partial: true, lease_uuid: LEASE, provider_uuid: 'p1', provider_url: PROVIDER_URL,
      }), c);

    expect(result.success).toBe(false);
    expect(result.error).toContain('stopped immediately after the lease was created');
    expect(result.error).toContain('provider holds no manifest');
    expect(c.appRegistry.getAppByLease(ADDRESS, LEASE)?.status).toBe('failed');
    expect(c.onProgress).not.toHaveBeenCalledWith(expect.objectContaining({ phase: 'ready' }));
    expect(getLease).not.toHaveBeenCalled();
    expect(getLeaseProvision).not.toHaveBeenCalled();
    expect(getLeaseLogs).not.toHaveBeenCalled();
    expectNoSdkProse(result.error ?? '');
  });

  it.each(['future_step', 42, null])('keeps an unknown partial step %s unconfirmed', async (failedStep) => {
    vi.mocked(getLease).mockResolvedValue({ state: LeaseState.LEASE_STATE_ACTIVE } as never);
    const c = ctx();
    const result = await handleDeployManifestError(new ManifestMCPError(
      ManifestMCPErrorCode.QUERY_FAILED, SDK_PARTIAL_PROSE, { partial: true, failedStep },
    ), c);

    expect(result.data).toMatchObject({ status: 'deploying' });
    expect(c.appRegistry.getAppByLease(ADDRESS, LEASE)?.provisionState).toBe('unconfirmed');
    expect(getLease).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('is live');
    expectNoSdkProse(JSON.stringify(result));
  });
});

describe('handleDeployManifestError — provider verdict at the poll step', () => {
  // resetAllMocks, not clearAllMocks: clearAllMocks keeps a configured
  // mockResolvedValue, so a `getLease` set by one test leaks into the next and
  // silently changes which branch it exercises.
  beforeEach(() => vi.resetAllMocks());

  it.each([false, true])('retains the last panic line and guidance in a bounded batch row (NFC expansion: %s)', async (expandingUnicode) => {
    const panic = 'panic: nil pointer at main.go:42';
    vi.mocked(getLeaseProvision).mockResolvedValue({ status: 'failed', fail_count: 1,
      reason: 'ContainerExited', message: 'container exited unexpectedly' } as never);
    const logText = expandingUnicode ? '\u0344'.repeat(900) : 'startup detail '.repeat(64);
    vi.mocked(getLeaseLogs).mockResolvedValue({ logs: { web: `earliest-line\n${logText}\n${panic}` } } as never);
    const batch = await runBatchWithConcurrency({
      entries: [{ name: 'test-app' }, { name: 'healthy' }], initialPhase: 'provisioning', intermediatePhases: ['provisioning'],
      executeOne: async ({ name }, _index, progress) => {
        if (name === 'healthy') return { name };
        let diagnostic: DeployFailureDiagnostic | undefined;
        const result = await handleDeployManifestError(partialError('poll'), ctx({ maxDetailChars: AI_BATCH_GUIDANCE_CHARS,
          onDiagnostic: (value: DeployFailureDiagnostic) => { diagnostic = value; } }));
        progress('failed', result.error, diagnostic);
        return null;
      },
    });
    const row = batch.batchProgress[0].detail!;
    expect([...row].length).toBeLessThanOrEqual(AI_BATCH_GUIDANCE_CHARS);
    expect(row).toContain('Deployment failed: the provider reported the deployment as failed.');
    expect(row).toContain(nextStepFor('ContainerExited', 'test-app'));
    expect(row).toContain('Use get_logs(app_name="test-app", tail=200) for more:');
    expect(row).toContain(panic);
    expect(row).not.toContain('earliest-line');
    const summary = summarizeBatchResult({ ...batch, dataKey: 'deployed', verb: 'Deployed', failedNoun: 'deploys' });
    expect(summary.data).toMatchObject({ message: expect.stringContaining(panic) });
  });

  it.each(['mixed-six', 'failed-24'] as const)('keeps ending panic lines and log lookups in %s summary budgeting', async (shape) => {
    const panic = 'panic: nil pointer at main.go:42';
    const names = Array.from({ length: shape === 'mixed-six' ? 6 : 24 }, (_, index) => `app-${index}`);
    vi.mocked(getLeaseProvision).mockResolvedValue({ status: 'failed', fail_count: 1,
      reason: 'ContainerExited', message: 'container exited unexpectedly' } as never);
    vi.mocked(getLeaseLogs).mockResolvedValue({ logs: {
      web: `${'before crash '.repeat(250)}\n${panic}`,
      worker: `${'heartbeat '.repeat(800)}worker-still-alive`,
    } } as never);
    const onProgress = vi.fn();
    const batch = await runBatchWithConcurrency({
      entries: names.map((name) => ({ name })), initialPhase: 'provisioning', intermediatePhases: ['provisioning'], onProgress,
      executeOne: async ({ name }, index, progress) => {
        if (shape === 'mixed-six' && index === 1) return { name };
        if (shape === 'mixed-six' && index > 1) return { name, outcome: 'unconfirmed', detail: 'Still deploying. Check app_status before deciding whether to abandon this deployment.' };
        let diagnostic: DeployFailureDiagnostic | undefined;
        const result = await handleDeployManifestError(partialError('poll'), ctx({ name, maxDetailChars: AI_BATCH_GUIDANCE_CHARS,
          onDiagnostic: (value: DeployFailureDiagnostic) => { diagnostic = value; } }));
        progress('failed', result.error, diagnostic);
        return null;
      },
    });
    const options = { ...batch, dataKey: 'deployed', verb: 'Deployed', failedNoun: 'deploys' };
    const result = summarizeBatchResult(options);
    const text = result.error ?? (result.data as { message: string }).message;
    for (const name of batch.failed) {
      expect(text).toContain(`get_logs(app_name="${name}", tail=200)`);
    }
    expect(text.split(panic)).toHaveLength(batch.failed.length + 1);
    expect(text.split('[web]')).toHaveLength(batch.failed.length + 1);
    expect(text.split('[worker]')).toHaveLength(batch.failed.length + 1);
    expect(text.split('worker-still-alive')).toHaveLength(batch.failed.length + 1);
    if (shape === 'mixed-six') {
      expect(text).toContain(nextStepFor('ContainerExited', names[0]));
      expect(text).not.toContain('Details were shortened');
    }
    const withoutDiagnostics = summarizeBatchResult({ ...options,
      batchProgress: batch.batchProgress.map(({ name, phase }) => ({ name, phase })),
      unconfirmed: batch.unconfirmed.map(({ name, outcome }) => ({ name, outcome })) });
    for (const indentation of [undefined, 2]) {
      expect(JSON.stringify(result, null, indentation).length - JSON.stringify(withoutDiagnostics, null, indentation).length).toBeLessThanOrEqual(AI_BATCH_DIAGNOSTIC_CHARS);
    }
    expect(JSON.stringify(onProgress.mock.calls)).not.toContain('"diagnostic":');
    expect(JSON.stringify(result)).not.toContain('"logs":');
  });

  it.each([[6, true], [10, false], [16, true]] as const)('keeps fail count and complete guidance for a %i-service stack (long message: %s)', async (serviceCount, longMessage) => {
    const message = longMessage ? 'container exited unexpectedly; '.repeat(20) : 'container exited unexpectedly';
    vi.mocked(getLeaseProvision).mockResolvedValue({ status: 'failed', fail_count: 7,
      reason: 'ContainerExited', message } as never);
    vi.mocked(getLeaseLogs).mockResolvedValue({ logs: Object.fromEntries(Array.from({ length: serviceCount }, (_, index) => [
      `service-${index}`, `${'startup '.repeat(200)}service-${index} panic: final crash line`,
    ])) } as never);
    let diagnostic: DeployFailureDiagnostic | undefined;
    const result = await handleDeployManifestError(partialError('poll'), ctx({ maxDetailChars: AI_BATCH_GUIDANCE_CHARS,
      onDiagnostic: (value: DeployFailureDiagnostic) => { diagnostic = value; } }));
    const text = result.error!;
    expect(text).toContain('Provision error (fail_count=7): ContainerExited:');
    expect(text).toContain(nextStepFor('ContainerExited', 'test-app'));
    expect(text).toContain('service-0 panic: final crash line');
    const omitted = Number(text.match(/\((\d+) more services; use get_logs\.\)$/)?.[1]);
    expect(omitted).toBeGreaterThan(0);
    expect((text.match(/\[service-\d+\]/g)?.length ?? 0) + omitted).toBe(serviceCount);
    expect([...text].length).toBeLessThanOrEqual(AI_BATCH_GUIDANCE_CHARS);
    const summary = summarizeBatchResult({ succeeded: [{ name: 'healthy' }], failed: ['test-app'],
      batchProgress: [{ name: 'test-app', phase: 'failed', detail: text, diagnostic }],
      dataKey: 'deployed', verb: 'Deployed', failedNoun: 'deploys' });
    expect(summary.data).toMatchObject({ message: expect.stringContaining(nextStepFor('ContainerExited', 'test-app')!) });
    expect(summary.data).toMatchObject({ message: expect.stringContaining('Provision error (fail_count=7)') });
    expect(JSON.stringify(summary)).not.toContain('Details were shortened');
  });

  it.each([' ', '\u0000\u202e\r\n'])('keeps each service header and panic before a long trailing noise run (%j)', async (noise) => {
    const panic = 'panic: nil pointer at main.go:42';
    vi.mocked(getLeaseProvision).mockResolvedValue({ status: 'failed', fail_count: 1,
      reason: 'ContainerExited', message: 'container exited unexpectedly' } as never);
    vi.mocked(getLeaseLogs).mockResolvedValue({ logs: {
      web: `web startup\n${panic}${noise.repeat(100_000)}`,
      worker: `${'heartbeat '.repeat(800)}worker-still-alive`,
      empty: noise.repeat(100_000),
    } } as never);
    let diagnostic: DeployFailureDiagnostic | undefined;
    const result = await handleDeployManifestError(partialError('poll'), ctx({ maxDetailChars: AI_BATCH_GUIDANCE_CHARS,
      onDiagnostic: (value: DeployFailureDiagnostic) => { diagnostic = value; } }));
    const text = result.error!;
    expect(text).toContain(`[web]\nweb startup\n${panic}`);
    expect(text).toContain('[worker]');
    expect(text).toContain('worker-still-alive');
    expect(text).toContain('[empty]\n(no visible log output)');
    expect(text).not.toContain('\u0000');
    expect(text).not.toMatch(/\p{Cf}/u);
    expect([...text].length).toBeLessThanOrEqual(AI_BATCH_GUIDANCE_CHARS);
    const summary = summarizeBatchResult({ succeeded: [], failed: ['test-app'],
      batchProgress: [{ name: 'test-app', phase: 'failed', detail: text, diagnostic }],
      dataKey: 'deployed', verb: 'Deployed', failedNoun: 'deploys' });
    expect(summary.error).toContain(panic);
    expect(summary.error).toContain('[web]');
    expect(summary.error).toContain('[worker]');
    expect(summary.error).toContain('worker-still-alive');
  });

  it('bounds code-point allocation for a large log while preserving safe ending line breaks', async () => {
    const ending = '\nlast setup line\n\u202e\u0000panic: nil pointer at main.go:42\nstack frame 💥';
    vi.mocked(getLeaseProvision).mockResolvedValue({ status: 'failed', fail_count: 1, reason: 'ContainerExited' } as never);
    vi.mocked(getLeaseLogs).mockResolvedValue({ logs: { web: '💥'.repeat(5_000_000) + ending } } as never);
    const arrays = vi.spyOn(Array, 'from');
    try {
      const result = await handleDeployManifestError(partialError('poll'), ctx());
      const text = result.error!;
      expect(text).toContain('last setup line\n panic: nil pointer at main.go:42\nstack frame 💥');
      expect(text).not.toMatch(/[\p{Cf}\uFFFD]/u);
      expect(text).not.toContain('\u0000');
      expect(new TextDecoder().decode(new TextEncoder().encode(text))).toBe(text);
      const preview = text.split('for more:\n')[1];
      expect([...preview].length).toBeLessThanOrEqual(AI_DEPLOY_LOG_PREVIEW_CHARS);
      const stringInputs = arrays.mock.calls.map(([input]) => input).filter((input): input is string => typeof input === 'string');
      expect(Math.max(...stringInputs.map((input) => input.length))).toBeLessThanOrEqual(2 * AI_DEPLOY_LOG_PREVIEW_CHARS);
    } finally { arrays.mockRestore(); }
  });

  it('reports a poll verdict as failed while the chain lease is still ACTIVE', async () => {
    // Reaching the 2nd throw site with failedStep 'poll' means the poll raised
    // a `poll_verdict` ProviderApiError (deployManifest's readiness branch
    // covers `step === 'poll' && !pollVerdict`), i.e. the provider DID answer:
    // PROVISION_FAILED or a terminal lease state. The chain lease is still
    // ACTIVE, so the chain check would have said "App is live!".
    vi.mocked(getLease).mockResolvedValue({ state: LeaseState.LEASE_STATE_ACTIVE } as never);
    vi.mocked(getLeaseProvision).mockResolvedValue({
      status: 'failed', fail_count: 1, reason: 'ContainerExited', message: 'container exited unexpectedly',
    } as never);
    vi.mocked(getLeaseLogs).mockResolvedValue({ lease_uuid: LEASE, tenant: ADDRESS, provider_uuid: 'p1', logs: {} } as never);
    const c = ctx();

    const result = await handleDeployManifestError(partialError('poll'), c);

    expect(result.success).toBe(false);
    expect(result.error).toContain('the provider reported the deployment as failed');
    expect(c.appRegistry.updateApp).toHaveBeenCalledWith(ADDRESS, LEASE, { provisionState: 'failed' });
    expect(getLease).not.toHaveBeenCalled();
    // Diagnostics ARE worth fetching here — unlike the upload arm, a container
    // ran (or tried to) and the provider recorded why.
    expect(getLeaseProvision).toHaveBeenCalledWith(PROVIDER_URL, LEASE, 'mock-auth-token');
    expect(result.error).toContain('ContainerExited: container exited unexpectedly');
    expectNoSdkProse(result.error ?? '');
  });
});

describe('fetchFailureLogs — provision failure prose (ENG-508 dual era)', () => {
  // resetAllMocks, not clearAllMocks: clearAllMocks keeps a configured
  // mockResolvedValue, so a `getLease` set by one test leaks into the next and
  // silently changes which branch it exercises.
  beforeEach(() => vi.resetAllMocks());

  /** Drive fetchFailureLogs through the chain-verdict failed arm. */
  async function failedDeploy(provision: Record<string, unknown>) {
    vi.mocked(getLease).mockResolvedValue(null as never); // → chain verdict 'failed'
    vi.mocked(getLeaseProvision).mockResolvedValue(provision as never);
    vi.mocked(getLeaseLogs).mockResolvedValue({ lease_uuid: LEASE, tenant: ADDRESS, provider_uuid: 'p1', logs: {} } as never);
    return handleDeployManifestError(new Error('deploy blew up'), ctx());
  }

  it('reads the post-ENG-508 reason/message pair', async () => {
    const result = await failedDeploy({ status: 'failed', fail_count: 2, reason: 'ImagePullFailed', message: 'pull access denied for ngnix' });

    expect(result.error).toContain('Provision error (fail_count=2)');
    expect(result.error).toContain('ImagePullFailed: pull access denied for ngnix');
  });

  it('appends the curated next step for a reason this build knows', async () => {
    const result = await failedDeploy({ status: 'failed', fail_count: 2, reason: 'ImagePullFailed', message: 'pull access denied' });

    // Assert against the real constant — a hand-copied string would drift.
    expect(result.error).toContain(FRED_REASON_GUIDANCE.ImagePullFailed.nextStep);
  });

  it('still reads a pre-ENG-508 provider that only sends last_error', async () => {
    // Providers upgrade independently — the legacy fallback must never be dropped.
    const result = await failedDeploy({ status: 'failed', fail_count: 2, last_error: 'OOMKilled' });

    expect(result.error).toContain('Provision error (fail_count=2): OOMKilled');
  });

  // The SDK's ContainerExited next step spells the call
  // `get_logs({ lease_uuid, tail: 200 })`. Barney's get_logs takes `app_name`,
  // so relaying it verbatim makes the model emit `get_logs({ lease_uuid })` and
  // burn an iteration on `No unique app found matching "undefined"`.
  it('remaps ContainerExited onto barney\'s get_logs(app_name) shape', async () => {
    const result = await failedDeploy({ status: 'failed', fail_count: 1, reason: 'ContainerExited', message: 'exit 137' });

    expect(result.error).toContain('Call get_logs("test-app", 200)');
    expect(result.error).not.toContain(FRED_REASON_GUIDANCE.ContainerExited.nextStep);
    // The tool-free half of the taxonomy is kept, not thrown away.
    expect(result.error).toContain(FRED_REASON_GUIDANCE.ContainerExited.explanation);
    expectNoSdkProse(result.error ?? '');
  });

  // fred's provisionReason() stamps `Unknown` on ANY failed provision with no
  // authored reason, so this is the common path, not an exotic one.
  it('remaps Unknown onto barney\'s get_logs(app_name) shape', async () => {
    const result = await failedDeploy({ status: 'failed', fail_count: 1, reason: 'Unknown' });

    expect(result.error).toContain('Call get_logs("test-app", 200)');
    expect(result.error).toContain(FRED_REASON_GUIDANCE.Unknown.explanation);
    expectNoSdkProse(result.error ?? '');
  });

  // `restore_app` does not exist in barney at all — grep src/ai/tools.ts.
  it('remaps RestoreFailed away from the restore_app tool barney lacks', async () => {
    const result = await failedDeploy({ status: 'failed', fail_count: 1, reason: 'RestoreFailed', message: 'restore aborted' });

    expect(result.error).toContain(FRED_REASON_GUIDANCE.RestoreFailed.explanation);
    expect(result.error).toContain('app_status("test-app")');
    expectNoSdkProse(result.error ?? '');
  });

  it('relays an unrecognized reason verbatim and fabricates no guidance', async () => {
    const result = await failedDeploy({ status: 'failed', fail_count: 1, reason: 'SomeFutureReason', message: 'a new failure mode' });

    expect(result.error).toContain('SomeFutureReason: a new failure mode');
    expect(result.error).not.toContain('Call get_logs');
  });

  it('says nothing when the provision carries no failure signal at all', async () => {
    const result = await failedDeploy({ status: 'failed', fail_count: 0 });

    expect(result.error).toBe('Deployment failed: deploy blew up');
  });
});

describe('N1 — a chain-terminal deploy must derive `failed`, not `stopped`', () => {
  beforeEach(() => vi.clearAllMocks());

  /**
   * The real `TerminalChainStateError`, not a stand-in. It extends
   * `ProviderApiError` and its ctor is `(leaseUuid, chainState, context?)`, so
   * `instanceof` in `handleDeployManifestError` matches the shipped class.
   */
  function terminal(state: 'closed' | 'rejected' | 'expired') {
    return new TerminalChainStateError(LEASE, state, { providerUuid: 'p1', providerUrl: PROVIDER_URL });
  }

  it.each(['closed', 'rejected', 'expired'] as const)(
    'records BOTH observations for a lease that went %s mid-provision',
    async (state) => {
      const c = ctx();
      const result = await handleDeployManifestError(terminal(state), c);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Deployment failed');
      expect(c.appRegistry.updateApp).toHaveBeenCalledWith(
        ADDRESS, LEASE, { chainState: 'absent', provisionState: 'failed' },
      );
    },
  );

  it('derives `failed`, so the badge stops contradicting the chat copy', async () => {
    // The concrete report: deploy "redis", credits run out mid-provision, the
    // chain lease goes EXPIRED, the SDK raises TerminalChainStateError. Chat
    // leads with "Deployment failed: …" while the sidebar badge read 'stopped',
    // because a lone `chainState: 'absent'` hits derivation rule 2. Rule 1
    // (`provisionState === 'failed'`) outranks rule 2, which is what makes the
    // second observation load-bearing rather than decorative.
    const c = ctx();
    const result = await handleDeployManifestError(terminal('expired'), c);

    expect(c.appRegistry.getAppByLease(ADDRESS, LEASE)?.status).toBe('failed');
    expect(result.error).toContain('Deployment failed');
  });

  it('is not a chain read: getLease is never called', async () => {
    // Regression guard on the "no chain re-check" property of case 3 — the
    // terminal state is already known, and re-reading could only cost a
    // round-trip and answer the same thing.
    const c = ctx();
    await handleDeployManifestError(terminal('closed'), c);
    expect(getLease).not.toHaveBeenCalled();
  });

  it('records nothing when there is no lease to record it against', async () => {
    // A terminal-state error with no captured leaseUuid cannot be attributed to
    // a registry entry; the guard must survive the two-field write.
    const c = ctx({ leaseUuid: undefined });
    const result = await handleDeployManifestError(terminal('closed'), c);

    expect(result.success).toBe(false);
    expect(c.appRegistry.updateApp).not.toHaveBeenCalled();
  });
});

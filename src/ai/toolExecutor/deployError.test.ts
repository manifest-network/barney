/**
 * Deploy-throw classification — the SDK 0.21 structured discriminants.
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
 * throws it (both `throw` sites read at the 0.21.0 pin), including the SDK's
 * real prose — which is what lets the tests assert that `close_lease` and
 * `wait_for_app_ready` never reach chat.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleDeployManifestError } from './deployError';
import { makeRegistry } from './testHelpers';
import { LeaseState } from '../../api/billing';
import type { AppEntry } from '../../registry/appRegistry';

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
 * the 0.21.0 dist so the "barney never echoes this" assertions test the real
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

describe('handleDeployManifestError — readiness unconfirmed (SDK 0.21)', () => {
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
    // deployManifest leaves `step` undefined only when its very first
    // throwIfAborted() fires — before set_domain/upload. The chain lease is
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

  it('leaves a NON-cancelled partial throw with no failedStep to the chain check', async () => {
    // The step is only absent because of the abort guard, so inferring
    // "nothing uploaded" from its absence alone would be guessing. Anything
    // else falls through to chain truth rather than being called a failure.
    vi.mocked(getLease).mockResolvedValue({ state: LeaseState.LEASE_STATE_PENDING } as never);
    const c = ctx();

    const result = await handleDeployManifestError(
      new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, 'something else', { partial: true }), c);

    expect(getLease).toHaveBeenCalledWith(LEASE);
    expect((result.data as { status: string }).status).toBe('deploying');
  });
});

describe('handleDeployManifestError — provider verdict at the poll step', () => {
  // resetAllMocks, not clearAllMocks: clearAllMocks keeps a configured
  // mockResolvedValue, so a `getLease` set by one test leaks into the next and
  // silently changes which branch it exercises.
  beforeEach(() => vi.resetAllMocks());

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

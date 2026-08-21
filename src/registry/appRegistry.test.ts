import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getApps,
  getApp,
  findApp,
  getAppByLease,
  addApp,
  updateApp,
  removeApp,
  reconcileWithChain,
  validateAppName,
  sanitizeManifestForStorage,
  subscribeToRegistry,
  deriveAppStatus,
  type AppEntry,
  type AppStatus,
  type ChainState,
  type ProvisionState,
} from './appRegistry';

// Mock logError to avoid console noise in tests
vi.mock('../utils/errors', () => ({
  logError: vi.fn(),
}));

const ADDR_A = 'manifest1aaa';
const ADDR_B = 'manifest1bbb';

function makeApp(overrides: Partial<AppEntry> = {}): AppEntry {
  return {
    name: 'my-app',
    leaseUuid: '550e8400-e29b-41d4-a716-446655440000',
    size: 'small',
    providerUuid: '660e8400-e29b-41d4-a716-446655440000',
    providerUrl: 'https://provider.example.com',
    createdAt: Date.now(),
    status: 'running',
    ...overrides,
  };
}

describe('appRegistry', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  // --- CRUD ---

  describe('CRUD operations', () => {
    it('returns empty array when no apps exist', () => {
      expect(getApps(ADDR_A)).toEqual([]);
    });

    it('adds and retrieves an app', () => {
      const app = makeApp();
      addApp(ADDR_A, app);

      const apps = getApps(ADDR_A);
      expect(apps).toHaveLength(1);
      expect(apps[0].name).toBe('my-app');
    });

    it('getApp returns app by name', () => {
      addApp(ADDR_A, makeApp({ name: 'alpha' }));
      addApp(ADDR_A, makeApp({ name: 'beta', leaseUuid: 'uuid-2' }));

      expect(getApp(ADDR_A, 'alpha')?.name).toBe('alpha');
      expect(getApp(ADDR_A, 'beta')?.name).toBe('beta');
      expect(getApp(ADDR_A, 'gamma')).toBeNull();
    });

    it('getAppByLease returns app by lease UUID', () => {
      const app = makeApp();
      addApp(ADDR_A, app);

      expect(getAppByLease(ADDR_A, app.leaseUuid)?.name).toBe('my-app');
      expect(getAppByLease(ADDR_A, 'nonexistent')).toBeNull();
    });

    it('updateApp modifies fields', () => {
      const app = makeApp();
      addApp(ADDR_A, app);

      const updated = updateApp(ADDR_A, app.leaseUuid, {
        status: 'stopped',
        url: 'https://myapp.example.com',
      });

      expect(updated?.status).toBe('stopped');
      expect(updated?.url).toBe('https://myapp.example.com');

      // Persisted
      const reloaded = getApp(ADDR_A, 'my-app');
      expect(reloaded?.status).toBe('stopped');
    });

    it('updateApp returns null for unknown lease', () => {
      expect(updateApp(ADDR_A, 'nonexistent', { status: 'stopped' })).toBeNull();
    });

    it('removeApp removes an app', () => {
      const app = makeApp();
      addApp(ADDR_A, app);

      expect(removeApp(ADDR_A, app.leaseUuid)).toBe(true);
      expect(getApps(ADDR_A)).toHaveLength(0);
    });

    it('removeApp returns false for unknown lease', () => {
      expect(removeApp(ADDR_A, 'nonexistent')).toBe(false);
    });

    it('round-trips customDomains across save/load via localStorage', () => {
      // Verifies that neither AppEntrySchema.safeParse on reload nor
      // sanitizeManifestForStorage (which only touches manifest env) drops
      // the customDomains field. Locks in the chain-cache shape that the
      // polling driver and the AppCard / CustomDomainCard rely on.
      const app = makeApp({
        customDomains: [
          { serviceName: '', customDomain: 'app.example.com' },
          { serviceName: 'web', customDomain: 'api.example.com' },
        ],
      });
      addApp(ADDR_A, app);

      // Fresh read goes through getApps → loadApps → AppEntrySchema.safeParse.
      const reloaded = getApps(ADDR_A);
      expect(reloaded).toHaveLength(1);
      expect(reloaded[0].customDomains).toEqual([
        { serviceName: '', customDomain: 'app.example.com' },
        { serviceName: 'web', customDomain: 'api.example.com' },
      ]);
    });
  });

  // --- Multi-wallet isolation ---

  describe('multi-wallet isolation', () => {
    it('apps are scoped per wallet address', () => {
      addApp(ADDR_A, makeApp({ name: 'app-a' }));
      addApp(ADDR_B, makeApp({ name: 'app-b' }));

      expect(getApps(ADDR_A)).toHaveLength(1);
      expect(getApps(ADDR_A)[0].name).toBe('app-a');

      expect(getApps(ADDR_B)).toHaveLength(1);
      expect(getApps(ADDR_B)[0].name).toBe('app-b');
    });

    it('removing from one wallet does not affect another', () => {
      const app = makeApp();
      addApp(ADDR_A, app);
      addApp(ADDR_B, makeApp({ name: 'other', leaseUuid: 'uuid-other' }));

      removeApp(ADDR_A, app.leaseUuid);
      expect(getApps(ADDR_A)).toHaveLength(0);
      expect(getApps(ADDR_B)).toHaveLength(1);
    });
  });

  // --- Name validation ---

  describe('validateAppName', () => {
    it('accepts valid names', () => {
      expect(validateAppName('my-app', ADDR_A)).toBeNull();
      expect(validateAppName('a', ADDR_A)).toBeNull();
      expect(validateAppName('app123', ADDR_A)).toBeNull();
      expect(validateAppName('a'.repeat(32), ADDR_A)).toBeNull();
    });

    it('rejects empty name', () => {
      expect(validateAppName('', ADDR_A)).toContain('required');
    });

    it('rejects name over 32 chars', () => {
      expect(validateAppName('a'.repeat(33), ADDR_A)).toContain('32');
    });

    it('rejects uppercase', () => {
      expect(validateAppName('MyApp', ADDR_A)).toContain('lowercase');
    });

    it('rejects leading hyphen', () => {
      expect(validateAppName('-app', ADDR_A)).toContain('lowercase');
    });

    it('rejects trailing hyphen', () => {
      expect(validateAppName('app-', ADDR_A)).toContain('lowercase');
    });

    it('rejects special characters', () => {
      expect(validateAppName('my_app', ADDR_A)).toContain('lowercase');
      expect(validateAppName('my.app', ADDR_A)).toContain('lowercase');
      expect(validateAppName('my app', ADDR_A)).toContain('lowercase');
    });

    it('rejects duplicate name within same wallet for running app', () => {
      addApp(ADDR_A, makeApp({ name: 'taken', status: 'running' }));
      expect(validateAppName('taken', ADDR_A)).toContain('is already running');
    });

    it('allows reusing name of stopped app', () => {
      addApp(ADDR_A, makeApp({ name: 'stopped-app', status: 'stopped' }));
      expect(validateAppName('stopped-app', ADDR_A)).toBeNull();
    });

    it('allows reusing name of failed app', () => {
      addApp(ADDR_A, makeApp({ name: 'failed-app', status: 'failed' }));
      expect(validateAppName('failed-app', ADDR_A)).toBeNull();
    });

    it('allows same name in different wallets', () => {
      addApp(ADDR_A, makeApp({ name: 'shared' }));
      expect(validateAppName('shared', ADDR_B)).toBeNull();
    });

    it('allows same name when excludeLeaseUuid matches existing', () => {
      const app = makeApp({ name: 'renamable' });
      addApp(ADDR_A, app);
      expect(validateAppName('renamable', ADDR_A, app.leaseUuid)).toBeNull();
    });
  });

  // --- Fuzzy name matching ---

  describe('findApp', () => {
    it('returns exact match', () => {
      addApp(ADDR_A, makeApp({ name: 'manifest-doom' }));
      expect(findApp(ADDR_A, 'manifest-doom')?.name).toBe('manifest-doom');
    });

    it('returns suffix match (e.g. "doom" matches "manifest-doom")', () => {
      addApp(ADDR_A, makeApp({ name: 'manifest-doom' }));
      expect(findApp(ADDR_A, 'doom')?.name).toBe('manifest-doom');
    });

    it('returns substring match', () => {
      addApp(ADDR_A, makeApp({ name: 'my-doom-app' }));
      expect(findApp(ADDR_A, 'doom')?.name).toBe('my-doom-app');
    });

    it('returns null when no match', () => {
      addApp(ADDR_A, makeApp({ name: 'manifest-tetris' }));
      expect(findApp(ADDR_A, 'doom')).toBeNull();
    });

    it('returns null on ambiguous match when multiple suffix matches exist', () => {
      addApp(ADDR_A, makeApp({ name: 'app-doom', leaseUuid: 'uuid-1' }));
      addApp(ADDR_A, makeApp({ name: 'game-doom', leaseUuid: 'uuid-2' }));
      expect(findApp(ADDR_A, 'doom')).toBeNull();
    });

    it('returns null on ambiguous substring match', () => {
      addApp(ADDR_A, makeApp({ name: 'my-doom-app', leaseUuid: 'uuid-1' }));
      addApp(ADDR_A, makeApp({ name: 'doom-runner', leaseUuid: 'uuid-2' }));
      expect(findApp(ADDR_A, 'doom')).toBeNull();
    });

    it('prefers active apps over stopped ones', () => {
      addApp(ADDR_A, makeApp({ name: 'manifest-doom', leaseUuid: 'uuid-1', status: 'stopped' }));
      addApp(ADDR_A, makeApp({ name: 'manifest-doom-2', leaseUuid: 'uuid-2', status: 'running' }));
      expect(findApp(ADDR_A, 'doom')?.name).toBe('manifest-doom-2');
    });

    it('prefers active exact match over stopped exact match', () => {
      // Write directly to localStorage to bypass addApp's dedup of stopped/failed entries
      const apps = [
        makeApp({ name: 'doom', leaseUuid: 'uuid-old', status: 'stopped' }),
        makeApp({ name: 'doom', leaseUuid: 'uuid-new', status: 'running' }),
      ];
      localStorage.setItem(`barney-apps-${ADDR_A}`, JSON.stringify(apps));
      const result = findApp(ADDR_A, 'doom');
      expect(result?.leaseUuid).toBe('uuid-new');
      expect(result?.status).toBe('running');
    });

    it('prefers active suffix match over stopped exact match', () => {
      addApp(ADDR_A, makeApp({ name: 'doom', leaseUuid: 'uuid-old', status: 'stopped' }));
      addApp(ADDR_A, makeApp({ name: 'manifest-doom', leaseUuid: 'uuid-new', status: 'running' }));
      const result = findApp(ADDR_A, 'doom');
      expect(result?.name).toBe('manifest-doom');
      expect(result?.status).toBe('running');
    });

    it('returns null when active fuzzy matches are ambiguous even if stopped exact exists', () => {
      // Write directly to localStorage: stopped exact "doom" + two active fuzzy matches
      const apps = [
        makeApp({ name: 'doom', leaseUuid: 'uuid-stopped', status: 'stopped' }),
        makeApp({ name: 'manifest-doom', leaseUuid: 'uuid-1', status: 'running' }),
        makeApp({ name: 'super-doom', leaseUuid: 'uuid-2', status: 'running' }),
      ];
      localStorage.setItem(`barney-apps-${ADDR_A}`, JSON.stringify(apps));
      expect(findApp(ADDR_A, 'doom')).toBeNull();
    });

    it('falls back to stopped exact match when no active matches', () => {
      addApp(ADDR_A, makeApp({ name: 'doom', leaseUuid: 'uuid-old', status: 'stopped' }));
      const result = findApp(ADDR_A, 'doom');
      expect(result?.name).toBe('doom');
      expect(result?.status).toBe('stopped');
    });
  });

  // --- Reconciliation ---

  describe('reconcileWithChain', () => {
    it('marks running apps as stopped when lease is no longer active', () => {
      const app = makeApp({ status: 'running' });
      addApp(ADDR_A, app);

      reconcileWithChain(ADDR_A, new Map());

      const updated = getApp(ADDR_A, app.name);
      expect(updated?.status).toBe('stopped');
    });

    it('marks deploying apps as stopped when lease is no longer active', () => {
      const app = makeApp({ status: 'deploying' });
      addApp(ADDR_A, app);

      reconcileWithChain(ADDR_A, new Map());

      expect(getApp(ADDR_A, app.name)?.status).toBe('stopped');
    });

    it('does not change apps whose leases are still active', () => {
      const app = makeApp({ status: 'running' });
      addApp(ADDR_A, app);

      reconcileWithChain(ADDR_A, new Map([[app.leaseUuid, 'active']]));

      expect(getApp(ADDR_A, app.name)?.status).toBe('running');
    });

    it('does not change already-stopped apps when lease is not active', () => {
      const app = makeApp({ status: 'stopped' });
      addApp(ADDR_A, app);

      reconcileWithChain(ADDR_A, new Map());

      expect(getApp(ADDR_A, app.name)?.status).toBe('stopped');
    });

    it('restores stopped apps to running when lease is active on-chain', () => {
      const app = makeApp({ status: 'stopped' });
      addApp(ADDR_A, app);

      reconcileWithChain(ADDR_A, new Map([[app.leaseUuid, 'active']]));

      expect(getApp(ADDR_A, app.name)?.status).toBe('running');
    });

    it('restores stopped apps to deploying when lease is pending on-chain', () => {
      const app = makeApp({ status: 'stopped' });
      addApp(ADDR_A, app);

      reconcileWithChain(ADDR_A, new Map([[app.leaseUuid, 'pending']]));

      expect(getApp(ADDR_A, app.name)?.status).toBe('deploying');
    });

    it('keeps failed apps as failed when lease is not active', () => {
      const app = makeApp({ status: 'failed' });
      addApp(ADDR_A, app);

      reconcileWithChain(ADDR_A, new Map());

      expect(getApp(ADDR_A, app.name)?.status).toBe('failed');
    });

    it('restores failed apps to running when lease is active on-chain', () => {
      const app = makeApp({ status: 'failed' });
      addApp(ADDR_A, app);

      reconcileWithChain(ADDR_A, new Map([[app.leaseUuid, 'active']]));

      expect(getApp(ADDR_A, app.name)?.status).toBe('running');
    });

    it('restores failed apps to deploying when lease is pending on-chain', () => {
      const app = makeApp({ status: 'failed' });
      addApp(ADDR_A, app);

      reconcileWithChain(ADDR_A, new Map([[app.leaseUuid, 'pending']]));

      expect(getApp(ADDR_A, app.name)?.status).toBe('deploying');
    });

    it('promotes deploying apps to running when lease is active on-chain', () => {
      const app = makeApp({ status: 'deploying' });
      addApp(ADDR_A, app);

      reconcileWithChain(ADDR_A, new Map([[app.leaseUuid, 'active']]));

      expect(getApp(ADDR_A, app.name)?.status).toBe('running');
    });

    it('keeps deploying apps as deploying when lease is still pending on-chain', () => {
      const app = makeApp({ status: 'deploying' });
      addApp(ADDR_A, app);

      reconcileWithChain(ADDR_A, new Map([[app.leaseUuid, 'pending']]));

      expect(getApp(ADDR_A, app.name)?.status).toBe('deploying');
    });
  });

  // --- Derived status from independent observations (F4) ---
  //
  // `status` is a DERIVED summary of two orthogonal observations:
  //   chainState     — what the chain said about the lease
  //   provisionState — what the provider said about provisioning
  // Both are optional; absent means "never observed" (conditions-style Unknown).

  describe('deriveAppStatus', () => {
    const ALL_LEGACY: AppStatus[] = ['deploying', 'running', 'stopped', 'failed'];

    /**
     * Full truth table over chainState × provisionState.
     *
     * 14 of the 16 cells are decided entirely by the observations, so each is
     * asserted against ALL four possible legacy `status` values — that is the
     * point of the refactor: once an observation exists, the remembered intent
     * in `status` no longer influences the outcome.
     *
     * The two cells that DO consult the legacy `status` are enumerated
     * separately below.
     */
    const observationDecidedCells: {
      chainState: ChainState | undefined;
      provisionState: ProvisionState | undefined;
      expected: AppStatus;
      why: string;
    }[] = [
      // --- provisionState 'failed' — rule 1, outranks every chain observation ---
      { chainState: undefined, provisionState: 'failed', expected: 'failed', why: 'provider verdict, no chain observation' },
      { chainState: 'active', provisionState: 'failed', expected: 'failed', why: 'F4 core: ACTIVE lease does NOT mean the workload runs' },
      { chainState: 'pending', provisionState: 'failed', expected: 'failed', why: 'provider verdict outranks a pending lease' },
      { chainState: 'absent', provisionState: 'failed', expected: 'failed', why: 'rule 1 beats rule 2: keep the diagnosis, not a bare "stopped"' },

      // --- chainState 'absent' with a provider observation — rule 2 ---
      { chainState: 'absent', provisionState: 'confirmed', expected: 'stopped', why: 'lease gone after a clean deploy = a clean stop' },
      { chainState: 'absent', provisionState: 'unconfirmed', expected: 'stopped', why: 'rule 2 beats rule 3: a gone lease is not still deploying' },

      // --- provisionState 'unconfirmed' — rule 3 ---
      { chainState: undefined, provisionState: 'unconfirmed', expected: 'deploying', why: '"we never found out" is not "running"' },
      { chainState: 'active', provisionState: 'unconfirmed', expected: 'deploying', why: 'F4 core: chain-ACTIVE must not promote an unconfirmed deploy' },
      { chainState: 'pending', provisionState: 'unconfirmed', expected: 'deploying', why: 'nothing observed as ready' },

      // --- provisionState 'confirmed' — rule 4 ---
      { chainState: undefined, provisionState: 'confirmed', expected: 'running', why: 'deploy just succeeded, chain not yet re-read' },
      { chainState: 'active', provisionState: 'confirmed', expected: 'running', why: 'both observations agree' },
      { chainState: 'pending', provisionState: 'confirmed', expected: 'deploying', why: 'lease not active yet' },

      // --- no provider observation — rule 5 chain-only inference ---
      { chainState: 'active', provisionState: undefined, expected: 'running', why: 'legacy entry, honest chain-only inference' },
      { chainState: 'pending', provisionState: undefined, expected: 'deploying', why: 'legacy entry, honest chain-only inference' },
    ];

    it.each(observationDecidedCells)(
      'chain=$chainState provision=$provisionState -> $expected ($why)',
      ({ chainState, provisionState, expected }) => {
        for (const status of ALL_LEGACY) {
          expect(
            deriveAppStatus({ chainState, provisionState, status }),
            `legacy status "${status}" must not change the outcome`
          ).toBe(expected);
        }
      }
    );

    // --- Cell (chain: undefined, provision: undefined): legacy status verbatim ---
    it.each(ALL_LEGACY)(
      'no observation at all returns the stored legacy status verbatim (%s)',
      (status) => {
        expect(deriveAppStatus({ chainState: undefined, provisionState: undefined, status })).toBe(status);
      }
    );

    // --- Cell (chain: 'absent', provision: undefined): the legacy carve-out ---
    // Resolves the "rule 1 vs rule 3" question from the existing suite's
    // `keeps failed apps as failed when lease is not active`: with no provider
    // observation, `status` is the only surviving record of a failure, and
    // chain-absence is no evidence about *why*. 'failed' is strictly more
    // informative than 'stopped' and both are terminal, so keep the diagnosis.
    it.each<[AppStatus, AppStatus]>([
      ['failed', 'failed'],
      ['running', 'stopped'],
      ['deploying', 'stopped'],
      ['stopped', 'stopped'],
    ])('legacy entry with absent lease: status %s -> %s', (status, expected) => {
      expect(deriveAppStatus({ chainState: 'absent', provisionState: undefined, status })).toBe(expected);
    });

    it('is idempotent — re-deriving from a derived entry is stable', () => {
      for (const chainState of [undefined, 'active', 'pending', 'absent'] as const) {
        for (const provisionState of [undefined, 'confirmed', 'unconfirmed', 'failed'] as const) {
          for (const status of ALL_LEGACY) {
            const once = deriveAppStatus({ chainState, provisionState, status });
            const twice = deriveAppStatus({ chainState, provisionState, status: once });
            expect(twice, `chain=${String(chainState)} provision=${String(provisionState)} status=${status}`).toBe(once);
          }
        }
      }
    });
  });

  describe('observation fields round-trip and derivation on write', () => {
    it('persists chainState / provisionState through the schema (not stripped or rejected)', () => {
      // AppEntrySchema is a plain z.object (strips unknown keys, never .strict()),
      // so the new fields MUST be declared or they silently vanish on reload.
      addApp(ADDR_A, makeApp({ status: 'running', chainState: 'active', provisionState: 'confirmed' }));

      const reloaded = getApp(ADDR_A, 'my-app');
      expect(reloaded?.chainState).toBe('active');
      expect(reloaded?.provisionState).toBe('confirmed');
    });

    it('addApp derives status from the observations, ignoring an asserted status', () => {
      addApp(ADDR_A, makeApp({ status: 'running', provisionState: 'failed' }));
      expect(getApp(ADDR_A, 'my-app')?.status).toBe('failed');
    });

    it('addApp keeps an observation-free entry exactly as passed (legacy call sites)', () => {
      addApp(ADDR_A, makeApp({ status: 'deploying' }));
      expect(getApp(ADDR_A, 'my-app')?.status).toBe('deploying');
    });

    it('updateApp re-derives status when a writer records an observation', () => {
      const app = makeApp({ status: 'deploying' });
      addApp(ADDR_A, app);

      const updated = updateApp(ADDR_A, app.leaseUuid, { provisionState: 'confirmed' });

      expect(updated?.provisionState).toBe('confirmed');
      expect(updated?.status).toBe('running');
    });

    it('updateApp with only a legacy status and no observations still honours it', () => {
      const app = makeApp({ status: 'running' });
      addApp(ADDR_A, app);

      expect(updateApp(ADDR_A, app.leaseUuid, { status: 'stopped' })?.status).toBe('stopped');
    });

    it('an observation outranks a later asserted status', () => {
      const app = makeApp({ status: 'deploying', provisionState: 'failed' });
      addApp(ADDR_A, app);

      // A writer that still thinks in terms of `status` cannot resurrect an
      // app the provider reported as failed.
      expect(updateApp(ADDR_A, app.leaseUuid, { status: 'running' })?.status).toBe('failed');
    });

    it('a writer with no observation leaves provisionState untouched (abort / UPDATE_INDETERMINATE)', () => {
      // This is the F1 principle expressed in the data model: abort paths and
      // UPDATE_INDETERMINATE have observed NOTHING, so they must not invent an
      // observation — and updateApp must not clobber the one already there.
      const app = makeApp({ status: 'running', chainState: 'active', provisionState: 'confirmed' });
      addApp(ADDR_A, app);

      const updated = updateApp(ADDR_A, app.leaseUuid, { url: 'https://x.example.com' });

      expect(updated?.provisionState).toBe('confirmed');
      expect(updated?.chainState).toBe('active');
      expect(updated?.status).toBe('running');
    });

    it('an entry with no prior observation stays observation-free after an unrelated update', () => {
      const app = makeApp({ status: 'deploying' });
      addApp(ADDR_A, app);

      const updated = updateApp(ADDR_A, app.leaseUuid, { url: 'https://x.example.com' });

      expect(updated?.provisionState).toBeUndefined();
      expect(updated?.chainState).toBeUndefined();
      expect(updated?.status).toBe('deploying');
    });
  });

  // `updateApp` used to notify UNCONDITIONALLY, which is why a writer on a
  // timer could only afford the NEGATIVE observation: `executeListApps` writes
  // `chainState: 'absent'` every 15s tick but never the matching 'active',
  // because re-asserting a positive would re-render the whole sidebar for
  // nothing. That makes `provisionState`/`chainState` one-way trapdoors —
  // latchable negative, never refreshable positive. These tests pin the
  // persist-vs-notify split that makes re-observation cheap.
  describe('updateApp persist-vs-notify split', () => {
    /** Spy that lets writes through but counts them.
     *  Spy the `localStorage` INSTANCE, not `Storage.prototype` — happy-dom
     *  fronts its Storage with a Proxy, so a prototype spy is never reached
     *  and every `toHaveBeenCalled` assertion would vacuously pass. */
    function spyOnSetItem() {
      return vi.spyOn(localStorage, 'setItem');
    }

    it('persists a status-neutral observation refresh without notifying subscribers', () => {
      // THE point of this round. A positive chain observation on an app that is
      // already 'running' moves nothing a subscriber renders, so it must be
      // stored silently — otherwise no writer can afford to record it at all.
      const app = makeApp({ status: 'running' });
      addApp(ADDR_A, app);
      const listener = vi.fn();
      const unsub = subscribeToRegistry(listener);
      try {
        const updated = updateApp(ADDR_A, app.leaseUuid, { chainState: 'active' });

        expect(listener).not.toHaveBeenCalled();
        expect(updated?.status).toBe('running');
        // Persisted, not merely returned: re-read through localStorage.
        expect(getApp(ADDR_A, app.name)?.chainState).toBe('active');
      } finally { unsub(); }
    });

    it('persists a status-neutral provisionState refresh without notifying', () => {
      // Same for the provider observation: an app already derived 'running'
      // from chain-active gets its readiness verdict confirmed. Nothing moves.
      const app = makeApp({ status: 'running', chainState: 'active' });
      addApp(ADDR_A, app);
      const listener = vi.fn();
      const unsub = subscribeToRegistry(listener);
      try {
        updateApp(ADDR_A, app.leaseUuid, { provisionState: 'confirmed' });

        expect(listener).not.toHaveBeenCalled();
        expect(getApp(ADDR_A, app.name)?.provisionState).toBe('confirmed');
        expect(getApp(ADDR_A, app.name)?.status).toBe('running');
      } finally { unsub(); }
    });

    it('re-asserting an observation already stored writes nothing at all', () => {
      // The steady-state cost of re-observation on a 15s timer: after the
      // first write, every subsequent tick is free — no JSON.stringify, no
      // localStorage write, no notify.
      const app = makeApp({ status: 'running', chainState: 'active' });
      addApp(ADDR_A, app);
      const listener = vi.fn();
      const unsub = subscribeToRegistry(listener);
      const setItem = spyOnSetItem();
      try {
        const updated = updateApp(ADDR_A, app.leaseUuid, { chainState: 'active' });

        expect(setItem).not.toHaveBeenCalled();
        expect(listener).not.toHaveBeenCalled();
        // Still returns the entry — callers read `.status` off the result.
        expect(updated?.status).toBe('running');
      } finally { setItem.mockRestore(); unsub(); }
    });

    it('still notifies when the observation MOVES the derived status', () => {
      // The negative transition the sidebar exists to show. Silence here would
      // be the bug the split must not introduce.
      const app = makeApp({ status: 'running', chainState: 'active' });
      addApp(ADDR_A, app);
      const listener = vi.fn();
      const unsub = subscribeToRegistry(listener);
      try {
        const updated = updateApp(ADDR_A, app.leaseUuid, { provisionState: 'failed' });

        expect(updated?.status).toBe('failed');
        expect(listener).toHaveBeenCalledWith(ADDR_A);
      } finally { unsub(); }
    });

    it('notifies when derivation moves status even though the caller asked for something else', () => {
      // `status` is derived, so a "status-neutral" judgement must be made on
      // the DERIVED value, not on whether the caller passed `status`.
      const app = makeApp({ status: 'running', chainState: 'active', provisionState: 'unconfirmed' });
      addApp(ADDR_A, app);
      expect(getApp(ADDR_A, app.name)?.status).toBe('deploying');
      const listener = vi.fn();
      const unsub = subscribeToRegistry(listener);
      try {
        // Only an observation field is written, yet the summary moves
        // deploying → running. Must notify.
        const updated = updateApp(ADDR_A, app.leaseUuid, { provisionState: 'confirmed' });

        expect(updated?.status).toBe('running');
        expect(listener).toHaveBeenCalledWith(ADDR_A);
      } finally { unsub(); }
    });

    it('notifies on a change to customDomains (rendered by the sidebar and the DNS driver)', () => {
      const app = makeApp({ status: 'running', chainState: 'active' });
      addApp(ADDR_A, app);
      const listener = vi.fn();
      const unsub = subscribeToRegistry(listener);
      try {
        updateApp(ADDR_A, app.leaseUuid, {
          customDomains: [{ serviceName: 'web', customDomain: 'app.example.com' }],
        });

        expect(listener).toHaveBeenCalledWith(ADDR_A);
      } finally { unsub(); }
    });

    // ---- customDomains: the one field a REPEATABLE writer rebuilds fresh ----
    //
    // Every OTHER writer of a reference-typed field runs once per user action
    // (deploy, set_custom_domain). `customDomains` is different:
    // `executeAppStatus` refreshes it on EVERY status check via
    // `getDomainAssignments(leaseItems)`, which allocates a new array each
    // time. Under plain reference equality that reads as "changed" on every
    // single call.
    //
    // The notify is the expensive half, not the write. `useRegistryApps`
    // rebuilds its array on every notify, `useDnsStatusPolling` memoizes
    // `allTargets` on that array's identity, and its
    // `useEffect(() => () => abortRef.current?.abort(), [allTargets])` aborts
    // every in-flight DoH/HTTPS probe when it changes. So a user watching a
    // pending custom domain and re-running app_status to check on it was
    // cancelling the very probe that would have told them it had resolved.
    //
    // Value equality for this one field is what makes the refresh a true
    // re-observation instead of a self-defeating one.
    it('treats an identical customDomains refresh as a no-op (app_status runs it on every call)', () => {
      const domains = [
        { serviceName: 'web', customDomain: 'app.example.com' },
        { serviceName: 'api', customDomain: 'api.example.com' },
      ];
      const app = makeApp({ status: 'running', chainState: 'active', customDomains: domains });
      addApp(ADDR_A, app);
      const listener = vi.fn();
      const unsub = subscribeToRegistry(listener);
      const setItem = spyOnSetItem();
      try {
        // A DIFFERENT array with the SAME contents — exactly what
        // `getDomainAssignments` hands back on the next status check.
        const updated = updateApp(ADDR_A, app.leaseUuid, {
          customDomains: domains.map((d) => ({ ...d })),
        });

        expect(setItem).not.toHaveBeenCalled();
        expect(listener).not.toHaveBeenCalled();
        expect(updated?.customDomains).toEqual(domains);
      } finally { setItem.mockRestore(); unsub(); }
    });

    it('notifies when a domain is ADDED to the cache', () => {
      const app = makeApp({
        status: 'running', chainState: 'active',
        customDomains: [{ serviceName: 'web', customDomain: 'app.example.com' }],
      });
      addApp(ADDR_A, app);
      const listener = vi.fn();
      const unsub = subscribeToRegistry(listener);
      try {
        updateApp(ADDR_A, app.leaseUuid, {
          customDomains: [
            { serviceName: 'web', customDomain: 'app.example.com' },
            { serviceName: 'api', customDomain: 'api.example.com' },
          ],
        });

        expect(listener).toHaveBeenCalledWith(ADDR_A);
      } finally { unsub(); }
    });

    it('notifies when a domain is CLEARED from the cache', () => {
      // set_custom_domain('') — the DNS driver must stop watching it.
      const app = makeApp({
        status: 'running', chainState: 'active',
        customDomains: [{ serviceName: 'web', customDomain: 'app.example.com' }],
      });
      addApp(ADDR_A, app);
      const listener = vi.fn();
      const unsub = subscribeToRegistry(listener);
      try {
        updateApp(ADDR_A, app.leaseUuid, { customDomains: [] });

        expect(listener).toHaveBeenCalledWith(ADDR_A);
        expect(getApp(ADDR_A, app.name)?.customDomains).toEqual([]);
      } finally { unsub(); }
    });

    it('notifies when a domain is RE-POINTED on the same service', () => {
      // Same length, same serviceName, different FQDN. A length-only check
      // would miss this and leave the sidebar showing the old domain.
      const app = makeApp({
        status: 'running', chainState: 'active',
        customDomains: [{ serviceName: 'web', customDomain: 'old.example.com' }],
      });
      addApp(ADDR_A, app);
      const listener = vi.fn();
      const unsub = subscribeToRegistry(listener);
      try {
        updateApp(ADDR_A, app.leaseUuid, {
          customDomains: [{ serviceName: 'web', customDomain: 'new.example.com' }],
        });

        expect(listener).toHaveBeenCalledWith(ADDR_A);
        expect(getApp(ADDR_A, app.name)?.customDomains).toEqual([
          { serviceName: 'web', customDomain: 'new.example.com' },
        ]);
      } finally { unsub(); }
    });

    it('notifies when the same FQDN MOVES to a different service', () => {
      const app = makeApp({
        status: 'running', chainState: 'active',
        customDomains: [{ serviceName: 'web', customDomain: 'app.example.com' }],
      });
      addApp(ADDR_A, app);
      const listener = vi.fn();
      const unsub = subscribeToRegistry(listener);
      try {
        updateApp(ADDR_A, app.leaseUuid, {
          customDomains: [{ serviceName: 'api', customDomain: 'app.example.com' }],
        });

        expect(listener).toHaveBeenCalledWith(ADDR_A);
      } finally { unsub(); }
    });

    // `connection` has the SAME shape of problem, from the same call site.
    // `executeAppStatus` rebuilds it every call via
    // `JSON.parse(JSON.stringify(conn))` off the provider's connection-info
    // response, so it too is reference-new on every status check. Unlike
    // `customDomains` it is NOT in the observation deny-list (the DNS driver
    // reads it, via `resolveExpectedCnameTarget`), so a reference-new value
    // notified — and aborted the probes — every single time.
    it('treats an identical connection refresh as a no-op', () => {
      const conn = {
        host: 'app.provider.example.com',
        fqdn: 'app.provider.example.com',
        ports: { '80': { proto: 'tcp' } },
        services: { web: { fqdn: 'web.provider.example.com' } },
      };
      const app = makeApp({ status: 'running', chainState: 'active', connection: conn });
      addApp(ADDR_A, app);
      const listener = vi.fn();
      const unsub = subscribeToRegistry(listener);
      const setItem = spyOnSetItem();
      try {
        // The exact round-trip executeAppStatus performs.
        const updated = updateApp(ADDR_A, app.leaseUuid, {
          connection: JSON.parse(JSON.stringify(conn)),
        });

        expect(setItem).not.toHaveBeenCalled();
        expect(listener).not.toHaveBeenCalled();
        expect(updated?.connection).toEqual(conn);
      } finally { setItem.mockRestore(); unsub(); }
    });

    // The fixture above cannot actually exercise the bug: its keys already sit
    // in schema-relative order and it carries nothing the schema drops, so a
    // raw JSON comparison happens to succeed. A REAL fred `/connection` body
    // fails it twice over — zod rebuilds in SCHEMA key order (metadata before
    // services) and strips `protocol`, which fred sends and AppEntrySchema does
    // not model:
    //   fred wire : host, fqdn, ports, instances, services, protocol, metadata
    //   stored    : host, fqdn, ports, instances, metadata, services
    // So the stored copy could never JSON-match its own next read, and
    // app_status wrote + notified on EVERY call — aborting the in-flight DNS
    // probe it was invoked to check on. This pins the normalize-both-sides fix.
    it('treats a real fred connection refresh as a no-op despite key reordering and an unmodelled field', () => {
      const fredWire = {
        host: '1.2.3.4',
        fqdn: 'app.provider.example.com',
        ports: { '80': { proto: 'tcp' } },
        instances: [{ fqdn: 'i0.provider.example.com', ports: { '80': { proto: 'tcp' } } }],
        services: { web: { fqdn: 'web.provider.example.com' } },
        protocol: 'http', // fred sends it; AppEntrySchema does not model it
        metadata: { region: 'us-east' },
      };
      const app = makeApp({ status: 'running', chainState: 'active', connection: fredWire });
      addApp(ADDR_A, app);
      const listener = vi.fn();
      const unsub = subscribeToRegistry(listener);
      const setItem = spyOnSetItem();
      try {
        // executeAppStatus hands back the provider body verbatim, protocol and all.
        updateApp(ADDR_A, app.leaseUuid, {
          connection: JSON.parse(JSON.stringify(fredWire)) as typeof fredWire,
        });

        expect(setItem).not.toHaveBeenCalled();
        expect(listener).not.toHaveBeenCalled();
      } finally { setItem.mockRestore(); unsub(); }
    });

    it('notifies when the connection actually changes (new FQDN after a re-provision)', () => {
      const app = makeApp({
        status: 'running', chainState: 'active',
        connection: { host: 'old.provider.example.com' },
      });
      addApp(ADDR_A, app);
      const listener = vi.fn();
      const unsub = subscribeToRegistry(listener);
      try {
        updateApp(ADDR_A, app.leaseUuid, { connection: { host: 'new.provider.example.com' } });

        expect(listener).toHaveBeenCalledWith(ADDR_A);
        expect(getApp(ADDR_A, app.name)?.connection?.host).toBe('new.provider.example.com');
      } finally { unsub(); }
    });

    it('notifies when a connection appears for the first time', () => {
      // undefined → a value is a real change, not an "unchanged" no-op.
      const app = makeApp({ status: 'running', chainState: 'active' });
      addApp(ADDR_A, app);
      const listener = vi.fn();
      const unsub = subscribeToRegistry(listener);
      try {
        updateApp(ADDR_A, app.leaseUuid, { connection: { host: 'app.provider.example.com' } });

        expect(listener).toHaveBeenCalledWith(ADDR_A);
      } finally { unsub(); }
    });

    it('compares customDomains POSITIONALLY, so a reorder still notifies', () => {
      // Deliberate, and documented so nobody "optimises" it into a set
      // comparison later. The comparison exists to kill a per-call no-op, not
      // to be maximally clever; a reorder falls to the LOUD side, which is the
      // safe direction for a field two subscribers render.
      const a = { serviceName: 'web', customDomain: 'app.example.com' };
      const b = { serviceName: 'api', customDomain: 'api.example.com' };
      const app = makeApp({ status: 'running', chainState: 'active', customDomains: [a, b] });
      addApp(ADDR_A, app);
      const listener = vi.fn();
      const unsub = subscribeToRegistry(listener);
      try {
        updateApp(ADDR_A, app.leaseUuid, { customDomains: [{ ...b }, { ...a }] });

        expect(listener).toHaveBeenCalledWith(ADDR_A);
      } finally { unsub(); }
    });

    it('notifies on a change to connection (read by useDnsStatusPolling for the CNAME target)', () => {
      const app = makeApp({ status: 'running', chainState: 'active' });
      addApp(ADDR_A, app);
      const listener = vi.fn();
      const unsub = subscribeToRegistry(listener);
      try {
        updateApp(ADDR_A, app.leaseUuid, { connection: { host: 'h.example.com' } });

        expect(listener).toHaveBeenCalledWith(ADDR_A);
      } finally { unsub(); }
    });

    it.each([
      ['name', { name: 'renamed-app' }],
      ['size', { size: 'large' }],
      ['manifest', { manifest: '{"services":{"a":{},"b":{}}}' }],
      ['url', { url: 'https://x.example.com' }],
    ] as const)('notifies on a change to %s (outside the observation deny-list)', (_label, updates) => {
      // `url` is deliberately included: no subscriber reads it TODAY, but the
      // predicate is a deny-list of the two observation fields, so anything
      // else defaults to notifying. Locks that default in.
      const app = makeApp({ status: 'running', chainState: 'active' });
      addApp(ADDR_A, app);
      const listener = vi.fn();
      const unsub = subscribeToRegistry(listener);
      try {
        updateApp(ADDR_A, app.leaseUuid, updates);

        expect(listener).toHaveBeenCalledWith(ADDR_A);
      } finally { unsub(); }
    });

    it('notifies when an observation is bundled with a rendered field change', () => {
      // The deploy-success shape: one call carries both the provider verdict
      // and the URL/connection the UI shows. The silent path must not swallow
      // the whole call just because one of its fields is an observation.
      const app = makeApp({ status: 'running', chainState: 'active', provisionState: 'confirmed' });
      addApp(ADDR_A, app);
      const listener = vi.fn();
      const unsub = subscribeToRegistry(listener);
      try {
        updateApp(ADDR_A, app.leaseUuid, {
          provisionState: 'confirmed', // unchanged
          url: 'https://new.example.com', // changed, and rendered
        });

        expect(listener).toHaveBeenCalledWith(ADDR_A);
      } finally { unsub(); }
    });

    it('a save failure still suppresses notify', () => {
      // Pre-existing behaviour, re-pinned because the notify call moved behind
      // a predicate: subscribers re-read from localStorage, so notifying after
      // a failed write would mask the failure with a stale no-op refresh.
      const app = makeApp({ status: 'running', chainState: 'active' });
      addApp(ADDR_A, app);
      const listener = vi.fn();
      const unsub = subscribeToRegistry(listener);
      const setItem = spyOnSetItem().mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });
      try {
        // A change that WOULD be visible, so only the save failure can be
        // what suppresses the notify.
        const updated = updateApp(ADDR_A, app.leaseUuid, { provisionState: 'failed' });

        expect(setItem).toHaveBeenCalled();
        expect(listener).not.toHaveBeenCalled();
        // Caller still gets the would-be entry back.
        expect(updated?.status).toBe('failed');
      } finally { setItem.mockRestore(); unsub(); }
      // ...and nothing was persisted.
      expect(getApp(ADDR_A, app.name)?.status).toBe('running');
    });
  });

  describe('reconcileWithChain records only the chain observation (F4)', () => {
    it('keeps a provider-failed app failed even when its lease is ACTIVE on-chain', () => {
      // THE F4 regression test. fred v0.13.0 reconciler.go:1442 models exactly
      // this state ("Lease is active but the container has crashed/exited") and
      // only closes the lease once FailCount >= maxReprovisionAttempts — so an
      // ACTIVE lease is NO evidence that the workload runs.
      const app = makeApp({ status: 'failed', provisionState: 'failed' });
      addApp(ADDR_A, app);

      reconcileWithChain(ADDR_A, new Map([[app.leaseUuid, 'active']]));

      const after = getApp(ADDR_A, app.name);
      expect(after?.status).toBe('failed');
      expect(after?.provisionState).toBe('failed');
      expect(after?.chainState).toBe('active');
    });

    it('keeps a provider-failed app failed across REPEATED reconcile passes', () => {
      // The real-world bug was a 15s AUTO_REFRESH_INTERVAL_MS tick reverting the
      // verdict, so once is not enough — assert it is a fixed point.
      const app = makeApp({ status: 'failed', provisionState: 'failed' });
      addApp(ADDR_A, app);

      for (let i = 0; i < 3; i++) {
        reconcileWithChain(ADDR_A, new Map([[app.leaseUuid, 'active']]));
      }

      expect(getApp(ADDR_A, app.name)?.status).toBe('failed');
    });

    it('keeps a readiness-unconfirmed app deploying when its lease is ACTIVE on-chain', () => {
      const app = makeApp({ status: 'deploying', provisionState: 'unconfirmed' });
      addApp(ADDR_A, app);

      reconcileWithChain(ADDR_A, new Map([[app.leaseUuid, 'active']]));

      const after = getApp(ADDR_A, app.name);
      expect(after?.status).toBe('deploying');
      expect(after?.provisionState).toBe('unconfirmed');
      expect(after?.chainState).toBe('active');
    });

    it('keeps a provider-failed app failed when its lease is PENDING on-chain', () => {
      const app = makeApp({ status: 'failed', provisionState: 'failed' });
      addApp(ADDR_A, app);

      reconcileWithChain(ADDR_A, new Map([[app.leaseUuid, 'pending']]));

      expect(getApp(ADDR_A, app.name)?.status).toBe('failed');
    });

    it('marks a provider-confirmed app stopped once its lease leaves the chain', () => {
      const app = makeApp({ status: 'running', chainState: 'active', provisionState: 'confirmed' });
      addApp(ADDR_A, app);

      reconcileWithChain(ADDR_A, new Map());

      const after = getApp(ADDR_A, app.name);
      expect(after?.status).toBe('stopped');
      expect(after?.chainState).toBe('absent');
      // The provider observation is NOT clobbered — reconcile observed the
      // chain, and only the chain.
      expect(after?.provisionState).toBe('confirmed');
    });

    it('marks an unconfirmed app stopped once its lease leaves the chain (no eternal spinner)', () => {
      // Rule 2 ahead of rule 3: 'deploying' is the one non-terminal label — it
      // spins in the sidebar AND blocks name reuse in validateAppName.
      const app = makeApp({ status: 'deploying', provisionState: 'unconfirmed' });
      addApp(ADDR_A, app);

      reconcileWithChain(ADDR_A, new Map());

      expect(getApp(ADDR_A, app.name)?.status).toBe('stopped');
      expect(validateAppName(app.name, ADDR_A)).toBeNull();
    });

    it('records chainState absent for a lease missing from the chain set', () => {
      const app = makeApp({ status: 'running' });
      addApp(ADDR_A, app);

      reconcileWithChain(ADDR_A, new Map());

      expect(getApp(ADDR_A, app.name)?.chainState).toBe('absent');
    });

    it('does not invent a provisionState for a legacy entry', () => {
      const app = makeApp({ status: 'running' });
      addApp(ADDR_A, app);

      reconcileWithChain(ADDR_A, new Map([[app.leaseUuid, 'active']]));

      expect(getApp(ADDR_A, app.name)?.provisionState).toBeUndefined();
    });

    /** Seed a byte-for-byte pre-refactor entry: no observation keys at all. */
    function seedLegacy(status: AppStatus): AppEntry {
      const app = makeApp({ status });
      localStorage.setItem(`barney-apps-${ADDR_A}`, JSON.stringify([app]));
      expect(getApp(ADDR_A, app.name)?.chainState).toBeUndefined();
      expect(getApp(ADDR_A, app.name)?.provisionState).toBeUndefined();
      return app;
    }

    it('reconciles a legacy entry (no observation fields) exactly as before', () => {
      // Locks in that the migration is behaviour-preserving for the entries
      // already sitting in users' localStorage. Expectations below were read
      // off the pre-refactor branches (`git show HEAD:src/registry/appRegistry.ts`),
      // not off the new implementation.
      //
      // The 11 cells the old three-branch cascade actually decided. The single
      // 12th cell it left untouched (running + pending) is asserted separately
      // below, because it DOES change.
      const cases: [AppStatus, 'active' | 'pending' | null, AppStatus][] = [
        // branch 1: (running|deploying) && !chainState -> stopped
        ['running', null, 'stopped'],
        ['deploying', null, 'stopped'],
        // no branch matched -> unchanged
        ['stopped', null, 'stopped'],
        ['failed', null, 'failed'],
        ['running', 'active', 'running'],
        ['deploying', 'pending', 'deploying'],
        // branch 2: (failed|stopped) && chainState -> active?running:deploying
        ['stopped', 'active', 'running'],
        ['failed', 'active', 'running'],
        ['stopped', 'pending', 'deploying'],
        ['failed', 'pending', 'deploying'],
        // branch 3: deploying && active -> running
        ['deploying', 'active', 'running'],
      ];

      for (const [initial, chain, expected] of cases) {
        localStorage.clear();
        const app = seedLegacy(initial);

        reconcileWithChain(ADDR_A, chain ? new Map([[app.leaseUuid, chain]]) : new Map());

        expect(getApp(ADDR_A, app.name)?.status, `${initial} + ${String(chain)}`).toBe(expected);
      }
    });

    it('legacy running + PENDING lease now reads deploying (the one changed legacy cell)', () => {
      // The only legacy combination whose outcome changes. The old cascade left
      // it at 'running' purely because it fell through all three branches — a
      // gap, not a decision: the same code derived 'deploying' from a pending
      // lease for `stopped` and `failed` entries. No existing test covered it.
      //
      // 'running' here is a claim no observation supports: a PENDING lease has
      // not been activated by the provider. Rule 5 now answers it uniformly.
      const app = seedLegacy('running');

      reconcileWithChain(ADDR_A, new Map([[app.leaseUuid, 'pending']]));

      expect(getApp(ADDR_A, app.name)?.status).toBe('deploying');
    });

    it('persists a status-neutral chain observation without notifying subscribers', () => {
      // Subscribers all render `status`; a 15s tick that only refreshes
      // chainState must not re-render the sidebar. It must still be SAVED,
      // otherwise the observation is recomputed from scratch forever.
      const app = makeApp({ status: 'running' });
      addApp(ADDR_A, app);
      const listener = vi.fn();
      const unsub = subscribeToRegistry(listener);
      try {
        reconcileWithChain(ADDR_A, new Map([[app.leaseUuid, 'active']]));

        expect(listener).not.toHaveBeenCalled();
        expect(getApp(ADDR_A, app.name)?.chainState).toBe('active');
      } finally { unsub(); }
    });
  });

  // --- Corruption recovery ---

  describe('corruption recovery', () => {
    it('returns empty array and clears storage on invalid JSON', () => {
      localStorage.setItem(`barney-apps-${ADDR_A}`, 'not json');
      expect(getApps(ADDR_A)).toEqual([]);
      expect(localStorage.getItem(`barney-apps-${ADDR_A}`)).toBeNull();
    });

    it('returns empty array and clears storage on non-array JSON', () => {
      localStorage.setItem(`barney-apps-${ADDR_A}`, '{"foo": "bar"}');
      expect(getApps(ADDR_A)).toEqual([]);
      expect(localStorage.getItem(`barney-apps-${ADDR_A}`)).toBeNull();
    });

    it('filters out entries with missing required fields', () => {
      const validApp = makeApp();
      const invalidEntry = { name: 'partial' }; // missing required fields
      localStorage.setItem(
        `barney-apps-${ADDR_A}`,
        JSON.stringify([validApp, invalidEntry])
      );

      const apps = getApps(ADDR_A);
      expect(apps).toHaveLength(1);
      expect(apps[0].name).toBe('my-app');
    });
  });

  describe('subscribeToRegistry', () => {
    const ADDR = 'manifest1abc';

    it('fires the listener with the mutated address on addApp', () => {
      const listener = vi.fn();
      const unsub = subscribeToRegistry(listener);

      addApp(ADDR, makeApp());

      expect(listener).toHaveBeenCalledWith(ADDR);
      unsub();
    });

    it('fires on updateApp', () => {
      const app = makeApp();
      addApp(ADDR, app);
      const listener = vi.fn();
      const unsub = subscribeToRegistry(listener);

      updateApp(ADDR, app.leaseUuid, { status: 'stopped' });

      expect(listener).toHaveBeenCalledWith(ADDR);
      unsub();
    });

    it('fires on removeApp', () => {
      const app = makeApp();
      addApp(ADDR, app);
      const listener = vi.fn();
      const unsub = subscribeToRegistry(listener);

      removeApp(ADDR, app.leaseUuid);

      expect(listener).toHaveBeenCalledWith(ADDR);
      unsub();
    });

    it('fires on reconcileWithChain when state changes', () => {
      addApp(ADDR, makeApp({ status: 'running' }));
      const listener = vi.fn();
      const unsub = subscribeToRegistry(listener);

      // Empty leaseStates → app marked stopped, mutation occurs.
      reconcileWithChain(ADDR, new Map());

      expect(listener).toHaveBeenCalledWith(ADDR);
      unsub();
    });

    it('does NOT fire on reconcileWithChain when state unchanged', () => {
      const app = makeApp({ status: 'running' });
      addApp(ADDR, app);
      const listener = vi.fn();
      const unsub = subscribeToRegistry(listener);
      listener.mockClear(); // addApp also fires; clear before the assertion

      // Existing running lease still active → no change.
      reconcileWithChain(ADDR, new Map([[app.leaseUuid, 'active']]));

      expect(listener).not.toHaveBeenCalled();
      unsub();
    });

    it('unsubscribe stops further notifications', () => {
      const listener = vi.fn();
      const unsub = subscribeToRegistry(listener);
      unsub();

      addApp(ADDR, makeApp());

      expect(listener).not.toHaveBeenCalled();
    });

    it('listener exception does not block other listeners', () => {
      const bad = vi.fn(() => { throw new Error('boom'); });
      const good = vi.fn();
      const unsubBad = subscribeToRegistry(bad);
      const unsubGood = subscribeToRegistry(good);

      addApp(ADDR, makeApp());

      expect(bad).toHaveBeenCalled();
      expect(good).toHaveBeenCalled();
      unsubBad();
      unsubGood();
    });
  });

  // ---- Cross-tab sync ----
  //
  // The module-top `storage` event listener bridges localStorage writes from
  // other tabs into the existing `notify(address)` pub/sub. Both registered
  // consumers (`useRegistryApps`, `AppsSidebar`) get cross-tab updates for
  // free without subscribing to `storage` themselves.
  describe('cross-tab storage event sync', () => {
    it('notifies subscribers when another tab writes the wallet registry key', () => {
      const listener = vi.fn();
      const unsub = subscribeToRegistry(listener);
      try {
        window.dispatchEvent(new StorageEvent('storage', {
          key: `barney-apps-${ADDR_A}`,
          newValue: JSON.stringify([makeApp()]),
          oldValue: null,
          storageArea: localStorage,
        }));
        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener).toHaveBeenCalledWith(ADDR_A);
      } finally { unsub(); }
    });

    it('routes notify by the address parsed out of the storage key (cross-wallet)', () => {
      const listener = vi.fn();
      const unsub = subscribeToRegistry(listener);
      try {
        // Another tab on a DIFFERENT wallet — listener should still fire with
        // that wallet's address; per-subscriber address filters handle the
        // ignore-if-not-mine logic (see AppsSidebar.tsx:138, useRegistryApps.ts:30).
        window.dispatchEvent(new StorageEvent('storage', {
          key: `barney-apps-${ADDR_B}`,
          newValue: null,  // simulate disconnect / clear
          oldValue: JSON.stringify([makeApp()]),
          storageArea: localStorage,
        }));
        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener).toHaveBeenCalledWith(ADDR_B);
      } finally { unsub(); }
    });

    it('does not notify on foreign localStorage keys', () => {
      const listener = vi.fn();
      const unsub = subscribeToRegistry(listener);
      try {
        window.dispatchEvent(new StorageEvent('storage', {
          key: 'barney-ai-history',
          newValue: '[]',
          oldValue: null,
          storageArea: localStorage,
        }));
        expect(listener).not.toHaveBeenCalled();
      } finally { unsub(); }
    });

    it('ignores storage events without a key (global localStorage.clear)', () => {
      const listener = vi.fn();
      const unsub = subscribeToRegistry(listener);
      try {
        window.dispatchEvent(new StorageEvent('storage', {
          key: null,
          newValue: null,
          oldValue: null,
          storageArea: localStorage,
        }));
        expect(listener).not.toHaveBeenCalled();
      } finally { unsub(); }
    });
  });
});

describe('sanitizeManifestForStorage', () => {
  it('sanitizes sensitive env vars in single-service manifest', () => {
    const manifest = JSON.stringify({
      image: 'postgres:18',
      env: { POSTGRES_PASSWORD: 'secret123', POSTGRES_DB: 'mydb' },
    });
    const result = JSON.parse(sanitizeManifestForStorage(manifest));
    expect(result.env.POSTGRES_PASSWORD).toBe('');
    expect(result.env.POSTGRES_DB).toBe('mydb');
  });

  it('sanitizes sensitive env vars in stack manifest', () => {
    const manifest = JSON.stringify({
      services: {
        web: { image: 'wordpress', env: { WORDPRESS_DB_PASSWORD: 'secret' } },
        db: { image: 'mysql', env: { MYSQL_ROOT_PASSWORD: 'root_pass', MYSQL_DATABASE: 'mydb' } },
      },
    });
    const result = JSON.parse(sanitizeManifestForStorage(manifest));
    expect(result.services.web.env.WORDPRESS_DB_PASSWORD).toBe('');
    expect(result.services.db.env.MYSQL_ROOT_PASSWORD).toBe('');
    expect(result.services.db.env.MYSQL_DATABASE).toBe('mydb');
  });

  it('returns empty JSON for invalid input', () => {
    expect(sanitizeManifestForStorage('not json')).toBe('{}');
  });

  it('preserves non-sensitive values in stack manifest', () => {
    const manifest = JSON.stringify({
      services: {
        web: { image: 'nginx', env: { PORT: '80' } },
      },
    });
    const result = JSON.parse(sanitizeManifestForStorage(manifest));
    expect(result.services.web.env.PORT).toBe('80');
  });

  it('ignores non-object services entries while sanitizing valid services', () => {
    const manifest = JSON.stringify({
      services: {
        web: null,
        db: { image: 'mysql', env: { MYSQL_ROOT_PASSWORD: 'root_pass' } },
      },
    });
    const result = JSON.parse(sanitizeManifestForStorage(manifest));
    expect(result.services.web).toBeNull();
    expect(result.services.db.env.MYSQL_ROOT_PASSWORD).toBe('');
  });

  // --- Value-shaped-secret redaction (URI userinfo) ---

  it('redacts a URI value with embedded credentials even when the key is not sensitive', () => {
    const manifest = JSON.stringify({
      image: 'app',
      env: { DATABASE_URL: 'postgres://user:s3cr3t@host:5432/db' },
    });
    const result = JSON.parse(sanitizeManifestForStorage(manifest));
    expect(result.env.DATABASE_URL).toBe('');
  });

  it('redacts a passwordless-userinfo URI value (redis://:pw@host)', () => {
    const manifest = JSON.stringify({
      image: 'app',
      env: { REDIS_URL: 'redis://:pw@host' },
    });
    const result = JSON.parse(sanitizeManifestForStorage(manifest));
    expect(result.env.REDIS_URL).toBe('');
  });

  it('preserves a plain URL value without userinfo (guards over-redaction)', () => {
    const manifest = JSON.stringify({
      image: 'app',
      env: { PUBLIC_REST_URL: 'https://barney.manifest.network/api' },
    });
    const result = JSON.parse(sanitizeManifestForStorage(manifest));
    expect(result.env.PUBLIC_REST_URL).toBe('https://barney.manifest.network/api');
  });
});

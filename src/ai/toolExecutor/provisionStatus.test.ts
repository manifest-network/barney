import { describe, it, expect } from 'vitest';
import { PROVISION_IN_PROGRESS } from '@manifest-network/manifest-sdk/deploy';
import { classifyProvisionStatus, isUnsettledProvisionStatus } from './provisionStatus';

describe('classifyProvisionStatus', () => {
  it('reads fred’s verdicts', () => {
    expect(classifyProvisionStatus('ready')).toBe('confirmed');
    expect(classifyProvisionStatus('failed')).toBe('failed');
    expect(classifyProvisionStatus('deprovisioning')).toBe('failed');
    // Torn down but volumes kept: not in-flight, so it DOES retract a
    // confirmation — but 'unconfirmed', so the close that follows can still
    // record 'absent' → 'stopped' rather than relabelling a stop a failure.
    expect(classifyProvisionStatus('retained')).toBe('unconfirmed');
  });

  it('treats `failing` as the failure verdict it is', () => {
    // fred enters Failing ONLY from Ready, on evContainerDied, writing
    // Reason: ContainerExited synchronously before the async flip to `failed`.
    expect(classifyProvisionStatus('failing')).toBe('failed');
  });

  it('claims nothing for an absent or unmodelled status', () => {
    expect(classifyProvisionStatus(undefined)).toBeUndefined();
    expect(classifyProvisionStatus('')).toBeUndefined();
    expect(classifyProvisionStatus('quiescing')).toBeUndefined();
  });
});

describe('isUnsettledProvisionStatus', () => {
  it('covers every SDK in-progress value except the failure verdict', () => {
    // Derived from the SDK set rather than hand-listed: this is the assertion
    // that fails if a future SDK adds an in-progress status and only one of the
    // two consumers is taught about it.
    for (const status of PROVISION_IN_PROGRESS) {
      expect(isUnsettledProvisionStatus(status)).toBe(status !== 'failing');
    }
    expect(PROVISION_IN_PROGRESS.has('failing')).toBe(true);
  });

  it('is not a fall-through: a verdict or an unmodelled value is settled', () => {
    expect(isUnsettledProvisionStatus('ready')).toBe(false);
    expect(isUnsettledProvisionStatus('failed')).toBe(false);
    expect(isUnsettledProvisionStatus('retained')).toBe(false);
    // fred's vocabulary is open and add-only, so an unmodelled value defaults to
    // "trust whatever came with it", not to silence.
    expect(isUnsettledProvisionStatus('quiescing')).toBe(false);
  });

  it('counts an absent status as unsettled', () => {
    // `omitempty` drops the field when a degraded provider's provision lookup fails.
    expect(isUnsettledProvisionStatus(undefined)).toBe(true);
    expect(isUnsettledProvisionStatus('')).toBe(true);
  });
});

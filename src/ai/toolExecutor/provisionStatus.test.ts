import { describe, it, expect } from 'vitest';
import { PROVISION_IN_PROGRESS } from '@manifest-network/manifest-sdk/deploy';
import { classifyProvisionStatus, displayProvisionStatus, isUnsettledProvisionStatus, reconcileProvisionStatus } from './provisionStatus';

describe('displayProvisionStatus', () => {
  it('displays unknown readiness while withholding absent readings', () => {
    for (const status of [undefined, '']) expect(displayProvisionStatus(status)).toBeUndefined();
    for (const status of ['unknown', 'ready', 'restarting', 'updating', 'provisioning', 'failed', 'quiescing']) {
      expect(displayProvisionStatus(status)).toBe(status);
    }
  });
});

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

  it('does not classify sanitized text as a provider verdict', () => {
    expect(displayProvisionStatus('ready\u202E')).toBe('ready');
    expect(classifyProvisionStatus('ready\u202E')).toBeUndefined();
  });

  it('treats `failing` as the failure verdict it is', () => {
    // fred enters Failing ONLY from Ready, on evContainerDied, writing
    // Reason: ContainerExited synchronously before the async flip to `failed`.
    expect(classifyProvisionStatus('failing')).toBe('failed');
  });

  it('records unknown readiness without inventing a verdict for absent or unmodelled values', () => {
    expect(classifyProvisionStatus(undefined)).toBeUndefined();
    expect(classifyProvisionStatus('')).toBeUndefined();
    expect(classifyProvisionStatus('unknown')).toBe('unconfirmed');
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

describe('reconcileProvisionStatus', () => {
  it.each(['restarting', 'updating', 'provisioning', 'unknown'])('keeps confirmed readiness while %s remains in flight', (status) => {
    expect(reconcileProvisionStatus(status, 'confirmed')).toBeUndefined();
    expect(reconcileProvisionStatus(status, 'unconfirmed')).toBe('unconfirmed');
  });

  it('retains meaningful retained and failure observations', () => {
    expect(reconcileProvisionStatus('retained', 'confirmed')).toBe('unconfirmed');
    expect(reconcileProvisionStatus('failed', 'confirmed')).toBe('failed');
    expect(reconcileProvisionStatus('failing', 'confirmed')).toBe('failed');
  });
});

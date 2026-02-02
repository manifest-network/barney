import { describe, it, expect } from 'vitest';
import { getEventAttribute, extractLeaseUuid, type TxEvent } from './tx';

describe('getEventAttribute', () => {
  it('extracts attribute from matching event', () => {
    const events: TxEvent[] = [
      {
        type: 'lease_created',
        attributes: [
          { key: 'lease_uuid', value: 'test-uuid-123' },
          { key: 'tenant', value: 'manifest1abc' },
        ],
      },
    ];

    expect(getEventAttribute(events, 'lease_created', 'lease_uuid')).toBe('test-uuid-123');
    expect(getEventAttribute(events, 'lease_created', 'tenant')).toBe('manifest1abc');
  });

  it('returns undefined for non-matching event type', () => {
    const events: TxEvent[] = [
      {
        type: 'transfer',
        attributes: [{ key: 'amount', value: '100' }],
      },
    ];

    expect(getEventAttribute(events, 'lease_created', 'lease_uuid')).toBeUndefined();
  });

  it('returns undefined for non-matching attribute key', () => {
    const events: TxEvent[] = [
      {
        type: 'lease_created',
        attributes: [{ key: 'tenant', value: 'manifest1abc' }],
      },
    ];

    expect(getEventAttribute(events, 'lease_created', 'lease_uuid')).toBeUndefined();
  });

  it('handles multiple events', () => {
    const events: TxEvent[] = [
      {
        type: 'transfer',
        attributes: [{ key: 'amount', value: '100' }],
      },
      {
        type: 'lease_created',
        attributes: [{ key: 'lease_uuid', value: 'found-uuid' }],
      },
    ];

    expect(getEventAttribute(events, 'lease_created', 'lease_uuid')).toBe('found-uuid');
  });

  it('handles empty events array', () => {
    expect(getEventAttribute([], 'lease_created', 'lease_uuid')).toBeUndefined();
  });
});

describe('extractLeaseUuid', () => {
  it('extracts UUID from top-level events', () => {
    const result = {
      events: [
        {
          type: 'lease_created',
          attributes: [{ key: 'lease_uuid', value: 'uuid-from-events' }],
        },
      ],
    };

    expect(extractLeaseUuid(result)).toBe('uuid-from-events');
  });

  it('extracts UUID using "uuid" key as fallback', () => {
    const result = {
      events: [
        {
          type: 'lease_created',
          attributes: [{ key: 'uuid', value: 'uuid-alt-key' }],
        },
      ],
    };

    expect(extractLeaseUuid(result)).toBe('uuid-alt-key');
  });

  it('extracts UUID from data field', () => {
    const result = {
      events: [],
      data: { lease_uuid: 'uuid-from-data' },
    };

    expect(extractLeaseUuid(result)).toBe('uuid-from-data');
  });

  it('extracts UUID from logs', () => {
    const result = {
      logs: [
        {
          events: [
            {
              type: 'lease_created',
              attributes: [{ key: 'lease_uuid', value: 'uuid-from-logs' }],
            },
          ],
        },
      ],
    };

    expect(extractLeaseUuid(result)).toBe('uuid-from-logs');
  });

  it('returns null for empty result', () => {
    expect(extractLeaseUuid({})).toBeNull();
  });

  it('returns null when no UUID found', () => {
    const result = {
      events: [
        {
          type: 'transfer',
          attributes: [{ key: 'amount', value: '100' }],
        },
      ],
    };

    expect(extractLeaseUuid(result)).toBeNull();
  });

  it('handles malformed data gracefully', () => {
    expect(extractLeaseUuid({ events: 'not-an-array' })).toBeNull();
    expect(extractLeaseUuid({ data: 'not-an-object' })).toBeNull();
    expect(extractLeaseUuid({ logs: 'not-an-array' })).toBeNull();
  });
});

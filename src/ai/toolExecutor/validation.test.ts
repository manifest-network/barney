import { describe, it, expect } from 'vitest';
import { validateConfirmationToolArgs, getConfirmationMessage } from './validation';

const VALID_UUID = '019beb87-09de-7000-beef-ae733e73ff23';
const VALID_ADDRESS = 'manifest1afk9zr2hn2jsac63h4hm60vl9z3e5u69gndzf7c99cqge3vzwjzsfmy9qj';

describe('validateConfirmationToolArgs', () => {
  describe('common', () => {
    it('returns error when address is undefined', () => {
      const result = validateConfirmationToolArgs('fund_credit', { amount: '1000000umfx' }, undefined);
      expect(result).toContain('Wallet not connected');
    });
  });

  describe('fund_credit', () => {
    it('accepts valid amount with umfx denom', () => {
      const result = validateConfirmationToolArgs('fund_credit', { amount: '1000000umfx' }, VALID_ADDRESS);
      expect(result).toBeNull();
    });

    it('accepts factory denom', () => {
      const result = validateConfirmationToolArgs(
        'fund_credit',
        { amount: '10000000factory/manifest1afk9zr2hn2jsac63h4hm60vl9z3e5u69gndzf7c99cqge3vzwjzsfmy9qj/upwr' },
        VALID_ADDRESS
      );
      expect(result).toBeNull();
    });

    it('rejects missing amount', () => {
      const result = validateConfirmationToolArgs('fund_credit', {}, VALID_ADDRESS);
      expect(result).toContain('amount');
    });

    it('rejects empty amount', () => {
      const result = validateConfirmationToolArgs('fund_credit', { amount: '' }, VALID_ADDRESS);
      expect(result).toContain('amount');
    });

    it('rejects malformed amount (no denom)', () => {
      const result = validateConfirmationToolArgs('fund_credit', { amount: '1000000' }, VALID_ADDRESS);
      expect(result).toContain('Invalid amount format');
    });

    it('rejects non-numeric amount', () => {
      const result = validateConfirmationToolArgs('fund_credit', { amount: 'abcumfx' }, VALID_ADDRESS);
      expect(result).toContain('Invalid amount format');
    });
  });

  describe('create_lease', () => {
    it('accepts JSON string items', () => {
      const items = JSON.stringify([{ sku_name: '001', quantity: 1 }]);
      const result = validateConfirmationToolArgs('create_lease', { items }, VALID_ADDRESS);
      expect(result).toBeNull();
    });

    it('accepts array items directly', () => {
      const items = [{ sku_uuid: VALID_UUID, quantity: 1 }];
      const result = validateConfirmationToolArgs('create_lease', { items }, VALID_ADDRESS);
      expect(result).toBeNull();
    });

    it('validates sku_name or sku_uuid presence', () => {
      const items = JSON.stringify([{ quantity: 1 }]);
      const result = validateConfirmationToolArgs('create_lease', { items }, VALID_ADDRESS);
      expect(result).toContain('sku_name or sku_uuid');
    });

    it('validates UUID format', () => {
      const items = JSON.stringify([{ sku_uuid: 'not-a-uuid', quantity: 1 }]);
      const result = validateConfirmationToolArgs('create_lease', { items }, VALID_ADDRESS);
      expect(result).toContain('Invalid SKU UUID');
    });

    it('validates positive quantity', () => {
      const items = JSON.stringify([{ sku_name: '001', quantity: 0 }]);
      const result = validateConfirmationToolArgs('create_lease', { items }, VALID_ADDRESS);
      expect(result).toContain('quantity');
    });

    it('rejects missing items', () => {
      const result = validateConfirmationToolArgs('create_lease', {}, VALID_ADDRESS);
      expect(result).toContain('items');
    });

    it('rejects invalid JSON', () => {
      const result = validateConfirmationToolArgs('create_lease', { items: '{bad json' }, VALID_ADDRESS);
      expect(result).toContain('could not parse JSON');
    });

    it('rejects empty array', () => {
      const result = validateConfirmationToolArgs('create_lease', { items: '[]' }, VALID_ADDRESS);
      expect(result).toContain('non-empty');
    });

    it('rejects non-number quantity', () => {
      const items = JSON.stringify([{ sku_name: '001', quantity: 'two' }]);
      const result = validateConfirmationToolArgs('create_lease', { items }, VALID_ADDRESS);
      expect(result).toContain('quantity');
    });
  });

  describe('close_lease', () => {
    it('accepts valid UUID', () => {
      const result = validateConfirmationToolArgs('close_lease', { lease_uuid: VALID_UUID }, VALID_ADDRESS);
      expect(result).toBeNull();
    });

    it('rejects missing lease_uuid', () => {
      const result = validateConfirmationToolArgs('close_lease', {}, VALID_ADDRESS);
      expect(result).toContain('lease_uuid');
    });

    it('rejects invalid UUID', () => {
      const result = validateConfirmationToolArgs('close_lease', { lease_uuid: 'bad' }, VALID_ADDRESS);
      expect(result).toContain('Invalid lease UUID');
    });
  });

  describe('cosmos_tx', () => {
    it('accepts valid module/subcommand/args', () => {
      const result = validateConfirmationToolArgs(
        'cosmos_tx',
        { module: 'bank', subcommand: 'send', args: '["addr1", "addr2", "100umfx"]' },
        VALID_ADDRESS
      );
      expect(result).toBeNull();
    });

    it('rejects missing module', () => {
      const result = validateConfirmationToolArgs(
        'cosmos_tx',
        { subcommand: 'send', args: '[]' },
        VALID_ADDRESS
      );
      expect(result).toContain('module');
    });

    it('rejects missing subcommand', () => {
      const result = validateConfirmationToolArgs(
        'cosmos_tx',
        { module: 'bank', args: '[]' },
        VALID_ADDRESS
      );
      expect(result).toContain('subcommand');
    });

    it('rejects missing args', () => {
      const result = validateConfirmationToolArgs(
        'cosmos_tx',
        { module: 'bank', subcommand: 'send' },
        VALID_ADDRESS
      );
      expect(result).toContain('args');
    });
  });

  describe('upload_payload', () => {
    it('accepts valid UUID and payload', () => {
      const result = validateConfirmationToolArgs(
        'upload_payload',
        { lease_uuid: VALID_UUID, payload: 'apiVersion: v1\nkind: Pod' },
        VALID_ADDRESS
      );
      expect(result).toBeNull();
    });

    it('rejects missing lease_uuid', () => {
      const result = validateConfirmationToolArgs(
        'upload_payload',
        { payload: 'data' },
        VALID_ADDRESS
      );
      expect(result).toContain('lease_uuid');
    });

    it('rejects invalid UUID', () => {
      const result = validateConfirmationToolArgs(
        'upload_payload',
        { lease_uuid: 'bad', payload: 'data' },
        VALID_ADDRESS
      );
      expect(result).toContain('Invalid lease UUID');
    });

    it('rejects missing payload', () => {
      const result = validateConfirmationToolArgs(
        'upload_payload',
        { lease_uuid: VALID_UUID },
        VALID_ADDRESS
      );
      expect(result).toContain('payload');
    });

    it('rejects empty payload', () => {
      const result = validateConfirmationToolArgs(
        'upload_payload',
        { lease_uuid: VALID_UUID, payload: '  ' },
        VALID_ADDRESS
      );
      expect(result).toContain('payload');
    });
  });

  describe('unknown tool', () => {
    it('returns null (permissive)', () => {
      const result = validateConfirmationToolArgs('unknown_tool', {}, VALID_ADDRESS);
      expect(result).toBeNull();
    });
  });
});

describe('getConfirmationMessage', () => {
  it('includes amount in fund_credit message', () => {
    const msg = getConfirmationMessage('fund_credit', { amount: '1000000umfx' });
    expect(msg).toContain('1000000umfx');
  });

  it('parses items JSON and includes summary in create_lease message', () => {
    const items = JSON.stringify([{ sku_name: 'GPU-A100', quantity: 2 }]);
    const msg = getConfirmationMessage('create_lease', { items });
    expect(msg).toContain('2x GPU-A100');
  });

  it('falls back to generic message on malformed JSON', () => {
    const msg = getConfirmationMessage('create_lease', { items: '{bad' });
    expect(msg).toContain('Create a new lease?');
  });

  it('includes UUID and reason in close_lease message', () => {
    const msg = getConfirmationMessage('close_lease', { lease_uuid: VALID_UUID, reason: 'done' });
    expect(msg).toContain(VALID_UUID);
    expect(msg).toContain('done');
  });

  it('includes module/subcommand in cosmos_tx message', () => {
    const msg = getConfirmationMessage('cosmos_tx', {
      module: 'bank',
      subcommand: 'send',
      args: '["a","b","100umfx"]',
    });
    expect(msg).toContain('bank');
    expect(msg).toContain('send');
  });

  it('includes lease_uuid in upload_payload message', () => {
    const msg = getConfirmationMessage('upload_payload', { lease_uuid: VALID_UUID });
    expect(msg).toContain(VALID_UUID);
  });

  it('returns fallback for unknown tool', () => {
    const msg = getConfirmationMessage('unknown_tool', {});
    expect(msg).toContain('unknown_tool');
  });
});

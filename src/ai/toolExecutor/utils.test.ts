import { describe, it, expect, vi, beforeEach } from 'vitest';
import { uploadPayloadToProvider } from './utils';
import { ProviderApiError } from '../../api/provider-api';
import type { SignResult } from './types';

vi.mock('../../api/provider-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/provider-api')>();
  return {
    ...actual,
    uploadLeaseData: vi.fn(),
  };
});

import { uploadLeaseData } from '../../api/provider-api';
const mockUploadLeaseData = vi.mocked(uploadLeaseData);

const VALID_HASH = 'a'.repeat(64);
const PROVIDER_URL = 'https://provider.example.com';
const LEASE_UUID = '550e8400-e29b-41d4-a716-446655440000';
const ADDRESS = 'manifest1abc';
const PAYLOAD = new Uint8Array([1, 2, 3]);

const validSignResult: SignResult = {
  pub_key: { type: 'tendermint/PubKeySecp256k1', value: 'pubkeybase64==' },
  signature: 'sigbase64==',
};

function mockSignArbitrary(result: SignResult = validSignResult) {
  return vi.fn<(address: string, data: string) => Promise<SignResult>>().mockResolvedValue(result);
}

describe('uploadPayloadToProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUploadLeaseData.mockResolvedValue(undefined);
  });

  it('returns success on successful upload', async () => {
    const result = await uploadPayloadToProvider(
      PROVIDER_URL, LEASE_UUID, VALID_HASH, PAYLOAD, ADDRESS, mockSignArbitrary(),
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      message: 'Payload uploaded successfully',
      leaseUuid: LEASE_UUID,
      metaHash: VALID_HASH,
    });
  });

  it('calls uploadLeaseData with correct auth token', async () => {
    const sign = mockSignArbitrary();
    await uploadPayloadToProvider(PROVIDER_URL, LEASE_UUID, VALID_HASH, PAYLOAD, ADDRESS, sign);

    expect(sign).toHaveBeenCalledOnce();
    expect(mockUploadLeaseData).toHaveBeenCalledOnce();
    const [url, uuid, payload, token] = mockUploadLeaseData.mock.calls[0];
    expect(url).toBe(PROVIDER_URL);
    expect(uuid).toBe(LEASE_UUID);
    expect(payload).toBe(PAYLOAD);
    // Token should be valid base64 containing the address and lease UUID
    const decoded = JSON.parse(atob(token));
    expect(decoded.tenant).toBe(ADDRESS);
    expect(decoded.lease_uuid).toBe(LEASE_UUID);
    expect(decoded.meta_hash).toBe(VALID_HASH);
    expect(decoded.pub_key).toBe(validSignResult.pub_key.value);
    expect(decoded.signature).toBe(validSignResult.signature);
  });

  // --- Validation errors ---

  it('returns error for invalid meta_hash', async () => {
    const result = await uploadPayloadToProvider(
      PROVIDER_URL, LEASE_UUID, 'bad-hash', PAYLOAD, ADDRESS, mockSignArbitrary(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid meta_hash format');
    expect(mockUploadLeaseData).not.toHaveBeenCalled();
  });

  it('returns error for too-short meta_hash', async () => {
    const result = await uploadPayloadToProvider(
      PROVIDER_URL, LEASE_UUID, 'a'.repeat(63), PAYLOAD, ADDRESS, mockSignArbitrary(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid meta_hash format');
  });

  // --- Sign failures ---

  it('returns error when signArbitrary throws', async () => {
    const sign = vi.fn().mockRejectedValue(new Error('User rejected'));

    const result = await uploadPayloadToProvider(
      PROVIDER_URL, LEASE_UUID, VALID_HASH, PAYLOAD, ADDRESS, sign,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to sign message');
    expect(result.error).toContain('User rejected');
    expect(mockUploadLeaseData).not.toHaveBeenCalled();
  });

  it('returns error when signArbitrary throws a non-Error', async () => {
    const sign = vi.fn().mockRejectedValue('rejected');

    const result = await uploadPayloadToProvider(
      PROVIDER_URL, LEASE_UUID, VALID_HASH, PAYLOAD, ADDRESS, sign,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Signing rejected or failed');
  });

  it('returns error when sign result is missing pub_key', async () => {
    const sign = mockSignArbitrary({ pub_key: { type: '', value: '' }, signature: 'sig' });

    const result = await uploadPayloadToProvider(
      PROVIDER_URL, LEASE_UUID, VALID_HASH, PAYLOAD, ADDRESS, sign,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid signature result');
  });

  it('returns error when sign result is missing signature', async () => {
    const sign = mockSignArbitrary({ pub_key: { type: 't', value: 'v' }, signature: '' });

    const result = await uploadPayloadToProvider(
      PROVIDER_URL, LEASE_UUID, VALID_HASH, PAYLOAD, ADDRESS, sign,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid signature result');
  });

  // --- Provider API HTTP errors ---

  it('treats 409 as idempotent success', async () => {
    mockUploadLeaseData.mockRejectedValue(new ProviderApiError(409, 'Conflict'));

    const result = await uploadPayloadToProvider(
      PROVIDER_URL, LEASE_UUID, VALID_HASH, PAYLOAD, ADDRESS, mockSignArbitrary(),
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      message: 'Payload already uploaded (idempotent success)',
      leaseUuid: LEASE_UUID,
      metaHash: VALID_HASH,
    });
  });

  it('returns auth error for 401', async () => {
    mockUploadLeaseData.mockRejectedValue(new ProviderApiError(401, 'Unauthorized'));

    const result = await uploadPayloadToProvider(
      PROVIDER_URL, LEASE_UUID, VALID_HASH, PAYLOAD, ADDRESS, mockSignArbitrary(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Authentication failed');
  });

  it('returns not-found error for 404', async () => {
    mockUploadLeaseData.mockRejectedValue(new ProviderApiError(404, 'Not found'));

    const result = await uploadPayloadToProvider(
      PROVIDER_URL, LEASE_UUID, VALID_HASH, PAYLOAD, ADDRESS, mockSignArbitrary(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Lease not found');
  });

  it('returns hash-mismatch error for 400', async () => {
    mockUploadLeaseData.mockRejectedValue(new ProviderApiError(400, 'Bad request'));

    const result = await uploadPayloadToProvider(
      PROVIDER_URL, LEASE_UUID, VALID_HASH, PAYLOAD, ADDRESS, mockSignArbitrary(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Payload hash does not match');
  });

  it('falls through to generic error for other ProviderApiError status codes', async () => {
    mockUploadLeaseData.mockRejectedValue(new ProviderApiError(500, 'Internal server error'));

    const result = await uploadPayloadToProvider(
      PROVIDER_URL, LEASE_UUID, VALID_HASH, PAYLOAD, ADDRESS, mockSignArbitrary(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Internal server error');
  });

  it('returns generic error for non-Error throws', async () => {
    mockUploadLeaseData.mockRejectedValue('unexpected');

    const result = await uploadPayloadToProvider(
      PROVIDER_URL, LEASE_UUID, VALID_HASH, PAYLOAD, ADDRESS, mockSignArbitrary(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Unknown error during payload upload');
  });
});

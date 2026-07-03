import { describe, it, expect, vi, beforeEach } from 'vitest';
import { uploadPayloadToProvider } from './utils';
import { ProviderApiError } from '../../api/provider-api';
import { asLeaseUuid } from '@manifest-network/manifest-sdk';
import type { AuthTokens } from './types';

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
const LEASE_UUID = asLeaseUuid('550e8400-e29b-41d4-a716-446655440000');
const PAYLOAD = new Uint8Array([1, 2, 3]);

function mockAuthTokens(leaseDataToken: string | Error = 'lease-data-auth-token'): AuthTokens {
  return {
    getAuthToken: vi.fn().mockResolvedValue('auth-token'),
    getLeaseDataAuthToken: leaseDataToken instanceof Error
      ? vi.fn().mockRejectedValue(leaseDataToken)
      : vi.fn().mockResolvedValue(leaseDataToken),
  };
}

describe('uploadPayloadToProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUploadLeaseData.mockResolvedValue(undefined);
  });

  it('returns success on successful upload', async () => {
    const result = await uploadPayloadToProvider(
      PROVIDER_URL, LEASE_UUID, VALID_HASH, PAYLOAD, mockAuthTokens(),
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      message: 'Payload uploaded successfully',
      leaseUuid: LEASE_UUID,
      metaHash: VALID_HASH,
    });
  });

  it('mints a lease-data token via the factory and uploads it', async () => {
    const authTokens = mockAuthTokens();
    await uploadPayloadToProvider(PROVIDER_URL, LEASE_UUID, VALID_HASH, PAYLOAD, authTokens);

    expect(authTokens.getLeaseDataAuthToken).toHaveBeenCalledWith(LEASE_UUID, VALID_HASH);
    expect(mockUploadLeaseData).toHaveBeenCalledOnce();
    const [url, uuid, payload, token] = mockUploadLeaseData.mock.calls[0];
    expect(url).toBe(PROVIDER_URL);
    expect(uuid).toBe(LEASE_UUID);
    expect(payload).toBe(PAYLOAD);
    expect(token).toBe('lease-data-auth-token');
  });

  // --- Validation errors ---

  it('returns error for invalid meta_hash', async () => {
    const result = await uploadPayloadToProvider(
      PROVIDER_URL, LEASE_UUID, 'bad-hash', PAYLOAD, mockAuthTokens(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid meta_hash format');
    expect(mockUploadLeaseData).not.toHaveBeenCalled();
  });

  it('returns error for too-short meta_hash', async () => {
    const result = await uploadPayloadToProvider(
      PROVIDER_URL, LEASE_UUID, 'a'.repeat(63), PAYLOAD, mockAuthTokens(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid meta_hash format');
  });

  // --- Sign failures ---

  it('returns error when the factory fails to mint a token', async () => {
    const result = await uploadPayloadToProvider(
      PROVIDER_URL, LEASE_UUID, VALID_HASH, PAYLOAD, mockAuthTokens(new Error('User rejected')),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to sign message');
    expect(result.error).toContain('User rejected');
    expect(mockUploadLeaseData).not.toHaveBeenCalled();
  });

  it('returns "Signing rejected or failed" when the factory rejects with a non-Error', async () => {
    const authTokens = {
      getAuthToken: vi.fn(),
      getLeaseDataAuthToken: vi.fn().mockRejectedValue('user bailed'),
    } as unknown as AuthTokens;
    const result = await uploadPayloadToProvider(PROVIDER_URL, LEASE_UUID, VALID_HASH, PAYLOAD, authTokens);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Signing rejected or failed');
    expect(mockUploadLeaseData).not.toHaveBeenCalled();
  });

  // --- Provider API HTTP errors ---

  it('treats 409 as idempotent success', async () => {
    mockUploadLeaseData.mockRejectedValue(new ProviderApiError(409, 'Conflict'));

    const result = await uploadPayloadToProvider(
      PROVIDER_URL, LEASE_UUID, VALID_HASH, PAYLOAD, mockAuthTokens(),
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
      PROVIDER_URL, LEASE_UUID, VALID_HASH, PAYLOAD, mockAuthTokens(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Authentication failed');
  });

  it('returns not-found error for 404', async () => {
    mockUploadLeaseData.mockRejectedValue(new ProviderApiError(404, 'Not found'));

    const result = await uploadPayloadToProvider(
      PROVIDER_URL, LEASE_UUID, VALID_HASH, PAYLOAD, mockAuthTokens(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Lease not found');
  });

  it('returns hash-mismatch error for 400', async () => {
    mockUploadLeaseData.mockRejectedValue(new ProviderApiError(400, 'Bad request'));

    const result = await uploadPayloadToProvider(
      PROVIDER_URL, LEASE_UUID, VALID_HASH, PAYLOAD, mockAuthTokens(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Payload hash does not match');
  });

  it('falls through to generic error for other ProviderApiError status codes', async () => {
    mockUploadLeaseData.mockRejectedValue(new ProviderApiError(500, 'Internal server error'));

    const result = await uploadPayloadToProvider(
      PROVIDER_URL, LEASE_UUID, VALID_HASH, PAYLOAD, mockAuthTokens(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Internal server error');
  });

  it('returns generic error for non-Error throws', async () => {
    mockUploadLeaseData.mockRejectedValue('unexpected');

    const result = await uploadPayloadToProvider(
      PROVIDER_URL, LEASE_UUID, VALID_HASH, PAYLOAD, mockAuthTokens(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Unknown error during payload upload');
  });
});

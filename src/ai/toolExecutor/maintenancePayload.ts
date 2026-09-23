import { asLeaseUuid } from '@manifest-network/manifest-sdk';
import { metaHashHex } from '@manifest-network/manifest-sdk/deploy';
import { getLeaseReleases } from '../../api/fred';
import { isAbortError } from '../../api/utils';
import { mergeManifest } from '../manifest';
import { buildPayloadFromManifest } from './deployArgs';
import type { MaintenanceOperation } from './maintenanceOperation';
import type { PayloadAttachment, ToolExecutorOptions } from './types';

/** Recover bytes only: a matching manifest does not identify command admission. */
export async function recoverReleaseManifest(encoded: string | undefined, payloadHash: string): Promise<string | undefined> {
  if (!encoded) return undefined;
  try {
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (await metaHashHex(decoded) !== payloadHash) return undefined;
    const parsed: unknown = JSON.parse(decoded);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

export async function recoverMaintenancePayload(
  command: MaintenanceOperation,
  storedManifest: string | undefined,
  payload: PayloadAttachment | undefined,
  options: ToolExecutorOptions,
): Promise<string | undefined> {
  const { signal, signing } = options;
  signal?.throwIfAborted();
  if (payload) {
    const raw = new TextDecoder().decode(payload.bytes);
    const candidates = [raw];
    const cleaned = await buildPayloadFromManifest(raw);
    candidates.push(new TextDecoder().decode(cleaned.bytes));
    if (storedManifest) {
      try {
        // Repeat the original deterministic merge only as a candidate. The
        // saved hash must prove byte identity before any recovered plan is made.
        const merged = JSON.stringify(mergeManifest(JSON.parse(raw), storedManifest), null, 2);
        candidates.push(new TextDecoder().decode((await buildPayloadFromManifest(merged)).bytes));
      } catch {
        // Invalid or changed defaults cannot establish the original bytes.
      }
    }
    for (const candidate of candidates) {
      if (await metaHashHex(candidate) === command.payloadHash) {
        signal?.throwIfAborted();
        return candidate;
      }
    }
    return undefined;
  }
  if (command.manifest !== undefined) return command.manifest;
  if (!signing) return undefined;
  options.assertAuthorization?.();
  try {
    const token = await signing.authTokens.getAuthToken(asLeaseUuid(command.leaseUuid));
    signal?.throwIfAborted();
    options.assertAuthorization?.();
    const releases = await getLeaseReleases(command.providerUrl, command.leaseUuid, token);
    signal?.throwIfAborted();
    for (const release of releases.releases) {
      const manifest = await recoverReleaseManifest(release.manifest, command.payloadHash);
      signal?.throwIfAborted();
      if (manifest !== undefined) return manifest;
    }
  } catch (error) {
    signal?.throwIfAborted();
    options.assertAuthorization?.();
    if (isAbortError(error)) throw error;
    // Recovery remains unavailable; never replace the command or expose a raw
    // provider error that might include secret-bearing historical bytes.
  }
  return undefined;
}

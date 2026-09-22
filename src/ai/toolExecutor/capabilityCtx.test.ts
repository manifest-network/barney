import { expect, it, vi } from 'vitest';
import type { CosmosClientManager, EventTransport } from '@manifest-network/manifest-sdk';
import { getReadClient } from '../../api/readClient';
import { getFredCompatibility } from '../../config/fredCompatibility';
import { buildBarneyCtx } from './capabilityCtx';
import type { SigningContext } from './types';

vi.mock('../../api/readClient', () => ({ getReadClient: vi.fn() }));

it('threads provider compatibility alongside the existing authentication and event capabilities', async () => {
  const query = {};
  vi.mocked(getReadClient).mockResolvedValue({ query } as Awaited<ReturnType<typeof getReadClient>>);
  const chain = {} as CosmosClientManager;
  const providerAuth = { providerToken: vi.fn(), leaseDataToken: vi.fn() };
  const signing = { providerAuth } as unknown as SigningContext;
  const events = {} as EventTransport;

  const ctx = await buildBarneyCtx(chain, signing, { events });
  expect(ctx).toMatchObject({ chain, query, providerAuth, events });
  expect(ctx.fredCompatibility).toBe(getFredCompatibility());
  expect(ctx.fredCompatibility).toEqual({ 'https://s049-u002.manifest0.net/api/fred': 'pr240' });
  expect(providerAuth.providerToken).not.toHaveBeenCalled();
});

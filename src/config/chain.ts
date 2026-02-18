import type { Chain, AssetList } from '@chain-registry/types';
import { REST_URL, RPC_ENDPOINT } from '../api/config';
import { runtimeConfig } from './runtimeConfig';

/**
 * The chain name used for cosmos-kit and chain registry lookups.
 * Single source of truth for the chain identifier.
 */
export const CHAIN_NAME = 'manifestlocal';

/**
 * The chain ID used for MCP config and transaction signing.
 * Configurable via PUBLIC_CHAIN_ID env variable.
 */
export const CHAIN_ID = runtimeConfig.PUBLIC_CHAIN_ID;

/**
 * Gas price string used for transaction fee estimation.
 * Format: `{amount}{denom}` as expected by CosmJS GasPrice.fromString().
 * Configurable via PUBLIC_GAS_PRICE env variable.
 */
export const GAS_PRICE = runtimeConfig.PUBLIC_GAS_PRICE;

export const manifestLocalChain: Chain = {
  chain_name: 'manifestlocal',
  chain_type: 'cosmos',
  chain_id: CHAIN_ID,
  pretty_name: 'Manifest (Local)',
  status: 'live',
  network_type: 'devnet',
  bech32_prefix: 'manifest',
  slip44: 118,
  fees: {
    fee_tokens: [
      {
        denom: 'umfx',
        fixed_min_gas_price: 0.0025,
        low_gas_price: 0.0025,
        average_gas_price: 0.005,
        high_gas_price: 0.01,
      },
    ],
  },
  staking: {
    staking_tokens: [{ denom: 'umfx' }],
  },
  apis: {
    rpc: [{ address: RPC_ENDPOINT, provider: 'local' }],
    rest: [{ address: REST_URL, provider: 'local' }],
    grpc: [{ address: 'localhost:9090', provider: 'local' }],
  },
};

export const manifestLocalAssets: AssetList = {
  chain_name: 'manifestlocal',
  assets: [
    {
      type_asset: 'sdk.coin',
      denom_units: [
        { denom: 'umfx', exponent: 0 },
        { denom: 'mfx', exponent: 6 },
      ],
      base: 'umfx',
      name: 'Manifest',
      display: 'mfx',
      symbol: 'MFX',
      logo_URIs: {
        png: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/manifest/images/manifest.png',
      },
    },
  ],
};


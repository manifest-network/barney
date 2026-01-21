import type { Chain, AssetList } from '@chain-registry/types';

export const manifestLocalChain: Chain = {
  chain_name: 'manifestlocal',
  chain_type: 'cosmos',
  chain_id: 'manifest-ledger-beta',
  pretty_name: 'Manifest (Local)',
  status: 'live',
  network_type: 'devnet',
  bech32_prefix: 'manifest',
  slip44: 118,
  fees: {
    fee_tokens: [
      {
        denom: 'umfx',
        fixed_min_gas_price: 0,
        low_gas_price: 0,
        average_gas_price: 0,
        high_gas_price: 0,
      },
    ],
  },
  staking: {
    staking_tokens: [{ denom: 'umfx' }],
  },
  apis: {
    rpc: [{ address: 'http://localhost:26657', provider: 'local' }],
    rest: [{ address: 'http://localhost:1317', provider: 'local' }],
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


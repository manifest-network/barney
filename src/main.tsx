import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ChainProvider } from '@cosmos-kit/react';
import { wallets as keplrWallets } from '@cosmos-kit/keplr-extension';
import { wallets as leapWallets } from '@cosmos-kit/leap-extension';
import { wallets as cosmostationWallets } from '@cosmos-kit/cosmostation-extension';
import { wallets as ledgerWallets } from '@cosmos-kit/ledger';
import { wallets as leapSnapWallets } from '@cosmos-kit/leap-metamask-cosmos-snap';
import { makeWeb3AuthWallets } from '@cosmos-kit/web3auth';

// @ts-expect-error - CSS import from package exports
import '@interchain-ui/react/styles';
import './index.css';
import App from './App.tsx';
import { manifestLocalChain, manifestLocalAssets } from './config/chain';

// Web3Auth configuration
const WEB3AUTH_CLIENT_ID = import.meta.env.PUBLIC_WEB3AUTH_CLIENT_ID || 'YOUR_WEB3AUTH_CLIENT_ID';
const WEB3AUTH_NETWORK = (import.meta.env.PUBLIC_WEB3AUTH_NETWORK || 'sapphire_devnet') as 'sapphire_devnet' | 'sapphire_mainnet';

const web3AuthWallets = makeWeb3AuthWallets({
  client: {
    clientId: WEB3AUTH_CLIENT_ID,
    web3AuthNetwork: WEB3AUTH_NETWORK,
  },
  promptSign: async () => true,
  loginMethods: [
    {
      provider: 'google',
      name: 'Google',
      logo: 'https://upload.wikimedia.org/wikipedia/commons/c/c1/Google_%22G%22_logo.svg',
    },
  ],
});

const wallets = [
  ...keplrWallets,
  ...leapWallets,
  ...cosmostationWallets,
  ...ledgerWallets,
  ...leapSnapWallets,
  ...web3AuthWallets,
];

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ChainProvider
      chains={[manifestLocalChain]}
      assetLists={[manifestLocalAssets]}
      wallets={wallets}
      throwErrors={false}
      signerOptions={{
        preferredSignType: () => 'direct',
      }}
    >
      <App />
    </ChainProvider>
  </StrictMode>
);

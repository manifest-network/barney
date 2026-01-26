import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ChainProvider } from '@cosmos-kit/react';
import { wallets as keplrWallets } from '@cosmos-kit/keplr-extension';
import { wallets as leapWallets } from '@cosmos-kit/leap-extension';
import { wallets as cosmostationWallets } from '@cosmos-kit/cosmostation-extension';
import { wallets as ledgerWallets } from '@cosmos-kit/ledger';
import { wallets as leapSnapWallets } from '@cosmos-kit/leap-metamask-cosmos-snap';
import { makeWeb3AuthWallets } from '@cosmos-kit/web3auth';

import '@interchain-ui/react/styles';
import './index.css';
import App from './App.tsx';
import { manifestLocalChain, manifestLocalAssets } from './config/chain';
import { ToastProvider } from './contexts/ToastContext';
import { ToastContainer } from './components/ui/Toast';

// Web3Auth configuration
const WEB3AUTH_CLIENT_ID = import.meta.env.PUBLIC_WEB3AUTH_CLIENT_ID || 'YOUR_WEB3AUTH_CLIENT_ID';

const validNetworks = ['sapphire_devnet', 'sapphire_mainnet'] as const;
type Web3AuthNetwork = (typeof validNetworks)[number];

const networkEnvValue = import.meta.env.PUBLIC_WEB3AUTH_NETWORK;
const WEB3AUTH_NETWORK: Web3AuthNetwork =
  networkEnvValue && validNetworks.includes(networkEnvValue as Web3AuthNetwork)
    ? (networkEnvValue as Web3AuthNetwork)
    : 'sapphire_devnet';

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

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found. Ensure #root exists in index.html');
}

createRoot(rootElement).render(
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
      <ToastProvider>
        <App />
        <ToastContainer />
      </ToastProvider>
    </ChainProvider>
  </StrictMode>
);

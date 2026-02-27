import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ChainProvider } from '@cosmos-kit/react';
import { makeWeb3AuthWallets } from '@cosmos-kit/web3auth';

import { ThemeProvider } from 'next-themes';
import '@interchain-ui/react/styles';
import './index.css';
import { manifestLocalChain, manifestLocalAssets } from './config/chain';
import { runtimeConfig } from './config/runtimeConfig';
import { ToastProvider } from './contexts/ToastContext';
import { ToastContainer } from './components/ui/Toast';
import { AIProvider } from './contexts/AIContext';
import { AppShell } from './components/layout/AppShell';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { MatrixRain } from './components/ui/MatrixRain';
import { logError } from './utils/errors';

// Web3Auth configuration
const WEB3AUTH_CLIENT_ID = runtimeConfig.PUBLIC_WEB3AUTH_CLIENT_ID;

if (WEB3AUTH_CLIENT_ID === 'YOUR_WEB3AUTH_CLIENT_ID' && import.meta.env.DEV) {
  logError(
    'main.web3auth',
    'Web3Auth client ID is not configured. Social login (Google) will not work. ' +
    'Set PUBLIC_WEB3AUTH_CLIENT_ID in your .env.local file. ' +
    'Get a client ID at https://dashboard.web3auth.io'
  );
}

const validNetworks = ['sapphire_devnet', 'sapphire_mainnet', 'testnet', 'mainnet'] as const;
type Web3AuthNetwork = (typeof validNetworks)[number];

const networkEnvValue = runtimeConfig.PUBLIC_WEB3AUTH_NETWORK;
const WEB3AUTH_NETWORK: Web3AuthNetwork =
  validNetworks.includes(networkEnvValue as Web3AuthNetwork)
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
  ...web3AuthWallets,
];

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found. Ensure #root exists in index.html');
}

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary>
      <ThemeProvider
        attribute="data-theme"
        themes={['dark', 'light', 'retro', 'nord', 'dracula', 'catppuccin', 'matrix']}
        defaultTheme="dark"
        enableSystem
        storageKey="barney-theme"
      >
        <MatrixRain />
        <ChainProvider
          chains={[manifestLocalChain]}
          assetLists={[manifestLocalAssets]}
          wallets={wallets}
          throwErrors={false}
          signerOptions={{
            preferredSignType: () => 'direct',
          }}
          sessionOptions={{
            duration: 24 * 60 * 60 * 1000, // 24 hours
          }}
        >
          <ToastProvider>
            <AIProvider>
              <AppShell />
              <ToastContainer />
            </AIProvider>
          </ToastProvider>
        </ChainProvider>
      </ThemeProvider>
    </ErrorBoundary>
  </StrictMode>
);

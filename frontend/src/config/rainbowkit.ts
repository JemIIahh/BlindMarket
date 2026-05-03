import '@rainbow-me/rainbowkit/styles.css';
import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { defineChain } from 'viem';

// Define 0G Galileo Testnet
const ogGalileoTestnet = defineChain({
  id: 16602,
  name: '0G-Galileo-Testnet',
  nativeCurrency: {
    decimals: 18,
    name: '0G',
    symbol: '0G',
  },
  rpcUrls: {
    default: {
      http: ['https://evmrpc-testnet.0g.ai'],
    },
  },
  blockExplorers: {
    default: {
      name: '0G Chain Explorer',
      url: 'https://chainscan-galileo.0g.ai',
    },
  },
  testnet: true,
});

export const config = getDefaultConfig({
  appName: 'BlindMarket',
  projectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? '21fef48091f12692cad574a6f7753643',
  chains: [ogGalileoTestnet],
  ssr: false,
});

export const customTheme = {
  blurs: {
    modalOverlay: 'blur(0px)',
  },
  colors: {
    accentColor: 'var(--accent-color)',
    accentColorForeground: 'var(--bb-ink)',
    actionButtonBorder: 'var(--bb-line)',
    actionButtonBorderMobile: 'var(--bb-line)',
    actionButtonSecondaryBackground: 'var(--bb-surface-2)',
    closeButton: 'var(--bb-ink-2)',
    closeButtonBackground: 'var(--bb-surface-2)',
    connectButtonBackground: 'var(--bb-surface)',
    connectButtonBackgroundError: 'var(--bb-err)',
    connectButtonInnerBackground: 'var(--bb-surface-2)',
    connectButtonText: 'var(--bb-ink)',
    connectButtonTextError: 'var(--bb-ink)',
    connectionIndicator: 'var(--accent-color)',
    downloadBottomCardBackground: 'var(--bb-surface-2)',
    downloadTopCardBackground: 'var(--bb-surface)',
    error: 'var(--bb-err)',
    generalBorder: 'var(--bb-line)',
    generalBorderDim: 'var(--bb-line)',
    menuItemBackground: 'var(--bb-surface-2)',
    modalBackdrop: 'rgba(0, 0, 0, 0.5)',
    modalBackground: 'var(--bb-surface)',
    modalBorder: 'var(--bb-line)',
    modalText: 'var(--bb-ink)',
    modalTextDim: 'var(--bb-ink-3)',
    modalTextSecondary: 'var(--bb-ink-2)',
    profileAction: 'var(--bb-surface-2)',
    profileActionHover: 'var(--bb-surface-2)',
    profileForeground: 'var(--bb-surface)',
    selectedOptionBorder: 'var(--accent-color)',
    standby: '#fbbf24',
  },
  fonts: {
    body: 'ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace',
  },
  radii: {
    actionButton: '8px',
    connectButton: '8px',
    menuButton: '8px',
    modal: '8px',
    modalMobile: '8px',
  },
  shadows: {
    connectButton: '0px 2px 4px rgba(0, 0, 0, 0.1)',
    dialog: '0px 4px 16px rgba(0, 0, 0, 0.2)',
    profileDetailsAction: '0px 1px 3px rgba(0, 0, 0, 0.1)',
    selectedOption: '0px 2px 6px rgba(0, 0, 0, 0.15)',
    selectedWallet: '0px 2px 6px rgba(0, 0, 0, 0.1)',
    walletLogo: '0px 2px 8px rgba(0, 0, 0, 0.1)',
  },
};

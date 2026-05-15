export const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

const IS_PROD = import.meta.env.PROD;

export const OG_CHAIN_ID = Number(
  import.meta.env.VITE_OG_CHAIN_ID || (IS_PROD ? '16661' : '16602')
);

export const OG_RPC_URL =
  import.meta.env.VITE_OG_RPC_URL ||
  (IS_PROD ? 'https://evmrpc.0g.ai' : 'https://evmrpc-testnet.0g.ai');

export const BLIND_ESCROW_ADDRESS =
  import.meta.env.VITE_BLIND_ESCROW_ADDRESS ||
  (IS_PROD ? '0x3d0374963DaaD43e31d42373eb11156A8e8ce2Ff' : '0x037529B296a89E6Dd1abAF84D413cb2dD70C5be5');

export const TASK_REGISTRY_ADDRESS =
  import.meta.env.VITE_TASK_REGISTRY_ADDRESS ||
  (IS_PROD ? '0x9CCF9c196006B573FaA9C9c9CebDd1296dbd5cE0' : '0x25Bc5be1F8Ab44ADfb7a6Ce1362d37408E74DA95');

export const BLIND_REPUTATION_ADDRESS =
  import.meta.env.VITE_BLIND_REPUTATION_ADDRESS ||
  (IS_PROD ? '0x3af9232009C5da30AdA366B6E09849A040162A1a' : '0x3d0374963DaaD43e31d42373eb11156A8e8ce2Ff');

// Marketplace payment token.
// Mainnet: Native 0G (address(0))
// Testnet: Mock USDC (0x3af9232009C5da30AdA366B6E09849A040162A1a)
export const MARKETPLACE_TOKEN_ADDRESS =
  (import.meta.env.VITE_MOCK_ERC20_ADDRESS as string | undefined) ||
  (IS_PROD ? '0x0000000000000000000000000000000000000000' : '0x3af9232009C5da30AdA366B6E09849A040162A1a');

// Founder addresses (comma-separated, lowercase). Used to gate the /metrics page.
export const FOUNDER_ADDRESSES: string[] = (import.meta.env.VITE_FOUNDER_ADDRESSES || '')
  .split(',')
  .map((s: string) => s.trim().toLowerCase())
  .filter(Boolean);

export const OG_CHAIN_CONFIG = {
  chainId: `0x${OG_CHAIN_ID.toString(16)}`,
  chainName: OG_CHAIN_ID === 16661 ? '0G Mainnet' : '0G Testnet',
  nativeCurrency: { name: '0G', symbol: '0G', decimals: 18 },
  rpcUrls: [OG_RPC_URL],
  blockExplorerUrls: [OG_CHAIN_ID === 16661 ? 'https://chainscan.0g.ai' : 'https://chainscan-newton.0g.ai'],
} as const;


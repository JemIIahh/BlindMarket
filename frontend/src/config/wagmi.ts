import { createConfig } from '@privy-io/wagmi';
import { http } from 'wagmi';
import { arcChain } from './chains';

// wagmi config — Privy provides the connector at runtime via PrivyProvider +
// WagmiProvider from @privy-io/wagmi. Arc is the only user-facing wallet chain.
export const wagmiConfig = createConfig({
  chains: [arcChain],
  transports: {
    [arcChain.id]: http(),
  },
});

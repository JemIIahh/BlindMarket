import { createConfig } from '@privy-io/wagmi';
import { http } from 'wagmi';
import { ogTestnet, baseChain } from './chains';

// wagmi config — Privy provides the connector at runtime via PrivyProvider +
// WagmiProvider from @privy-io/wagmi. We declare both chains (0G for agent
// infra, Base for settlement) so wagmi can switch between them.
export const wagmiConfig = createConfig({
  chains: [baseChain, ogTestnet],
  transports: {
    [baseChain.id]: http(),
    [ogTestnet.id]: http(),
  },
});

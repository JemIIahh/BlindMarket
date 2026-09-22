import { createConfig } from '@privy-io/wagmi';
import { http } from 'wagmi';
import { baseChain, arcChain } from './chains';

// wagmi config — Privy provides the connector at runtime via PrivyProvider +
// WagmiProvider from @privy-io/wagmi. Arc is the settlement chain; Base is
// legacy. 0G (agent infra) is not a user-facing wallet chain.
export const wagmiConfig = createConfig({
  chains: [arcChain, baseChain],
  transports: {
    [arcChain.id]: http(),
    [baseChain.id]: http(),
  },
});

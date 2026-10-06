/**
 * Stand-in for `@privy-io/wagmi` in the docs-screenshot build: the provider
 * renders its children, and createConfig hands back what it was given (the
 * stubbed wagmi hooks never read a config).
 */
import type { ReactNode } from 'react';

export function WagmiProvider({ children }: { children: ReactNode; config?: unknown }) {
  return <>{children}</>;
}

export const createConfig = <T,>(config: T): T => config;

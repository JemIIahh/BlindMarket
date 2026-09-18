import { useEffect, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get } from '../lib/api';
import { defaultSettlement, mergeSettlement, setSettlement, type BackendSettlement } from '../config/settlement';

/**
 * Loads GET /api/v1/health/settlement once and lays the backend's answer over
 * the build-time settlement table (config/settlement.ts): which chain new
 * tasks post on, and each chain's token, escrow and relay name.
 *
 * Non-blocking: until the answer arrives — or if it never does — every reader
 * sees the build-time defaults, which are what this app assumed before it
 * asked. The endpoint is config-only on the backend (no RPC), so the answer
 * normally lands before the first page renders anything priced.
 */
export function SettlementProvider({ children }: { children: ReactNode }) {
  const { data } = useQuery({
    queryKey: ['settlement'],
    queryFn: () => get<BackendSettlement>('/api/v1/health/settlement'),
    staleTime: Infinity,
    retry: 2,
  });
  useEffect(() => {
    if (data) setSettlement(mergeSettlement(defaultSettlement(), data));
  }, [data]);
  return <>{children}</>;
}

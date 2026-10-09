import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import {
  getOpenScorecard,
  getOpenSubmissionConfig,
  getOpenTaskStatus,
  listOpenSubmissions,
} from '../services/openSubmission';
import { openStatusSettled, openStatusStale } from '../lib/openTask';

/** Whether this server runs open submission, and its pick windows. Off when the read fails. */
export function useOpenSubmissionConfig() {
  return useQuery({
    queryKey: ['open-submission', 'config'],
    queryFn: getOpenSubmissionConfig,
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

/**
 * Where an open task stands, refreshed every 30 s while the page is open
 * until it has settled; sooner (past the server's 15 s cache) while the read
 * is older than the escrow status the page has.
 */
export function useOpenTaskStatus(taskHash: string | undefined, enabled: boolean, onChainStatus: number | undefined) {
  return useQuery({
    queryKey: ['open-submission', 'status', taskHash],
    queryFn: () => getOpenTaskStatus(taskHash!),
    enabled: enabled && !!taskHash,
    refetchInterval: (q) => {
      const s = q.state.data;
      if (s && openStatusSettled(s, onChainStatus)) return false;
      return s && openStatusStale(s, onChainStatus) ? 16_000 : 30_000;
    },
  });
}

/** An open task's submissions, page by page (signed in); refreshed every 30 s while `live`. */
export function useOpenSubmissions(taskHash: string | undefined, enabled: boolean, live: boolean) {
  const { isAuthenticated } = useAuth();
  return useInfiniteQuery({
    queryKey: ['open-submission', 'submissions', taskHash],
    queryFn: ({ pageParam }) => listOpenSubmissions(taskHash!, pageParam),
    initialPageParam: '0',
    getNextPageParam: (last) => (last.cursor && last.cursor !== '0' ? last.cursor : undefined),
    enabled: enabled && !!taskHash && isAuthenticated,
    refetchInterval: live ? 30_000 : false,
    retry: false,
  });
}

/** The judge's scorecard once a winner was picked (signed in). */
export function useOpenScorecard(taskHash: string | undefined, enabled: boolean) {
  const { isAuthenticated } = useAuth();
  return useQuery({
    queryKey: ['open-submission', 'scorecard', taskHash],
    queryFn: () => getOpenScorecard(taskHash!),
    enabled: enabled && !!taskHash && isAuthenticated,
    // The status can show a pick (read from the escrow) a few seconds before
    // the indexer records it, and the scorecard answers NOT_CLOSED until then.
    retry: (n, e) => (e as { code?: string }).code === 'NOT_CLOSED' && n < 6,
    retryDelay: 10_000,
  });
}

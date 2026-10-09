import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import {
  getOpenScorecard,
  getOpenSubmissionConfig,
  getOpenTaskStatus,
  listOpenSubmissions,
} from '../services/openSubmission';

/** Whether this server runs open submission, and its pick windows. Off when the read fails. */
export function useOpenSubmissionConfig() {
  return useQuery({
    queryKey: ['open-submission', 'config'],
    queryFn: getOpenSubmissionConfig,
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

/** Where an open task stands, refreshed every 30 s while the page is open, until it closes. */
export function useOpenTaskStatus(taskHash: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['open-submission', 'status', taskHash],
    queryFn: () => getOpenTaskStatus(taskHash!),
    enabled: enabled && !!taskHash,
    refetchInterval: (q) => (q.state.data?.phase === 'closed' ? false : 30_000),
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
    retry: false,
  });
}

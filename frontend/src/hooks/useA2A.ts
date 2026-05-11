import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as a2aService from '../services/a2a';

export function useAgentProfile() {
  return useQuery({
    queryKey: ['a2a', 'profile'],
    queryFn: () => a2aService.getProfile(),
    retry: false,
  });
}

export function useBrowseAgentTasks(capabilities?: string[], minReputation?: number) {
  return useQuery({
    queryKey: ['a2a', 'tasks', capabilities, minReputation],
    queryFn: () => a2aService.browseAgentTasks(capabilities, minReputation),
    refetchInterval: 10_000,
  });
}

export function useMyExecutions() {
  return useQuery({
    queryKey: ['a2a', 'executions'],
    queryFn: () => a2aService.getExecutions(),
    refetchInterval: 10_000,
  });
}

export function useRegisterAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: a2aService.registerAgent,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['a2a', 'profile'] });
    },
  });
}

export function useAcceptTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => a2aService.acceptTask(taskId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['a2a'] });
    },
  });
}

export function useSubmitWork() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, resultData }: { taskId: string; resultData: Record<string, unknown> }) =>
      a2aService.submitWork(taskId, resultData),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['a2a'] });
    },
  });
}

export function usePostedTasks() {
  return useQuery({
    queryKey: ['a2a', 'posted'],
    queryFn: () => a2aService.getPostedTasks(),
    refetchInterval: 10_000,
  });
}

export function useVerifyTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, passed, reasons }: { taskId: string; passed: boolean; reasons?: string[] }) =>
      a2aService.verifyTask(taskId, passed, reasons),
    onSuccess: () => {
      // Refresh the posted list so the verified task drops out of the inbox
      qc.invalidateQueries({ queryKey: ['a2a', 'posted'] });
      qc.invalidateQueries({ queryKey: ['a2a'] });
    },
  });
}

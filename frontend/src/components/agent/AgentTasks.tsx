import { useState, useEffect, useCallback } from 'react';
import { StatusTag, EmptyState, ErrorState } from '../bb';
import { authedGet } from '../../lib/api';

export function AgentTasks({ agentWallet }: { agentWallet?: string }) {
  type Execution = {
    meta: { taskId: string; requiredCapabilities?: string[] };
    state: { status: string; acceptedAt?: string; verificationResult?: { passed: boolean } };
  };
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [tasksError, setTasksError] = useState(false);

  const loadTasks = useCallback(() => {
    if (!agentWallet) return;
    setTasksError(false);
    authedGet<{ executions?: Execution[] }>(`/api/v1/a2a/executions?address=${agentWallet}`)
      .then(data => setExecutions(data.executions ?? []))
      .catch(() => setTasksError(true));
  }, [agentWallet]);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  if (tasksError && executions.length === 0) {
    return <ErrorState title="Couldn't load this agent's tasks" onRetry={() => loadTasks()} />;
  }

  if (executions.length === 0) {
    return (
      <EmptyState
        icon="briefcase"
        title="No tasks yet"
        description="Tasks this agent accepts and executes will appear here."
      />
    );
  }

  const sorted = [...executions].sort((a, b) => {
    const ta = a.state.acceptedAt ? Date.parse(a.state.acceptedAt) : 0;
    const tb = b.state.acceptedAt ? Date.parse(b.state.acceptedAt) : 0;
    return tb - ta;
  });

  return (
    <div className="space-y-2">
      {sorted.map(e => (
        <div key={e.meta.taskId} className="card-dark flex items-center justify-between gap-3 px-4 py-3 text-sm">
          <span className="font-mono text-ink-3 shrink-0">{e.meta.taskId.slice(0, 10)}…</span>
          <span className="text-ink-2 truncate flex-1 text-center">{(e.meta.requiredCapabilities ?? []).join(', ') || '—'}</span>
          <span className="shrink-0"><StatusTag status={e.state.status} /></span>
        </div>
      ))}
    </div>
  );
}

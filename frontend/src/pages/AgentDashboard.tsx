import { useAccount } from 'wagmi';
import { useQuery } from '@tanstack/react-query';
import { Breadcrumb, PageHeader, SectionRule, StatCard, Panel, Tag, Prompt } from '../components/bb';
import { useReputation } from '../hooks/useReputation';
import { truncateAddress } from '../lib/utils';
import { Link } from 'react-router-dom';

const STATUS_LABELS: Record<number, string> = { 0: 'funded', 1: 'assigned', 2: 'submitted', 3: 'verified', 4: 'completed', 5: 'cancelled', 6: 'disputed' };
const STATUS_TONE: Record<number, 'ok' | 'warn' | 'err' | 'neutral'> = { 0: 'neutral', 1: 'warn', 2: 'warn', 3: 'ok', 4: 'ok', 5: 'err', 6: 'err' };

export default function AgentDashboard() {
  const { address } = useAccount();
  const { data: reputation } = useReputation(address ?? null);

  // Fetch tasks assigned to this agent wallet
  const { data: taskData } = useQuery({
    queryKey: ['agent-tasks', address],
    queryFn: async () => {
      const res = await fetch(`/api/v1/tasks?limit=50`);
      const json = await res.json();
      if (!json.success) return [];
      // Filter tasks where worker === address (assigned to this agent)
      return (json.data.tasks as Array<{ taskId: string; category: string; locationZone: string; reward: string; agent: string; worker?: string; status?: number }>)
        .filter(t => t.worker?.toLowerCase() === address?.toLowerCase());
    },
    enabled: !!address,
  });

  const active = taskData?.filter(t => t.status === 1 || t.status === 2) ?? [];
  const completed = taskData?.filter(t => t.status === 4) ?? [];

  return (
    <div>
      <Breadcrumb items={['marketplace', 'agent']} />
      <PageHeader
        title="Agent dashboard"
        description="Tasks assigned to your agent — complete them via the SDK or CLI."
      />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-0 border border-line mb-8">
        <StatCard label="assigned" value={String(active.length)} sub="active tasks" subColor={active.length > 0 ? 'warn' : undefined} />
        <div className="border-l border-line">
          <StatCard label="completed" value={String(completed.length)} sub="all time" subColor="ok" />
        </div>
        <div className="border-l border-line">
          <StatCard label="reputation" value={reputation ? reputation.decayedScore.toFixed(1) : '—'} sub={address ? `${reputation?.tasksCompleted ?? 0} tasks` : 'connect wallet'} />
        </div>
        <div className="border-l border-line">
          <StatCard label="wallet" value={address ? truncateAddress(address) : '—'} sub="agent identity" />
        </div>
      </div>

      {/* Assigned tasks */}
      <Panel>
        <SectionRule num="01" title="assigned tasks" side={`${active.length} active`} />
        <div className="mt-4 border border-line overflow-x-auto">
          {!address ? (
            <div className="px-5 py-8 text-center text-xs font-mono text-ink-3">connect wallet to see assigned tasks</div>
          ) : active.length === 0 ? (
            <div className="px-5 py-8 flex flex-col items-center gap-3">
              <Prompt command="blind tasks --assigned" blink />
              <p className="text-xs font-mono text-ink-3">no tasks assigned yet. browse the task feed to apply.</p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-[80px_1fr_120px_100px_80px] gap-4 px-5 py-3 border-b border-line text-[11px] font-mono font-semibold uppercase tracking-widest text-ink-3">
                <span>id</span><span>category · zone</span><span>bounty</span><span>status</span><span></span>
              </div>
              {active.map(t => (
                <div key={t.taskId} className="grid grid-cols-[80px_1fr_120px_100px_80px] gap-4 px-5 py-4 border-b border-line last:border-b-0 text-[13px] font-mono items-center">
                  <span className="text-ink-3">#{t.taskId}</span>
                  <span className="text-ink truncate">{t.category} · <span className="text-ink-3">{t.locationZone || 'global'}</span></span>
                  <span className="text-ink font-semibold">${(BigInt(t.reward) / 10n ** 18n).toString()} USDC</span>
                  <Tag tone={STATUS_TONE[t.status ?? 0]}>{STATUS_LABELS[t.status ?? 0]}</Tag>
                  <Link to={`/tasks/${t.taskId}`} className="text-[11px] font-mono text-cream hover:underline">view →</Link>
                </div>
              ))}
            </>
          )}
        </div>
      </Panel>

      {/* How to complete via SDK */}
      <div className="mt-6 border border-line p-6 space-y-3">
        <SectionRule num="02" title="complete a task via sdk" />
        <pre className="bg-surface-2 border border-line p-4 text-xs font-mono text-ink-3 leading-relaxed overflow-x-auto whitespace-pre">{`import { BlindMarket } from '@blindmarket/sdk';
import { ethers } from 'ethers';

const wallet = new ethers.Wallet(process.env.AGENT_PRIVATE_KEY);
const apiKey = await BlindMarket.authenticate(wallet);
const bb = new BlindMarket({ apiKey });

// Get your assigned tasks
const tasks = await bb.listTasks();

// Submit evidence via the CLI instead:
// blind submit-evidence --task-id 1 --evidence "result here"`}</pre>
      </div>
    </div>
  );
}

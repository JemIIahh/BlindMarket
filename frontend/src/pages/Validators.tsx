import { useState } from 'react';
import { useAccount, useWalletClient } from 'wagmi';
import { useQuery } from '@tanstack/react-query';
import { BrowserProvider } from 'ethers';
import { Breadcrumb, PageHeader, SectionRule, StatCard } from '../components/bb';
import { useSocket } from '../hooks/useSocket';
import { signAndSendTx } from '../lib/txSigner';
import { authedPost } from '../lib/api';
import { API_BASE_URL } from '../config/constants';
import { MintTestTokensCard } from '../components/MintTestTokensCard';

interface ValidatorInfo {
  stake: string;
  active: boolean;
  totalVotes: number;
  correctVotes: number;
}

interface Dispute {
  disputeId: string;
  taskId: string;
  amount: string;
  openedAt: number;
  finalized: boolean;
  workerFavored: boolean;
  workerVotes: number;
  agentVotes: number;
}

export default function Validators() {
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();

  const [stakeAmount, setStakeAmount] = useState('100');
  const [txStatus, setTxStatus] = useState('');

  const { data: stats, refetch: refetchStats } = useQuery({
    queryKey: ['stats'],
    queryFn: async () => {
      const r = await fetch(`${API_BASE_URL}/api/v1/stats`);
      return r.json().then(j => j.data);
    },
  });

  const { data: validatorInfo, refetch: refetchValidator } = useQuery<ValidatorInfo>({
    queryKey: ['validator', address],
    queryFn: async () => {
      const r = await fetch(`${API_BASE_URL}/api/v1/validators/${address}`);
      const j = await r.json();
      return j.success ? j.data : null;
    },
    enabled: !!address,
  });

  const { data: disputes = [], refetch: refetchDisputes } = useQuery<Dispute[]>({
    queryKey: ['disputes'],
    queryFn: async () => {
      // Fetch open disputes — try IDs 1..20
      const results: Dispute[] = [];
      for (let i = 1; i <= 10; i++) {
        const r = await fetch(`${API_BASE_URL}/api/v1/validators/disputes/${i}`);
        if (!r.ok) break;
        const j = await r.json();
        if (j.success && !j.data.finalized) results.push({ ...j.data, disputeId: String(i) });
      }
      return results;
    },
  });

  useSocket('disputes', {
    'dispute:voted': () => { refetchDisputes(); refetchStats(); },
    'dispute:finalized': () => { refetchDisputes(); refetchStats(); },
  });

  async function sendTx(endpoint: string, body: object, label: string) {
    if (!address || !walletClient) return;
    setTxStatus(`${label}…`);
    try {
      const txJson = await authedPost<{ unsignedTx: object }>(endpoint, body);
      const provider = new BrowserProvider(walletClient.transport);
      const signer = await provider.getSigner();
      await signAndSendTx(signer, txJson.unsignedTx as any);
      setTxStatus('✓ done');
      refetchValidator();
      refetchDisputes();
      refetchStats();
    } catch (e) {
      setTxStatus(`error: ${(e as Error).message}`);
    }
  }

  async function stakeWithApproval() {
    if (!address || !walletClient) return;
    const amountWei = BigInt(Math.round(parseFloat(stakeAmount))) * 10n ** 6n;
    const USDC = import.meta.env.VITE_MOCK_ERC20_ADDRESS ?? '0x3af9232009C5da30AdA366B6E09849A040162A1a';
    const POOL = '0xBBE1b3736147C849455467E558245b04f01790E6';
    const approveData = '0x095ea7b3' +
      POOL.slice(2).toLowerCase().padStart(64, '0') +
      amountWei.toString(16).padStart(64, '0');
    setTxStatus('step 1/2: approve USDC…');
    try {
      const provider = new BrowserProvider(walletClient.transport);
      const signer = await provider.getSigner();
      const approveTx = await signer.sendTransaction({ to: USDC, data: approveData });
      // Poll for receipt — 0G RPC doesn't support .wait() reliably
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 3000));
        try { if (await provider.getTransactionReceipt(approveTx.hash)) break; } catch {}
      }
      setTxStatus('step 2/2: staking…');
      await sendTx('/api/v1/validators/register', { amount: String(amountWei) }, 'staking');
    } catch (e) {
      setTxStatus(`error: ${(e as Error).message}`);
    }
  }

  const isValidator = validatorInfo?.active;
  const accuracy = validatorInfo && validatorInfo.totalVotes > 0
    ? Math.round((validatorInfo.correctVotes / validatorInfo.totalVotes) * 100)
    : null;

  return (
    <div>
      <Breadcrumb items={['marketplace', 'validators']} />
      <PageHeader
        title="Validators"
        description="Stake tokens to join the dispute resolution pool. Vote on disputes, earn rewards."
      />

      {/* Stats */}
      <div className="grid grid-cols-3 gap-0 border border-line mb-8">
        <StatCard label="active validators" value={String(stats?.activeValidators ?? '—')} sub="staked + online" subColor="ok" />
        <div className="border-l border-line">
          <StatCard label="open disputes" value={String(disputes.length)} sub="awaiting votes" subColor={disputes.length > 0 ? 'warn' : undefined} />
        </div>
        <div className="border-l border-line">
          {isValidator
            ? <StatCard label="your accuracy" value={accuracy !== null ? `${accuracy}%` : '—'} sub={`${validatorInfo!.totalVotes} votes`} subColor="ok" />
            : <StatCard label="your status" value="not staked" sub="stake to become a validator" />
          }
        </div>
      </div>

      {/* Onboarding / status */}
      <div className="border border-line mb-8">
        <div className="p-6 border-b border-line">
          <SectionRule num="01" title={isValidator ? 'your validator status' : 'become a validator'} />
        </div>

        {!address ? (
          <div className="p-8 text-center text-xs font-mono text-ink-3">connect wallet to continue</div>
        ) : isValidator ? (
          <div className="p-6 grid grid-cols-4 gap-6 text-xs font-mono">
            <div><div className="text-ink-3 mb-1">staked</div><div className="text-cream">{(BigInt(validatorInfo!.stake) / 10n ** 6n).toString()} USDC</div></div>
            <div><div className="text-ink-3 mb-1">total votes</div><div className="text-ink">{validatorInfo!.totalVotes}</div></div>
            <div><div className="text-ink-3 mb-1">correct votes</div><div className="text-ink">{validatorInfo!.correctVotes}</div></div>
            <div>
              <div className="text-ink-3 mb-2">actions</div>
              <button onClick={() => sendTx('/api/v1/validators/unstake', {}, 'unstaking')}
                className="px-3 py-1 border border-line text-ink-3 hover:border-red-400 hover:text-red-400 transition-colors">
                unstake
              </button>
            </div>
          </div>
        ) : (
          <div className="p-6 space-y-4">
            <MintTestTokensCard />
            <div className="text-xs font-mono text-ink-3 leading-relaxed max-w-lg">
              Stake USDC to join the validator pool. You'll vote on disputed tasks and earn a share of slashed stakes from wrong voters. Minimum stake: 100 USDC.
            </div>
            <div className="flex items-end gap-4">
              <div>
                <label className="block text-[11px] font-mono uppercase tracking-widest text-ink-3 mb-2">stake amount (USDC)</label>
                <input type="number" min="100" value={stakeAmount} onChange={e => setStakeAmount(e.target.value)}
                  className="w-40 bg-surface-2 border border-line px-4 py-3 text-xs font-mono text-ink focus:outline-none focus:border-cream" />
              </div>
              <button onClick={() => stakeWithApproval()}
                className="px-6 py-3 border border-cream text-xs font-mono text-cream hover:bg-cream hover:text-bg transition-colors">
                stake + become validator →
              </button>
            </div>
            {txStatus && <div className={`text-xs font-mono ${txStatus.startsWith('error') ? 'text-red-400' : 'text-green-400'}`}>{txStatus}</div>}
          </div>
        )}
      </div>

      {/* Open disputes */}
      <div className="border border-line">
        <div className="p-6 border-b border-line">
          <SectionRule num="02" title="open disputes" side={`${disputes.length} pending`} />
        </div>

        {disputes.length === 0 ? (
          <div className="p-8 text-center text-xs font-mono text-ink-3">no open disputes</div>
        ) : (
          <>
            <div className="grid grid-cols-[80px_1fr_120px_100px_100px_160px] gap-4 px-5 py-3 border-b border-line text-[11px] font-mono font-semibold uppercase tracking-widest text-ink-3">
              <span>dispute</span><span>task</span><span>amount</span><span>worker votes</span><span>agent votes</span><span></span>
            </div>
            {disputes.map(d => (
              <div key={d.disputeId} className="grid grid-cols-[80px_1fr_120px_100px_100px_160px] gap-4 px-5 py-4 border-b border-line last:border-b-0 text-xs font-mono items-center">
                <span className="text-ink-3">#{d.disputeId}</span>
                <span className="text-ink">task #{d.taskId}</span>
                <span className="text-cream">${(BigInt(d.amount) / 10n ** 6n).toString()} USDC</span>
                <span className="text-ink">{d.workerVotes}</span>
                <span className="text-ink">{d.agentVotes}</span>
                <div className="flex gap-2">
                  <button onClick={() => sendTx('/api/v1/validators/vote', { disputeId: d.disputeId, vote: 1 }, 'voting')}
                    className="px-3 py-1 border border-green-400 text-green-400 hover:bg-green-400 hover:text-bg transition-colors text-[11px]">
                    worker ✓
                  </button>
                  <button onClick={() => sendTx('/api/v1/validators/vote', { disputeId: d.disputeId, vote: 2 }, 'voting')}
                    className="px-3 py-1 border border-line text-ink-3 hover:border-red-400 hover:text-red-400 transition-colors text-[11px]">
                    agent ✓
                  </button>
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {/* How it works */}
      <div className="mt-8 border border-line p-6">
        <SectionRule num="03" title="how validators work" />
        <div className="mt-4 grid grid-cols-4 gap-6 text-xs font-mono">
          {[
            ['stake', 'Lock USDC as collateral. This is your skin in the game — wrong votes get slashed.'],
            ['dispute opens', 'When a task outcome is contested, a dispute is created on-chain with a 48h voting window.'],
            ['vote', 'Review the dispute and vote: worker-favored or agent-favored. Your vote is recorded on-chain.'],
            ['earn', 'Majority wins. Correct voters share the slashed stakes from wrong voters. Unstake anytime.'],
          ].map(([title, body], i) => (
            <div key={title} className={i < 3 ? 'border-r border-line pr-6' : ''}>
              <div className="text-cream mb-2">{String(i + 1).padStart(2, '0')} · {title}</div>
              <div className="text-ink-3 leading-relaxed">{body}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

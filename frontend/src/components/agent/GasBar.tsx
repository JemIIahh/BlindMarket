import { Button, Icon, ConfirmDialog } from '../bb';

/**
 * Gas management strip — presentational. Every piece of state and every
 * transaction lives in the page (the balance also feeds the stats row); this
 * only renders it and calls back.
 */
export function GasBar({
  symbol,
  topUpAmount,
  lowGasThreshold,
  isLowGas,
  balanceEther,
  agentStatus,
  ownerLabel,
  topUpStatus,
  topUpError,
  withdrawStatus,
  withdrawError,
  withdrawInfo,
  confirmOpen,
  onTopUp,
  onWithdrawRequest,
  onWithdrawConfirm,
  onWithdrawCancel,
}: {
  symbol: string;
  topUpAmount: string;
  lowGasThreshold: number;
  isLowGas: boolean;
  balanceEther: number;
  agentStatus: string;
  ownerLabel: string;
  topUpStatus: 'idle' | 'sending' | 'error';
  topUpError: string;
  withdrawStatus: 'idle' | 'sending' | 'done' | 'error';
  withdrawError: string;
  withdrawInfo: Array<{ chain: string; asset: string; amount: string; txHash: string }> | null;
  confirmOpen: boolean;
  onTopUp: () => void;
  onWithdrawRequest: () => void;
  onWithdrawConfirm: () => void;
  onWithdrawCancel: () => void;
}) {
  return (
    <div className="border border-line px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 text-ink-2">
          <Icon name="bolt" size={16} className={isLowGas ? 'text-warn' : 'text-ink-3'} />
          <span className="text-[13px] font-medium">Wallet</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={isLowGas ? 'primary' : 'outline'}
            size="sm"
            onClick={onTopUp}
            disabled={topUpStatus === 'sending'}
            label={topUpStatus === 'sending' ? `Sending ${topUpAmount} ${symbol}…` : `Fund wallet (+${topUpAmount} ${symbol})`}
          />
          {/* Withdraw — single button sweeps whichever chain(s) the agent's
              wallet actually holds a balance on (0G and/or Base) in one
              call. Empty body sweeps native balance on both; pass
              tokenAddress to sweep that ERC20 instead. */}
          {agentStatus !== 'running' && (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={onWithdrawRequest}
                disabled={withdrawStatus === 'sending' || balanceEther < 0.0015}
                label={withdrawStatus === 'sending' ? 'Withdrawing…' : 'Withdraw to owner'}
              />
              <ConfirmDialog
                open={confirmOpen}
                title="Withdraw agent funds"
                description={`Funds in this agent's wallet will be sent back to ${ownerLabel}. This can't be undone.`}
                confirmLabel="Withdraw funds"
                onConfirm={onWithdrawConfirm}
                onCancel={onWithdrawCancel}
              />
            </>
          )}
        </div>
      </div>

      {/* Status / warning line */}
      {(topUpStatus === 'error' ||
        withdrawStatus === 'done' ||
        withdrawStatus === 'error' ||
        (isLowGas && agentStatus !== 'stopped')) && (
        <div className="mt-3 space-y-1.5 text-xs">
          {topUpStatus === 'error' && <div className="text-err">{topUpError}</div>}
          {withdrawStatus === 'done' && withdrawInfo && withdrawInfo.length > 0 && (
            <div className="text-ok space-y-0.5">
              {withdrawInfo.map((w) => (
                <div key={`${w.chain}-${w.txHash}`}>
                  Withdrew <span className="font-mono">{parseFloat(w.amount).toFixed(4)} {w.asset}</span> from{' '}
                  <span className="font-mono">{w.chain === 'base' ? 'Base' : '0G'}</span> ·
                  tx <span className="font-mono">{w.txHash.slice(0, 10)}…</span>
                </div>
              ))}
            </div>
          )}
          {withdrawStatus === 'error' && <div className="text-err">{withdrawError}</div>}
          {isLowGas && agentStatus !== 'stopped' && (
            <div className="text-warn">
              Agent will fail to submit evidence below <span className="font-mono">{lowGasThreshold} {symbol}</span>.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

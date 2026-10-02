import { formatUnits } from 'ethers';
import { Button, Icon, ConfirmDialog, CopyButton, ErrorNotice } from '../bb';

/** How a withdraw receipt names the chain it swept (backend chain keys). */
const CHAIN_LABEL: Record<string, string> = { arc: 'Arc', base: 'Base', '0g': '0G' };

/**
 * Gas management strip — presentational. Every piece of state and every
 * transaction lives in the page (the balance also feeds the stats row); this
 * only renders it and calls back.
 */
export function GasBar({
  symbol,
  fundingAddress,
  chainLabel,
  topUpAmount,
  minGasLabel,
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
  refreshing,
  onTopUp,
  onRefresh,
  onWithdrawRequest,
  onWithdrawConfirm,
  onWithdrawCancel,
  cctpChains,
  cctpDestChain,
  onCctpDestChainChange,
  cctpStatus,
  cctpError,
  cctpTransfer,
  onCctpWithdraw,
  cctpQuote,
  cctpQuoteLoading,
  cctpSymbol,
}: {
  symbol: string;
  /** Where the agent pays gas from on the posting chain: the address to fund. */
  fundingAddress?: string;
  /** The posting chain's name, e.g. "Arc". */
  chainLabel: string;
  topUpAmount: string;
  /**
   * What one transaction can cost at current gas prices, formatted in
   * `symbol`: below it the worker takes no task. Null where it is unknown.
   */
  minGasLabel: string | null;
  isLowGas: boolean;
  balanceEther: number;
  agentStatus: string;
  ownerLabel: string;
  topUpStatus: 'idle' | 'sending' | 'error';
  topUpError: unknown;
  withdrawStatus: 'idle' | 'sending' | 'done' | 'error';
  withdrawError: unknown;
  withdrawInfo: Array<{ chain: string; asset: string; amount: string; txHash: string }> | null;
  confirmOpen: boolean;
  refreshing?: boolean;
  onTopUp: () => void;
  onRefresh: () => void;
  onWithdrawRequest: () => void;
  onWithdrawConfirm: () => void;
  onWithdrawCancel: () => void;
  // CCTP outbound bridge (Base USDC -> another EVM chain). `cctpChains` empty
  // means CCTP isn't enabled on this deployment — the whole control hides.
  cctpChains: Array<{ chainKey: string; label: string }>;
  cctpDestChain: string;
  onCctpDestChainChange: (chainKey: string) => void;
  cctpStatus: 'idle' | 'sending' | 'polling' | 'done' | 'error';
  cctpError: unknown;
  cctpTransfer: { stage: string; burnTxHash: string | null; mintTxHash: string | null } | null;
  onCctpWithdraw: () => void;
  // Fee preview — fetched from GET /api/v1/cctp/quote as soon as a
  // destination is picked, shown BEFORE the owner commits to a burn.
  cctpQuote: { maxFeeRaw: string; estimatedReceiveRaw: string } | null;
  cctpQuoteLoading: boolean;
  cctpSymbol: string;
}) {
  return (
    <div className="card-dark px-5 py-4 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 text-ink-2">
          <Icon name="bolt" size={16} className={isLowGas ? 'text-warn' : 'text-ink-3'} />
          <span className="text-[13px] font-medium">Wallet</span>
          <span className="font-mono text-sm text-ink">{balanceEther.toFixed(4)} {symbol}</span>
          <button
            onClick={onRefresh}
            disabled={refreshing}
            title="Refresh balance"
            aria-label="Refresh balance"
            className="p-1.5 -m-1.5 rounded-full text-ink-3 hover:text-ink transition-colors disabled:opacity-50"
          >
            <Icon name={refreshing ? 'clock' : 'search'} size={14} className={refreshing ? 'animate-spin' : ''} />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={isLowGas ? 'primary' : 'outline'}
            size="sm"
            onClick={onTopUp}
            disabled={topUpStatus === 'sending'}
            label={topUpStatus === 'sending' ? `Sending ${topUpAmount} ${symbol}…` : 'Fund wallet'}
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
          {/* Bridge out via Circle CCTP — moves Base USDC to a DIFFERENT
              chain, unlike Withdraw above which only sweeps back to the same
              address on the same chain. Hidden entirely when CCTP isn't
              enabled on this deployment (cctpChains empty). */}
          {agentStatus !== 'running' && cctpChains.length > 0 && (
            <div className="flex flex-col items-end gap-1">
              <div className="flex items-center gap-1.5">
                <select
                  value={cctpDestChain}
                  onChange={(e) => onCctpDestChainChange(e.target.value)}
                  disabled={cctpStatus === 'sending' || cctpStatus === 'polling'}
                  className="rounded-full border border-line bg-transparent px-3 py-1.5 text-xs text-ink-2 disabled:opacity-50"
                >
                  {cctpChains.map((c) => (
                    <option key={c.chainKey} value={c.chainKey}>{c.label}</option>
                  ))}
                </select>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onCctpWithdraw}
                  disabled={cctpStatus === 'sending' || cctpStatus === 'polling' || balanceEther < 0.0015}
                  label={
                    cctpStatus === 'sending' ? 'Submitting…'
                    : cctpStatus === 'polling' ? 'Bridging…'
                    : 'Bridge out'
                  }
                />
              </div>
              {/* Fee preview — shown before the owner commits to a burn, not
                  only discoverable afterward by diffing balances. */}
              {cctpStatus === 'idle' && (
                <div className="text-[11px] text-ink-3">
                  {cctpQuoteLoading && 'Quoting…'}
                  {!cctpQuoteLoading && cctpQuote && (
                    <>You'll receive ≈<span className="font-mono">{parseFloat(formatUnits(cctpQuote.estimatedReceiveRaw, 6)).toFixed(4)} {cctpSymbol}</span> (fee {formatUnits(cctpQuote.maxFeeRaw, 6)} {cctpSymbol})</>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* The address itself, for funding from anywhere else: an exchange,
          another wallet, a bridge. "Fund wallet" only sends from the
          connected wallet. */}
      {fundingAddress && (
        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-3">
          <span>Or send {symbol} on {chainLabel} from any wallet to</span>
          <span className="font-mono text-ink-2 break-all">{fundingAddress}</span>
          <CopyButton text={fundingAddress} what="wallet address" />
        </div>
      )}

      {/* Status / warning line */}
      {(topUpStatus === 'error' ||
        withdrawStatus === 'done' ||
        withdrawStatus === 'error' ||
        cctpStatus === 'polling' ||
        cctpStatus === 'done' ||
        cctpStatus === 'error' ||
        (isLowGas && agentStatus !== 'stopped')) && (
        <div className="mt-3 space-y-1.5 text-xs">
          {topUpStatus === 'error' && <ErrorNotice error={topUpError} title="Couldn't top up" compact />}
          {withdrawStatus === 'done' && withdrawInfo && withdrawInfo.length > 0 && (
            <div className="text-ok space-y-0.5">
              {withdrawInfo.map((w) => (
                <div key={`${w.chain}-${w.txHash}`}>
                  Withdrew <span className="font-mono">{parseFloat(w.amount).toFixed(4)} {w.asset}</span> from{' '}
                  <span className="font-mono">{CHAIN_LABEL[w.chain] ?? w.chain}</span> ·
                  tx <span className="font-mono">{w.txHash.slice(0, 10)}…</span>
                </div>
              ))}
            </div>
          )}
          {withdrawStatus === 'error' && <ErrorNotice error={withdrawError} title="Couldn't withdraw" compact />}
          {cctpStatus === 'polling' && cctpTransfer && (
            <div className="text-ink-2">
              Bridging — {cctpTransfer.stage.replace(/_/g, ' ')}
              {cctpTransfer.burnTxHash && <> · burn tx <span className="font-mono">{cctpTransfer.burnTxHash.slice(0, 10)}…</span></>}
            </div>
          )}
          {cctpStatus === 'done' && cctpTransfer?.mintTxHash && (
            <div className="text-ok">
              Bridge complete · mint tx <span className="font-mono">{cctpTransfer.mintTxHash.slice(0, 10)}…</span>
            </div>
          )}
          {cctpStatus === 'error' && <ErrorNotice error={cctpError} title="Couldn't bridge" compact />}
          {isLowGas && agentStatus !== 'stopped' && (
            <div className="text-warn">
              {minGasLabel !== null ? (
                <>
                  It takes no tasks while its wallet holds less than{' '}
                  <span className="font-mono">{minGasLabel} {symbol}</span>, what one transaction can cost at current gas
                  prices. Top it up to resume; a submitted result usually costs under a cent.
                </>
              ) : (
                <>Its wallet is empty, so it can't pay gas and takes no tasks until you top it up.</>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

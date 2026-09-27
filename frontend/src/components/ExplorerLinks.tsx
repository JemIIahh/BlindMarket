import { OG_CHAIN_CONFIG } from '../config/constants';
import { useSettlement, type SettlementSnapshot } from '../config/settlement';

/**
 * The explorers an agent wallet is linked on. It is the same EOA on every
 * chain, and two of them matter for an agent: the posting chain, where its
 * tasks settle and it pays gas (Arc), and 0G, where its identity and
 * reputation live. Other settlement chains the backend keeps only for tasks
 * posted before the move (Base) are left out: listing them linked every agent
 * there, including ones that never worked on them, and a task on one of those
 * chains links its own chain from the task page. Exported for tests.
 */
export function agentExplorerLinks(
  settlement: SettlementSnapshot,
  ogExplorer: string | undefined = OG_CHAIN_CONFIG.blockExplorerUrls[0],
): Array<{ label: string; url: string }> {
  const posting = settlement.chains[settlement.postingChain];
  return [
    { label: shortLabel(posting.label), url: posting.explorer },
    { label: '0G', url: ogExplorer ?? '' },
  ].filter((l) => !!l.url);
}

/** Explorer links for an agent wallet (agentExplorerLinks). */
export function ExplorerAddressLinks({
  address,
  className = '',
}: {
  address: string;
  className?: string;
}) {
  const links = agentExplorerLinks(useSettlement());
  const linkCls =
    '-my-1 py-1 hover:text-accent hover:underline decoration-line-2 underline-offset-[3px] transition-colors';
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      {links.map((l, i) => (
        <span key={l.label} className="inline-flex items-center gap-1.5">
          {i > 0 && <span className="opacity-50">·</span>}
          <a href={`${l.url}/address/${address}`} target="_blank" rel="noopener noreferrer" className={linkCls} title={`View ${address} on the ${l.label} explorer`}>
            {l.label} ↗
          </a>
        </span>
      ))}
    </span>
  );
}

/** "Arc Testnet" → "Arc", "Base Sepolia" → "Base": the chain, not the network tier. */
function shortLabel(label: string): string {
  return label.split(' ')[0] || label;
}

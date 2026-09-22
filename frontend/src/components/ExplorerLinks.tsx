import { OG_CHAIN_CONFIG } from '../config/constants';
import { useSettlement } from '../config/settlement';

/**
 * Explorer links for an agent wallet. It is the same EOA on every chain: the
 * posting chain (where new tasks settle — Arc), the other settlement chains
 * it may hold earlier payouts on (Base), and 0G, where identity and
 * reputation live — so a single-chain link hides part of the picture.
 */
export function ExplorerAddressLinks({
  address,
  className = '',
}: {
  address: string;
  className?: string;
}) {
  const settlement = useSettlement();
  const posting = settlement.chains[settlement.postingChain];
  const others = Object.values(settlement.chains).filter((c) => c.key !== posting.key);
  const links = [
    { label: shortLabel(posting.label), url: posting.explorer },
    ...others.map((c) => ({ label: shortLabel(c.label), url: c.explorer })),
    { label: '0G', url: OG_CHAIN_CONFIG.blockExplorerUrls[0] },
  ].filter((l) => !!l.url);
  const linkCls =
    '-my-1 py-1 hover:text-cream hover:underline decoration-cream/30 transition-colors';
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

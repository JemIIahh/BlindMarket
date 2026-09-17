import { BASE_CHAIN_CONFIG, OG_CHAIN_CONFIG } from '../config/constants';

/**
 * Dual-explorer address links. An agent wallet is the same EOA on both
 * chains — USDC settlement on Base, identity/reputation on 0G — so a
 * single-chain link always hides half the picture.
 */
export function ExplorerAddressLinks({
  address,
  className = '',
}: {
  address: string;
  className?: string;
}) {
  const base = BASE_CHAIN_CONFIG.blockExplorerUrls[0];
  const og = OG_CHAIN_CONFIG.blockExplorerUrls[0];
  const linkCls =
    '-my-1 py-1 hover:text-cream hover:underline decoration-cream/30 transition-colors';
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <a href={`${base}/address/${address}`} target="_blank" rel="noopener noreferrer" className={linkCls} title={`View ${address} on Base explorer`}>
        Base ↗
      </a>
      <span className="opacity-50">·</span>
      <a href={`${og}/address/${address}`} target="_blank" rel="noopener noreferrer" className={linkCls} title={`View ${address} on 0G explorer`}>
        0G ↗
      </a>
    </span>
  );
}

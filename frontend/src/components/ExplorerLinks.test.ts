import { describe, expect, it } from 'vitest';
import { defaultSettlement } from '../config/settlement';
import { agentExplorerLinks } from './ExplorerLinks';

/**
 * An agent wallet is linked on the chain its tasks settle on and on 0G, where
 * its identity and reputation live. Base stays a settlement chain on the
 * backend only for tasks posted before the move to Arc, so linking it for
 * every agent pointed owners at a chain most of their agents never used.
 */

const OG = 'https://chainscan.0g.ai';

describe('agentExplorerLinks', () => {
  it('links Arc and 0G, not Base, while Arc is the posting chain', () => {
    const links = agentExplorerLinks({ ...defaultSettlement(), postingChain: 'arc' }, OG);
    expect(links.map((l) => l.label)).toEqual(['Arc', '0G']);
    expect(links[1].url).toBe(OG);
  });

  it('follows the posting chain', () => {
    const links = agentExplorerLinks({ ...defaultSettlement(), postingChain: 'base' }, OG);
    expect(links.map((l) => l.label)).toEqual(['Base', '0G']);
  });

  it('leaves out a chain with no explorer', () => {
    const s = defaultSettlement();
    const links = agentExplorerLinks({ ...s, postingChain: 'arc', chains: { ...s.chains, arc: { ...s.chains.arc, explorer: '' } } }, OG);
    expect(links.map((l) => l.label)).toEqual(['0G']);
  });
});

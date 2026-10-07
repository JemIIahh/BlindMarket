/** Alert copy shared by the open-submission indexer handlers and sweep. */

/** "1 agent", "12 agents". */
export const agents = (n: number) => (n === 1 ? '1 agent' : `${n} agents`);

/**
 * The terms an executor accepts a task on: what the work is and how it will be
 * judged. POST /a2a/tasks/index is re-runnable so a poster can retry a failed
 * listing or merge wrappedKeys, but a re-index must not change these. If it
 * could, a poster could let an executor accept an auto task and then switch it
 * to manual, or swap its criteria, and reject work that met the original terms
 * (security audit run 1, C01).
 *
 * The agent verifier reads verificationCriteria, requiredCapabilities,
 * routingSummary and (on public tasks) publicBrief as the task's requirements
 * (routes/verification.ts buildAuthoritativeRequirements), so they are pinned
 * together with the mode, the verifier and the brief pointer.
 */

export interface TaskTerms {
  verificationMode?: string;
  verificationCriteria?: unknown;
  verifierAddress?: string;
  rootHash?: string;
  publicBrief?: string;
  routingSummary?: string;
  requiredCapabilities?: readonly string[];
}

export const PINNED_TASK_TERMS = [
  'verificationMode',
  'verificationCriteria',
  'verifierAddress',
  'rootHash',
  'publicBrief',
  'routingSummary',
  'requiredCapabilities',
] as const satisfies readonly (keyof TaskTerms)[];

/** JSON with object keys sorted, so a retry that re-sends the same criteria in
 *  another key order still compares equal. */
function stableJson(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalize(term: (typeof PINNED_TASK_TERMS)[number], terms: TaskTerms): string {
  switch (term) {
    // /tasks/index stores 'manual' when the mode is omitted.
    case 'verificationMode':
      return terms.verificationMode ?? 'manual';
    case 'verificationCriteria':
      return stableJson(terms.verificationCriteria);
    case 'verifierAddress':
      return (terms.verifierAddress ?? '').toLowerCase();
    // A storage id, compared exactly: it is not guaranteed to be hex.
    case 'rootHash':
    case 'publicBrief':
    case 'routingSummary':
      return terms[term] ?? '';
    // Stored as [] when omitted. Compared as a set: order and repeats carry no
    // meaning (the index route de-duplicates, and older rows may hold repeats).
    case 'requiredCapabilities':
      return stableJson([...new Set(terms.requiredCapabilities ?? [])].sort());
  }
}

/** The first pinned term that differs between the stored meta and a re-index
 *  request, or null when the re-index keeps every term. */
export function changedTaskTerm(existing: TaskTerms, incoming: TaskTerms): (typeof PINNED_TASK_TERMS)[number] | null {
  for (const term of PINNED_TASK_TERMS) {
    if (normalize(term, existing) !== normalize(term, incoming)) return term;
  }
  return null;
}

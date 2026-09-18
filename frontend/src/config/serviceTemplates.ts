/**
 * Starter listings for "rent my agent" services.
 *
 * A service is a name, a per-call price and a short description of what the
 * buyer gets for one call, so the hard part of listing one is deciding what to
 * sell and for how much. These cover the capability areas BlindMarket routes
 * on (AGENT_CAPABILITIES in backend/src/types.ts); owners pick one and edit it
 * before publishing — nothing here is enforced or sent anywhere on its own.
 *
 * `type` is the listing's own label: `api` for a service a person or app calls,
 * `a2a` for one aimed at other agents delegating work. Nothing branches on it.
 *
 * `suggestedPrice` is in the settlement token the agent is paid in (USDC on
 * Base), written the way the price field expects it. They are deliberately
 * small: a first listing that undercuts is easier to raise than to walk back.
 */
export interface ServiceTemplate {
  slug: string;
  name: string;
  description: string;
  type: 'api' | 'a2a';
  suggestedPrice: string;
}

export const SERVICE_TEMPLATES: ServiceTemplate[] = [
  {
    slug: 'document-summary',
    name: 'Document summary',
    description: 'Send a document or long article. You get a short summary: the key points, any figures that matter, and what it asks you to do.',
    type: 'api',
    suggestedPrice: '0.25',
  },
  {
    slug: 'research-brief',
    name: 'Research brief',
    description: 'Ask a question. You get a short written brief answering it, with the sources it used and how confident it is in each.',
    type: 'api',
    suggestedPrice: '0.75',
  },
  {
    slug: 'competitor-scan',
    name: 'Competitor scan',
    description: 'Name a company or product. You get a rundown of its main competitors: what each sells, how they price it, and where they differ.',
    type: 'api',
    suggestedPrice: '1.50',
  },
  {
    slug: 'code-review',
    name: 'Code review',
    description: 'Send a file or a diff. You get a review: likely bugs, risky edge cases and unclear naming, each pointing at the line it refers to.',
    type: 'api',
    suggestedPrice: '0.75',
  },
  {
    slug: 'write-tests',
    name: 'Write tests',
    description: 'Send a file. You get tests for it in the same style as the ones already in the project, covering the normal path and the edges.',
    type: 'api',
    suggestedPrice: '1.00',
  },
  {
    slug: 'extract-to-json',
    name: 'Extract to JSON',
    description: 'Send messy text such as an invoice, email or page. You get the fields you asked for as JSON, with anything missing marked rather than guessed.',
    type: 'api',
    suggestedPrice: '0.30',
  },
  {
    slug: 'clean-data',
    name: 'Clean up a data file',
    description: 'Send a CSV or spreadsheet. You get it back tidied: consistent columns and dates, duplicates merged, and a note of what was changed.',
    type: 'api',
    suggestedPrice: '0.50',
  },
  {
    slug: 'translate',
    name: 'Translation',
    description: 'Send text and a target language. You get a translation that keeps the original tone and leaves names, code and numbers untouched.',
    type: 'api',
    suggestedPrice: '0.20',
  },
  {
    slug: 'sentiment-read',
    name: 'Sentiment read',
    description: 'Send reviews, replies or posts. You get the overall mood, the themes behind it, and the quotes that best show each one.',
    type: 'api',
    suggestedPrice: '0.20',
  },
  {
    slug: 'draft-post',
    name: 'Draft a post',
    description: 'Give a topic and an audience. You get a draft written to length, plus two alternative openings to choose between.',
    type: 'api',
    suggestedPrice: '0.40',
  },
  {
    slug: 'draft-reply',
    name: 'Draft an email reply',
    description: 'Send a message thread and what you want to happen next. You get a reply written in your tone, short enough to send as it is.',
    type: 'api',
    suggestedPrice: '0.15',
  },
  {
    slug: 'meeting-notes',
    name: 'Meeting notes to actions',
    description: 'Send a transcript or notes. You get the decisions, the open questions and a list of actions with owners where they were named.',
    type: 'api',
    suggestedPrice: '0.35',
  },
  {
    slug: 'report-pack',
    name: 'Weekly report',
    description: 'Send this period\'s numbers. You get a written report: what changed against last period, the likely reasons, and what to watch.',
    type: 'api',
    suggestedPrice: '1.00',
  },
  {
    slug: 'image-describe',
    name: 'Describe an image',
    description: 'Send an image. You get a description of what it shows, any text in it read out, and alt text you can use as it is.',
    type: 'api',
    suggestedPrice: '0.20',
  },
  {
    slug: 'check-work',
    name: 'Check another agent\'s work',
    description: 'For agents: send a brief and the result. You get a pass or fail against the brief, with the reasons, before you settle the task.',
    type: 'a2a',
    suggestedPrice: '0.30',
  },
  {
    slug: 'subtask-research',
    name: 'Research step for another agent',
    description: 'For agents: hand over one research step mid-task. You get the finding and its sources back in a form you can paste into your own result.',
    type: 'a2a',
    suggestedPrice: '0.50',
  },
];

/**
 * The two shown on an agent page that has no services yet, so visitors and
 * owners can see what a published listing looks like: one a person or app
 * calls, one aimed at other agents.
 */
export const EXAMPLE_SERVICES: ServiceTemplate[] = [
  SERVICE_TEMPLATES.find((t) => t.slug === 'document-summary')!,
  SERVICE_TEMPLATES.find((t) => t.slug === 'check-work')!,
];

/**
 * A poster's brief (or a private task's routing summary) as display text.
 *
 * Briefs arrive in whatever shape the poster's client sent them. Some were
 * JSON-encoded twice, so their line breaks reach us as the two characters
 * backslash + n and used to render as a literal "\n\n" on the page. Some keep
 * the JSON string's own quotes around them. Neither is what the poster wrote.
 */

// Line breaks written as text. Code spans are left alone, so a coding brief
// that says "split on `\n`" keeps its backslash.
const ESCAPED_BREAK = /\\r\\n|\\n|\\r/g;
const CODE_SPAN = /(```[\s\S]*?```|`[^`\n]*`)/;
// Control characters other than newline and tab, and format characters (bidi
// overrides, zero-width marks), which can make a title read differently than
// it is. The zero-width joiner and non-joiner (U+200D, U+200C) stay: emoji
// sequences like a technologist are built with them, and Persian and Indic
// scripts need them to join letters correctly.
const HIDDEN = /(?![\u200C\u200D])\p{Cf}|[^\P{Cc}\n\t]/gu;

function unescapeBreaks(text: string): string {
  return text
    .split(CODE_SPAN)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(ESCAPED_BREAK, '\n')))
    .join('');
}

/** The text of a JSON string literal the poster pasted whole, quotes and all
 *  (`"Title\n\nBody",`). Anything else comes back unchanged. */
function unwrapJsonString(text: string): string {
  const core = text.replace(/,\s*$/, '');
  if (core.length < 2 || !core.startsWith('"') || !core.endsWith('"')) return text;
  try {
    const parsed: unknown = JSON.parse(core);
    if (typeof parsed === 'string') return parsed;
  } catch {
    // Not valid JSON (real line breaks inside, say): just drop the quotes.
  }
  return core.slice(1, -1);
}

/** The brief with real line breaks and no hidden characters. */
export function normalizeBrief(raw: string | null | undefined): string {
  if (!raw) return '';
  let text = raw.replace(/\r\n?|[\u2028\u2029]/g, '\n').trim();
  text = unwrapJsonString(text);
  text = unescapeBreaks(text).replace(HIDDEN, '');
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Past this length the first line reads as a paragraph, not a title.
const TITLE_MAX = 100;

function cleanTitle(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/^(?:title|task)\s*:\s*/i, '')
    .replace(/^(\*\*|__)(.+)\1$/, '$2')
    .trim();
}

export interface BriefParts {
  /** First line of the brief (or its first sentence, for a single paragraph). */
  title: string;
  /** Everything after the title, line breaks kept. */
  body: string;
}

/** Splits a brief into a title and the rest. */
export function splitBrief(raw: string | null | undefined): BriefParts {
  const lines = normalizeBrief(raw).split('\n');
  const first = lines.findIndex((line) => line.trim() !== '');
  if (first === -1) return { title: '', body: '' };

  let title = cleanTitle(lines[first]);
  let body = lines.slice(first + 1).join('\n').trim();

  // A brief with no title line: take its first sentence.
  if (title.length > TITLE_MAX) {
    const sentence = title.match(/^(.{12,120}?[.!?])\s+(\S[\s\S]*)$/);
    if (sentence) {
      title = sentence[1];
      body = body ? `${sentence[2]}\n\n${body}` : sentence[2];
    }
  }
  return { title: title.replace(/(?<!\.)\.$/, ''), body };
}

// A setting line the poster typed at the end of the brief ("min_length: 300"):
// it is for the verifier, and it is noise in a two-line card preview.
const SETTING_LINE = /^\s*"?(?:min|max)[_-]?(?:length|words|chars|characters)"?\s*[:=]\s*"?\d+"?\s*,?\s*$/i;

/**
 * Short plain text for a card: markdown marks and trailing setting lines
 * removed, on one line. The full brief is on the task page.
 */
export function briefPreview(body: string): string {
  const lines = body.split('\n');
  while (lines.length && (lines[lines.length - 1].trim() === '' || SETTING_LINE.test(lines[lines.length - 1]))) {
    lines.pop();
  }
  return lines
    .map((line) =>
      line
        .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/(\*\*|__)(.+?)\1/g, '$2')
        .replace(/`([^`]+)`/g, '$1'),
    )
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

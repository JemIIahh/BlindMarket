/**
 * How the batch routes (docs/BULK-POSTING.md) refuse rows: a readable
 * summary in error.message, which the web app shows, and every refused row
 * in error.details.errors, which the SDK reads. The summary counts rows from
 * 1, as the web app and the CLI do; details.errors[].index is the 0-based
 * position in the request. Server-written text only: no secret and no raw
 * input goes into either.
 */
import type { ZodError } from 'zod';
import { AppError } from './errorHandler.js';

/** One refused row of a batch request, by its position in the request. */
export interface RowError {
  index: number;
  code: string;
  message: string;
}

/** Rows the summary names before "…". */
const SUMMARY_ROWS = 5;

/**
 * 400 `code`: '<n> of <m> <unit>s are invalid: <unit> <i>: <reason>; …',
 * with <i> counted from 1, and { errors: [{ index, code, message }] }
 * (0-based index, sorted, plus `extra`) as error.details.
 */
export function invalidRows(
  code: string,
  /** What a row is, singular: 'task', 'brief'. */
  unit: string,
  total: number,
  errors: readonly RowError[],
  extra: Record<string, unknown> = {},
): AppError {
  const rows = [...errors].sort((a, b) => a.index - b.index);
  const shown = rows.slice(0, SUMMARY_ROWS).map((e) => `${unit} ${e.index + 1}: ${e.message.replace(/\.$/, '')}`).join('; ');
  return new AppError(
    400,
    code,
    `${rows.length} of ${total} ${unit}s ${rows.length === 1 ? 'is' : 'are'} invalid: ${shown}${rows.length > SUMMARY_ROWS ? '; …' : ''}`,
    undefined,
    { ...extra, errors: rows },
  );
}

/**
 * A ZodError as text a client may be shown: each issue's field and message.
 * zod's own message is its issues as JSON, and its enum message quotes the
 * value it received; neither that value nor a free-form key (a wrappedKeys
 * address) is repeated here.
 */
export function zodIssuesText(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path
        .map((segment) => (typeof segment === 'number' || /^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(segment) ? String(segment) : '[key]'))
        .join('.');
      const message = issue.code === 'invalid_enum_value'
        ? `must be one of ${issue.options.map((option) => `'${String(option)}'`).join(', ')}`
        : issue.message;
      return `${path || 'body'}: ${message}`;
    })
    .join('; ');
}

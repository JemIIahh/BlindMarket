import { z } from 'zod';

// Service text is shown to renters and embedded in the generated "Use from
// your agent" script and prompt. The name must be one line, and neither field
// may carry control characters, JS line separators or bidi overrides (security
// audit run 1, C03). The client sanitizes too; this keeps bad rows out.
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/;
export const serviceName = z.string().min(5).max(60).refine(
  (s) => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(s) && !BIDI_CONTROLS.test(s),
  'name must be a single line of plain text',
);
export const serviceDescription = z.string().max(2000).refine(
  (s) => !/[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/.test(s) && !BIDI_CONTROLS.test(s),
  'description must be plain text (line breaks and tabs are fine)',
);

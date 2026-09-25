import { z } from 'zod';

/**
 * The poster's auto-verification criteria, shared by POST /tasks and POST
 * /a2a/tasks/index so the two can't drift. Every list and string is bounded:
 * autoVerify runs synchronously on the request thread, and its per-field work
 * grows with the number of criteria, so 8,000 required_fields held the event
 * loop for about two seconds (security audit run 1, C17). The limits are far
 * above what any real task uses.
 */
export const CRITERIA_LIMITS = {
  listItems: 50,
  itemChars: 200,
  rubricItems: 20,
  rubricKeywords: 20,
  expectedAnswerChars: 2000,
  schemaProperties: 50,
  lengthBound: 1_000_000,
} as const;

const item = z.string().max(CRITERIA_LIMITS.itemChars);
const list = z.array(item).max(CRITERIA_LIMITS.listItems);

export const verificationCriteriaSchema = z.object({
  required_fields: list.optional(),
  min_length: z.number().int().positive().max(CRITERIA_LIMITS.lengthBound).optional(),
  contains_keywords: list.optional(),
  max_length: z.number().int().positive().max(CRITERIA_LIMITS.lengthBound).optional(),
  expected_answer: z.string().max(CRITERIA_LIMITS.expectedAnswerChars).optional(),
  forbidden_phrases: list.optional(),
  regex_pattern: z.string().max(200).optional(),
  expected_schema: z
    .object({
      type: z.string().max(50).optional(),
      required: list.optional(),
      properties: z
        .record(item, z.object({ type: z.string().max(50).optional() }))
        .refine((p) => Object.keys(p).length <= CRITERIA_LIMITS.schemaProperties, {
          message: `expected_schema.properties cannot exceed ${CRITERIA_LIMITS.schemaProperties} entries`,
        })
        .optional(),
    })
    .optional(),
  rubric: z
    .array(
      z.object({
        criterion: item,
        keywords: z.array(item).max(CRITERIA_LIMITS.rubricKeywords).optional(),
        min_mentions: z.number().int().positive().max(CRITERIA_LIMITS.rubricKeywords).optional(),
        weight: z.number().positive().max(100).optional(),
      }),
    )
    .max(CRITERIA_LIMITS.rubricItems)
    .optional(),
  pass_threshold: z.number().min(0).max(100).optional(),
  // Natural-language acceptance hint for verificationMode='agent'.
  acceptance: z.string().max(4000).optional(),
});

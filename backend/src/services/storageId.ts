import { z } from 'zod';

/**
 * A storage blob id: 64 hex characters (0G root hash, optionally 0x-prefixed)
 * or a URL-safe Base64 id (Walrus). GET /storage/:rootHash only ever serves
 * these, so a rootHash in any other shape can't be downloaded anyway.
 *
 * Checked wherever a task stores one, because clients put it in an
 * authenticated request path: a '../' value turned an executor's brief
 * download into a GET of another backend route (security audit run 1, C24).
 */
export const STORAGE_ID_PATTERN = /^(?:(?:0x)?[0-9a-fA-F]{64}|[A-Za-z0-9_-]{32,66})$/;

export const storageIdSchema = z
  .string()
  .regex(STORAGE_ID_PATTERN, 'must be a storage id: 64 hex characters, or a 32-66 character URL-safe id');

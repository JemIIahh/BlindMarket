/**
 * Text written by another user (a provider's service name or description) that
 * ends up inside generated code or an agent prompt. A line break in a service
 * name used to end the `//` comment it sat in, so the rest of the name ran as
 * code on the renter's machine, with their wallet key in the environment
 * (security audit run 1, C03).
 *
 * Besides \n and \r, JavaScript treats U+2028 and U+2029 as line terminators,
 * and format characters (bidi overrides, zero-width marks) can make code read
 * differently than it runs, so all of them are removed. Backticks are replaced
 * because the agent prompt embeds the script in a ``` fence.
 */
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** One line of plain text, at most `max` characters. */
export function plainLine(text: string | null | undefined, max: number): string {
  const flat = (text ?? '').replace(UNSAFE_TEXT, ' ').replace(/`/g, "'").replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export interface GeneratedListingFields {
  id: number;
  agent_address: string;
  price_raw: string;
  agent_public_key?: string | null;
}

/** The listing fields a generated script embeds as code. The backend validates
 *  them, but a script someone will run with their private key shouldn't rely on
 *  that, so anything malformed means no script at all. */
export function isWellFormedListing(s: GeneratedListingFields): boolean {
  return Number.isSafeInteger(s.id) && s.id > 0
    && /^0x[0-9a-fA-F]{40}$/.test(s.agent_address)
    && /^\d+$/.test(s.price_raw)
    && (s.agent_public_key == null || s.agent_public_key === ''
      || /^(0x)?04[0-9a-fA-F]{128}$/.test(s.agent_public_key));
}

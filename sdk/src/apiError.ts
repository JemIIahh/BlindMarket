/**
 * An error from the BlindMarket backend, or from a spend the client ran for
 * you. It is a module of its own so the on-chain helpers can throw it without
 * importing the client.
 */
export class ApiError extends Error {
  /** Backend sub-reason within `code` (e.g. 'PAYER_NOT_LINKED'), when the envelope carried one. */
  reason?: string;
  /**
   * A deploy fee transaction that was already paid when this error happened.
   * Pass it back as `params.feeTxHash` and the retry pays nothing.
   */
  feeTxHash?: string;
  /**
   * A transaction that was already sent when this error happened (postTask's
   * escrow funding, a refund). Check it before sending another.
   */
  txHash?: string;

  constructor(
    public status: number,
    message: string,
    public body?: unknown,
    /** Backend error code (e.g. 'NEEDS_WRAP', 'NOT_SUBMITTED_ON_CHAIN'), when the envelope carried one. */
    public code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

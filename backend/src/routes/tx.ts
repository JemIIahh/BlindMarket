/**
 * Gas sponsorship relay endpoint.
 *
 * Privy "user_pays" mode requires sponsor_options which the React client SDK
 * doesn't support. This endpoint relays via the @privy-io/node server SDK.
 *
 * Flow:
 *   1. Frontend sends { walletAddress, to, data, value?, chain? }
 *   2. Server looks up wallet by address → gets Privy wallet ID
 *   3. Server generates authorization signature from user's Privy JWT
 *   4. Server calls wallets().ethereum().sendTransaction() with sponsor_options
 *   5. Returns { hash }
 */
import { Router } from 'express';
import { PrivyClient, generateAuthorizationSignatures } from '@privy-io/node';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import type { AuthRequest, AuthUser } from '../types.js';
import { config } from '../config.js';
import { AppError } from '../middleware/errorHandler.js';

/** Privy eth_sendTransaction RPC response — fields not in WalletRpcResponse. */
interface PrivySendTxResult {
  hash?: string;
  user_operation_hash?: string;
  transaction_id?: string;
  sponsorship_provider?: string;
  caip2?: string;
}

export const txRouter = Router();

/** How a relayed transaction's gas was paid. Reported back to the caller so it
 *  never has to guess — and used by the error mapping below, because the same
 *  Privy failure means different things on different rungs. */
type GasMode = 'user-pays' | 'app-pays' | 'wallet-pays';

const CHAIN_CAIP2: Record<string, string> = {
  base: 'eip155:8453',
  'base-mainnet': 'eip155:8453',
  'base-sepolia': 'eip155:84532',
};

let privyClient: PrivyClient | null = null;
function getPrivyClient(): PrivyClient {
  if (!privyClient) {
    if (!config.privyAppId || !config.privyAppSecret) {
      throw new AppError(500, 'MISCONFIGURED', 'PRIVY_APP_ID or PRIVY_APP_SECRET not set');
    }
    privyClient = new PrivyClient({ appId: config.privyAppId, appSecret: config.privyAppSecret });
  }
  return privyClient;
}

const relaySchema = z.object({
  walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  to: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  data: z.string().regex(/^0x[0-9a-fA-F]*$/),
  // Decimal wei string. Validated here because BigInt() on anything else throws
  // SyntaxError inside the handler, which the catch below reported as a 502
  // "Privy relay failed" — a caller's typo labelled as an upstream outage.
  value: z.string().regex(/^\d+$/).optional(),
  chain: z.string().default('base'),
  /**
   * 'auto' — let the backend negotiate how gas is paid, trying in order:
   *   1. user-pays   sponsor:true + sponsor_options{asset}   (user pays gas in USDC — the product path)
   *   2. app-pays    sponsor:true, no options                (Privy fronts native gas, app is billed)
   *   3. wallet-pays no sponsor key                          (wallet pays from its own native balance)
   * Each rung advances ONLY on Privy's exact refusal for that rung
   * ("Asset <x> is not configured for gas payments on chain …" → 2,
   * "Gas sponsorship is not enabled." → 3); any other error surfaces at once.
   * The response says which rung succeeded (`gas`), so a caller never has to
   * guess what it paid with. These are three separately-configured Privy
   * features, and no single client could reach all of them: the web app hard-
   * codes user-pays and has no fallback, and the MCP fell from user-pays
   * straight to wallet-pays, skipping app-pays entirely — so enabling
   * sponsorship in the dashboard changed nothing for either. Negotiating here
   * fixes both at once. Omit `gas` for the explicit sponsor/asset behaviour.
   */
  gas: z.enum(['auto']).optional(),
  /**
   * ERC-20 to charge gas in. Present => sponsor_options is sent, which asks
   * Privy for *user-pays-in-token* gas. OMIT it to request plain sponsorship
   * instead, where Privy fronts the native gas itself.
   *
   * The two are separate Privy features and are configured separately: Base
   * Sepolia has no token gas asset, so any request naming one is refused with
   * "Asset <x> is not configured for gas payments on chain eip155:84532" — but
   * plain sponsorship there may still work. No default, because a default of
   * 'usdc' silently forced every caller onto the token path. The web app and
   * MCP both send 'usdc' explicitly, so they are unaffected.
   */
  asset: z.string().optional(),
  /**
   * Ask Privy to sponsor gas (paid in `asset`). Defaults to true, which is the
   * whole point of this endpoint: users hold only USDC and never need the
   * chain's native token.
   *
   * It is a request field rather than a constant because sponsorship depends
   * on Privy having a gas asset configured for the target chain, and that is
   * not universal — Base Sepolia has none, so Privy rejects EVERY relay there
   * with "Asset <x> is not configured for gas payments on chain
   * eip155:84532", whatever asset is named. With sponsorship hardcoded on
   * there was no way to transact on such a chain at all, even from a wallet
   * holding native gas.
   *
   * Pass false to have Privy simply sign and broadcast, gas coming from the
   * wallet's own native balance. Callers that want the sponsored behaviour —
   * the web app and the MCP server — send nothing and are unaffected.
   */
  sponsor: z.boolean().default(true),
});

/**
 * The Privy wallets this principal is entitled to move funds from.
 *
 * `ownerAddress` is deliberately EXCLUDED. It is set on agent platform tokens
 * and names the human who owns the agent — and agent private keys live in
 * plaintext in Postgres, so honouring it would turn any agent-key compromise
 * into a compromise of that owner's personal wallet. An agent has its own
 * wallet and does not relay from its owner's.
 */
function callerWallets(user: AuthUser | undefined): Set<string> {
  if (!user) return new Set();
  return new Set(
    [user.address, ...(user.addresses ?? [])]
      .filter((a): a is string => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a))
      .map((a) => a.toLowerCase()),
  );
}

txRouter.post('/relay-tx', requireAuth, async (req: AuthRequest, res, next) => {
  // The rung that was being attempted when an error escaped. Declared outside
  // the try so the catch can word its message for the right path — an
  // "insufficient funds" on wallet-pays means "needs native ETH", not USDC.
  let lastGas: GasMode | null = null;
  // Hoisted for the same reason: the catch names the requested asset.
  let body: z.infer<typeof relaySchema> | undefined;
  try {
    body = relaySchema.parse(req.body);

    // The wallet must belong to the caller.
    //
    // This endpoint hands the platform's PRIVY_AUTHORIZATION_KEY an arbitrary
    // `to` + `data` and signs it from the wallet named in the BODY, with gas
    // sponsored. requireAuth proves the caller is *someone*; until this check
    // nothing proved the wallet was theirs, so any authenticated principal
    // could have the platform sign `transfer(attacker, balance)` out of a
    // victim's embedded wallet and pay the gas for it. Reproduced before
    // fixing: that request returned 200.
    //
    // The check runs FIRST, before the Privy lookup, so an unauthorised caller
    // cannot even probe which addresses are embedded wallets.
    if (!callerWallets(req.user).has(body.walletAddress.toLowerCase())) {
      throw new AppError(
        403,
        'NOT_WALLET_OWNER',
        'This wallet is not linked to your account. You can only relay transactions from your own embedded wallet.',
      );
    }

    const caip2 = CHAIN_CAIP2[body.chain];
    if (!caip2) {
      throw new AppError(400, 'INVALID_CHAIN', `Unsupported chain "${body.chain}". Supported: ${Object.keys(CHAIN_CAIP2).join(', ')}`);
    }

    const privy = getPrivyClient();

    console.log(`[relay-tx] Looking up wallet address=${body.walletAddress} chain=${body.chain} caip2=${caip2}`);

    // Look up the Privy wallet ID by address.
    let walletId: string;
    try {
      const wallet = await privy.wallets().getWalletByAddress({ address: body.walletAddress });
      walletId = wallet.id;
      console.log(`[relay-tx] Found wallet id=${walletId}`);
    } catch (err: any) {
      console.warn('[relay-tx] getWalletByAddress failed:', JSON.stringify({ status: err?.status, message: err?.message, body: err?.body || err?.error }, null, 2));
      throw new AppError(400, 'WALLET_NOT_FOUND', `Wallet ${body.walletAddress} is not a Privy embedded wallet. Log in with email/social to create one.`);
    }

    // Build the transaction params. `value` is schema-validated as decimal
    // digits, so BigInt cannot throw here.
    const transaction = {
      to: body.to,
      data: body.data,
      ...(body.value ? { value: `0x${BigInt(body.value).toString(16)}` } : {}),
    };

    // Generate authorization signature using the server-side authorization key.
    // This key must be an owner of the wallet's key quorum in the Privy dashboard.
    if (!config.privyAuthorizationKey) {
      throw new AppError(500, 'MISCONFIGURED', 'PRIVY_AUTHORIZATION_KEY not set in backend config');
    }
    const authorizationKey = config.privyAuthorizationKey;
    const rpcUrl = `https://api.privy.io/v1/wallets/${walletId}/rpc`;
    const asset = body.asset ?? 'usdc';

    // One RPC body per rung. The three shapes map onto Privy's separately-
    // configured features (see relaySchema.gas). `sponsor_options` can only
    // appear with `sponsor: true` by construction, and wallet-pays carries no
    // `sponsor` key at all — which is what the SDK's optional field expects.
    const rungBody = (mode: GasMode) => ({
      method: 'eth_sendTransaction' as const,
      caip2,
      chain_type: 'ethereum' as const,
      params: { transaction },
      ...(mode !== 'wallet-pays' ? { sponsor: true as const } : {}),
      ...(mode === 'user-pays' ? { sponsor_options: { asset } } : {}),
    });

    // Built ONCE per rung and used for BOTH the authorization signature and
    // the call. The signature is computed over this exact body; two literals
    // that merely look alike would make Privy reject the signature, which
    // reads as a bad authorization key rather than a mismatched payload.
    const sendRung = async (mode: GasMode) => {
      const rpcBody = rungBody(mode);
      const signatures = await generateAuthorizationSignatures(privy, {
        authorizationContext: { authorization_private_keys: [authorizationKey] },
        input: { version: 1, method: 'POST', url: rpcUrl, body: rpcBody, headers: { 'privy-app-id': config.privyAppId! } },
      });
      const authSignature = signatures[0];
      if (!authSignature) {
        throw new AppError(500, 'SIGN_FAILED', 'Failed to generate authorization signature');
      }
      return privy.wallets()._rpc(walletId, rpcBody as any, {
        headers: { 'privy-authorization-signature': authSignature },
      });
    };

    // gas:'auto' negotiates down the ladder; otherwise the explicit
    // sponsor/asset fields name exactly one rung (the pre-existing behaviour,
    // unchanged: sponsor defaults to true, and an asset makes it user-pays).
    const attempts: GasMode[] = body.gas === 'auto'
      ? ['user-pays', 'app-pays', 'wallet-pays']
      : [!body.sponsor ? 'wallet-pays' : body.asset ? 'user-pays' : 'app-pays'];

    let result: unknown;
    for (let i = 0; i < attempts.length; i++) {
      const mode = attempts[i];
      lastGas = mode;
      console.log(`[relay-tx] wallet=${body.walletAddress} id=${walletId} chain=${body.chain} caip2=${caip2} to=${body.to} gas=${mode}${mode === 'user-pays' ? ` asset=${asset}` : ''}`);
      try {
        result = await sendRung(mode);
        break;
      } catch (err: any) {
        const msg = String(err?.message ?? '');
        const nextMode = attempts[i + 1];
        // Advance ONLY on Privy's exact refusal for this rung. Anything else —
        // insufficient funds, a rejected signature, a wrong owner, a policy
        // block — is the real answer and must surface as itself, not be
        // retried into a second, differently-failing request.
        // Privy words the user-pays refusal two ways depending on app state:
        //   "Asset usdc is not configured for gas payments on chain eip155:…"
        //     — sponsorship off entirely (observed before the toggle)
        //   "User-pays token gas sponsorship is not configured for this app."
        //     — app-pays on, token gas not (observed right after the toggle;
        //       gas:'auto' surfaced it instead of stepping down, which is
        //       exactly the failure this list exists to prevent)
        // Both mean the same thing for the ladder: try app-pays.
        const refusedThisRung =
          (mode === 'user-pays' && /not configured for gas payments on chain|user-pays token gas sponsorship is not configured/i.test(msg)) ||
          (mode === 'app-pays' && /gas sponsorship is not enabled/i.test(msg));
        if (nextMode === undefined || !refusedThisRung) throw err;
        console.log(`[relay-tx] ${mode} refused by Privy — "${msg.slice(0, 120)}" — trying ${nextMode}`);
      }
    }

    const rpcResult = (result as any)?.data as PrivySendTxResult | undefined || result as unknown as PrivySendTxResult;
    const userOpHash = rpcResult.user_operation_hash || '';
    const txId = rpcResult.transaction_id || null;
    console.log(`[relay-tx] userOpHash=${userOpHash} txId=${txId} raw=${JSON.stringify(result).slice(0, 300)}`);

    const finalHash = rpcResult.hash || '';
    const isUserOp = !rpcResult.hash && !!userOpHash;
    console.log(`[relay-tx] finalHash=${finalHash || '(user-op, no tx hash yet)'} isUserOp=${isUserOp}`);

    res.json({ success: true, data: { hash: finalHash || userOpHash, isUserOp, userOperationHash: userOpHash || null, transactionId: txId, gas: lastGas } });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors.map(e => e.message).join(', ')));
    }

    // Deliberate AppErrors raised by this handler are already the answer we
    // want the caller to get — pass them straight through. Without this they
    // fall into the Privy-error branch below and are relabelled 502
    // UPSTREAM_ERROR: the 403 ownership refusal reported as a Privy outage,
    // and the pre-existing WALLET_NOT_FOUND (400) and MISCONFIGURED (500)
    // likewise. Same shape as the auth-middleware bug where a 401 thrown
    // inside a .then() was rewrapped as a 500.
    if (err instanceof AppError) {
      return next(err);
    }

    const status = err?.status || err?.httpStatus;
    const msg = err?.message || err?.error?.message || String(err);
    console.log(`[relay-tx] Full error:`, JSON.stringify({ status, message: msg, body: err?.error || err?.body || err?.response || null, stack: err?.stack?.slice(0, 300) }, null, 2));

    // Auth first: a 401/403 from Privy's /rpc with valid app credentials is
    // almost always the authorization signature being refused — the key is
    // not an owner of this wallet's key quorum. Checked before the text
    // matches below so a refusal whose wording happens to contain "not
    // configured" is never reported as a gas problem.
    if (status === 401 || status === 403) {
      return next(new AppError(401, 'PRIVY_AUTH_FAILED',
        'Privy rejected this request\'s authorization. Most often PRIVY_AUTHORIZATION_KEY is not an owner of this wallet\'s key quorum; otherwise check PRIVY_APP_ID / PRIVY_APP_SECRET.'));
    }
    // Same Privy error, two meanings: on wallet-pays the wallet needs native
    // gas, not USDC. Telling an agent to "add USDC" here sent it in circles.
    if (/insufficient/i.test(msg)) {
      return next(new AppError(402, 'INSUFFICIENT_BALANCE',
        lastGas === 'wallet-pays'
          ? 'Wallet has no native ETH for gas — this relay ran unsponsored. Add a little native ETH on this chain, or enable gas sponsorship for the app in Privy.'
          : 'Insufficient USDC balance for gas. Please add USDC to your wallet.'));
    }
    // Exact Privy strings only. The previous bare `includes('not configured')`
    // would have relabelled any unrelated error containing those words as a
    // sponsorship gap — and clients treat that code as "safe to retry".
    // App-level: sponsorship is on, but "user pays gas in a token" is a
    // separate Privy feature that is not. Distinct code — the remedy is a
    // different dashboard setting (or mainnet), not chain support.
    if (/user-pays token gas sponsorship is not configured/i.test(msg)) {
      return next(new AppError(400, 'USER_PAYS_DISABLED',
        'Privy: user-pays token gas sponsorship is not configured for this app — users cannot pay gas in USDC here yet. App-pays sponsorship may still work; pass gas:\'auto\' to fall back to it.'));
    }
    if (/not configured for gas payments on chain/i.test(msg)) {
      return next(new AppError(400, 'UNSUPPORTED_CHAIN',
        `Privy has no ${lastGas === 'user-pays' ? (body?.asset ?? 'usdc') : 'token'} gas payments configured for this chain. Pass gas:'auto' to fall back to app-pays or wallet-pays.`));
    }
    if (/gas sponsorship is not enabled/i.test(msg)) {
      return next(new AppError(400, 'SPONSORSHIP_DISABLED',
        'Gas sponsorship is not enabled for this Privy app. Enable it in the Privy dashboard (Wallet infrastructure → Fee sponsorship), or pass gas:\'auto\' to fall back to the wallet paying its own gas.'));
    }
    if (/unsupported chain/i.test(msg)) {
      return next(new AppError(400, 'UNSUPPORTED_CHAIN', 'Privy does not support this chain for the requested operation.'));
    }

    console.error('[relay-tx] Privy error:', msg.slice(0, 500));
    next(new AppError(status || 502, 'PRIVY_RELAY_FAILED', msg));
  }
});

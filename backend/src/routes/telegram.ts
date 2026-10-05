import { Router } from 'express';
import { createHash, timingSafeEqual } from 'crypto';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { callerWallets } from '../services/callerWallets.js';
import { handleTelegramUpdate, telegramEnabled, telegramWebhookReady } from '../services/telegram.js';
import {
  NONCE_TTL_S,
  TELEGRAM_TYPES,
  createLinkNonce,
  getLink,
  getPrefs,
  isTelegramType,
  setPrefs,
  unlinkWallets,
  type TelegramPrefs,
} from '../services/telegramStore.js';
import type { AuthRequest, ApiResponse } from '../types.js';

export const telegramRouter = Router();

const disabled = (res: import('express').Response) =>
  res.status(503).json({ success: false, error: { code: 'TELEGRAM_DISABLED', message: 'Telegram alerts are not enabled on this server' } });

/** Constant-time compare of two secrets of any length. */
function secretsMatch(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * POST /api/v1/telegram/webhook
 * Telegram's callback. Authenticated by the secret token Telegram echoes in a
 * header (set with setWebhook's secret_token); there is no user session here.
 * Answers 200 once the secret checks out, before handling, so a slow reply
 * cannot make Telegram time out and redeliver.
 */
telegramRouter.post('/webhook', async (req, res) => {
  if (!telegramWebhookReady()) return disabled(res);
  const header = req.header('x-telegram-bot-api-secret-token') ?? '';
  if (!secretsMatch(header, config.telegramWebhookSecret)) {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Bad webhook secret' } });
    return;
  }
  // Answer first: replies to the chat can take seconds (retries), and Telegram
  // would time out and redeliver. handleTelegramUpdate never throws.
  res.json({ success: true, data: {} } as ApiResponse);
  void handleTelegramUpdate(req.body);
});

function sessionWallets(req: AuthRequest): string[] {
  // The legacy shared agent key has no wallet to alert.
  if (!req.user || req.user.address === 'agent') return [];
  return callerWallets(req.user);
}

const unauthorized = (res: import('express').Response) =>
  res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Wallet authentication required' } });

/**
 * POST /api/v1/telegram/link
 * Mints a single-use deep link. Opening it in Telegram and pressing Start binds
 * that chat to this session's wallets. Nothing is linked until the chat does so.
 */
telegramRouter.post('/link', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    if (!telegramEnabled() || !config.telegramBotUsername) return disabled(res);
    const wallets = sessionWallets(req);
    if (wallets.length === 0) return unauthorized(res);
    const nonce = await createLinkNonce(wallets);
    res.json({
      success: true,
      data: { url: `https://t.me/${config.telegramBotUsername}?start=${nonce}`, expiresInSec: NONCE_TTL_S },
    } as ApiResponse);
  } catch (err) { next(err); }
});

/** GET /api/v1/telegram/status — whether alerts are available, linked, and which types are on. */
telegramRouter.get('/status', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const wallets = sessionWallets(req);
    const enabled = telegramEnabled() && config.telegramBotUsername !== '';
    let linked = false;
    let prefs: TelegramPrefs = {};
    for (const w of wallets) {
      const link = await getLink(w);
      if (link) {
        linked = true;
        prefs = await getPrefs(link.chatId);
        break;
      }
    }
    const types = Object.fromEntries(TELEGRAM_TYPES.map((t) => [t, prefs[t] !== false]));
    res.json({ success: true, data: { enabled, linked, types } } as ApiResponse);
  } catch (err) { next(err); }
});

/** PUT /api/v1/telegram/prefs — body { types: { <type>: boolean } }. */
telegramRouter.put('/prefs', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const wallets = sessionWallets(req);
    if (wallets.length === 0) return unauthorized(res);
    const raw = (req.body as { types?: unknown } | undefined)?.types;
    if (!raw || typeof raw !== 'object') {
      res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'types must be an object of booleans' } });
      return;
    }
    const patch: TelegramPrefs = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!isTelegramType(k) || typeof v !== 'boolean') {
        res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: `unknown type or non-boolean value: ${k}` } });
        return;
      }
      patch[k] = v;
    }
    let chatId: string | null = null;
    for (const w of wallets) {
      const link = await getLink(w);
      if (link) { chatId = link.chatId; break; }
    }
    if (!chatId) {
      res.status(409).json({ success: false, error: { code: 'NOT_LINKED', message: 'Connect Telegram first' } });
      return;
    }
    const merged = await setPrefs(chatId, patch);
    res.json({ success: true, data: { types: Object.fromEntries(TELEGRAM_TYPES.map((t) => [t, merged[t] !== false])) } } as ApiResponse);
  } catch (err) { next(err); }
});

/** DELETE /api/v1/telegram/link — disconnect. Safe to call when nothing is linked. */
telegramRouter.delete('/link', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const wallets = sessionWallets(req);
    if (wallets.length === 0) return unauthorized(res);
    const unlinked = await unlinkWallets(wallets);
    res.json({ success: true, data: { unlinked } } as ApiResponse);
  } catch (err) { next(err); }
});

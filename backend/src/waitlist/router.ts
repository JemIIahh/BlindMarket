import express, { Router, type ErrorRequestHandler, type Request } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { waitlistConfig } from './config.js';
import { AppError } from '../middleware/errorHandler.js';
import { requestLogger } from '../middleware/requestLogger.js';
import {
  WAITLIST_TASKS,
  joinWaitlist,
  getStandingByToken,
  addTaskByToken,
  getWaitlistTotal,
  getLeaderboard,
  type LeaderboardEntry,
  type WaitlistStanding,
} from './store.js';
import type { ApiResponse } from '../types.js';

/**
 * Public waitlist API for the blindmarket-waitlist landing page, served by the
 * standalone waitlist service (app.ts / server.ts) — not by the marketplace.
 *
 *   GET  /stats        → { total }
 *   GET  /leaderboard  → { entries: [{ rank, handle, points, referrals }] }
 *   POST /join         { email, xHandle, tasks?, ref? } → 201 { token, ...standing } | 200 { alreadyJoined, ...standing }
 *   GET  /me           Authorization: Bearer <token> → standing
 *   POST /me/tasks     Authorization: Bearer <token>, { task } → standing
 *
 * Brings its own credential-less CORS allowlist (WAITLIST_CORS_ORIGIN), a 4kb
 * body cap, and per-IP limits.
 */
export const waitlistRouter = Router();

const LOCALHOST_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

waitlistRouter.use(cors({
  origin: waitlistConfig.nodeEnv === 'development'
    ? [...waitlistConfig.corsOrigin, LOCALHOST_ORIGIN]
    : [...waitlistConfig.corsOrigin],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 600,
}));
waitlistRouter.use(express.json({ limit: '4kb' }));
waitlistRouter.use(requestLogger);

function limiter(windowMs: number, max: number, message: string) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: { code: 'RATE_LIMIT', message } },
  });
}

// /join is the only route that creates rows. 10 per IP per 10 min leaves room
// for a shared NAT (office, conference Wi-Fi) while capping a scripted flood.
const joinLimiter = limiter(10 * 60 * 1000, 10, 'Too many signups from this network — try again in a few minutes');
const readLimiter = limiter(60 * 1000, 60, 'Too many requests, please try again later');
// /stats and /leaderboard are answered from a 10s in-memory cache, so they
// cost the database nothing per request. Every page load calls both; a looser
// cap keeps a room full of people on one Wi-Fi from seeing blank counters.
const publicLimiter = limiter(60 * 1000, 300, 'Too many requests, please try again later');

function bearerToken(req: Request): string {
  const match = /^Bearer\s+(wl_[A-Za-z0-9_-]{16,128})$/.exec(req.headers.authorization ?? '');
  if (!match) throw new AppError(401, 'WAITLIST_TOKEN_INVALID', 'Missing or malformed waitlist token');
  return match[1];
}

const taskSchema = z.enum(WAITLIST_TASKS);

const joinSchema = z.object({
  email: z.string().trim().toLowerCase().max(254).email(),
  // X's own rule: 1–15 letters, digits or underscores. Shown publicly on the
  // leaderboard, so nothing else gets through. Self-reported, like the tasks.
  xHandle: z.string().trim().regex(/^@?[A-Za-z0-9_]{1,15}$/).transform((h) => h.replace(/^@/, '')),
  tasks: z.array(taskSchema).max(WAITLIST_TASKS.length).default([]),
  // A mangled share link must never cost someone their signup: a bad code is
  // dropped (no referral credited), not rejected.
  ref: z.string().trim().toLowerCase().regex(/^[a-z0-9]{4,32}$/).optional().catch(undefined),
});

const addTaskSchema = z.object({ task: taskSchema });

waitlistRouter.get('/stats', publicLimiter, async (_req, res, next) => {
  try {
    const body: ApiResponse<{ total: number }> = { success: true, data: { total: await getWaitlistTotal() } };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

waitlistRouter.get('/leaderboard', publicLimiter, async (_req, res, next) => {
  try {
    const body: ApiResponse<{ entries: LeaderboardEntry[] }> = { success: true, data: { entries: await getLeaderboard() } };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

waitlistRouter.post('/join', joinLimiter, async (req, res, next) => {
  try {
    const { email, xHandle, tasks, ref } = joinSchema.parse(req.body);
    const { token, standing } = await joinWaitlist({ email, xHandle, tasks: [...new Set(tasks)], ref });
    if (token) {
      const body: ApiResponse<WaitlistStanding & { token: string; alreadyJoined: false }> = {
        success: true,
        data: { ...standing, token, alreadyJoined: false },
      };
      res.status(201).json(body);
      return;
    }
    const body: ApiResponse<WaitlistStanding & { alreadyJoined: true }> = {
      success: true,
      data: { ...standing, alreadyJoined: true },
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

waitlistRouter.get('/me', readLimiter, async (req, res, next) => {
  try {
    const standing = await getStandingByToken(bearerToken(req));
    if (!standing) throw new AppError(401, 'WAITLIST_TOKEN_INVALID', 'Unknown waitlist token');
    const body: ApiResponse<WaitlistStanding> = { success: true, data: standing };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

waitlistRouter.post('/me/tasks', readLimiter, async (req, res, next) => {
  try {
    const token = bearerToken(req);
    const { task } = addTaskSchema.parse(req.body);
    const standing = await addTaskByToken(token, task);
    if (!standing) throw new AppError(401, 'WAITLIST_TOKEN_INVALID', 'Unknown waitlist token');
    const body: ApiResponse<WaitlistStanding> = { success: true, data: standing };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// body-parser failures carry an HTTP status but aren't AppErrors, so the
// global handler would log them as [unhandled] and answer 500. A public form
// endpoint gets junk bodies routinely — translate them into clean 4xx here.
const bodyParserErrors: ErrorRequestHandler = (err, _req, _res, next) => {
  if (err?.type === 'entity.parse.failed') {
    next(new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON'));
  } else if (err?.type === 'entity.too.large') {
    next(new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large'));
  } else {
    next(err);
  }
};
waitlistRouter.use(bodyParserErrors);

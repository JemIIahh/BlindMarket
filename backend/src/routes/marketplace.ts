import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import type { AuthRequest } from '../types.js';
import * as reviewStore from '../services/reviewStore.js';
import * as templateStore from '../services/templateStore.js';
import * as webhookStore from '../services/webhookStore.js';
import * as badgeStore from '../services/badgeStore.js';
import type { ApiResponse } from '../types.js';

export const marketplaceRouter = Router();

// ── Reviews ────────────────────────────────────────────────────────────────

const reviewSchema = z.object({
  taskId: z.string().min(1),
  agentAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  rating: z.number().int().min(1).max(5),
  review: z.string().max(2000).optional(),
});

marketplaceRouter.post('/reviews', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const reviewerAddress = req.user!.address;
    const { taskId, agentAddress, rating, review } = reviewSchema.parse(req.body);

    const existing = await reviewStore.getReviewForTask(taskId, reviewerAddress);
    if (existing) {
      res.status(409).json({ success: false, error: { code: 'ALREADY_REVIEWED', message: 'You already reviewed this task' } });
      return;
    }

    const r = await reviewStore.submitReview({ taskId, agentAddress, reviewerAddress, rating, review });
    res.json({ success: true, data: r } as ApiResponse);
  } catch (err) { next(err); }
});

marketplaceRouter.get('/reviews/:agentAddress', async (req, res, next) => {
  try {
    const limit = Math.min(50, parseInt(req.query.limit as string) || 20);
    const offset = Math.max(0, parseInt(req.query.offset as string) || 0);
    const result = await reviewStore.getAgentReviews(req.params.agentAddress, limit, offset);
    res.json({ success: true, data: result } as ApiResponse);
  } catch (err) { next(err); }
});

// ── Templates ──────────────────────────────────────────────────────────────

const templateSchema = z.object({
  name: z.string().min(1).max(100),
  category: z.string().min(1).max(64),
  description: z.string().min(10).max(5000),
  requiredCapabilities: z.array(z.string()).optional(),
  verificationCriteria: z.record(z.unknown()).optional(),
  suggestedReward: z.string().optional(),
  isPublic: z.boolean().optional(),
});

marketplaceRouter.post('/templates', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const creatorAddress = req.user!.address;
    const data = templateSchema.parse(req.body);
    const t = await templateStore.createTemplate({ creatorAddress, ...data });
    res.json({ success: true, data: t } as ApiResponse);
  } catch (err) { next(err); }
});

marketplaceRouter.get('/templates', async (req, res, next) => {
  try {
    const limit = Math.min(50, parseInt(req.query.limit as string) || 20);
    const offset = Math.max(0, parseInt(req.query.offset as string) || 0);
    const result = await templateStore.getPublicTemplates(limit, offset);
    res.json({ success: true, data: result } as ApiResponse);
  } catch (err) { next(err); }
});

marketplaceRouter.get('/templates/mine', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const templates = await templateStore.getTemplatesByCreator(req.user!.address);
    res.json({ success: true, data: templates } as ApiResponse);
  } catch (err) { next(err); }
});

marketplaceRouter.get('/templates/:id', async (req, res, next) => {
  try {
    const t = await templateStore.getTemplate(parseInt(req.params.id));
    if (!t) { res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Template not found' } }); return; }
    res.json({ success: true, data: t } as ApiResponse);
  } catch (err) { next(err); }
});

marketplaceRouter.delete('/templates/:id', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const deleted = await templateStore.deleteTemplate(parseInt(req.params.id), req.user!.address);
    if (!deleted) { res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Template not found or not yours' } }); return; }
    res.json({ success: true, data: { deleted: true } } as ApiResponse);
  } catch (err) { next(err); }
});

// ── Webhooks ───────────────────────────────────────────────────────────────

const webhookSchema = z.object({
  url: z.string().url(),
  secret: z.string().max(128).optional(),
  events: z.array(z.string()).optional(),
});

marketplaceRouter.post('/webhooks', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const agentAddress = req.user!.address;
    const data = webhookSchema.parse(req.body);
    const w = await webhookStore.registerWebhook({ agentAddress, ...data });
    res.json({ success: true, data: { id: w.id, url: w.url, events: w.events, secret: w.secret } } as ApiResponse);
  } catch (err) { next(err); }
});

marketplaceRouter.get('/webhooks', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const hooks = await webhookStore.getAgentWebhooks(req.user!.address);
    res.json({ success: true, data: hooks.map(h => ({ id: h.id, url: h.url, events: h.events, isActive: h.is_active })) } as ApiResponse);
  } catch (err) { next(err); }
});

marketplaceRouter.delete('/webhooks/:id', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const deleted = await webhookStore.deleteWebhook(parseInt(req.params.id), req.user!.address);
    res.json({ success: true, data: { deleted } } as ApiResponse);
  } catch (err) { next(err); }
});

// ── Badges ─────────────────────────────────────────────────────────────────

marketplaceRouter.get('/badges/:agentAddress', async (req, res, next) => {
  try {
    const badges = await badgeStore.getAgentBadges(req.params.agentAddress);
    res.json({ success: true, data: badges } as ApiResponse);
  } catch (err) { next(err); }
});

marketplaceRouter.post('/badges', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const { agentAddress, capability, badgeType, expiresAt } = req.body;
    if (!agentAddress || !capability) {
      res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'agentAddress and capability required' } });
      return;
    }
    const b = await badgeStore.grantBadge({ agentAddress, capability, badgeType, grantedBy: req.user!.address, expiresAt });
    res.json({ success: true, data: b } as ApiResponse);
  } catch (err) { next(err); }
});

marketplaceRouter.delete('/badges/:agentAddress/:capability', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const revoked = await badgeStore.revokeBadge(req.params.agentAddress, req.params.capability);
    res.json({ success: true, data: { revoked } } as ApiResponse);
  } catch (err) { next(err); }
});

// ── Agent search ───────────────────────────────────────────────────────────

marketplaceRouter.get('/agents/search', async (req, res, next) => {
  try {
    const capability = req.query.capability as string | undefined;
    const minRating = parseFloat(req.query.minRating as string) || 0;
    const limit = Math.min(50, parseInt(req.query.limit as string) || 20);

    // Search via agent store (Redis) — filter by capability
    const agentStore = await import('../services/agentStore.js');
    let agents = await agentStore.listAgents(capability ? [capability] : undefined);

    // Enrich with reviews
    const enriched = await Promise.all(
      agents.slice(0, limit).map(async (a) => {
        const { stats } = await reviewStore.getAgentReviews(a.address, 0);
        const badges = await badgeStore.getAgentBadges(a.address);
        return {
          address: a.address,
          name: a.displayName,
          capabilities: a.capabilities,
          reputation: a.reputation,
          tasksCompleted: a.tasksCompleted,
          avgRating: stats.avgRating,
          totalReviews: stats.totalReviews,
          badges: badges.map(b => ({ capability: b.capability, type: b.badge_type })),
        };
      }),
    );

    const filtered = minRating > 0 ? enriched.filter(a => a.avgRating >= minRating) : enriched;
    res.json({ success: true, data: { agents: filtered, total: filtered.length } } as ApiResponse);
  } catch (err) { next(err); }
});

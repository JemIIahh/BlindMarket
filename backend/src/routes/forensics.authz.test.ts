import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ethers } from 'ethers';

/**
 * SEC-08. POST /forensics/submit was requireAuth only, with nothing tying the
 * report to the caller or to the task it was filed under. An unrelated wallet
 * could self-sign a report naming its OWN address — so the signature verified
 * and no provenance flag fired — file it under a victim's taskHash, and have
 * it become THE forensic record for that task, reaching the victim's
 * verification prompt inside the block labelled "verified by platform".
 *
 * Every case below was a working attack before the fix.
 */

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { address: req.headers['x-test-address'] };
    next();
  },
}));
vi.mock('../services/custodyVault.js', () => ({ ingestEvidence: vi.fn(async () => {}) }));
vi.mock('../services/a2aStore.js', () => ({ getMeta: vi.fn(), getState: vi.fn() }));

import { forensicsRouter } from './forensics.js';
import { forensicStore } from '../services/forensicStore.js';
import * as a2aStore from '../services/a2aStore.js';

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use('/api/v1/forensics', forensicsRouter);

const TASK = '0x' + 'cc'.repeat(32);
const executor = ethers.Wallet.createRandom();
const attacker = ethers.Wallet.createRandom();

async function signed(w: ethers.HDNodeWallet, over: Partial<{ taskId: string; workerAddress: string }> = {}) {
  const report = {
    version: 1 as const,
    taskId: over.taskId ?? TASK,
    workerAddress: over.workerAddress ?? w.address,
    timestamp: Date.now(),
    exif: {},
    photoSource: 'camera' as const,
    phash: 'a'.repeat(16),
    deviceFingerprint: {
      screenWidth: 1, screenHeight: 1, hardwareConcurrency: 1,
      deviceMemory: null, webglRenderer: 'x', userAgent: 'x', platform: 'x',
    },
    freshness: { photoAgeMs: 1000, submissionTimestamp: Date.now(), isFresh: true, maxAgeMs: 600000 },
    tamperingSignals: [],
    reportHash: ethers.keccak256(ethers.toUtf8Bytes('r' + Math.random())),
  };
  return { report, signature: await w.signMessage(report.reportHash) };
}

const post = (addr: string, body: unknown) =>
  request(app).post('/api/v1/forensics/submit').set('x-test-address', addr).send(body as object);

beforeEach(() => {
  vi.mocked(a2aStore.getState).mockResolvedValue({ executorAddress: executor.address } as never);
});

describe('SEC-08 — only the assigned executor can write a task\'s forensic record', () => {
  it('rejects a stranger filing a self-signed report under someone else\'s task', async () => {
    const res = await post(attacker.address, { taskId: TASK, signedReport: await signed(attacker) });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_TASK_EXECUTOR');
    expect(forensicStore.getReport(TASK)).toBeFalsy();
  });

  it('rejects a report whose own taskId is not the task it is filed under', async () => {
    const res = await post(executor.address, {
      taskId: TASK,
      signedReport: await signed(executor, { taskId: 'some-other-task' }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TASK_ID_MISMATCH');
  });

  it('rejects the executor attributing the work to a third party', async () => {
    const res = await post(executor.address, {
      taskId: TASK,
      signedReport: await signed(executor, { workerAddress: attacker.address }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WORKER_ADDRESS_MISMATCH');
  });

  it('rejects a report whose signature does not verify, instead of flagging and saving it', async () => {
    const sr = await signed(executor);
    sr.signature = await attacker.signMessage(sr.report.reportHash); // wrong signer
    const res = await post(executor.address, { taskId: TASK, signedReport: sr });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_SIGNATURE');
    expect(forensicStore.getReport(TASK)).toBeFalsy();
  });

  it('still accepts the legitimate submission from the assigned executor', async () => {
    const res = await post(executor.address, { taskId: TASK, signedReport: await signed(executor) });
    expect(res.status).toBe(200);
    const stored = forensicStore.getReport(TASK);
    expect(stored?.signedReport.report.workerAddress).toBe(executor.address);
  });

});

import { useState } from 'react';
import { formatUnits } from 'ethers';
import { Button, Modal } from './bb';
import { copyToClipboard } from '../lib/utils';
import {
  API_BASE_URL,
  MARKETPLACE_TOKEN_ADDRESS,
  OG_RPC_URL,
  OG_CHAIN_ID,
  isMainnet,
  WORKER_SHARE_PCT,
  PLATFORM_FEE_PCT,
} from '../config/constants';
import type { AgentService } from '../services/marketplace';

/**
 * "Use from your agent" — the agent-native counterpart to Use now.
 *
 * BlindMarket serves humans AND agents: a human can rent in the browser
 * (UseServiceModal does the crypto + signing), or hand this copyable block to
 * their own agent (Claude Code, OpenClaw, Codex, …) which then runs the same
 * rent flow itself: encrypt brief → escrow → poll for the result.
 *
 * Everything here is generated from live service data + the verified backend
 * contract (API-key auth via requireAuth; crypto identical to lib/crypto.ts,
 * decrypted by backend/agents/worker.js). Two tabs:
 *  - prompt: paste-into-your-agent instructions with the script embedded
 *  - script: the self-contained Node reference implementation alone
 *
 * Deliberately NOT an @blindmarket/sdk snippet: the published SDK's
 * createTask predates rootHash/wrappedKeys/targetExecutor and can't run this
 * flow. The script needs only Node 18+ and ethers v6.
 */

type CopyTab = 'prompt' | 'script';

function buildScript(service: AgentService, symbol: string, apiBase: string, privacy: 'private' | 'public'): string {
  const price = formatUnits(service.price_raw, 18);
  const chainName = isMainnet ? '0G Mainnet' : '0G Testnet';
  const isPublic = privacy === 'public';
  // NB: the script must stay free of backticks/template-interpolation so this
  // generator (and the prompt tab that embeds it) never fights escaping.
  return `#!/usr/bin/env node
// BlindMarket — rent "${service.name}" (service #${service.id}) from agent ${service.agent_address}
// One call: ${isPublic ? 'post your brief (PUBLIC — plaintext, result is public too)' : 'encrypt your brief'} -> escrow ${price} ${symbol} -> the agent executes -> you get the result.
//
// Setup (once):
//   npm i ethers                          # v6, Node 18+
//   BLINDMARKET_API_KEY   sk_... key from ${apiBase}/settings ("API keys").
//                         MUST be created while signed in with the SAME wallet as PRIVATE_KEY —
//                         the backend resolves the key to its owner wallet, and the funding tx
//                         must come from that wallet or indexing is rejected (NOT_TASK_AGENT).
//   PRIVATE_KEY           wallet that pays ${price} ${symbol} + gas on ${chainName} (chain ${OG_CHAIN_ID})
//   PROMPT                what you want the agent to do${isPublic ? ' (PUBLIC: posted in plaintext,\n//                         visible to everyone — do not include secrets)' : ' (encrypted end-to-end; the\n//                         platform only ever sees a hash)'}
//
// Run:  PROMPT="..." node use-service.mjs

import { Wallet, JsonRpcProvider${isPublic ? '' : ', SigningKey'} } from 'ethers';
import crypto from 'node:crypto';

const API = '${apiBase}';
const RPC = '${OG_RPC_URL}';
const SERVICE = {
  id: ${service.id},
  agent: '${service.agent_address.toLowerCase()}',
  publicKey: '${service.agent_public_key ?? ''}', // uncompressed secp256k1 (04...)
  priceRaw: '${service.price_raw}',               // wei
  token: '${MARKETPLACE_TOKEN_ADDRESS}',          // 0x000...0 = native ${symbol}
};

const API_KEY = process.env.BLINDMARKET_API_KEY;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const PROMPT = process.env.PROMPT;
if (!API_KEY || !PRIVATE_KEY || !PROMPT) {
  console.error('Set BLINDMARKET_API_KEY, PRIVATE_KEY and PROMPT');
  process.exit(1);
}

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) {
    throw new Error(path + ' failed: ' + (json.error?.message || res.status));
  }
  return json.data;
}

${isPublic ? `// 1. The brief is PUBLIC — the plaintext itself is the blob (no key, no wrap).
const blob = Buffer.from(PROMPT, 'utf8');
const taskHash = '0x' + crypto.createHash('sha256').update(blob).digest('hex');

const wallet = new Wallet(PRIVATE_KEY, new JsonRpcProvider(RPC));
console.log('paying from', wallet.address);

// 2. Upload the plaintext blob to 0G Storage.
const { rootHash } = await api('POST', '/api/v1/storage/upload', { data: blob.toString('base64') });
` : `// AES-256-GCM. Wire format: [12-byte IV][16-byte auth tag][ciphertext]
function aesEncrypt(plain, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

// ECIES over secp256k1. Wire: [65-byte uncompressed ephemeral pubkey][AES-GCM blob]
// AES key = HKDF-SHA256(ECDH shared secret X coordinate, salt=empty, info='BlindMarket-ECIES-v1')
function eciesEncrypt(payload, recipientPubHex) {
  const eph = Wallet.createRandom();
  const shared = new SigningKey(eph.privateKey).computeSharedSecret('0x' + recipientPubHex);
  const sharedX = Buffer.from(shared.slice(4, 68), 'hex'); // drop 0x04 prefix, keep X
  const aesKey = Buffer.from(crypto.hkdfSync('sha256', sharedX, Buffer.alloc(0), 'BlindMarket-ECIES-v1', 32));
  const ephPub = Buffer.from(SigningKey.computePublicKey(eph.privateKey, false).slice(2), 'hex');
  return Buffer.concat([ephPub, aesEncrypt(payload, aesKey)]);
}

const wallet = new Wallet(PRIVATE_KEY, new JsonRpcProvider(RPC));
console.log('paying from', wallet.address);

// 1. Encrypt the brief — only the provider agent can read it.
const aesKey = crypto.randomBytes(32);
const ciphertext = aesEncrypt(Buffer.from(PROMPT, 'utf8'), aesKey);
const taskHash = '0x' + crypto.createHash('sha256').update(ciphertext).digest('hex');

// 2. Upload the encrypted blob to 0G Storage.
const { rootHash } = await api('POST', '/api/v1/storage/upload', { data: ciphertext.toString('base64') });

// 3. Wrap the AES key to the provider agent only.
const wrappedKeys = { [SERVICE.agent]: eciesEncrypt(aesKey, SERVICE.publicKey).toString('hex') };
`}
// ${isPublic ? '3' : '4'}. Build the escrow funding tx, sign + send it from YOUR wallet.
const { unsignedTx } = await api('POST', '/api/v1/tasks', {
  taskHash,
  token: SERVICE.token,
  amount: SERVICE.priceRaw,
  locationZone: 'global',
  duration: '3600',
  targetExecutorType: 'agent',
  verificationMode: 'auto',
  verificationCriteria: { min_length: 1 },
  requiredCapabilities: [],
  rootHash,${isPublic ? '' : '\n  wrappedKeys,'}
});
const isNative = /^0x0+$/.test(SERVICE.token);
const tx = await wallet.sendTransaction({
  to: unsignedTx.to,
  data: unsignedTx.data,
  value: isNative ? BigInt(SERVICE.priceRaw) : 0n,
  gasLimit: 1000000,
});
console.log('funding tx', tx.hash);
await tx.wait();

// ${isPublic ? '4' : '5'}. Index the task, pinned to the provider agent + this service.
await api('POST', '/api/v1/a2a/tasks/index', {
  txHash: tx.hash,
  taskHash,
  verificationMode: 'auto',
  verificationCriteria: { min_length: 1 },
  requiredCapabilities: [],
  rootHash,${isPublic ? "\n  privacy: 'public',\n  publicBrief: PROMPT.slice(0, 4000)," : '\n  wrappedKeys,'}
  targetExecutor: SERVICE.agent,
  serviceId: SERVICE.id,
});
console.log('task indexed', taskHash);

// ${isPublic ? '5' : '6'}. Poll until the agent delivers (auto-verified; escrow settles ${WORKER_SHARE_PCT}/${PLATFORM_FEE_PCT} on pass).
for (let i = 0; i < 75; i++) {
  await new Promise((r) => setTimeout(r, 4000));
  const { tasks } = await api('GET', '/api/v1/a2a/tasks/posted');
  const t = tasks.find((x) => x.meta.taskId && x.meta.taskId.toLowerCase() === taskHash);
  const status = t && t.state && t.state.status;
  if ((status === 'verified' || status === 'completed') && t.state.resultData) {
    const out = t.state.resultData.output;
    console.log(typeof out === 'string' ? out : JSON.stringify(t.state.resultData, null, 2));
    process.exit(0);
  }
  if (status === 'failed') {
    console.error('The agent could not complete this call. Reclaim escrow from ' + API + '/tasks/mine');
    process.exit(1);
  }
}
console.error('Timed out waiting for the result — the task may still settle. Check ' + API + '/tasks/mine');
process.exit(1);
`;
}

function buildPrompt(service: AgentService, symbol: string, apiBase: string, script: string, privacy: 'private' | 'public'): string {
  const price = formatUnits(service.price_raw, 18);
  const chainName = isMainnet ? '0G Mainnet' : '0G Testnet';
  const privacyLine = privacy === 'public'
    ? `BlindMarket is a task marketplace with on-chain escrow. This call is PUBLIC:
my brief and the result will be visible to everyone (no encryption involved) —
do not include secrets in the prompt.`
    : `BlindMarket is an encrypted task marketplace: my brief is encrypted so only the
provider agent can read it (the platform only sees a hash), payment is escrowed
on-chain, and the result comes back after automatic verification.`;
  return `I'd like to use a BlindMarket agent service from here.

${privacyLine}

Service:   ${service.name} (service #${service.id})
${service.description ? `About:     ${service.description}\n` : ''}Provider:  agent ${service.agent_address}
Price:     ${price} ${symbol} per call, escrowed on ${chainName} (chain ${OG_CHAIN_ID})
API base:  ${apiBase}

What I need you to do:
1. Save the reference implementation below as use-service.mjs (Node 18+, then: npm i ethers).
2. Ask me for anything missing from this environment:
   - BLINDMARKET_API_KEY — my sk_... key from ${apiBase}/settings ("API keys" section).
     IMPORTANT: it must have been created while I was signed in with the SAME
     wallet as PRIVATE_KEY, because the API resolves the key to its owner wallet
     and the funding transaction must come from that wallet.
   - PRIVATE_KEY — the wallet paying ${price} ${symbol} + gas.
   - PROMPT — what I want the provider agent to do.
3. Run:  PROMPT="..." node use-service.mjs
4. It prints the provider agent's output on success. If it times out, the task
   may still settle later — check ${apiBase}/tasks/mine.

Never send PRIVATE_KEY or the API key anywhere except this script's environment.

Reference implementation:

\`\`\`js
${script}
\`\`\`
`;
}

export default function UseFromAgentModal({
  service,
  symbol,
  onClose,
}: {
  service: AgentService;
  symbol: string;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<CopyTab>('prompt');
  const [copied, setCopied] = useState(false);
  // The generated code/prompt differs per privacy mode: private = the full
  // encrypt→wrap flow; public = plaintext brief, no key handling, public result.
  const [privacy, setPrivacy] = useState<'private' | 'public'>('private');

  // API_BASE_URL is '' behind the nginx same-origin proxy — the copy block
  // leaves the app, so it needs an absolute URL either way.
  const apiBase = API_BASE_URL || window.location.origin;
  const script = buildScript(service, symbol, apiBase, privacy);
  const prompt = buildPrompt(service, symbol, apiBase, script, privacy);
  const active = tab === 'prompt' ? prompt : script;

  const copy = async () => {
    const ok = await copyToClipboard(active);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Use from your agent"
      subtitle={`${service.name} · ${formatUnits(service.price_raw, 18)} ${symbol} / call`}
      size="lg"
    >
      <div className="space-y-4">
        <p className="text-xs text-ink-3 leading-relaxed">
          Paste this into your own agent (Claude Code, OpenClaw, Codex, …) — it will rent
          this service directly: encrypt your brief, escrow the payment from your wallet,
          and return the provider agent's output. You'll need an API key from{' '}
          <a href="/settings" className="text-cream hover:underline">Settings</a>, created
          with the same wallet your agent pays from.
        </p>

        <div className="flex flex-wrap items-center gap-1.5">
          {([['private', 'Private (encrypted)'], ['public', 'Public']] as const).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              onClick={() => setPrivacy(mode)}
              className={`px-2.5 py-1 text-xs border transition-colors ${privacy === mode
                ? 'bg-cream/10 border-cream/40 text-cream'
                : 'bg-surface-2 border-line text-ink-3 hover:text-ink-2'
                }`}
            >
              {label}
            </button>
          ))}
          <span className="text-[11px] text-ink-3 ml-1">
            {privacy === 'private' ? 'Brief encrypted end-to-end.' : 'Brief + result become public record.'}
          </span>
        </div>

        <div role="tablist" className="flex gap-6 border-b border-line">
          {([
            { id: 'prompt', label: 'Agent prompt' },
            { id: 'script', label: 'Node script' },
          ] as const).map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`pb-2.5 -mb-px text-xs border-b-2 transition-colors ${
                tab === t.id
                  ? 'text-ink font-medium border-cream'
                  : 'text-ink-3 border-transparent hover:text-ink-2'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-ink-2 border border-line bg-surface-2 p-3 max-h-72 overflow-y-auto select-all">
          {active}
        </pre>

        <div className="flex items-center justify-between gap-3">
          <span className="font-mono text-[10px] uppercase tracking-widest text-ink-3">
            {tab === 'prompt' ? 'one paste — instructions + script' : 'save as use-service.mjs'}
          </span>
          <Button
            variant="primary"
            size="sm"
            label={copied ? 'Copied' : 'Copy to clipboard'}
            onClick={copy}
          />
        </div>
      </div>
    </Modal>
  );
}

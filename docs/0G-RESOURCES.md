# 0G Developer Resources

> Curated documentation and SDK references for building on 0G. Updated as we discover new resources.

---

## Official Documentation

- **Docs Home**: https://docs.0g.ai/
- **Understanding 0G**: https://docs.0g.ai/introduction/understanding-0g
- **Builder Hub**: https://build.0g.ai/sdks/
- **Testnet Guide**: https://0g.ai/blog/0g-testnet-guide
- **Whitepaper (PDF)**: https://cdn.jsdelivr.net/gh/0glabs/0g-doc/static/whitepaper.pdf

---

## 0G Chain (EVM L1)

The fastest modular EVM L1 — deploy Solidity contracts like any EVM chain.

**RPC Endpoints:**
- Mainnet: `https://0g-rpc.publicnode.com`
- Testnet: `https://evmrpc-testnet.0g.ai`

**Chain IDs:**
- Testnet (Galileo): `16602`
- Testnet (Newton): `16600`

**Block Explorers:**
- Mainnet: https://chainscan.0g.ai
- Testnet: https://chainscan-testnet.0g.ai

**Getting Testnet Tokens:**
- Faucet: https://faucet.0g.ai/ (0.1 0G per wallet per day)
- Alternative: https://faucets.chain.link/0g-testnet-galileo

**Hardhat Config Example:**
```javascript
networks: {
  "0g-testnet": {
    url: "https://evmrpc-testnet.0g.ai",
    chainId: 16602,
    accounts: [process.env.PRIVATE_KEY],
  }
}
```

**Deploy Contracts Docs:** https://docs.0g.ai/developer-hub/building-on-0g/contracts-on-0g/deploy-contracts

---

## 0G Storage (Decentralized Storage)

80% cheaper than AWS S3. Merkle tree integrity proofs. Both Go and TypeScript SDKs.

### TypeScript SDK

**Install:**
```bash
npm install @0gfoundation/0g-ts-sdk ethers
```

**Setup:**
```typescript
import { ZgFile, Indexer, MemData } from '@0gfoundation/0g-ts-sdk';
import { ethers } from 'ethers';

const RPC_URL = 'https://evmrpc-testnet.0g.ai';
const INDEXER_RPC = 'https://indexer-storage-testnet-turbo.0g.ai';

const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet('YOUR_PRIVATE_KEY', provider);
const indexer = new Indexer(INDEXER_RPC);
```

**Upload a file:**
```typescript
const file = await ZgFile.fromFilePath(filePath);
const [tree, treeErr] = await file.merkleTree();
console.log("Root Hash:", tree?.rootHash());

const [tx, uploadErr] = await indexer.upload(file, RPC_URL, signer);
await file.close();
```

**Upload in-memory data:**
```typescript
const data = new TextEncoder().encode('Hello, 0G Storage!');
const memData = new MemData(data);
const [tx, err] = await indexer.upload(memData, RPC_URL, signer);
```

**Download a file:**
```typescript
const err = await indexer.download(rootHash, outputPath, true); // true = verify proof
```

**Browser upload (from file input):**
```typescript
import { Blob as ZgBlob, Indexer } from '@0gfoundation/0g-ts-sdk';
import { BrowserProvider } from 'ethers';

const provider = new BrowserProvider(window.ethereum);
const signer = await provider.getSigner();
const zgBlob = new ZgBlob(fileInput.files[0]);
const [tx, err] = await indexer.upload(zgBlob, RPC_URL, signer);
```

**Key-Value Storage:**
```typescript
import { Batcher, KvClient } from '@0gfoundation/0g-ts-sdk';

// Write
const batcher = new Batcher(1, nodes, flowContract, RPC_URL);
batcher.streamDataBuilder.set(streamId, keyBytes, valueBytes);
const [tx, err] = await batcher.exec();

// Read
const kvClient = new KvClient("http://3.101.147.150:6789");
const value = await kvClient.getValue(streamId, encodedKey);
```

**Starter Kit:**
```bash
git clone https://github.com/0gfoundation/0g-storage-ts-starter-kit
cd 0g-storage-ts-starter-kit && npm install
cp .env.example .env
npm run upload -- ./file.txt
```

**GitHub:** https://github.com/0glabs/0g-ts-sdk

---

## 0G Compute / Sealed Inference (TEE-based AI)

Decentralized AI inference inside hardware enclaves (Intel TDX + NVIDIA H100/H200 TEE mode).

### Verification Modes

| Mode | Description |
|---|---|
| **TeeML** | Model runs directly inside TEE. Full computation protection. Responses signed by TEE private key. |
| **TeeTLS** | Brokers in TEE proxy to centralized providers over HTTPS. Cryptographic proof of authentic routing. |

### Available Models

**Testnet:**
- Qwen 2.5 7B Instruct (chatbot)
- Qwen Image Edit 2511 (image editing)

**Mainnet:**
- GLM-5-FP8, DeepSeek Chat V3, GPT-OSS-120B, Qwen3 VL 30B, Qwen3.6-Plus
- Whisper Large V3 (speech-to-text)
- Z-Image (text-to-image)

### SDK (TypeScript)

**Install:**
```bash
pnpm add @0glabs/0g-serving-broker
```

**Setup:**
```typescript
import { ethers } from 'ethers';
import { createZGComputeNetworkBroker } from '@0glabs/0g-serving-broker';

const provider = new ethers.JsonRpcProvider('https://0g-rpc.publicnode.com');
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const broker = await createZGComputeNetworkBroker(wallet);
```

**List services:**
```typescript
const services = await broker.inference.listService();
```

**Make inference request:**
```typescript
const { endpoint, model } = await broker.inference.getServiceMetadata(providerAddress);
const headers = await broker.inference.getRequestHeaders(providerAddress);

const response = await fetch(`${endpoint}/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify({
    model,
    messages: [{ role: 'user', content: 'Verify this evidence...' }]
  })
});
```

**Verify response integrity:**
```typescript
const chatID = response.headers.get('ZG-Res-Key');
if (chatID) {
  const isValid = await broker.inference.processResponse(providerAddress, chatID);
  console.log('TEE verification:', isValid ? 'VALID' : 'INVALID');
}
```

**Account setup (minimum balances):**
```typescript
// Deposit to main account (minimum 3 0G for ledger creation)
await broker.ledger.depositFund(10);

// Transfer to provider (minimum 1 0G locked balance)
await broker.ledger.transferFund(providerAddress, 'inference', BigInt(1e18));
```

### CLI

```bash
# Install
pnpm add @0glabs/0g-serving-broker -g

# Setup
0g-compute-cli setup-network
0g-compute-cli login
0g-compute-cli deposit --amount 100
0g-compute-cli transfer-fund --provider <ADDRESS> --amount 1

# Get API secret for direct HTTP calls
0g-compute-cli inference get-secret --provider <ADDRESS>

# Run local proxy (OpenAI-compatible endpoint)
0g-compute-cli inference serve --provider <PROVIDER_ADDRESS> --port 3000
```

### API (cURL)

**Chat completion:**
```bash
curl <service_url>/v1/proxy/chat/completions \
  -H "Authorization: Bearer app-sk-<YOUR_SECRET>" \
  -d '{"model": "<model>", "messages": [{"role": "user", "content": "Hello!"}]}'
```

**Image generation:**
```bash
curl <service_url>/v1/proxy/images/generations \
  -H "Authorization: Bearer app-sk-<YOUR_SECRET>" \
  -d '{"model": "<model>", "prompt": "A cute otter", "size": "1024x1024"}'
```

**Speech-to-text:**
```bash
curl <service_url>/v1/proxy/audio/transcriptions \
  -H "Authorization: Bearer app-sk-<YOUR_SECRET>" \
  -F "file=@audio.ogg" -F "model=whisper-large-v3"
```

### Rate Limits

- 30 requests/minute (sustained)
- 5-request burst allowance
- 5 concurrent requests max
- HTTP 429 = rate limited, wait and retry

### Prerequisites

- Node.js >= 22.0.0
- 0G tokens (testnet or mainnet)
- EVM-compatible wallet

**Web UI (for testing):** https://compute-marketplace.0g.ai/inference

---

## 0G DA (Data Availability)

*(Documentation TBD — research during Phase 1)*

---

## 0G Agent Skills

GitHub repository with pre-built agent skills for 0G integration:
- https://github.com/0gfoundation/0g-agent-skills

---

## Key GitHub Repositories

| Repo | Description |
|---|---|
| https://github.com/0glabs/0g-ts-sdk | TypeScript SDK for 0G Storage |
| https://github.com/0gfoundation/0g-storage-client | Go SDK for 0G Storage |
| https://github.com/0gfoundation/0g-agent-skills | Pre-built agent skills |
| https://github.com/0gfoundation/0g-storage-ts-starter-kit | TypeScript starter kit |

---

## Useful Links

- **0G Website**: https://0g.ai/
- **0G Foundation**: https://www.0gfoundation.ai/
- **Compute Marketplace**: https://compute-marketplace.0g.ai/inference
- **Hackathon Page**: https://www.hackquest.io/hackathons/0G-APAC-Hackathon

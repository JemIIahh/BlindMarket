# Production response fixtures

These are real responses from `https://api.blindmarket.xyz`, recorded on
2026-09-23 with plain unauthenticated GETs. The SDK, MCP and CLI tests read them,
so each client is tested against what production actually serves, not a shape
someone remembered.

| File | Endpoint | What it pins |
|---|---|---|
| `health-settlement.json` | `GET /health/settlement` | Arc is the posting chain. It settles in the USDC ERC-20 (6 decimals) with **no relay**. Base is configured but not postable. |
| `health-bridge.json` | `GET /health/bridge` | Same chain list plus the signer reports. This is what the MCP's settlement discovery reads. |
| `deploy-fee.json` | `GET /api/v1/agents/deploy-fee` | 1 USDC by transfer on Arc to the escrow treasury. It was recorded **before** the terms carried `chainId`. |

When production's shape changes, re-record the file and let the tests that break
show which client code has to follow. Record with:

```sh
curl -s https://api.blindmarket.xyz/health/settlement | python3 -m json.tool > fixtures/prod/health-settlement.json
```

Don't edit a fixture by hand to make a test pass. A test that needs a newer
shape adds the field in the test itself: for example `chainId` on the deploy
terms, which the backend serves from commit 31833c2.

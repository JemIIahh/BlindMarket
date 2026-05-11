/**
 * Sanity-check that marketplaceAssign is live on the upgraded proxy.
 *
 * Reads the EIP-1967 impl slot directly from the RPC (not via the OZ helper,
 * which we observed returning stale cached values), confirms our selector is
 * in the deployed bytecode, then does a non-state-changing eth_call as the
 * verifier with a guaranteed-to-revert payload to confirm the function
 * dispatches with a structured error rather than "function does not exist".
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const PROXY = "0x037529B296a89E6Dd1abAF84D413cb2dD70C5be5";
const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("signer:", signer.address);

  const rpcUrl = process.env.OG_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
  const raw = await ethers.provider.getStorage(PROXY, EIP1967_IMPL_SLOT);
  const impl = ethers.getAddress("0x" + raw.slice(-40));
  console.log("live impl (EIP-1967):", impl);

  const code = await ethers.provider.getCode(impl);
  const selector = ethers.id("marketplaceAssign(uint256,address)").slice(0, 10);
  console.log("expected selector:", selector);
  console.log("selector in deployed bytecode:", code.includes(selector.slice(2)));

  const escrow = await ethers.getContractAt("BlindEscrow", PROXY);
  const verifier = await (escrow as unknown as { verifier: () => Promise<string> }).verifier();
  console.log("on-chain verifier:", verifier);

  // Dry-call as the signer. If signer is the verifier, we expect a structured
  // revert from the function body (ZeroAddress because we pass address(0) as
  // worker). If signer is NOT the verifier, we expect NotVerifier. Either way
  // proves the function dispatches.
  try {
    await (escrow as unknown as { marketplaceAssign: { staticCall: (taskId: bigint, worker: string) => Promise<unknown> } })
      .marketplaceAssign.staticCall(0n, ethers.ZeroAddress);
    console.log("[unexpected] static call did not revert");
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("NotVerifier") || msg.includes("ZeroAddress") || msg.includes("InvalidStatus")) {
      console.log("[ok] marketplaceAssign dispatched with structured revert:", msg.match(/(NotVerifier|ZeroAddress|InvalidStatus)/)?.[0]);
    } else {
      console.log("[?] revert message:", msg.slice(0, 200));
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

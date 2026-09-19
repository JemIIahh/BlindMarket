/**
 * Regenerate (or, with CHECK=1, verify) the backend and frontend address
 * modules from contracts/deployments/*.json. Everything it does is in
 * _sync-addresses.ts (render, main), which tests import; this file only runs it.
 *
 *   npx hardhat run scripts/sync-addresses.ts
 *   CHECK=1 npx hardhat run scripts/sync-addresses.ts
 */
import { main } from "./_sync-addresses.js";

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

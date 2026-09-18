// Must stay the first import: it picks the OpenZeppelin manifest directory for
// DEPLOYMENT_SET before upgrades-core reads it, and snapshots the guard
// variables before dotenv loads contracts/.env.
import { assertGuardVarsNotFromDotenv } from "./scripts/_manifest-dir";
import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades";
import "dotenv/config";

assertGuardVarsNotFromDotenv();

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // viaIR: required since the agent-verify upgrade added a 7th createTask
      // param path (stack-too-deep without it). Storage-layout-neutral, so the
      // BlindEscrow UUPS upgrade stays compatible — viaIR only changes codegen.
      viaIR: true,
      evmVersion: "cancun",
    },
  },
  networks: {
    "0g-testnet": {
      url: "https://evmrpc-testnet.0g.ai",
      chainId: 16602,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
    "0g-mainnet": {
      url: "https://evmrpc.0g.ai",
      chainId: 16661,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
    "base-sepolia": {
      url: process.env.BASE_RPC_URL || "https://sepolia.base.org",
      chainId: 84532,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
    "base": {
      url: process.env.BASE_RPC_URL || "https://mainnet.base.org",
      chainId: 8453,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
    // Arc (Circle's L1). Each network name equals its deployment file name
    // (deployments/arc-testnet.json, arc-mainnet.json); see _deployments.ts.
    "arc-testnet": {
      url: process.env.ARC_TESTNET_RPC_URL || "https://rpc.testnet.arc.io",
      chainId: 5042002,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
    // No default RPC for Arc Mainnet: set ARC_MAINNET_RPC_URL. Unset, the
    // empty URL still loads the config, and any run on this network stops at
    // its first request (HH117) before sending anything.
    "arc-mainnet": {
      url: process.env.ARC_MAINNET_RPC_URL ?? "",
      chainId: 5042,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
  },
};

export default config;

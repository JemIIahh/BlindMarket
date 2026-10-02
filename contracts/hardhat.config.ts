// Must stay the first import: it picks the OpenZeppelin manifest directory for
// DEPLOYMENT_SET before upgrades-core reads it, and snapshots the guard
// variables before dotenv loads contracts/.env.
import { assertGuardVarsNotFromDotenv } from "./scripts/_manifest-dir.js";
import { configVariable, defineConfig } from "hardhat/config";
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import openzeppelinUpgrades from "@openzeppelin/hardhat-upgrades";
import "dotenv/config";

assertGuardVarsNotFromDotenv();

export default defineConfig({
  plugins: [hardhatToolboxMochaEthers, openzeppelinUpgrades],
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
    // The in-process chain the tests run on. A fixed gas limit, as Hardhat 2
    // sent by default: BlindEscrow makes its registry and reputation calls
    // inside try/catch, so a tightly estimated limit lets the inner call run
    // out of gas and the catch hides it. Live networks keep estimating.
    default: {
      type: "edr-simulated",
      chainType: "l1",
      gas: 12_000_000,
    },
    // The same in-process chain pinned to Prague, the hardfork that brought
    // EIP-7702. BlindAgentDelegate.test.ts sends its type-4 transactions
    // here; `default` keeps Hardhat's latest stable hardfork.
    prague: {
      type: "edr-simulated",
      chainType: "l1",
      gas: 12_000_000,
      hardfork: "prague",
    },
    "0g-testnet": {
      type: "http",
      chainType: "l1",
      url: "https://evmrpc-testnet.0g.ai",
      chainId: 16602,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
    "0g-mainnet": {
      type: "http",
      chainType: "l1",
      url: "https://0g-rpc.publicnode.com",
      chainId: 16661,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
    "base-sepolia": {
      type: "http",
      chainType: "l1",
      url: process.env.BASE_RPC_URL || "https://base-sepolia-rpc.publicnode.com",
      chainId: 84532,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
    "base": {
      type: "http",
      chainType: "l1",
      url: process.env.BASE_RPC_URL || "https://base-rpc.publicnode.com",
      chainId: 8453,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
    // Arc (Circle's L1). Each network name equals its deployment file name
    // (deployments/arc-testnet.json, arc-mainnet.json); see _deployments.ts.
    "arc-testnet": {
      type: "http",
      chainType: "l1",
      url: process.env.ARC_TESTNET_RPC_URL || "https://arc-testnet-rpc.publicnode.com",
      chainId: 5042002,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
    // No default RPC for Arc Mainnet. A configuration variable is resolved
    // only when this network is actually used, so the config loads for every
    // other command, and a run on arc-mainnet without ARC_MAINNET_RPC_URL
    // stops before it sends anything.
    "arc-mainnet": {
      type: "http",
      chainType: "l1",
      url: configVariable("ARC_MAINNET_RPC_URL"),
      chainId: 5042,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
    // CCTP source chains — AA infrastructure (deploy-aa.ts) only. Defaults
    // match the backend's CCTP RPCs (backend/src/config.ts); override per
    // network with the env var when needed.
    "ethereum-sepolia": {
      type: "http",
      chainType: "l1",
      url: process.env.CCTP_ETHEREUM_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
      chainId: 11155111,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
    "arbitrum-sepolia": {
      type: "http",
      chainType: "l1",
      url: process.env.CCTP_ARBITRUM_RPC_URL || "https://sepolia-rollup.arbitrum.io/rpc",
      chainId: 421614,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
    "optimism-sepolia": {
      type: "http",
      chainType: "l1",
      url: process.env.CCTP_OPTIMISM_RPC_URL || "https://sepolia.optimism.io",
      chainId: 11155420,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
    "polygon-amoy": {
      type: "http",
      chainType: "l1",
      url: process.env.CCTP_POLYGON_RPC_URL || "https://rpc-amoy.polygon.technology",
      chainId: 80002,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
    // CCTP mainnet chains — AA deploys only, behind the mainnet checklist
    // guard. No default RPC: like arc-mainnet these resolve from the
    // environment only when actually used.
    "ethereum-mainnet": {
      type: "http",
      chainType: "l1",
      url: configVariable("CCTP_ETHEREUM_MAINNET_RPC_URL"),
      chainId: 1,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
    "arbitrum-mainnet": {
      type: "http",
      chainType: "l1",
      url: configVariable("CCTP_ARBITRUM_MAINNET_RPC_URL"),
      chainId: 42161,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
    "polygon-mainnet": {
      type: "http",
      chainType: "l1",
      url: configVariable("CCTP_POLYGON_MAINNET_RPC_URL"),
      chainId: 137,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
  },
});

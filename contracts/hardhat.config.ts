import { defineConfig } from "hardhat/config";
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import openzeppelinUpgrades from "@openzeppelin/hardhat-upgrades";
import "dotenv/config";

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
      url: "https://evmrpc.0g.ai",
      chainId: 16661,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
    "base-sepolia": {
      type: "http",
      chainType: "l1",
      url: process.env.BASE_RPC_URL || "https://sepolia.base.org",
      chainId: 84532,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
    "base": {
      type: "http",
      chainType: "l1",
      url: process.env.BASE_RPC_URL || "https://mainnet.base.org",
      chainId: 8453,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
  },
});

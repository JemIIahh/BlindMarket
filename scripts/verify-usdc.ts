import { ethers } from "hardhat";

async function main() {
  const proxyAddress = "0xCca5ab873158b888158AD9Dc36fb4Ee683eFbEBf";
  const correctUsdc = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
  
  // Read directly from provider
  const provider = ethers.provider;
  const escrow = await ethers.getContractAt("BlindEscrow", proxyAddress);
  
  const allowed = await escrow.allowedTokens(correctUsdc);
  console.log("Correct USDC allowed:", allowed);
  
  // Also check the wrong one is now disallowed
  const wrongUsdc = "0x036cbd53842c5426634c4923a64805772f97d1b6";
  const wrongAllowed = await escrow.allowedTokens(wrongUsdc);
  console.log("Wrong USDC allowed:", wrongAllowed);
}

main().catch(console.error);

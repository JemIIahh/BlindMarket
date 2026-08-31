import { Router } from 'express';
import { formatEther } from 'ethers';
import type { ApiResponse } from '../types.js';
import { escrow, marketplaceSigner, provider, baseEscrow, baseMarketplaceSigner, baseProvider } from '../services/chain.js';
import { isBridgeConfigured } from '../services/a2aSettlement.js';
import { config } from '../config.js';

export const healthRouter = Router();

// Below this native-0G balance the marketplace signer is at risk of failing to
// broadcast marketplaceAssign / completeVerification (out of gas), which surfaces
// as BRIDGE_FAILED even though the verifier role is correct.
const SIGNER_GAS_LOW_OG = 0.02;

healthRouter.get('/', (_req, res) => {
  const body: ApiResponse<{ status: string; timestamp: string }> = {
    success: true,
    data: { status: 'ok', timestamp: new Date().toISOString() },
  };
  res.json(body);
});

// GET /api/v1/health/bridge — surfaces the A2A settlement bridge config
// without needing backend log access. Returns whether the marketplace signer
// is set and whether it actually holds the on-chain verifier role. A `false`
// for `verifierMatches` is the root cause of every "task accepted but never
// completes" report; the response includes the exact rotate-verifier command
// to run from contracts/.
healthRouter.get('/bridge', async (_req, res, next) => {
  try {
    const configured = isBridgeConfigured();
    if (!configured || !marketplaceSigner) {
      const body: ApiResponse = {
        success: true,
        data: {
          configured: false,
          reason: 'MARKETPLACE_SIGNER_PRIVATE_KEY not set in backend env',
        },
      };
      res.json(body);
      return;
    }
    const signerAddr = await marketplaceSigner.getAddress();
    let onChainVerifier: string | null = null;
    let escrowReadError: string | null = null;
    try {
      onChainVerifier = (await escrow.verifier()) as string;
    } catch (e) {
      escrowReadError = (e as Error).message;
    }
    const verifierMatches =
      onChainVerifier !== null &&
      onChainVerifier.toLowerCase() === signerAddr.toLowerCase();

    let signerBalanceOg: string | null = null;
    let signerGasLow: boolean | null = null;
    let signerBalanceError: string | null = null;
    try {
      const balanceWei = await provider.getBalance(signerAddr);
      const og = Number(formatEther(balanceWei));
      signerBalanceOg = formatEther(balanceWei);
      signerGasLow = og < SIGNER_GAS_LOW_OG;
    } catch (e) {
      signerBalanceError = (e as Error).message;
    }

    const network = config.ogChainId === 16661 ? 'mainnet' : 'testnet';

    // Base bridge status (USDC settlement)
    let baseBridge: Record<string, unknown> | null = null;
    if (config.baseEscrowAddress && baseEscrow && baseMarketplaceSigner && baseProvider) {
      const baseSignerAddr = await baseMarketplaceSigner.getAddress();
      let baseVerifier: string | null = null;
      let baseEscrowError: string | null = null;
      try {
        baseVerifier = (await baseEscrow.verifier()) as string;
      } catch (e) {
        baseEscrowError = (e as Error).message;
      }
      const baseVerifierMatches =
        baseVerifier !== null &&
        baseVerifier.toLowerCase() === baseSignerAddr.toLowerCase();
      let baseSignerBalanceUsdc: string | null = null;
      let baseSignerBalanceError: string | null = null;
      try {
        // USDC balance (6 decimals)
        const USDC_ABI = ['function balanceOf(address) view returns (uint256)'];
        const usdc = new (await import('ethers')).ethers.Contract(config.baseUsdcAddress!, USDC_ABI, baseProvider);
        baseSignerBalanceUsdc = (await usdc.balanceOf(baseSignerAddr)).toString();
      } catch (e) {
        baseSignerBalanceError = (e as Error).message;
      }
      let baseSignerEthBalance: string | null = null;
      let baseSignerEthLow: boolean | null = null;
      try {
        const ethBal = await baseProvider.getBalance(baseSignerAddr);
        baseSignerEthBalance = formatEther(ethBal);
        baseSignerEthLow = Number(baseSignerEthBalance) < 0.001;
      } catch {
        // non-critical
      }
      baseBridge = {
        configured: true,
        signerAddress: baseSignerAddr,
        escrowAddress: config.baseEscrowAddress,
        chainId: config.baseChainId,
        onChainVerifier: baseVerifier,
        verifierMatches: baseVerifierMatches,
        escrowReadError: baseEscrowError,
        signerUsdcBalance: baseSignerBalanceUsdc,
        signerEthBalance: baseSignerEthBalance,
        signerEthLow: baseSignerEthLow,
        signerBalanceError: baseSignerBalanceError,
        rotateCommand: baseVerifierMatches
          ? null
          : `cd contracts && MARKETPLACE_SIGNER_ADDRESS=${baseSignerAddr} npx hardhat run scripts/rotate-verifier.ts --network base${network === 'mainnet' ? '' : '-sepolia'}`,
      };
    }

    const body: ApiResponse = {
      success: true,
      data: {
        configured: true,
        signerAddress: signerAddr,
        escrowAddress: config.blindEscrowAddress,
        chainId: config.ogChainId,
        onChainVerifier,
        verifierMatches,
        escrowReadError,
        signerBalanceOg,
        signerGasLow,
        signerBalanceError,
        rotateCommand: verifierMatches
          ? null
          : `cd contracts && MARKETPLACE_SIGNER_ADDRESS=${signerAddr} npx hardhat run scripts/rotate-verifier.ts --network 0g-${network}`,
        base: baseBridge,
      },
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

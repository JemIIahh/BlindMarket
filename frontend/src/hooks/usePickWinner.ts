import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ethers } from 'ethers';
import { useWallets } from '@privy-io/react-auth';
import { switchWalletToChain } from '../context/WalletContext';
import { ARC_CHAIN_CONFIG } from '../config/constants';
import { getSettlement, isSettlementChainKey } from '../config/settlement';
import { checkSelectWinnerTx, requestSelectWinner } from '../services/openSubmission';
import { isDirectSigned, signAndSendTx } from '../lib/txSigner';
import { truncateAddress } from '../lib/utils';

export interface PickRequest {
  taskHash: string;
  onChainTaskId: string;
  chain: string;
  /** The wallet that posted the task (the escrow's `agent`): only it can pick. */
  poster: string;
  winner: string;
}

/**
 * The poster's pick of an open task's winner, in their pick window: the
 * server builds selectWinner, this checks it (this chain's escrow, the
 * posting wallet, this task, this winner) and the posting wallet signs it.
 * Like a refund, the signer is the connected wallet that posted the task,
 * switched to the task's chain first.
 */
export function usePickWinner() {
  const { wallets } = useWallets();
  const qc = useQueryClient();

  const canSignAs = (poster: string | undefined) =>
    !!poster && wallets.some((w) => w.address.toLowerCase() === poster.toLowerCase());

  const mutation = useMutation({
    mutationFn: async ({ taskHash, onChainTaskId, chain, poster, winner }: PickRequest) => {
      if (!isSettlementChainKey(chain)) throw new Error(`This task's chain (${chain}) is not one this app can sign on.`);
      const wallet = wallets.find((w) => w.address.toLowerCase() === poster.toLowerCase());
      if (!wallet) throw new Error(`This task was posted from ${truncateAddress(poster)}. Connect that wallet to pick the winner.`);
      if (isDirectSigned(chain)) {
        const chainId = getSettlement().chains[chain].chainId;
        if (wallet.chainId !== `eip155:${chainId}`) await switchWalletToChain(wallet, chainId, ARC_CHAIN_CONFIG);
      }
      const signer = await new ethers.BrowserProvider(await wallet.getEthereumProvider()).getSigner();
      const built = await requestSelectWinner(taskHash, winner);
      const problem = checkSelectWinnerTx(built.unsignedSelectWinner, {
        escrow: getSettlement().chains[chain].escrow,
        poster,
        onChainTaskId,
        winner,
      });
      if (problem) throw new Error(problem);
      const tx = built.unsignedSelectWinner!;
      return signAndSendTx(signer, { to: tx.to, data: tx.data, from: tx.from }, undefined, { chain });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['open-submission'] });
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['my-tasks-posted'] });
    },
  });

  return { ...mutation, canSignAs };
}

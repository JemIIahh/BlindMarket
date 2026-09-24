import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ethers } from 'ethers';
import { useWallets } from '@privy-io/react-auth';
import { switchWalletToChain } from '../context/WalletContext';
import { ARC_CHAIN_CONFIG } from '../config/constants';
import { getSettlement } from '../config/settlement';
import { assertRefundTarget, buildCancelTask, buildClaimTimeout, confirmRefund, type RefundTx } from '../services/tasks';
import { isDirectSigned, signAndSendTx } from '../lib/txSigner';
import { truncateAddress } from '../lib/utils';
import { encodeRefundCall, type RefundKind } from '../lib/refund';

export interface RefundRequest {
  /** The on-chain task id (the refund routes take the id, not the hash). */
  taskId: string;
  /** The task's chain: ids repeat across chains. Unknown on a partial response. */
  chain: string | undefined;
  /** The wallet that posted the task (the escrow's `agent`): only it can refund. */
  poster: string;
  kind: RefundKind;
  /**
   * False when the funding wallet isn't linked to the account. The backend
   * builds refunds only for the account's wallets (403 otherwise), so the call
   * is encoded here instead, and nothing is reported back: such a task was
   * never listed. Direct-signed chains only (a relay refuses the wallet too).
   * Defaults to true.
   */
  linked?: boolean;
}

/**
 * Take a task's escrow back: cancelTask for a task nobody took, claimTimeout
 * once an assigned task's deadline has passed.
 *
 * Signed by the wallet that POSTED the task, which is not always the one the
 * page treats as the user's (useWallet prefers the embedded wallet, while a
 * task posted from a linked external wallet can only be refunded by that
 * wallet: the escrow checks msg.sender). So the signer is looked up among the
 * connected wallets by address, and switched to the task's chain first. A
 * successful refund is confirmed to the backend, which takes the task off the
 * market.
 */
export function useRefundEscrow() {
  const { wallets } = useWallets();
  const qc = useQueryClient();

  /** Whether the posting wallet is connected in this browser, so it can sign. */
  const canSignAs = (poster: string | undefined) =>
    !!poster && wallets.some((w) => w.address.toLowerCase() === poster.toLowerCase());

  const mutation = useMutation({
    mutationFn: async ({ taskId, chain, poster, kind, linked = true }: RefundRequest) => {
      if (!chain) throw new Error("This task's chain is unknown. Reload the page and try again.");
      const wallet = wallets.find((w) => w.address.toLowerCase() === poster.toLowerCase());
      if (!wallet) {
        throw new Error(`This task was posted from ${truncateAddress(poster)}. Connect that wallet to reclaim its escrow.`);
      }
      if (isDirectSigned(chain)) {
        const chainId = getSettlement().chains[chain].chainId;
        if (wallet.chainId !== `eip155:${chainId}`) await switchWalletToChain(wallet, chainId, ARC_CHAIN_CONFIG);
      }
      const signer = await new ethers.BrowserProvider(await wallet.getEthereumProvider()).getSigner();
      let built: RefundTx;
      if (linked) {
        built = kind === 'cancel' ? await buildCancelTask(taskId, chain) : await buildClaimTimeout(taskId, chain);
      } else {
        if (!isDirectSigned(chain)) {
          throw new Error(`Link ${truncateAddress(poster)} under Settings → Link wallet to reclaim this escrow.`);
        }
        built = { chain, unsignedTx: { to: getSettlement().chains[chain].escrow, data: encodeRefundCall(kind, taskId), from: wallet.address } };
      }
      // Sign only a tx for this task's chain and escrow.
      const tx = assertRefundTarget(built, chain);
      const sent = await signAndSendTx(signer, tx, undefined, { chain });
      // A relayed user-op has no receipt for the backend to check.
      if (linked && !sent.userOp) await confirmRefund(taskId, sent.hash, chain).catch(() => {});
      return sent;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['my-tasks-posted'] });
    },
  });

  return { ...mutation, canSignAs };
}

import { useState } from 'react';
import {
  Breadcrumb,
  PageHeader,
  SectionRule,
  Panel,
  StatCard,
  Button,
  FormField,
  FormInput,
  FormTextarea,
  Prompt,
} from '../components/bb';
import { TxPendingModal } from '../components/TxPendingModal';
import {
  aesDecrypt,
  aesEncrypt,
  eciesDecrypt,
  fromBase64,
  fromBytes,
  generateAesKey,
  sha256,
  toBase64,
  toBytes,
} from '../lib/crypto';
import { downloadBlob, uploadBlob } from '../services/storage';
import { buildSubmitEvidence } from '../services/submissions';
import { useTxSend } from '../hooks/useTxSend';
import { useWallet } from '../context/WalletContext';
import { useAccount } from 'wagmi';

export default function WorkerView() {
  const [rootHash, setRootHash] = useState('');
  const [wrappedKey, setWrappedKey] = useState('');
  const [privateKey, setPrivateKey] = useState('');

  const [taskId, setTaskId] = useState('');
  const [evidence, setEvidence] = useState('');
  const [attachment, setAttachment] = useState('');

  const [decrypting, setDecrypting] = useState(false);
  const [decryptError, setDecryptError] = useState<string | null>(null);
  const [decryptedInstructions, setDecryptedInstructions] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [lastSubmit, setLastSubmit] = useState<{ rootHash: string; evidenceHash: string; txHash: string } | null>(null);

  const txSend = useTxSend();
  const { isCorrectChain } = useWallet();
  const { isConnected } = useAccount();

  const handleDecrypt = async () => {
    setDecryptError(null);
    setDecryptedInstructions(null);
    setDecrypting(true);
    try {
      // 1. Pull the encrypted blob from 0G Storage
      const blobRes = await downloadBlob(rootHash);
      const ciphertext = fromBase64(blobRes.data);

      // 2. ECIES-unwrap the AES key with the worker's private key
      const wrappedBytes = fromBase64(wrappedKey);
      const aesKey = await eciesDecrypt(wrappedBytes, privateKey);

      // 3. AES-256-GCM decrypt the blob
      const plaintext = await aesDecrypt(ciphertext, aesKey);
      setDecryptedInstructions(fromBytes(plaintext));
    } catch (err) {
      setDecryptError((err as Error).message || 'failed to decrypt');
    } finally {
      setDecrypting(false);
    }
  };

  const handleSubmitEvidence = async () => {
    setSubmitError(null);
    setSubmitting(true);
    try {
      // 1. AES-encrypt the evidence with a fresh key (simple submission format —
      //    the full dual-recipient envelope is available in the SDK for production).
      //    Attachment (if present) is appended to the evidence text before sealing.
      const payload = attachment ? `${evidence}\n\nattachment: ${attachment}` : evidence;
      const aesKey = await generateAesKey();
      const ciphertext = await aesEncrypt(toBytes(payload), aesKey);

      // 2. Upload to 0G Storage
      const uploaded = await uploadBlob(toBase64(ciphertext));

      // 3. On-chain evidenceHash is SHA-256 of the ciphertext
      const evidenceHashHex = await sha256(ciphertext);
      const evidenceHash = `0x${evidenceHashHex}`;

      // 4. Build + sign submitEvidence tx
      const unsignedTx = await buildSubmitEvidence({ taskId, evidenceHash });
      const receipt = await txSend.mutateAsync(unsignedTx);

      setLastSubmit({ rootHash: uploaded.rootHash, evidenceHash, txHash: receipt.hash });
    } catch (err) {
      setSubmitError((err as Error).message || 'failed to submit evidence');
    } finally {
      setSubmitting(false);
    }
  };

  const canDecrypt = rootHash && wrappedKey && privateKey && !decrypting;
  const canSubmit =
    taskId && evidence.trim() && isConnected && isCorrectChain && !submitting && !txSend.isPending;

  return (
    <div>
      <Breadcrumb items={['marketplace', 'worker']} />
      <PageHeader
        title="Worker view"
        description="Decrypt instructions · submit evidence · track releases."
      />
      <TxPendingModal open={txSend.isPending} />

      {/* Stat cards — real data deferred to Phase post-hackathon */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-0 border border-line mb-8">
        <StatCard label="total staked" value="—" sub="preview" />
        <div className="border-l border-line">
          <StatCard label="active" value="—" sub="preview" />
        </div>
        <div className="border-l border-line">
          <StatCard label="returned" value="—" sub="preview" />
        </div>
        <div className="border-l border-line">
          <StatCard label="slashed" value="—" sub="preview" />
        </div>
      </div>

      {/* Two columns */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-0 border border-line mb-8">
        {/* Decrypt instructions */}
        <div className="p-6 space-y-5">
          <SectionRule num="01" title="decrypt task instructions" />

          <FormField label="root_hash" required hint="from agent — points to encrypted blob on 0g storage">
            <FormInput
              placeholder="0x..."
              value={rootHash}
              onChange={(e) => setRootHash(e.target.value)}
            />
          </FormField>

          <FormField label="wrapped_aes_key" required hint="base64 ecies blob from agent">
            <FormInput
              placeholder="base64-encoded ecies blob"
              value={wrappedKey}
              onChange={(e) => setWrappedKey(e.target.value)}
            />
          </FormField>

          <FormField label="private_key" required hint="never leaves your browser — ecies decryption only">
            <FormInput
              type="password"
              placeholder="hex private key"
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
            />
          </FormField>

          <div className="flex items-center gap-3 flex-wrap">
            <Button
              variant="primary"
              label={decrypting ? 'decrypting…' : 'decrypt_instructions'}
              disabled={!canDecrypt}
              onClick={handleDecrypt}
            />
            {decryptError && (
              <span className="text-[11px] font-mono text-err break-all">{decryptError}</span>
            )}
          </div>

          {decryptedInstructions !== null && (
            <div>
              <div className="text-[11px] font-mono font-semibold uppercase tracking-widest text-ink-3 mb-2">
                decrypted
              </div>
              <pre className="bg-surface-2 border border-ok/40 p-4 text-xs font-mono text-ink leading-relaxed overflow-x-auto whitespace-pre-wrap">
                {decryptedInstructions}
              </pre>
            </div>
          )}
        </div>

        {/* Submit evidence */}
        <div className="border-l border-line p-6 space-y-5">
          <SectionRule num="02" title="submit evidence" />

          <FormField label="task_id" required>
            <FormInput
              placeholder="e.g., 1"
              value={taskId}
              onChange={(e) => setTaskId(e.target.value)}
            />
          </FormField>

          <FormField label="evidence" required hint="describe completed work — will be aes-256 encrypted">
            <FormTextarea
              rows={4}
              placeholder="describe your completed work..."
              value={evidence}
              onChange={(e) => setEvidence(e.target.value)}
            />
          </FormField>

          <FormField label="attachment" hint="optional file hash or ipfs cid">
            <FormInput
              placeholder="0x... or ipfs://..."
              value={attachment}
              onChange={(e) => setAttachment(e.target.value)}
            />
          </FormField>

          <div className="flex items-center gap-3 flex-wrap">
            <Button
              variant="primary"
              label={submitting || txSend.isPending ? 'submitting…' : 'submit_evidence'}
              disabled={!canSubmit}
              onClick={handleSubmitEvidence}
            />
            {!isConnected && (
              <span className="text-[11px] font-mono text-ink-3">connect wallet to submit</span>
            )}
            {isConnected && !isCorrectChain && (
              <span className="text-[11px] font-mono text-err">switch to 0G Galileo</span>
            )}
            {submitError && (
              <span className="text-[11px] font-mono text-err break-all">{submitError}</span>
            )}
          </div>

          {lastSubmit && (
            <div className="bg-surface-2 border border-ok/40 p-3 text-[11px] font-mono text-ink-3 space-y-1">
              <div><span className="text-ok">✓ submitted</span></div>
              <div>storage_root: <span className="text-ink break-all">{lastSubmit.rootHash}</span></div>
              <div>evidence_hash: <span className="text-ink break-all">{lastSubmit.evidenceHash}</span></div>
              <div>tx_hash: <span className="text-ink break-all">{lastSubmit.txHash}</span></div>
            </div>
          )}
        </div>
      </div>

      {/* Active tasks — bottom */}
      <Panel>
        <div className="flex items-center gap-3 mb-4">
          <SectionRule num="03" title="my active tasks · live" side="streaming" className="flex-1" />
          <span className="animate-bb-pulse text-ok text-xs font-mono">●●●</span>
        </div>
        <div className="border border-line">
          <div className="p-8 flex flex-col items-center justify-center gap-3">
            <Prompt command="tail -f active_tasks.log" blink />
            <p className="text-ink-3 text-xs font-mono">no active tasks. decrypt instructions or accept a task from the feed.</p>
          </div>
        </div>
      </Panel>
    </div>
  );
}

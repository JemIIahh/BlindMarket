import { useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Breadcrumb, PageHeader, Panel, Button, LoadingState, ErrorState, EmptyState } from '../components/bb';
import { authedGet } from '../lib/api';
import { useAuth } from '../context/AuthContext';

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function detectImage(bytes: Uint8Array): string | null {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((b, i) => bytes[i] === b)) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return null;
}

export default function StorageView() {
  const { rootHash } = useParams<{ rootHash: string }>();
  const { isAuthenticated } = useAuth();
  const [blobB64, setBlobB64] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!rootHash) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    authedGet<{ rootHash: string; blob: string }>(`/api/v1/storage/${rootHash}`)
      .then((d) => {
        if (!cancelled) setBlobB64(d.blob);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message || 'Download failed');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rootHash]);

  const view = useMemo(() => {
    if (!blobB64) return null;
    let bytes: Uint8Array;
    try {
      bytes = fromBase64(blobB64);
    } catch {
      return { kind: 'raw' as const, text: blobB64 };
    }
    const imageMime = detectImage(bytes);
    if (imageMime) {
      const url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: imageMime }));
      return { kind: 'image' as const, url, mime: imageMime, bytes };
    }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      try {
        return { kind: 'json' as const, text: JSON.stringify(JSON.parse(text), null, 2), bytes };
      } catch {
        return { kind: 'text' as const, text, bytes };
      }
    } catch {
      const hex = Array.from(bytes.slice(0, 2048))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      return {
        kind: 'binary' as const,
        text: hex + (bytes.length > 2048 ? `\n… (${bytes.length} bytes total, showing first 2048)` : ''),
        bytes,
      };
    }
  }, [blobB64]);

  // Revoke image object URLs on unmount / blob change.
  useEffect(() => {
    return () => {
      if (view?.kind === 'image') URL.revokeObjectURL(view.url);
    };
  }, [view]);

  function download() {
    if (!blobB64 || !rootHash) return;
    const bytes = fromBase64(blobB64);
    const url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${rootHash}.bin`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  return (
    <div>
      <Breadcrumb items={['storage', rootHash?.slice(0, 12) ?? '…']} />
      <PageHeader
        title="Storage blob"
        description={`0G storage root ${rootHash ?? ''}`}
        right={<Button variant="outline" label="Download" size="sm" onClick={download} />}
      />

      {!isAuthenticated ? (
        <EmptyState
          icon="lock"
          title="Sign in to view this blob"
          description="Storage downloads require authentication — the endpoint returns UNAUTHORIZED without a signed-in wallet."
        />
      ) : loading ? (
        <LoadingState label="Downloading blob…" />
      ) : error ? (
        <ErrorState
          title="Couldn't load this blob"
          description={error}
          onRetry={() => window.location.reload()}
        />
      ) : !view ? (
        <EmptyState icon="search" title="Empty blob" description="The storage node returned no data." />
      ) : (
        <Panel padding="md">
          {view.kind === 'image' ? (
            <img src={view.url} alt={`storage blob ${rootHash}`} className="max-w-full border border-line" />
          ) : view.kind === 'json' ? (
            <pre className="text-xs font-mono text-ink bg-surface-2 border border-line p-4 overflow-x-auto whitespace-pre-wrap">
              {view.text}
            </pre>
          ) : view.kind === 'text' ? (
            <p className="text-sm text-ink-2 whitespace-pre-wrap leading-relaxed">{view.text}</p>
          ) : (
            <>
              <p className="text-xs text-ink-3 mb-2 italic">
                {view.kind === 'binary'
                  ? 'Encrypted or binary content — shown as hex. Only a keyholder can decrypt it.'
                  : 'Raw content:'}
              </p>
              <pre className="text-xs font-mono text-ink bg-surface-2 border border-line p-4 overflow-x-auto whitespace-pre-wrap break-all">
                {view.text}
              </pre>
            </>
          )}
          <div className="mt-4 text-[11px] text-ink-3">
            Private task blobs are encrypted — readable only with the brief key.{' '}
            <Link to="/a2a" className="text-cream hover:underline">
              Back to marketplace
            </Link>
          </div>
        </Panel>
      )}
    </div>
  );
}

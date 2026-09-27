import { Component, type ErrorInfo, type ReactNode } from 'react';
import * as Sentry from '@sentry/react';
import { isChunkLoadError, reloadForNewBuild } from '../lib/chunkReload';

interface Props { children: ReactNode }
interface State {
  error: Error | null;
  /** For a chunk that failed to download: 'pending' until componentDidCatch
   *  decides, then 'reloading' (a reload is under way) or 'failed' (it already
   *  reloaded once and the chunk still fails: an outage, not a stale tab). */
  chunk: 'no' | 'pending' | 'reloading' | 'failed';
}

/**
 * Top-level error boundary. The app previously had ZERO boundaries, so any
 * uncaught render/effect throw unmounted the whole tree and left a blank page
 * (tab title "Error") — e.g. the AgentMesh WebGL globe on browsers without
 * WebGL. This catches the throw, keeps the shell alive, and shows a recoverable
 * fallback instead of a white screen.
 *
 * A page chunk that fails to download (a tab opened before a deploy asks for
 * chunk names the new build no longer has) is not a bug: it reloads once to
 * pick up the current build (lib/chunkReload.ts), and only says the page
 * couldn't load if the chunk still fails after that.
 *
 * componentDidCatch logs to the console with the component stack and reports
 * to Sentry: React only console.errors an error a boundary catches, so it never
 * reaches Sentry's global handlers. A no-op until main.tsx inits Sentry. A
 * chunk failure that a reload fixes is not reported.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, chunk: 'no' };

  static getDerivedStateFromError(error: Error): State {
    return { error, chunk: isChunkLoadError(error) ? 'pending' : 'no' };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (isChunkLoadError(error)) {
      if (reloadForNewBuild()) {
        console.warn('[ErrorBoundary] a page chunk failed to load; reloading for the current build:', error.message);
        this.setState({ chunk: 'reloading' });
        return;
      }
      this.setState({ chunk: 'failed' });
    }
    console.error('[ErrorBoundary] uncaught render error:', error, info.componentStack);
    Sentry.captureException(error, { contexts: { react: { componentStack: info.componentStack } } });
  }

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    const { error, chunk } = this.state;
    if (!error) return this.props.children;

    if (chunk === 'pending' || chunk === 'reloading') {
      return (
        <div role="status" className="min-h-screen flex items-center justify-center bg-bg px-6">
          <p className="font-mono text-[11px] uppercase tracking-widest text-ink-3">Loading the latest version…</p>
        </div>
      );
    }

    const outage = chunk === 'failed';
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface px-6">
        <div role="alert" className="max-w-md w-full border border-line bg-surface-2 p-6">
          <div className="text-sm font-semibold text-ink mb-2">
            {outage ? "Couldn't load this page" : 'Something went wrong'}
          </div>
          <p className="text-xs text-ink-3 mb-4 leading-relaxed">
            {outage
              ? 'Part of the page failed to download. Check your connection, then reload.'
              : 'This page hit an unexpected error. Reloading usually fixes it.'}
          </p>
          <details className="mb-4">
            <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-widest text-ink-3 hover:text-ink">
              Show details
            </summary>
            <pre className="mt-1.5 text-[11px] text-ink-3 font-mono whitespace-pre-wrap break-words max-h-32 overflow-auto">
              {error.message}
            </pre>
          </details>
          <button
            type="button"
            onClick={this.handleReload}
            className="px-3 py-1.5 text-xs border border-line bg-surface hover:border-cream text-ink"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}

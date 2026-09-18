import { Component, type ErrorInfo, type ReactNode } from 'react';
import * as Sentry from '@sentry/react';

interface Props { children: ReactNode }
interface State { error: Error | null }

/**
 * Top-level error boundary. The app previously had ZERO boundaries, so any
 * uncaught render/effect throw unmounted the whole tree and left a blank page
 * (tab title "Error") — e.g. the AgentMesh WebGL globe on browsers without
 * WebGL. This catches the throw, keeps the shell alive, and shows a recoverable
 * fallback instead of a white screen.
 *
 * componentDidCatch logs to the console with the component stack and reports
 * to Sentry: React only console.errors an error a boundary catches, so it never
 * reaches Sentry's global handlers. A no-op until main.tsx inits Sentry.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary] uncaught render error:', error, info.componentStack);
    Sentry.captureException(error, { contexts: { react: { componentStack: info.componentStack } } });
  }

  private handleReload = () => {
    this.setState({ error: null });
    window.location.reload();
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="min-h-screen flex items-center justify-center bg-surface px-6">
        <div className="max-w-md w-full border border-line bg-surface-2 p-6">
          <div className="text-sm font-semibold text-ink mb-2">Something went wrong</div>
          <p className="text-xs text-ink-3 mb-4">
            This view hit an unexpected error. The rest of the app is fine — reload to recover.
          </p>
          <pre className="text-[11px] text-err font-mono whitespace-pre-wrap break-words mb-4 max-h-32 overflow-auto">
            {error.message}
          </pre>
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

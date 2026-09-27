import { useAccount } from 'wagmi';
import { useAuth } from '../../context/AuthContext';
import { Button } from './Button';
import { Icon } from './Icon';

/**
 * SignInGate — the ONE banner for the connected-but-not-signed-in state
 * (an injected wallet can auto-connect without a Privy session, so pages
 * that call the backend still need a sign-in). Renders nothing once
 * authenticated. Replaces the per-page hand-rolled "Sign in to backend"
 * banners so the copy and treatment can't drift.
 *
 * `prompt` completes the sentence: <SignInGate prompt="to post a task" />
 */
export function SignInGate({ prompt }: { prompt: string }) {
  const { address } = useAccount();
  const { isAuthenticated, login } = useAuth();

  if (isAuthenticated) return null;

  return (
    <div className="mb-6 p-4 rounded-2xl border border-[color-mix(in_srgb,var(--bb-warn)_40%,transparent)] bg-[color-mix(in_srgb,var(--bb-warn)_5%,transparent)] flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-sm">
      <span className="flex items-center gap-2 text-ink-2">
        <Icon name={address ? 'lock' : 'wallet'} size={16} className="text-warn shrink-0" />
        {address
          ? `You're connected but not signed in. Sign in ${prompt}.`
          : `Connect your wallet ${prompt}.`}
      </span>
      <Button
        variant="outline"
        size="sm"
        label={address ? 'Sign in' : 'Connect wallet'}
        onClick={login}
      />
    </div>
  );
}

import { useState } from 'react';
import { AgentAvatar, Button, Icon, StatusTag } from '../bb';
import type { AgentAction, AgentDetails } from './types';

export function AgentHeader({
  agent,
  displayStatus,
  badgeCount,
  fromPrice,
  isOwner,
  actionPending,
  onAction,
}: {
  agent: AgentDetails;
  displayStatus: string;
  badgeCount: number;
  fromPrice: string | null;
  isOwner: boolean;
  actionPending: boolean;
  onAction: (act: AgentAction) => void;
}) {
  const [descExpanded, setDescExpanded] = useState(false);
  const description = (agent.instructions ?? '').trim();
  const isRunning = agent.status === 'running';

  return (
    <div className="mb-8">
      <div className="flex items-center gap-4 sm:gap-5">
        <AgentAvatar seed={agent.walletAddress || agent.id} size={48} className="shrink-0" />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5 flex-wrap">
            <h1 className="text-xl sm:text-2xl font-bold text-ink leading-tight tracking-tight break-words">
              {agent.name}
            </h1>
            <StatusTag status={displayStatus} />
          </div>
          <div className="mt-1 flex items-center gap-2 flex-wrap font-mono text-xs text-ink-3">
            <span>{agent.provider} · {agent.model}</span>
            {badgeCount > 0 && (
              <span className="text-ok">
                <Icon name="check" size={12} className="inline-block align-[-2px] mr-0.5" />
                {badgeCount} badge{badgeCount > 1 ? 's' : ''}
              </span>
            )}
          </div>
        </div>

        {isOwner && (
          <div className="flex items-center gap-2 shrink-0">
            {!isRunning && (
              <Button
                variant="primary"
                size="sm"
                disabled={actionPending}
                onClick={() => onAction('start')}
                label="Start"
              />
            )}
            {isRunning && (
              <>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={actionPending}
                  onClick={() => onAction('restart')}
                  label="Restart"
                  title="Stop and start in one go — re-forks the worker with fresh code, env, and retry budgets"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={actionPending}
                  onClick={() => onAction('stop')}
                  label="Stop"
                />
              </>
            )}
          </div>
        )}
      </div>

      {description && (
        <div className="mt-4 max-w-3xl">
          <p className={`text-sm text-ink-2 leading-relaxed whitespace-pre-line ${descExpanded ? '' : 'line-clamp-3'}`}>
            {description}
          </p>
          {description.length > 220 && (
            <button
              onClick={() => setDescExpanded((v) => !v)}
              className="mt-1 font-mono text-[11px] uppercase tracking-widest text-ink-3 hover:text-cream transition-colors"
            >
              {descExpanded ? 'show less' : 'view all'}
            </button>
          )}
        </div>
      )}

      {!isOwner && fromPrice && (
        <a
          href="#services"
          className="mt-4 inline-flex items-baseline gap-2 font-mono text-sm text-cream hover:underline"
        >
          {fromPrice}
          <span className="text-[11px] uppercase tracking-widest text-ink-3">view services ↓</span>
        </a>
      )}
    </div>
  );
}

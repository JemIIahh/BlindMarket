import { useState } from 'react';
import { AgentAvatar, Button, Icon, StatusTag } from '../bb';
import { Markdown } from '../Markdown';
import { briefPreview, normalizeBrief } from '../../lib/briefText';
import type { AgentAction, AgentDetails } from './types';

/** The collapsed description: the text without its Markdown headings, which
 *  would otherwise run into the sentences ("Specification Role You are…"). */
function descriptionPreview(text: string): string {
  const body = text
    .split('\n')
    .filter((line) => !/^\s{0,3}#{1,6}\s/.test(line))
    .join('\n');
  return briefPreview(body) || briefPreview(text);
}

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
  const description = normalizeBrief(agent.instructions);
  // Instructions are usually Markdown ("# Research Agent Specification…"):
  // collapsed, show them as one plain paragraph; expanded, render them.
  const preview = descriptionPreview(description);
  const isRunning = agent.status === 'running';

  return (
    <div className="mb-8">
      <div className="flex items-center gap-4 sm:gap-5">
        <AgentAvatar seed={agent.walletAddress || agent.id} size={56} className="shrink-0 rounded-xl" />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5 flex-wrap">
            <h1 className="text-[clamp(26px,3vw,36px)] font-medium text-ink leading-[1.08] tracking-[-0.03em] break-words">
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
        <div className="mt-5 max-w-3xl">
          {descExpanded ? (
            <Markdown text={description} />
          ) : (
            <p className="text-[15px] text-ink-2 leading-relaxed line-clamp-3">{preview}</p>
          )}
          {description.length > 220 && (
            <button
              type="button"
              onClick={() => setDescExpanded((v) => !v)}
              aria-expanded={descExpanded}
              className="mt-2 font-mono text-[11px] uppercase tracking-widest text-ink-3 hover:text-ink transition-colors"
            >
              {descExpanded ? 'Show less' : 'Read all'}
            </button>
          )}
        </div>
      )}

      {!isOwner && fromPrice && (
        <a
          href="#services"
          className="mt-5 inline-flex items-center gap-2.5 rounded-full border border-line px-4 py-2 text-sm text-accent transition-colors hover:border-line-2"
        >
          <span className="font-medium">{fromPrice}</span>
          <span className="font-mono text-[11px] uppercase tracking-widest text-ink-3">See services ↓</span>
        </a>
      )}
    </div>
  );
}

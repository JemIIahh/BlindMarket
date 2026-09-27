import { Link } from 'react-router-dom';
import { Icon } from '../bb/Icon';
import { Tag } from '../bb/Tag';
import { Skeleton, StatusTag } from '../bb/states';
import { PosterAvatar, type AvatarConfig } from '../avatar/PosterAvatar';
import { cardText, deadlineLabel, formatReward, verifyLabel, type DeadlineTone, type TaskReward } from './format';

/** One row of GET /api/v1/a2a/tasks: the public projection of a task's A2A
 *  meta (backend projectPublicMeta) and its state. */
export interface BrowseTask {
  meta: {
    taskId: string;
    verificationMode?: string;
    targetExecutorType?: string;
    // Present only on public tasks: the poster opted out of blindness, so the
    // brief itself is browsable.
    privacy?: 'public';
    publicBrief?: string;
    // The poster's public one-liner: the only readable text on a private task.
    routingSummary?: string;
    requiredCapabilities?: string[];
    reward?: TaskReward;
    /** Unix seconds. */
    deadline?: number;
    posterAddress?: string;
    posterAvatar?: AvatarConfig | null;
  };
  state: { status: string };
  onChain?: { taskId?: string };
}

const MAX_TAGS = 3;

const DEADLINE_CLASS: Record<DeadlineTone, string> = {
  normal: 'text-ink-2',
  soon: 'text-warn',
  ended: 'text-ink-3',
};

// Text on the featured (invert) card, as mixes of its foreground so they hold
// contrast in both themes: an ink card on paper, a cream card on dark.
const ON_INVERT = {
  soft: 'text-[color:color-mix(in_srgb,var(--bb-invert-fg)_78%,transparent)]',
  muted: 'text-[color:color-mix(in_srgb,var(--bb-invert-fg)_70%,transparent)]',
  label: 'text-[color:color-mix(in_srgb,var(--bb-invert-fg)_62%,transparent)]',
  line: 'border-[color:color-mix(in_srgb,var(--bb-invert-fg)_24%,transparent)]',
};

/**
 * A task on the browse board: what it is, what it pays, and when it ends, as
 * one of the landing page's rounded cards. `featured` makes it the page's one
 * invert card (the landing's ink-on-paper "agent market" card): ink on paper,
 * cream on dark.
 */
export function TaskCard({ task, now, featured = false }: { task: BrowseTask; now: number; featured?: boolean }) {
  const { meta } = task;
  const id = meta.taskId || task.onChain?.taskId || '';
  const isPublic = meta.privacy === 'public';
  const { title, description } = cardText(meta);
  const reward = formatReward(meta.reward);
  const deadline = deadlineLabel(meta.deadline, now);
  const verify = verifyLabel(meta.verificationMode);
  const tags = (meta.requiredCapabilities ?? []).filter(Boolean);
  const poster = meta.posterAddress;
  const ref = task.onChain?.taskId ? `#${task.onChain.taskId}` : `${id.slice(0, 10)}…${id.slice(-4)}`;

  return (
    <Link
      to={`/tasks/${id}`}
      className={`group relative flex min-h-[248px] flex-col rounded-2xl p-6 transition-[transform,box-shadow,border-color] duration-300 ease-bb hover:-translate-y-1 hover:shadow-[0_22px_44px_-28px_rgba(10,10,11,0.45)] motion-reduce:transition-none motion-reduce:hover:translate-y-0 ${
        featured ? 'border border-transparent bg-invert text-invert-fg' : 'card-dark hover:border-line-2'
      }`}
    >
      <div className="flex items-center gap-2">
        <Tag tone="neutral" className={featured ? `${ON_INVERT.line} ${ON_INVERT.soft}` : ''}>
          {isPublic ? 'Public' : <><Icon name="lock" size={10} />Private</>}
        </Tag>
        {/* The board lists only open tasks, so a chip saying so is noise. */}
        {task.state.status !== 'open' && <StatusTag status={task.state.status} />}
        {reward && (
          <span
            className={`ml-auto whitespace-nowrap pl-2 text-[17px] font-medium tabular-nums tracking-[-0.01em] ${
              featured ? 'text-invert-fg' : 'text-ink'
            }`}
          >
            {reward}
          </span>
        )}
      </div>

      <div className="mt-5 min-w-0">
        {featured && (
          <div className={`mb-2 font-mono text-[10.5px] uppercase tracking-widest ${ON_INVERT.label}`}>Top reward</div>
        )}
        <h3
          className={`line-clamp-2 break-words text-[19px] font-medium leading-snug tracking-[-0.02em] ${
            featured ? 'text-invert-fg' : 'text-ink'
          }`}
        >
          {title}
        </h3>
        {description && (
          <p
            className={`mt-2 line-clamp-2 break-words text-[13.5px] leading-relaxed ${
              featured ? ON_INVERT.muted : 'text-ink-3'
            }`}
          >
            {description}
          </p>
        )}
      </div>

      {tags.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {tags.slice(0, MAX_TAGS).map((tag) => (
            <span
              key={tag}
              className={`rounded-full border px-2.5 py-1 text-[11.5px] leading-none ${
                featured ? `${ON_INVERT.line} ${ON_INVERT.soft}` : 'border-line text-ink-2'
              }`}
            >
              {tag.replace(/_/g, ' ')}
            </span>
          ))}
          {tags.length > MAX_TAGS && (
            <span className={`px-1 py-1 text-[11.5px] leading-none ${featured ? ON_INVERT.label : 'text-ink-3'}`}>
              +{tags.length - MAX_TAGS}
            </span>
          )}
        </div>
      )}

      <div className="mt-auto flex items-center gap-3 pt-6">
        <span className="shrink-0" title={poster ? `Posted by ${poster}` : undefined}>
          <PosterAvatar
            config={meta.posterAvatar}
            seed={(poster || id).toLowerCase()}
            size={34}
            className={`border ${featured ? ON_INVERT.line : 'border-line'}`}
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[13px]">
            {deadline && (
              <span className={featured ? 'text-invert-fg' : DEADLINE_CLASS[deadline.tone]}>{deadline.text}</span>
            )}
            {deadline && verify && <span aria-hidden className={featured ? ON_INVERT.label : 'text-ink-3'}>·</span>}
            {verify && (
              <span className={`truncate ${featured ? ON_INVERT.muted : 'text-ink-3'}`} title={verify.hint}>
                {verify.label}
              </span>
            )}
          </div>
          <div className={`mt-0.5 truncate font-mono text-[10.5px] ${featured ? ON_INVERT.label : 'text-ink-3'}`} title={id}>
            {ref}
          </div>
        </div>
        {/* The landing's round arrow: ink on a light card, cream on a dark one. */}
        <span
          aria-hidden
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-transform duration-300 ease-bb group-hover:translate-x-1 motion-reduce:group-hover:translate-x-0 ${
            featured ? 'bg-invert-fg text-invert' : 'bg-invert text-invert-fg'
          }`}
        >
          →
        </span>
      </div>
    </Link>
  );
}

/** Placeholder for a card while the list loads. */
export function TaskCardSkeleton() {
  return (
    <div aria-hidden className="card-dark flex min-h-[248px] flex-col rounded-2xl p-6">
      <div className="flex items-center gap-2">
        <Skeleton className="h-5 w-16 rounded-full" />
        <Skeleton className="ml-auto h-5 w-20 rounded-full" />
      </div>
      <div className="mt-5 space-y-2.5">
        <Skeleton className="h-5 w-4/5 rounded-md" />
        <Skeleton className="h-3.5 w-full rounded-md" />
        <Skeleton className="h-3.5 w-2/3 rounded-md" />
      </div>
      <div className="mt-auto flex items-center gap-3 pt-6">
        <Skeleton className="h-[34px] w-[34px] rounded-full" />
        <Skeleton className="h-3.5 w-28 rounded-md" />
        <Skeleton className="ml-auto h-10 w-10 rounded-full" />
      </div>
    </div>
  );
}

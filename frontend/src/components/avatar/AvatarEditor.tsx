import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Button, ErrorNotice, Modal, Spinner } from '../bb';
import { ApiError } from '../../lib/api';
import { UserFacingError } from '../../lib/friendlyError';
import { useMyAvatar } from '../../hooks/useMyAvatar';
import { AvatarBuilder } from './AvatarBuilder';
import type { SavedAvatar } from './avatarOptions';
import { PosterAvatar } from './PosterAvatar';

// Only a development preview saves on the device (hooks/useMyAvatar.ts), so the
// note is compiled out of production builds along with that path.
const PREVIEW_NOTE = import.meta.env.DEV ? 'Saved on this device (preview)' : '';

const SAVE_FAILED = "Couldn't save your avatar";

/** Words for the failures only this form knows; the rest go to ErrorNotice as thrown. */
function saveFailure(err: unknown): unknown {
  if (!(err instanceof ApiError)) return err;
  const say = (message: string) => new UserFacingError(message, { title: SAVE_FAILED, cause: err });
  if (err.status === 404) return say("Avatars aren't on this server yet. Try again after the next update.");
  if (err.status === 401) return say('Sign in again, then save.');
  if (err.code === 'VALIDATION_ERROR') return say("Part of this avatar isn't allowed. Pick again, or press Randomise.");
  return err;
}

/** The builder in a modal, saving to the signed-in person's profile. */
export function AvatarBuilderModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const me = useMyAvatar();
  const [failed, setFailed] = useState<unknown>(null);

  const close = () => {
    setFailed(null);
    onClose();
  };

  const save = async (avatar: SavedAvatar) => {
    setFailed(null);
    try {
      await me.save(avatar);
      close();
    } catch (err) {
      setFailed(saveFailure(err));
    }
  };

  // The Modal renders nothing while closed, so the builder mounts fresh on
  // each opening, once the saved avatar is known, and starts from it.
  return (
    <Modal open={open} onClose={close} title="Your avatar" size="lg" dismissable={!me.saving}>
      {me.isLoading ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : (
        <AvatarBuilder
          seed={me.seed}
          initial={me.avatar}
          saving={me.saving}
          onSave={save}
          onCancel={close}
          error={<ErrorNotice error={failed} title={SAVE_FAILED} />}
          note={me.source === 'device' ? PREVIEW_NOTE : null}
        />
      )}
    </Modal>
  );
}

/** "Posting as [avatar] · Edit" for the post-task form. */
export function PostingAs({ className = '' }: { className?: string }) {
  const me = useMyAvatar();
  const [open, setOpen] = useState(false);
  if (!me.signedIn) return null;
  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 ${className}`}>
      {/* A pill, like the landing page's caption pill. */}
      <div className="inline-flex max-w-full items-center gap-2.5 rounded-full border border-line bg-surface-2 py-1 pl-1 pr-1.5">
        <PosterAvatar config={me.avatar} seed={me.seed} size={30} label="Your avatar" />
        <span className="text-[13.5px] text-ink-3">Posting as</span>
        <span className="truncate font-mono text-xs text-ink-2">{me.seed.startsWith('0x') ? `${me.seed.slice(0, 6)}…${me.seed.slice(-4)}` : 'you'}</span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="shrink-0 rounded-full bg-invert px-3 py-1 text-[12.5px] text-invert-fg transition-opacity duration-200 hover:opacity-90"
        >
          {me.avatar ? 'Edit avatar' : 'Make an avatar'}
        </button>
      </div>
      {me.source === 'device' && me.avatar && <span className="text-2xs text-ink-3">{PREVIEW_NOTE}</span>}
      <AvatarBuilderModal open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

/** The avatar block for Settings: the current face and an edit button.
 * The top bar's avatar links here as /settings#avatar. */
export function YourAvatarField() {
  const me = useMyAvatar();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { hash, key } = useLocation();
  // The router doesn't scroll to a #hash target by itself. `key` re-runs
  // this when the top bar link is clicked again from this same page.
  useEffect(() => {
    if (hash === '#avatar') ref.current?.scrollIntoView({ block: 'center' });
  }, [hash, key]);
  return (
    <div id="avatar" ref={ref} className="flex items-center gap-4 rounded-2xl border border-line bg-surface-2 p-4">
      <PosterAvatar config={me.avatar} seed={me.seed} size={64} className="border border-line" label="Your avatar" />
      <div className="min-w-0 space-y-2">
        <p className="text-xs text-ink-3 leading-relaxed">
          {me.avatar ? 'Shown on the tasks you post.' : 'Your tasks show this default face. Make it yours.'}
          {me.source === 'device' && me.avatar && <span className="block">{PREVIEW_NOTE}</span>}
        </p>
        <Button
          variant="outline"
          size="sm"
          type="button"
          label={me.avatar ? 'Edit avatar' : 'Make an avatar'}
          onClick={() => setOpen(true)}
          disabled={!me.signedIn}
        />
      </div>
      <AvatarBuilderModal open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

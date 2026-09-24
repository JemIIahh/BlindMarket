// ⌘B on Apple platforms, Ctrl+B elsewhere: the sidebar toggle people already
// know from Claude, VS Code and Slack.
export const IS_APPLE =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
export const SIDEBAR_SHORTCUT_LABEL = IS_APPLE ? '⌘B' : 'Ctrl+B';
export const SIDEBAR_SHORTCUT_ARIA = IS_APPLE ? 'Meta+B' : 'Control+B';

type KeyLike = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'repeat'> & {
  target: EventTarget | null;
};

/** True for the sidebar shortcut, except while typing: ⌘B in a text field or
 *  editor is left to the field (bold, or the cursor move on macOS). */
export function isSidebarShortcut(e: KeyLike, apple = IS_APPLE): boolean {
  if (e.key.toLowerCase() !== 'b' || e.altKey || e.shiftKey || e.repeat) return false;
  if (apple ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey) return false;
  return !isEditable(e.target);
}

function isEditable(target: EventTarget | null): boolean {
  const el = target as Partial<HTMLElement> | null;
  if (!el || typeof el.tagName !== 'string') return false;
  return el.isContentEditable === true || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

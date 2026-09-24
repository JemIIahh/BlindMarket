import { describe, it, expect } from 'vitest';
import { isSidebarShortcut } from './sidebarShortcut';

const body = { tagName: 'BODY', isContentEditable: false } as unknown as EventTarget;
const key = (over: Partial<Parameters<typeof isSidebarShortcut>[0]> = {}) => ({
  key: 'b', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, target: body, ...over,
});

describe('isSidebarShortcut', () => {
  it('is ⌘B on Apple platforms and Ctrl+B elsewhere', () => {
    expect(isSidebarShortcut(key({ metaKey: true }), true)).toBe(true);
    expect(isSidebarShortcut(key({ ctrlKey: true }), true)).toBe(false);
    expect(isSidebarShortcut(key({ ctrlKey: true }), false)).toBe(true);
    expect(isSidebarShortcut(key({ metaKey: true }), false)).toBe(false);
  });

  it('accepts caps lock (B) but not other modifiers, other keys or a held key', () => {
    expect(isSidebarShortcut(key({ metaKey: true, key: 'B' }), true)).toBe(true);
    expect(isSidebarShortcut(key({ metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(isSidebarShortcut(key({ metaKey: true, altKey: true }), true)).toBe(false);
    expect(isSidebarShortcut(key({ metaKey: true, ctrlKey: true }), true)).toBe(false);
    expect(isSidebarShortcut(key({ metaKey: true, key: 'k' }), true)).toBe(false);
    expect(isSidebarShortcut(key({ metaKey: true, repeat: true }), true)).toBe(false);
    expect(isSidebarShortcut(key(), true)).toBe(false);
  });

  it.each(['INPUT', 'TEXTAREA', 'SELECT'])('leaves ⌘B to a focused %s', (tagName) => {
    const target = { tagName, isContentEditable: false } as unknown as EventTarget;
    expect(isSidebarShortcut(key({ metaKey: true, target }), true)).toBe(false);
  });

  it('leaves ⌘B to a rich-text editor', () => {
    const target = { tagName: 'DIV', isContentEditable: true } as unknown as EventTarget;
    expect(isSidebarShortcut(key({ metaKey: true, target }), true)).toBe(false);
  });

  it('works with no target (the window itself)', () => {
    expect(isSidebarShortcut(key({ metaKey: true, target: null }), true)).toBe(true);
  });
});

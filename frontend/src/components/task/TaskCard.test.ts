import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { TaskCard, type BrowseTask } from './TaskCard';

const NOW = 1_790_534_557_000;

// Shaped like a row of GET /api/v1/a2a/tasks on prod (Sep 2026).
const privateTask: BrowseTask = {
  meta: {
    taskId: '0x5fa5701b01cb1c0c196ae0a2b5bfcc7097d35a9bfcbf6b57b63021644e571364',
    verificationMode: 'auto',
    targetExecutorType: 'agent',
    routingSummary: 'Write 10 launch tweets for a new AI agent marketplace',
    requiredCapabilities: ['content_generation', 'social_media', 'web_research', 'summarization'],
    reward: { amount: '450000', unit: { symbol: 'USDC', decimals: 6 } },
    deadline: NOW / 1000 + 5.5 * 3600,
    posterAddress: '0xB3704310E72538342B0CB28EE41D62e77d64f7be',
  },
  state: { status: 'open' },
};

const render = (task: BrowseTask, featured = false) =>
  renderToStaticMarkup(createElement(MemoryRouter, null, createElement(TaskCard, { task, now: NOW, featured })));

describe('TaskCard', () => {
  it("shows a private task's summary, tags, reward and deadline", () => {
    const html = render(privateTask);
    expect(html).toContain('Private');
    expect(html).toContain('Write 10 launch tweets for a new AI agent marketplace');
    expect(html).toContain('Details are encrypted for the agent who takes it.');
    expect(html).toContain('content generation');
    expect(html).toContain('social media');
    expect(html).toContain('web research');
    expect(html).not.toContain('summarization');
    expect(html).toContain('+1');
    expect(html).toContain('0.45 USDC');
    expect(html).toContain('Ends in 5h');
    expect(html).toContain('Auto check');
    expect(html).toContain(`href="/tasks/${privateTask.meta.taskId}"`);
    expect(html).toContain('Posted by 0xB3704310E72538342B0CB28EE41D62e77d64f7be');
    expect(html).not.toContain('Top reward');
    // Every task on the board is open; the chip only shows for anything else.
    expect(html).not.toMatch(/>open</i);
  });

  it('shows the status chip for a task that is no longer open', () => {
    expect(render({ ...privateTask, state: { status: 'accepted' } })).toContain('>accepted<');
  });

  it("shows a public task's brief title instead of the escaped text", () => {
    const html = render({
      ...privateTask,
      meta: {
        ...privateTask.meta,
        privacy: 'public',
        routingSummary: undefined,
        publicBrief: 'Top Memecoins by Volume\\n\\nList the 10 memecoins with the highest 7-day volume.',
      },
    });
    expect(html).toContain('Public');
    expect(html).toContain('>Top Memecoins by Volume<');
    expect(html).toContain('List the 10 memecoins with the highest 7-day volume.');
    expect(html).not.toContain('\\n');
  });

  it('marks the featured card', () => {
    expect(render(privateTask, true)).toContain('Top reward');
  });
});

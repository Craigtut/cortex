import { describe, expect, it } from 'vitest';
import { getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import {
  emptySystemHead,
  foldSystemMessages,
  replaySections,
  spliceHistory,
  withoutSystemMessages,
} from '../../src/system-transcript.js';
import type { SystemMessage } from '@earendil-works/pi-ai';

const tool = (name: string) => ({ name, description: name, parameters: { type: 'object' } });
const user = (content: string) => ({ role: 'user', content, timestamp: 1 });
const system = (fields: Partial<SystemMessage>): SystemMessage =>
  ({ role: 'system', content: '', timestamp: 2, ...fields });

describe('spliceHistory', () => {
  it('folds the system messages a rewrite drops into the head, in order', () => {
    const head = system({ sections: { Rules: 'v1' }, toolsAdded: [tool('a')] });
    const dropped = system({ toolsAdded: [tool('b')], sections: { Rules: 'v2' } });
    const kept = system({ toolsRemoved: [{ name: 'a' }] });
    const target: unknown[] = [head, user('slot'), user('old'), dropped, user('recent'), kept];
    const before = { prompt: getCurrentSystemPrompt(target as never), tools: getCurrentTools(target as never) };

    spliceHistory(target, 2, [user('summary'), target[4], kept]);

    expect(target.slice(1).map((m) => (m as { role: string }).role))
      .toEqual(['user', 'user', 'user', 'system']);
    // What the transcript declares survives the rewrite that removed where it was declared.
    expect(getCurrentSystemPrompt(target as never)).toBe(before.prompt);
    expect(getCurrentTools(target as never)).toEqual(before.tools);
    expect(target[target.length - 1]).toBe(kept);
  });

  it('leaves the head object alone when nothing declarative is dropped', () => {
    const head = system({ sections: { Rules: 'v1' } });
    const target: unknown[] = [head, user('old'), user('recent')];

    spliceHistory(target, 1, [user('summary')]);

    expect(target[0]).toBe(head);
    expect(target).toHaveLength(2);
  });
});

describe('replay helpers', () => {
  it('reads the patched sections and ignores non-system messages', () => {
    const messages = [
      system({ sections: { A: 'a1', B: 'b1' } }),
      user('hi'),
      system({ sections: { A: 'a2', B: null } }),
    ];
    expect([...replaySections(messages)]).toEqual([['A', 'a2']]);
    expect(withoutSystemMessages(messages)).toEqual([user('hi')]);
  });

  it('folds an empty transcript to an empty head', () => {
    expect(foldSystemMessages([user('hi')])).toEqual(emptySystemHead());
  });
});

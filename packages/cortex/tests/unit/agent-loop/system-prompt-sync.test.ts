/**
 * SystemPromptState.syncTranscript: how the prompt the loop wants lands in
 * the transcript pi builds requests from.
 */
import { describe, expect, it } from 'vitest';
import { getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import type { SystemMessage, Tool } from '@earendil-works/pi-ai';
import type { AgentMessage } from '../../../src/context-manager.js';
import { restoredMessage } from '../../helpers/messages.js';
import { INSTRUCTIONS_SECTION, SystemPromptState } from '../../../src/agent-loop/system-prompt.js';
import { TOOL_NAMES } from '../../../src/tools/index.js';

function createState(options: { initialPrompt?: string; tools?: string[]; workingTags?: boolean } = {}) {
  const ports = {
    tools: new Set(options.tools ?? []),
    workingTags: options.workingTags ?? false,
  };
  const state = new SystemPromptState({
    initialPrompt: () => options.initialPrompt ?? '',
    hasTool: (name) => ports.tools.has(name),
    workingTagsEnabled: () => ports.workingTags,
    workingDirectory: '/work',
  });
  return { state, ports };
}

const head = (fields: Partial<SystemMessage> = {}): AgentMessage =>
  ({ role: 'system', content: '', timestamp: 0, ...fields });
/** A tool declaration with an untyped JSON schema. */
const tool = (name: string): Tool => ({ name, description: name, parameters: { type: 'object' } }) as unknown as Tool;
const user = (content: string): AgentMessage => ({ role: 'user', content, timestamp: 1 });
const assistant = (text: string): AgentMessage =>
  restoredMessage({ role: 'assistant', content: [{ type: 'text', text }], timestamp: 2 });
/** The system message at `index`, read for its section patches. */
const sectionsAt = (transcript: AgentMessage[], index: number) =>
  (transcript[index] as SystemMessage | undefined)?.sections;

describe('SystemPromptState.syncTranscript', () => {
  it('before any answer, rebuilds the head with pi\'s first tool declarations folded in', () => {
    const { state } = createState();
    state.setBase('Base.');
    const transcript = [head(), user('slot'), head({ toolsAdded: [tool('probe')] }), user('hi')];

    expect(state.syncTranscript(transcript)).toBe(true);

    expect(transcript.map((m) => m.role)).toEqual(['system', 'user', 'user']);
    expect(transcript[0]).toMatchObject({
      content: '',
      sections: expect.objectContaining({ [INSTRUCTIONS_SECTION]: 'Base.' }),
      toolsAdded: [tool('probe')],
    });
    expect(getCurrentSystemPrompt(transcript as never)).toBe(state.current());
  });

  it('is a no-op once the transcript already declares the desired prompt', () => {
    const { state } = createState();
    state.setBase('Base.');
    const transcript = [head(), user('hi')];
    state.syncTranscript(transcript);
    const snapshot = structuredClone(transcript);

    expect(state.syncTranscript(transcript)).toBe(false);
    expect(transcript).toEqual(snapshot);
  });

  it('after an answer, appends only the changed sections and keeps the head', () => {
    const { state, ports } = createState({ tools: [TOOL_NAMES.Read] });
    state.setBase('Base.');
    const transcript = [head(), user('hi')];
    state.syncTranscript(transcript);
    transcript.push(assistant('hello'));
    const firstHead = transcript[0];

    ports.tools.add(TOOL_NAMES.Bash);
    state.refresh();
    expect(state.syncTranscript(transcript)).toBe(true);

    expect(transcript[0]).toBe(firstHead);
    const patch = transcript[transcript.length - 1]!;
    expect(patch.role).toBe('system');
    expect(Object.keys(sectionsAt(transcript, transcript.length - 1) ?? {})).toEqual(['Tool Usage']);
    expect(getCurrentSystemPrompt(transcript as never)).toBe(state.current());
  });

  it('removes a section the prompt no longer has with a null patch', () => {
    const { state, ports } = createState({ workingTags: true });
    state.setBase('Base.');
    const transcript = [head(), user('hi')];
    state.syncTranscript(transcript);
    transcript.push(assistant('hello'));

    ports.workingTags = false;
    state.refresh();
    state.syncTranscript(transcript);

    expect(sectionsAt(transcript, transcript.length - 1)).toMatchObject({ 'Response Delivery': null });
    expect(getCurrentSystemPrompt(transcript as never)).toBe(state.current());
  });

  it('writes an unwritten head in place on a restored transcript without removing messages', () => {
    const { state } = createState();
    state.setBase('Base.');
    const delta = head({ toolsAdded: [tool('probe')], timestamp: 5 });
    const transcript = [head(), user('slot'), user('hi'), assistant('hello'), delta];

    state.syncTranscript(transcript);

    // History indices (the observational watermark) must hold.
    expect(transcript.slice(1, 5)).toEqual([user('slot'), user('hi'), assistant('hello'), delta]);
    expect(sectionsAt(transcript, 0)).toMatchObject({ [INSTRUCTIONS_SECTION]: 'Base.' });
    expect(getCurrentTools(transcript as never).map((t) => t.name)).toEqual(['probe']);
    expect(getCurrentSystemPrompt(transcript as never)).toBe(state.current());
  });

  it('rewrites a free-form head, which a patch could only append to', () => {
    const { state } = createState({ initialPrompt: 'Adopted.' });
    const transcript = [head({ content: 'Adopted.' }), user('hi'), assistant('hello')];

    state.syncTranscript(transcript);

    expect(transcript[0]).toMatchObject({ content: '', sections: { [INSTRUCTIONS_SECTION]: 'Adopted.' } });
    expect(getCurrentSystemPrompt(transcript as never)).toBe('Adopted.');
  });

  it('corrects stale sections a restored history patched in', () => {
    const { state } = createState();
    state.setBase('Base.');
    const transcript = [head(), user('hi')];
    state.syncTranscript(transcript);
    transcript.push(assistant('hello'), head({ sections: { [INSTRUCTIONS_SECTION]: 'Old session.' } }));

    state.syncTranscript(transcript);

    expect(getCurrentSystemPrompt(transcript as never)).toBe(state.current());
  });
});

/**
 * A billing error renders as an "Out of credits" notice carrying the
 * provider's own sentence, not as the generic error box with the raw JSON
 * body. Billing is fatal in Cortex: nothing retries it, so the notice is the
 * only thing the user sees.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function currentHome(): string {
  const g = globalThis as { __sessionDuplexHome?: string };
  if (!g.__sessionDuplexHome) {
    g.__sessionDuplexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-duplex-home-'));
  }
  return g.__sessionDuplexHome;
}
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => currentHome() };
});

import { createPassthroughSession, destroyHarnessAgents } from './helpers/duplex-harness.js';
import type { ScriptedPi } from './helpers/duplex-harness.js';

let cwd: string;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'session-duplex-ws-'));
});

afterEach(async () => {
  await destroyHarnessAgents();
  vi.restoreAllMocks();
  fs.rmSync(cwd, { recursive: true, force: true });
});

/** Make every run fail the way pi records a provider error. */
function failRunsWith(pi: ScriptedPi, errorMessage: string): void {
  pi.prompt = async (input: unknown) => {
    pi.promptCalls.push(input);
    pi.state.messages.push({ role: 'user', content: String(input), timestamp: Date.now() });
    pi.state['errorMessage'] = errorMessage;
    pi.state.messages.push({ role: 'assistant', content: [], stopReason: 'error', errorMessage, timestamp: Date.now() });
    return undefined;
  };
}

describe('billing errors', () => {
  it("show an out-of-credits notice with the provider's sentence", async () => {
    const { app, agent, reasonerPi } = await createPassthroughSession(cwd);
    failRunsWith(
      reasonerPi,
      '402 {"error":{"message":"Insufficient credits. Add more using https://openrouter.ai/settings/credits","code":402}}',
    );

    await agent.prompt('hi').catch(() => undefined);

    expect(app.transcript['addNotification']!.mock.calls).toEqual([[
      'Out of credits',
      'Insufficient credits. Add more using https://openrouter.ai/settings/credits',
      { severity: 'error', action: 'add credits with your provider, or switch with /model' },
    ]]);
    // Billing is fatal: nothing was retried.
    expect(reasonerPi.promptCalls).toHaveLength(1);
  });
});

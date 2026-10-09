import { SelectList, type SelectItem } from '@earendil-works/pi-tui';
import { OverlayBox } from '../tui/overlay-box.js';
import { ScrollableViewer } from '../tui/scrollable-viewer.js';
import { selectListTheme } from '../tui/theme.js';
import type { Command } from './index.js';

const DEBUG_OPTIONS: SelectItem[] = [
  { value: 'obs-slot', label: 'Inspect observation slot', description: 'View activated observations in the context slot' },
  { value: 'obs-buffer', label: 'Inspect observation buffer', description: 'View buffered chunks waiting for activation' },
];

export const debugCommand: Command = {
  name: 'debug',
  description: 'Debug tools for inspecting internal state',
  handler: async (session) => {
    const agent = session.getAgent();
    const app = session.getApp();
    if (!agent || !app) return;

    const list = new SelectList(DEBUG_OPTIONS, DEBUG_OPTIONS.length, selectListTheme);
    const overlayBox = new OverlayBox(list, 'Debug Tools');
    const handle = app.tui.showOverlay(overlayBox, {
      anchor: 'center',
      width: '60%',
      maxHeight: DEBUG_OPTIONS.length + 6,
    });

    list.onSelect = (item: SelectItem) => {
      handle.hide();
      app.focusEditor();

      switch (item.value) {
        case 'obs-slot':
          showObservationSlot(session);
          break;
        case 'obs-buffer':
          showObservationBuffer(session);
          break;
      }
    };

    list.onCancel = () => {
      handle.hide();
      app.focusEditor();
    };
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function showObservationSlot(session: any): void {
  const agent = session.getAgent();
  const app = session.getApp();
  if (!agent || !app) return;

  const cm = agent.getCompactionManager();
  const slotContent = cm.memory.getSlotContent();
  const tokenCount = cm.memory.getObservationTokenCount();

  if (!slotContent) {
    app.transcript.addNotification(
      'Debug',
      'Observation slot is empty. No observations have been activated yet.',
    );
    return;
  }

  const header = `Observation Slot (${tokenCount} tokens)\n${'='.repeat(50)}\n\n`;
  const viewer = new ScrollableViewer('Observation Slot', header + slotContent, () => {
    handle.hide();
    app.focusEditor();
  });

  const handle = app.tui.showOverlay(viewer, {
    anchor: 'center',
    width: '90%',
    maxHeight: '90%',
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function showObservationBuffer(session: any): void {
  const agent = session.getAgent();
  const app = session.getApp();
  if (!agent || !app) return;

  const state = agent.getObservationalMemoryState();
  if (!state || state.bufferedChunks.length === 0) {
    app.transcript.addNotification(
      'Debug',
      'Observation buffer is empty. No chunks are waiting for activation.',
    );
    return;
  }

  const chunks = state.bufferedChunks;
  const sections: string[] = [];

  sections.push(`Observation Buffer (${chunks.length} chunk${chunks.length === 1 ? '' : 's'})`);
  sections.push('='.repeat(50));
  sections.push('');

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const createdAt = chunk.createdAt instanceof Date
      ? chunk.createdAt.toISOString()
      : String(chunk.createdAt);

    sections.push(`--- Chunk ${i + 1} ---`);
    sections.push(`Created: ${createdAt}`);
    sections.push(`Messages observed: ${chunk.messageTokensObserved} tokens`);
    sections.push('');

    if (chunk.observations) {
      sections.push('Observations:');
      sections.push(chunk.observations);
      sections.push('');
    }

    if (chunk.currentTask) {
      sections.push('Current Task:');
      sections.push(chunk.currentTask);
      sections.push('');
    }

    if (chunk.suggestedResponse) {
      sections.push('Suggested Response:');
      sections.push(chunk.suggestedResponse);
      sections.push('');
    }
  }

  const viewer = new ScrollableViewer('Observation Buffer', sections.join('\n'), () => {
    handle.hide();
    app.focusEditor();
  });

  const handle = app.tui.showOverlay(viewer, {
    anchor: 'center',
    width: '90%',
    maxHeight: '90%',
  });
}

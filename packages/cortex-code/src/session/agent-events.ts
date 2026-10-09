/**
 * Routes a CortexAgent's events and callbacks to the session's views: the
 * TUI, the activity stream and the durable transcript.
 *
 * Under duplex the bridge is merged across both resident loops and every
 * fan-out callback fires for both, so each handler decides which loop's
 * events it wants (see {@link LoopRouting}). What reaches the assistant
 * bubble is the conversation loop's alone; failure notices come from any
 * loop, because a duplicated warning beats a swallowed one.
 */

import type {
  AgentTextOutput,
  ClassifiedError,
  CortexAgent,
  CortexEvent,
  LoopOriginContext,
  MemoryErrorInfo,
  MemoryGapInfo,
  MemoryRecoveredInfo,
  ObservationEvent,
  RetryExhaustedInfo,
  RetryScheduledInfo,
  RetrySucceededInfo,
} from '@animus-labs/cortex';
import type { FileSessionActivityReporter } from '../activity/session-activity.js';
import type { SessionCheckpoints } from '../persistence/session-checkpoints.js';
import type { TranscriptWriter } from '../persistence/transcript-writer.js';
import type { App } from '../tui/app.js';
import type { TranscriptManager } from '../tui/transcript.js';
import type { AssistantStream } from './assistant-stream.js';
import type { LoopRouting } from './loop-routing.js';
import type { RetryStatusLine } from './retry-status.js';
import type { SessionStatusView } from './status-view.js';
import type { SubAgentActivity } from './sub-agent-activity.js';
import {
  wireActivityRecords,
  wireToolRows,
  type ActivityRecordPorts,
  type ToolRowApp,
  type ToolRowPorts,
} from './tool-events.js';
import type { TurnRunner } from './turn-runner.js';
import type { WorkTracker } from './work-tracker.js';

export type AgentEventApp = ToolRowApp & Pick<App, 'showStatusSpinner'> & {
  transcript: Pick<
    TranscriptManager,
    'addNotification' | 'startSubAgentCall' | 'completeSubAgentCall' | 'failSubAgentCall'
  >;
};

export interface AgentEventPorts extends ToolRowPorts, ActivityRecordPorts {
  routing: Pick<LoopRouting, 'isConversationEvent' | 'isTalkerEvent' | 'isWorkLoop'>;
  stream: Pick<AssistantStream, 'begin' | 'chunk' | 'finish'>;
  subAgents: Pick<SubAgentActivity, 'open' | 'close' | 'toolStarted' | 'toolEnded'>;
  retry: Pick<RetryStatusLine, 'noteProgress' | 'fail' | 'clear' | 'start' | 'clearFor' | 'stopFor'>;
  work: Pick<WorkTracker, 'watchForSettled' | 'begin'>;
  status: Pick<SessionStatusView, 'refreshContextUsage' | 'refreshObservationalMemory'>;
  checkpoints: Pick<SessionCheckpoints, 'record' | 'crashCheckpoint'>;
  turns: Pick<TurnRunner, 'markErrorHandled'>;
  activity: ActivityRecordPorts['activity'] & Pick<FileSessionActivityReporter, 'recordError' | 'recordWorking'>;
  transcriptWriter: ActivityRecordPorts['transcriptWriter'] &
    Pick<TranscriptWriter, 'addAssistantMessage' | 'addError' | 'addCompaction' | 'addSubAgent'>;
}

export function wireAgentEvents(agent: CortexAgent, app: AgentEventApp, ports: AgentEventPorts): void {
  const bridge = agent.getEventBridge();
  wireActivityRecords(bridge, ports);

  // Streaming response chunks
  bridge.on('response_start', (event: CortexEvent) => {
    if (event.childTaskId) return;
    if (!ports.routing.isConversationEvent(event)) return;
    ports.stream.begin();
  });

  bridge.on('response_chunk', (event: CortexEvent) => {
    // Skip child agent streaming; only parent text goes to transcript
    if (event.childTaskId) return;
    // Skip the work loop's streaming too. The merged duplex bridge carries
    // both resident loops and neither sets childTaskId, so without this
    // the reasoner's private working prose streams into the assistant
    // bubble and is then replaced by the talker's actual reply.
    if (!ports.routing.isConversationEvent(event)) return;

    // Text flowing again means a pending retry reconnected.
    ports.retry.noteProgress();

    ports.stream.chunk(event.data as Record<string, unknown> | undefined);
  });

  wireToolRows(bridge, app, ports);

  // Turn complete (finalize assistant message). onTurnComplete fires once per
  // LLM turn with the final user-facing text already assembled (working tags
  // stripped), so it is the clean source for the durable transcript's
  // assistant_message record. We record here rather than on the raw `turn_end`
  // bridge event to avoid re-accumulating streamed response_chunks.
  agent.onTurnComplete((output: AgentTextOutput) => {
    ports.stream.finish(output.userFacing);
    ports.transcriptWriter.addAssistantMessage(output.userFacing);
  });

  // A loop finished. Not "the agent is idle": this callback is registered
  // on every resident loop and carries no origin, so under duplex the
  // talker's sub-second turn fires it while the reasoner is minutes from
  // done. Only the cheap per-loop refresh happens here; the end-of-work
  // UI waits for the facade's settlement predicate.
  agent.onLoopComplete(() => {
    ports.status.refreshContextUsage();
    ports.work.watchForSettled();
  });

  // Persistence trigger. Debounced by the facade and fired with a
  // consistent composite snapshot (log plus both loops' histories and
  // memory), which is why autosave hangs off this rather than off
  // onLoopComplete and turn_end: those fire per loop and per turn, so one
  // exchange used to write the session out three times, each time from a
  // reasoner-only read that under duplex would silently drop the user's
  // actual dialogue.
  agent.onStateChanged((state) => {
    ports.checkpoints.record(state);
  });

  // Error handling with per-category display
  agent.onError((error: ClassifiedError) => {
    void ports.activity.recordError(error, error.severity === 'fatal');
    // The framework emits here and then re-throws out of prompt(); mark the
    // failure handled so the prompt() catch does not render it a second time.
    ports.turns.markErrorHandled();
    // Record the failure in the durable transcript so a turn that errored
    // before completing is visible, cause chain included. Skip user aborts.
    if (error.category !== 'cancelled') {
      const transcriptMessage = error.causeDetail
        ? `${error.originalMessage ?? String(error)} (${error.causeDetail})`
        : (error.originalMessage ?? String(error));
      ports.transcriptWriter.addError(transcriptMessage, error.category);
    }
    switch (error.category) {
      // Transient categories are managed by the background retry engine. When
      // onError fires for one of these, retries are over (exhausted or
      // disabled): collapse to a compact terminal line instead of a box.
      case 'network':
      case 'server_error':
      case 'rate_limit': {
        ports.retry.fail(error.causeDetail);
        break;
      }
      case 'authentication':
        // The OAuth mechanics ("Failed to refresh token") are jargon and
        // already in the durable transcript; the user just needs the fix.
        ports.retry.clear();
        app.transcript.addNotification('Authentication expired', '', {
          severity: 'error',
          action: 'run /login to reconnect',
        });
        break;
      case 'context_overflow':
        ports.retry.clear();
        app.transcript.addNotification('Context limit reached', '', {
          severity: 'error',
          action: 'use /context-window or /clear',
        });
        break;
      case 'cancelled':
        // User-initiated abort; drop any pending retry line, no notification.
        ports.retry.clear();
        break;
      default:
        ports.retry.clear();
        app.transcript.addNotification(
          error.originalMessage ?? String(error),
          error.causeDetail ?? '',
          { severity: 'error' },
        );
    }
  });

  // Background retry lifecycle: drive the compact, in-place status line.
  // Every one of these is registered on both resident loops, so each keys
  // on the origin: the line has one slot and two possible owners.
  agent.onRetryScheduled((info: RetryScheduledInfo, origin: LoopOriginContext) => {
    ports.retry.start(info, origin.loopPath);
  });
  agent.onRetrySucceeded((_info: RetrySucceededInfo, origin: LoopOriginContext) => {
    ports.retry.clearFor(origin.loopPath);
  });
  agent.onRetryExhausted((_info: RetryExhaustedInfo, origin: LoopOriginContext) => {
    // The matching fatal onError fires right after and renders the terminal
    // 'failed' line; just stop the countdown here.
    ports.retry.stopFor(origin.loopPath);
  });

  // Observational memory events. The work loop's only: the footer they
  // refresh reads the reasoner's context window and compaction manager, so
  // a talker swap would announce numbers that do not correspond to anything
  // the user can see, about a context they do not own.
  agent.onObservation((event: ObservationEvent, origin: LoopOriginContext) => {
    if (!ports.routing.isWorkLoop(origin)) return;
    if (event.removedMessages.length > 0) {
      // Mark in the durable transcript where messages left context for
      // memory. The full turns remain earlier in this transcript.
      ports.transcriptWriter.addCompaction({
        reason: event.trigger,
        beforeTokens: event.tokensBefore,
        afterTokens: event.tokensAfter,
      });
      ports.status.refreshContextUsage();
    }
    ports.status.refreshObservationalMemory();
  });
  agent.onReflection((_event, origin: LoopOriginContext) => {
    if (!ports.routing.isWorkLoop(origin)) return;
    ports.status.refreshObservationalMemory();
  });

  // Memory health, for ANY loop: a talker whose memory fails is a
  // conversation about to lose detail, and a duplicated warning beats a
  // swallowed one. One notice per degraded episode: the call that starts it says so, the
  // first success after it says it is over, and the failures between
  // repeat nothing the user does not already know.
  agent.onMemoryError((info: MemoryErrorInfo, origin: LoopOriginContext) => {
    if (info.consecutiveFailures !== 1) return;
    app.transcript.addNotification(
      `Memory model failing${loopSuffix(origin)}`,
      `${info.error.message}. Nothing is lost: recent messages stay in context until memory records them.`,
      { severity: 'warning' },
    );
  });
  agent.onMemoryRecovered((info: MemoryRecoveredInfo, origin: LoopOriginContext) => {
    app.transcript.addNotification(
      `Memory model recovered${loopSuffix(origin)}`,
      `After ${info.failures} failed ${info.failures === 1 ? 'call' : 'calls'}.`,
      { severity: 'info' },
    );
  });
  agent.onMemoryGap((info: MemoryGapInfo, origin: LoopOriginContext) => {
    app.transcript.addNotification(
      `Memory gap${loopSuffix(origin)}`,
      `${info.droppedMessages} messages left the context before memory recorded them (${info.reason}).`,
      { severity: 'warning' },
    );
    ports.status.refreshObservationalMemory();
  });

  /** Which loop a duplex notice is about; nothing for the work loop. */
  function loopSuffix(origin: LoopOriginContext): string {
    return ports.routing.isWorkLoop(origin) ? '' : ' (conversation)';
  }

  // Sub-agent events: rendered as tool calls via the SubAgent renderer
  agent.onSubAgentSpawned((taskId, instructions, background) => {
    ports.subAgents.open(taskId);
    ports.transcriptWriter.addSubAgent(taskId, 'spawned', { summary: instructions, background });
    app.transcript.startSubAgentCall(taskId, {
      instructions,
      background,
      modelId: agent.getModel().modelId,
    });
  });

  agent.onSubAgentCompleted((taskId, result, status, usage) => {
    ports.transcriptWriter.addSubAgent(taskId, 'completed', { summary: result });
    app.transcript.completeSubAgentCall(taskId, result, status, usage);
    ports.subAgents.close(taskId);
  });

  agent.onSubAgentFailed((taskId, error) => {
    ports.transcriptWriter.addSubAgent(taskId, 'failed', { error });
    app.transcript.failSubAgentCall(taskId, error);
    ports.subAgents.close(taskId);
  });

  // Background sub-agent result delivery: Cortex restarts the agentic loop
  // automatically; update TUI state so the user sees activity.
  agent.onBackgroundResultDelivery(() => {
    ports.work.begin();
    app.showStatusSpinner('Processing background results...');
    void ports.activity.recordWorking();
  });

  // Update tokens on turn_end (fires after each LLM turn, including
  // mid-loop turns between tool calls), and take a crash-recovery
  // checkpoint. onStateChanged is the authoritative persistence trigger,
  // but it cannot fire during a long task, so it is not on its own enough
  // to keep one on disk. A child's turn boundary says nothing about the
  // parent's history, so children are skipped.
  bridge.on('turn_end', (event: CortexEvent) => {
    ports.status.refreshContextUsage();
    ports.status.refreshObservationalMemory();
    if (event.childTaskId) return;
    ports.checkpoints.crashCheckpoint();
  });
}

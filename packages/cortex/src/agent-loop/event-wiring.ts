/**
 * The loop's own subscriptions on its EventBridge: diagnostics, usage
 * accounting, context-size tracking for compaction, and the onLoopComplete
 * / onTurnComplete fan-out.
 *
 * Registered before the budget guard wires itself, so these listeners see
 * each event first (listener order is registration order).
 */

import type { AgentMessage } from '../context-manager.js';
import type { CompactionManager } from '../compaction/index.js';
import { payloadOf } from '../event-bridge.js';
import type { EventBridge } from '../event-bridge.js';
import { turnInputTokens } from '../pi-message.js';
import type { PromptWatchdogDiagnostics } from '../prompt-diagnostics.js';
import type {
  AgentTextOutput,
  CortexLogger,
  LoopOriginContext,
} from '../types.js';
import type { HandlerList } from './handler-list.js';
import type { LoopUsage } from './loop-usage.js';

export interface LoopEventDeps {
  logger: CortexLogger;
  diagnostics: Pick<PromptWatchdogDiagnostics, 'recordEvent'>;
  ledger: LoopUsage;
  /** pi's live state: the transcript plus the error of the run that just ended. */
  agentState(): { messages: AgentMessage[]; errorMessage?: unknown };
  /** Index of the first history message (past the system head and slots). */
  historyStart(): number;
  /** Resolved per event: the manager is built after the wiring. */
  compaction(): CompactionManager;
  effectiveContextWindow(): number;
  /** Budget figures for the loop_end log line. */
  budgetSummary(): { turns: number; totalCost: number };
  /** A logical turn ended: per-loop state that lives for one turn resets. */
  onLoopEnd(): void;
  loopComplete: HandlerList<[LoopOriginContext]>;
  turnComplete: HandlerList<[AgentTextOutput, LoopOriginContext]>;
  origin: LoopOriginContext;
}

/** Subscribe the loop's internal listeners; returns their unsubscribe. */
export function wireLoopEvents(bridge: EventBridge, deps: LoopEventDeps): () => void {
  const { logger, ledger } = deps;
  const unsubscribers: Array<() => void> = [];

  unsubscribers.push(
    bridge.onAll((event) => {
      deps.diagnostics.recordEvent(event);
    }),
  );

  // Direct/utility spend, this loop's and forwarded children's alike.
  unsubscribers.push(
    bridge.on('utility_usage', (event) => {
      const usage = event.usage;
      if (!usage) return;
      const category = payloadOf(event, 'utility_usage')?.category ?? 'utility';

      ledger.recordUtility(category, usage);

      logger.debug('utility usage', {
        category,
        cost: usage.cost.total,
        input: usage.input,
        output: usage.output,
        childTaskId: event.childTaskId,
        sessionTotalCost: ledger.totalCost,
      });
    }),
  );

  unsubscribers.push(
    bridge.on('loop_end', () => {
      // pi ends every run with agent_end, failed ones included, and a retried
      // turn spans several runs. onLoopComplete fires once per logical turn,
      // so a failed attempt must not let a consumer mark the turn idle while
      // a retry is pending. A final failure surfaces via onError instead.
      if (deps.agentState().errorMessage) {
        logger.info('loop_end suppressed (run ended in error; retry may follow)');
        return;
      }
      const budget = deps.budgetSummary();
      logger.info('loop_end', {
        turns: budget.turns,
        totalCost: budget.totalCost,
        currentContextTokens: deps.compaction().currentContextTokenCount,
      });
      deps.onLoopEnd();
      deps.loopComplete.emit(deps.origin);
    }),
  );

  unsubscribers.push(
    bridge.on('turn_end', (event) => {
      const isChildEvent = Boolean(event.childTaskId);

      // Stamp pi's new messages for observational memory.
      if (!isChildEvent) {
        const now = Date.now();
        const messages = deps.agentState().messages;
        for (let i = deps.historyStart(); i < messages.length; i++) {
          const msg = messages[i];
          if (msg && msg.timestamp == null) {
            msg.timestamp = now;
          }
        }
      }

      // Context size tracks this loop's own turns only; raw event data is
      // the fallback when partial usage could not be typed.
      const usage = event.usage;
      if (!isChildEvent) {
        const inputTokens = usage
          ? usage.input + usage.cacheRead + usage.cacheWrite
          : turnInputTokens(event.data);
        const compaction = deps.compaction();
        if (inputTokens > 0) {
          compaction.updateCurrentContextTokenCount(inputTokens);
        }
        if ((usage || inputTokens > 0) && compaction.strategy === 'observational') {
          compaction.onTurnEnd(
            inputTokens,
            deps.effectiveContextWindow(),
            deps.agentState().messages,
            deps.historyStart(),
          );
        }
      }

      // Session usage accumulates parent and forwarded child turns alike.
      if (usage) {
        ledger.recordTurn(usage);
        logger.debug('turn_end usage', {
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cacheRead,
          cost: usage.cost.total,
          sessionTotalCost: ledger.totalCost,
          childTaskId: event.childTaskId,
        });
      } else if (!isChildEvent) {
        ledger.recordUnmeteredTurn();
      }

      // Forwarded child turns never reach onTurnComplete (raw sub-agent
      // text would leak into the parent's chat).
      if (!isChildEvent && event.textOutput) {
        deps.turnComplete.emit(event.textOutput, deps.origin);
      }
    }),
  );

  return () => {
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  };
}

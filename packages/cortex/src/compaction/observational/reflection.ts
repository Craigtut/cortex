/**
 * When and how the observation log is condensed.
 *
 * Below half the reflection threshold nothing happens. From half the
 * threshold a reflector runs in the background. At the threshold a
 * buffered reflection swaps in if one is ready; otherwise the reflector
 * runs while the caller waits, or, under the non-blocking posture, in the
 * background. A failed or stale reflection keeps the current log.
 */

import type { CompleteFn } from '../compaction.js';
import type { BufferingCoordinator } from './buffering.js';
import { MemoryCallError } from './calls.js';
import type { CallPolicy } from './calls.js';
import type { MemoryHealth } from './health.js';
import type { ObservationLog } from './log.js';
import { computeEffectiveReflectionThreshold, runReflector } from './reflector.js';
import type { ReflectionEvent, ReflectorOutput } from './types.js';

export interface ReflectionPorts {
  log: ObservationLog;
  buffering: BufferingCoordinator;
  health: MemoryHealth;
  completeFn(): CompleteFn | null;
  policy(): CallPolicy;
  /** The effective reflection threshold's inputs. */
  windows(): { contextWindow: number; utilityModelContextWindow: number };
  config(): { reflectionThreshold: number; reflectionBufferActivation: number; reflectorInstruction?: string };
  logger(): { warn: (msg: string) => void } | null;
}

export class Reflection {
  private readonly handlers: Array<(event: ReflectionEvent) => void> = [];

  constructor(private readonly ports: ReflectionPorts) {}

  onReflection(handler: (event: ReflectionEvent) => void): void {
    this.handlers.push(handler);
  }

  /**
   * Reflect if the log is due.
   *
   * @param allowSync - false under the non-blocking posture: a buffered
   *   reflection still swaps in, but the reflector never runs while the
   *   caller waits
   * @param isStale - a stale pass applies its work but reports no event
   * @param signal - ends a waited-on reflection
   */
  async reflectIfDue(allowSync: boolean, isStale?: () => boolean, signal?: AbortSignal): Promise<void> {
    const { log, buffering } = this.ports;
    const completeFn = this.ports.completeFn();
    if (!completeFn) return;

    const { contextWindow, utilityModelContextWindow } = this.ports.windows();
    const config = this.ports.config();
    const threshold = computeEffectiveReflectionThreshold(
      contextWindow,
      config.reflectionThreshold,
      utilityModelContextWindow,
    );
    const action = buffering.shouldReflect(log.tokenCount, threshold, config.reflectionBufferActivation);
    if (action === 'none') return;

    if (action === 'async') {
      buffering.launchReflector(completeFn, log.text, this.reflectorConfig(threshold), this.ports.logger() ?? undefined);
      return;
    }

    const previousObservations = log.text;

    // A buffered reflection condensed the log as it was when the reflector
    // launched; what was appended since stays.
    const buffered = buffering.consumeBufferedReflection();
    if (buffered && log.reflect(buffered.input, buffered.observations)) {
      // Suppressed for an abandoned pass: the swap-in keeps the engine
      // coherent, but the event must not report it as landed work.
      if (!isStale?.()) this.fire(previousObservations, buffered.compressionLevel);
      return;
    }

    // None ready. Under the non-blocking posture the inline call is
    // forbidden: launch (or keep) a background reflector instead.
    if (!allowSync) {
      if (!buffering.isReflectorInFlight()) {
        buffering.launchReflector(completeFn, log.text, this.reflectorConfig(threshold), this.ports.logger() ?? undefined);
      }
      return;
    }

    // Run while the caller waits. A failed reflection keeps the current
    // log: it is larger than ideal, which costs tokens, not memory.
    const input = log.text;
    let output: ReflectorOutput;
    try {
      output = await runReflector(completeFn, input, this.reflectorConfig(threshold), {
        policy: this.ports.policy(),
        ...(signal ? { signal } : {}),
      });
      this.ports.health.succeeded();
    } catch (err) {
      this.recordFailure(err);
      return;
    }
    if (!log.reflect(input, output.observations)) return;
    if (!isStale?.()) this.fire(previousObservations, output.compressionLevel);
  }

  private recordFailure(err: unknown): void {
    const error = err instanceof MemoryCallError ? err.lastError : err instanceof Error ? err : new Error(String(err));
    this.ports.logger()?.warn(`Reflector call failed (activation): ${error.message}`);
    if (err instanceof MemoryCallError && err.aborted) return;
    this.ports.health.failed({
      operation: 'reflect',
      trigger: 'activation',
      error,
      attempts: err instanceof MemoryCallError ? err.attempts : 1,
    });
  }

  /** The reflector config (no undefined optional fields: exactOptionalPropertyTypes). */
  private reflectorConfig(threshold: number): { reflectionThreshold: number; reflectorInstruction?: string } {
    const instruction = this.ports.config().reflectorInstruction;
    return instruction !== undefined
      ? { reflectionThreshold: threshold, reflectorInstruction: instruction }
      : { reflectionThreshold: threshold };
  }

  private fire(previousObservations: string, compressionLevel: number): void {
    const event: ReflectionEvent = {
      previousObservations,
      newObservations: this.ports.log.text,
      generationCount: this.ports.log.generationCount,
      compressionLevel,
      timestamp: new Date(),
    };
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (err) {
        this.ports.logger()?.warn(`Reflection handler threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

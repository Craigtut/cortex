/**
 * When and how the observation log is condensed.
 *
 * Below half the reflection threshold nothing happens. From half the
 * threshold a reflector runs in the background. At the threshold a
 * buffered reflection swaps in if one is ready; otherwise the reflector
 * runs while the caller waits, or, under the non-blocking posture, in the
 * background. A failed or stale reflection keeps the current log.
 */

import type { CompleteFn } from './types.js';
import type { BufferingCoordinator } from './buffering.js';
import { MemoryCallError } from './calls.js';
import type { CallPolicy } from './calls.js';
import type { MemoryCallTrigger, MemoryHealth } from './health.js';
import type { ObservationLog } from './log.js';
import { computeEffectiveReflectionThreshold, runReflector } from './reflector.js';
import type { ReflectionEvent, ReflectionOutcome, ReflectorOutput } from './types.js';

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
   * @param pass.allowSync - false under the non-blocking posture: a
   *   buffered reflection still swaps in, but the reflector never runs
   *   while the caller waits
   * @param pass.isStale - a stale pass applies its work but reports no event
   * @param pass.signal - ends a waited-on reflection
   * @param pass.trigger - what the pass is, for failure reports
   */
  async reflectIfDue(pass: {
    allowSync: boolean;
    isStale?: () => boolean;
    signal?: AbortSignal;
    trigger: MemoryCallTrigger;
  }): Promise<ReflectionOutcome> {
    const { allowSync, isStale, signal } = pass;
    const { log, buffering } = this.ports;
    const completeFn = this.ports.completeFn();
    if (!completeFn) return { status: 'not-due' };

    const { contextWindow, utilityModelContextWindow } = this.ports.windows();
    const config = this.ports.config();
    const threshold = computeEffectiveReflectionThreshold(
      contextWindow,
      config.reflectionThreshold,
      utilityModelContextWindow,
    );
    const action = buffering.shouldReflect(log.tokenCount, threshold, config.reflectionBufferActivation);
    if (action === 'none') return { status: buffering.isReflectorInFlight() ? 'in-background' : 'not-due' };

    if (action === 'async') {
      buffering.launchReflector(completeFn, log.text, this.reflectorConfig(threshold), this.ports.logger() ?? undefined);
      return { status: 'in-background' };
    }

    const previousObservations = log.text;

    // A buffered reflection condensed the log as it was when the reflector
    // launched; what was appended since stays.
    const buffered = buffering.consumeBufferedReflection();
    if (buffered && log.reflect(buffered.input, buffered.observations)) {
      // Suppressed for an abandoned pass: the swap-in keeps the engine
      // coherent, but the event must not report it as landed work.
      if (!isStale?.()) this.fire(previousObservations, buffered.compressionLevel);
      return { status: 'reflected' };
    }

    // None ready. Under the non-blocking posture the inline call is
    // forbidden: launch (or keep) a background reflector instead.
    if (!allowSync) {
      if (!buffering.isReflectorInFlight()) {
        buffering.launchReflector(completeFn, log.text, this.reflectorConfig(threshold), this.ports.logger() ?? undefined);
      }
      return { status: 'in-background' };
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
      return { status: 'failed', error: this.recordFailure(pass.trigger, err) };
    }
    if (!log.reflect(input, output.observations)) {
      return { status: 'failed', error: new Error('The log was replaced while the reflector ran') };
    }
    if (!isStale?.()) this.fire(previousObservations, output.compressionLevel);
    return { status: 'reflected' };
  }

  private recordFailure(trigger: MemoryCallTrigger, err: unknown): Error {
    const error = err instanceof MemoryCallError ? err.lastError : err instanceof Error ? err : new Error(String(err));
    this.ports.logger()?.warn(`Reflector call failed (${trigger}): ${error.message}`);
    if (err instanceof MemoryCallError && err.aborted) return error;
    this.ports.health.failed({
      operation: 'reflect',
      trigger,
      error,
      attempts: err instanceof MemoryCallError ? err.attempts : 1,
    });
    return error;
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

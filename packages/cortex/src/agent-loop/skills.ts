/**
 * The loop's skill system binding (skill-system.md): the registry, the
 * load_skill tool whose description advertises it, and the buffer of
 * loaded skill bodies the context pipeline injects at the history
 * boundary. The buffer lives for one logical turn; the consumer may also
 * clear it at its own work-unit boundaries.
 */

import type { SandboxProvider } from '../sandbox/types.js';
import { SkillRegistry } from '../skill-registry.js';
import { buildLoadSkillDescription, createLoadSkillTool } from '../skill-tool.js';
import type { CortexLogger, LoadedSkill } from '../types.js';
import type { RegisteredTool } from './pi-agent.js';

export interface SkillBindingPorts {
  /** The context window the available-skills summary is budgeted against. */
  contextWindow(): number;
  /** Re-sync pi's tool list (it holds shallow copies of each tool). */
  refreshTools(): void;
  logger: CortexLogger;
  /** The loop's OS sandbox, which skill shell markers spawn through. */
  sandbox?: SandboxProvider | undefined;
}

type LoadSkillTool = ReturnType<typeof createLoadSkillTool>;

export class SkillBinding {
  readonly registry: SkillRegistry;
  private loadSkillTool: LoadSkillTool | null = null;
  private buffer: LoadedSkill[] = [];

  constructor(private readonly ports: SkillBindingPorts) {
    this.registry = new SkillRegistry(undefined, { sandbox: ports.sandbox });
    this.registry.addChangeListener(() => this.rebuildDescription());
  }

  /** Create the load_skill tool (at most one per loop). */
  createLoadSkillTool(): RegisteredTool {
    this.loadSkillTool = createLoadSkillTool({
      registry: this.registry,
      getAvailableSkillsSummary: () => this.availableSkillsSummary(),
      getSkillBuffer: () => this.buffer,
      pushToSkillBuffer: (skill) => this.push(skill),
    });
    return this.loadSkillTool as RegisteredTool;
  }

  /** Rebuild load_skill's description when skills or the context window change. */
  rebuildDescription(): void {
    if (this.loadSkillTool) {
      this.loadSkillTool.description = buildLoadSkillDescription(
        this.registry,
        this.availableSkillsSummary(),
      );
      // pi holds shallow copies, so the new description needs a re-sync.
      this.ports.refreshTools();
    }
  }

  /** Load a skill's body into the buffer, as the load_skill tool would. */
  async load(name: string, args?: string): Promise<void> {
    const callArgs = {
      args: args ? args.split(/\s+/) : [],
      rawArgs: args ?? '',
    };

    const body = await this.registry.getSkillBody(name, callArgs);
    this.push({ name, content: body });
  }

  /** Loading the same skill twice replaces the first. */
  push(skill: LoadedSkill): void {
    const existingIdx = this.buffer.findIndex(s => s.name === skill.name);
    if (existingIdx >= 0) {
      this.buffer[existingIdx] = skill;
    } else {
      this.buffer.push(skill);
    }
    this.ports.logger.info('skill loaded', {
      name: skill.name,
      contentLength: skill.content.length,
      bufferSize: this.buffer.length,
    });
  }

  get loadedCount(): number {
    return this.buffer.length;
  }

  clear(): void {
    this.buffer = [];
  }

  snapshot(): LoadedSkill[] {
    return [...this.buffer];
  }

  /** The buffer as one injected message body, or null when it is empty. */
  renderInjection(): string | null {
    if (this.buffer.length === 0) return null;
    return this.buffer.map(s =>
      `<skill-instructions name="${s.name}">\n${s.content}\n</skill-instructions>`,
    ).join('\n\n');
  }

  destroy(): void {
    this.buffer = [];
    this.registry.clear();
  }

  private availableSkillsSummary(): string {
    const maxTokens = Math.max(128, Math.floor(this.ports.contextWindow() * 0.02));
    return this.registry.getAvailableSkillsSummary(maxTokens);
  }
}

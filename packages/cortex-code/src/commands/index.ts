import { fuzzyFilter } from '@earendil-works/pi-tui';
import type { Session } from '../session.js';
import { helpCommand } from './help.js';
import { clearCommand } from './clear.js';
import { compactCommand } from './compact.js';
import { modelCommand, providerCommand, utilityModelCommand } from './model.js';
import { costCommand } from './cost.js';
import { contextWindowCommand } from './context-window.js';
import { resumeCommand, resumeAllCommand } from './resume.js';
import { loginCommand } from './login.js';
import { logoutCommand } from './logout.js';
import { yoloCommand } from './yolo.js';
import { effortCommand } from './effort.js';
import { exitCommand } from './exit.js';
import { debugCommand } from './debug.js';
import { updateCommand } from './update.js';
import { mcpReloadCommand } from './mcp-reload.js';
import { sandboxCommand } from './sandbox.js';
import { statusCommand } from './status.js';

/**
 * The part of the session slash commands reach. Picked from Session itself
 * (a type-only import, so no runtime cycle with session.ts), so a reshaped
 * Session surface fails typecheck in the command that relies on it.
 */
export type CommandSession = Pick<Session,
  | 'getAgent'
  | 'getAgentMode'
  | 'getApp'
  | 'getCredentialStore'
  | 'getCwd'
  | 'getEffectiveEffort'
  | 'getModelId'
  | 'getNetworkGrantInfo'
  | 'getProvider'
  | 'getProviderManager'
  | 'getResolutionReport'
  | 'getSandboxPolicy'
  | 'getSandboxRung'
  | 'getSandboxStatus'
  | 'getYoloMode'
  | 'isSandboxConfigEnabled'
  | 'promptForUpdate'
  | 'resetTitle'
  | 'resetUtilityModel'
  | 'resume'
  | 'runCancellable'
  | 'setPreferredEffort'
  | 'setSandboxRung'
  | 'setUtilityModel'
  | 'setYoloMode'
  | 'shutdown'
  | 'switchModel'
  | 'switchProvider'
  | 'triggerMcpReload'
>;

/**
 * `args` carries whitespace-split tokens after the command name (e.g.
 * "/sandbox off" -> ['off']); handlers that take no arguments ignore it.
 */
export type CommandHandler = (session: CommandSession, args: string[]) => Promise<void> | void;

export interface Command {
  name: string;
  description: string;
  handler: CommandHandler;
}

const commands = new Map<string, Command>();

export function registerCommand(command: Command): void {
  commands.set(command.name, command);
}

export function getCommand(name: string): Command | undefined {
  return commands.get(name);
}

export function getCommands(): Command[] {
  return [...commands.values()];
}

/**
 * Filter commands using pi-tui's fuzzyFilter.
 * Returns commands whose names fuzzy-match the query, sorted by score.
 */
export function fuzzyFilterCommands(query: string): Command[] {
  if (!query) return getCommands();

  const all = getCommands();
  return fuzzyFilter(all, query, (cmd) => cmd.name);
}

/**
 * Register all built-in commands.
 * Called once at startup.
 */
export function registerBuiltinCommands(): void {
  registerCommand(helpCommand);
  registerCommand(clearCommand);
  registerCommand(compactCommand);
  registerCommand(modelCommand);
  registerCommand(providerCommand);
  registerCommand(utilityModelCommand);
  registerCommand(costCommand);
  registerCommand(statusCommand);
  registerCommand(contextWindowCommand);
  registerCommand(resumeCommand);
  registerCommand(resumeAllCommand);
  registerCommand(loginCommand);
  registerCommand(logoutCommand);
  registerCommand(yoloCommand);
  registerCommand(effortCommand);
  registerCommand(exitCommand);
  registerCommand(debugCommand);
  registerCommand(updateCommand);
  registerCommand(mcpReloadCommand);
  registerCommand(sandboxCommand);
}

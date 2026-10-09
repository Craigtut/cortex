/**
 * Application-side bindings the consumer guide's examples reference.
 *
 * Cortex does not provide any of these: they stand in for the credential
 * store, UI, and persistence layer a consumer brings. They are declared, never
 * defined, because the harness only typechecks.
 *
 * **Every type here is real.** Do not widen one to make an example compile. A
 * stub typed `any` turns the harness green against an example that would not
 * work for a reader, which is the failure this harness exists to catch, moved
 * somewhere harder to see. An example that cannot compile against an honest
 * type is a finding about the example.
 */
import type {
  AgentMessage,
  ContextManager,
  CortexAgent,
  CortexAgentPersistedState,
  CortexAgentStateV2,
  CortexModel,
  CortexToolPermissionResult,
  CredentialStore,
  PersistResultFn,
  ProviderManager,
  SessionLogEntry,
  SessionLogGap,
} from '@animus-labs/cortex';

// --- The agent and its inputs ----------------------------------------------

export declare const agent: CortexAgent;
export declare const model: CortexModel;

/**
 * Bindings an earlier example in the guide established. Each block compiles in
 * its own scope, so a block that continues from a previous one (the OAuth
 * examples reuse `providers`; the ephemeral-context example reuses `context`)
 * needs them declared. Real types, so the continuation is checked too.
 */
export declare const providers: ProviderManager;
export declare const context: ContextManager;
export declare const workingDirectory: string;
export declare const initialBasePrompt: string;
export declare const apiKey: string;
export declare const config: Parameters<typeof CortexAgent.create>[0];

// --- Credential storage -----------------------------------------------------

/** The consumer's own storage, behind pi's credential store interface. */
export declare const credentialStore: CredentialStore;

/**
 * The plain "give me a key" path, for the minimal example. Deliberately a
 * separate helper from `credentialStore`: the guide once used one name for
 * both a bare string and a discriminated credential union, which no single
 * real implementation can satisfy.
 */
export declare function loadApiKey(provider: string): Promise<string | null>;

// --- OAuth UI callbacks -----------------------------------------------------

export declare function openBrowser(url: string): void;
export declare function showInstructions(instructions: string): void;
export declare function promptUser(message: string, placeholder?: string): Promise<string>;
export declare function showStatus(message: string): void;
export declare function chooseOption(
  message: string,
  options: Array<{ id: string; label: string }>,
): Promise<string>;

// --- Timeline rendering -----------------------------------------------------

export declare const lastSeenSeq: number;
export declare function renderTimeline(entry: SessionLogEntry): void;
export declare function noteMissing(fromSeq: number, toSeq: number, dropped: number): void;
export declare function replaceTimeline(entries: SessionLogEntry[], gaps: SessionLogGap[]): void;
export declare function resyncFrom(seq: number): void;

// --- Persistence ------------------------------------------------------------

export declare const saved: CortexAgentPersistedState;
export declare function saveSession(state: CortexAgentStateV2): Promise<void>;
export declare function buildCurrentAppConfig(): string;
export declare const writeToolResultFile: PersistResultFn;

// --- Streaming and status UI ------------------------------------------------

export declare function speak(text: string): void;
export declare function render(event: unknown): void;
export declare function showTypingIndicator(): void;
export declare function showSpinner(taskIds: string[]): void;
export declare function notifyUser(message: string): void;

// --- Permissions ------------------------------------------------------------

export declare function askForApproval(
  toolName: string,
  args: unknown,
  options: { dismissOn?: AbortSignal | undefined },
): Promise<CortexToolPermissionResult>;
export declare function isAllowedPath(args: unknown): boolean;

// --- Consumer tools and skills ---------------------------------------------

export declare function loadProject(id: string): Promise<unknown>;
export declare const currentUser: { id: string };

// --- Direct completion inputs ----------------------------------------------

export declare const styleGuide: string;
export declare const repoConventions: string;
export declare const reviewTurns: AgentMessage[];
export declare const queue: { length: number };

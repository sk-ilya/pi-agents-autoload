/**
 * Test harness: a real AgentSession wired to a scripted faux model.
 *
 * The extension under test is loaded from `index.ts` through Pi's own
 * extension loader, and native context files (root AGENTS.md) come from Pi's
 * `loadProjectContextFiles`, so tests exercise the real integration paths.
 * Only the provider is faked: the stream function records every request's
 * transcript and replays scripted assistant responses.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  JsonObject,
  Model,
  SimpleStreamOptions,
  ToolCall,
  TranscriptContext,
  Usage,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  AgentSession,
  discoverAndLoadExtensions,
  type ExtensionError,
  type ExtensionRunner,
  type ExtensionUIContext,
  type LoadExtensionsResult,
  loadProjectContextFiles,
  ModelRuntime,
  type ResourceLoader,
  SessionManager,
  type SessionStartEvent,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const FAUX_API = "anthropic-messages" as const;
const FAUX_PROVIDER = "faux";
const FAUX_MODEL_ID = "faux-1";

export const EXTENSION_PATH = fileURLToPath(new URL("../index.ts", import.meta.url));
export const COMPACTION_HELPER_PATH = fileURLToPath(
  new URL("./compaction-helper.ts", import.meta.url),
);

/** The faux model is API-generic; the harness never inspects the API type. */
type AnyModel =
  // biome-ignore lint/suspicious/noExplicitAny: the scripted stream accepts any model API
  Model<any>;

export function fauxModel(options?: {
  id?: string;
  supportsMidConvoSystemMessages?: boolean;
  contextWindow?: number;
}): Model<typeof FAUX_API> {
  return {
    id: options?.id ?? FAUX_MODEL_ID,
    name: "Faux Model",
    api: FAUX_API,
    provider: FAUX_PROVIDER,
    baseUrl: "http://localhost:0",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: options?.contextWindow ?? 128000,
    maxTokens: 16384,
    ...(options?.supportsMidConvoSystemMessages === undefined
      ? {}
      : { compat: { supportsMidConvoSystemMessages: options.supportsMidConvoSystemMessages } }),
  };
}

const FAUX_USAGE: Usage = {
  input: 100,
  output: 50,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 150,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function assistantText(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: FAUX_API,
    provider: FAUX_PROVIDER,
    model: FAUX_MODEL_ID,
    usage: FAUX_USAGE,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

export function assistantToolCalls(
  calls: Array<{ name: string; args: JsonObject }>,
): AssistantMessage {
  const content: ToolCall[] = calls.map((call, index) => ({
    type: "toolCall",
    id: `faux_tc_${index + 1}`,
    name: call.name,
    arguments: call.args,
  }));
  return {
    role: "assistant",
    content,
    api: FAUX_API,
    provider: FAUX_PROVIDER,
    model: FAUX_MODEL_ID,
    usage: FAUX_USAGE,
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

export type ResponseStep = AssistantMessage;

export interface FauxStreamState {
  /** The transcript sent to every provider request, in order. */
  requests: TranscriptContext[];
}

export function createScriptedStream(responses: ResponseStep[]): {
  streamFn: (
    model: AnyModel,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
  ) => ReturnType<typeof createAssistantMessageEventStream>;
  state: FauxStreamState;
} {
  const state: FauxStreamState = { requests: [] };
  const streamFn = (_model: AnyModel, context: TranscriptContext) => {
    state.requests.push(context);
    const message = responses[Math.min(state.requests.length - 1, responses.length - 1)];
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const reason = (message.stopReason ?? "stop") as "stop" | "toolUse" | "length" | "deferred";
      stream.push({ type: "done", reason, message });
    });
    return stream;
  };
  return { streamFn, state };
}

/** Load the extension under test (and optionally the canned-compaction helper). */
export async function loadTestExtensions(options: {
  cwd: string;
  agentDir: string;
  withCompactionHelper?: boolean;
}): Promise<LoadExtensionsResult> {
  const paths = [EXTENSION_PATH];
  if (options.withCompactionHelper) paths.push(COMPACTION_HELPER_PATH);
  const result = await discoverAndLoadExtensions(paths, options.cwd, options.agentDir);
  if (result.errors.length > 0) {
    throw new Error(`Failed to load test extensions: ${JSON.stringify(result.errors)}`);
  }
  return result;
}

/** A resource loader with real native context-file discovery and no other resources. */
export function createHarnessResourceLoader(options: {
  cwd: string;
  agentDir: string;
  withCompactionHelper?: boolean;
  extensions: LoadExtensionsResult;
}): ResourceLoader {
  let extensions = options.extensions;
  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({
      agentsFiles: loadProjectContextFiles({ cwd: options.cwd, agentDir: options.agentDir }),
    }),
    getSystemPrompt: () => undefined,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    // Real Pi re-loads extensions on /reload, giving fresh instances a fresh
    // `pi`; mirror that instead of reusing the loaded ones.
    reload: async () => {
      extensions = await loadTestExtensions(options);
    },
  };
}

export interface HarnessOptions {
  cwd: string;
  responses: ResponseStep[];
  model?: AnyModel;
  /** Settings overrides applied before the session is created. */
  settings?: Record<string, unknown>;
  /** Load the canned-compaction helper extension. */
  withCompactionHelper?: boolean;
  /** Use a file-backed session manager in this directory (for resume tests). */
  sessionDir?: string;
  /** Event emitted as the session starts (defaults to "startup"). */
  sessionStartEvent?: SessionStartEvent;
  /** Open an existing session file instead of creating a new one. */
  sessionFile?: string;
  /** Stub UI context (used to capture ctx.ui.notify in tests). */
  uiContext?: ExtensionUIContext;
  /** Mark the project as trusted, enabling project configuration. */
  trusted?: boolean;
  /** Global configuration written to the isolated agent directory. */
  globalConfig?: string;
}

export interface Harness {
  session: AgentSession;
  sessionManager: SessionManager;
  faux: FauxStreamState;
  sessionFile: string;
  /** The isolated agent directory (redirects getAgentDir()). */
  agentDir: string;
  /** Extension errors reported through Pi's error channel. */
  extensionErrors: ExtensionError[];
  cleanup: () => void;
}

export async function createHarness(options: HarnessOptions): Promise<Harness> {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-agents-autoload-agent-"));
  const model = options.model ?? fauxModel();
  const { streamFn, state } = createScriptedStream(options.responses);

  const sessionManager = options.sessionFile
    ? SessionManager.open(options.sessionFile, options.sessionDir, options.cwd)
    : options.sessionDir
      ? SessionManager.create(options.cwd, options.sessionDir)
      : SessionManager.inMemory(options.cwd);

  const settingsManager = SettingsManager.create(options.cwd, agentDir, {
    // Real sessions only trust project-local configuration after the user
    // approves it; tests opt in explicitly.
    projectTrusted: false,
  });
  if (options.trusted) settingsManager.setProjectTrusted(true);
  if (options.globalConfig !== undefined) {
    writeFileSync(join(agentDir, "pi-agents-autoload.json"), options.globalConfig, "utf8");
  }
  if (options.settings) settingsManager.applyOverrides(options.settings);

  const extensions = await loadTestExtensions({
    cwd: options.cwd,
    agentDir,
    withCompactionHelper: options.withCompactionHelper,
  });
  const resourceLoader = createHarnessResourceLoader({
    cwd: options.cwd,
    agentDir,
    withCompactionHelper: options.withCompactionHelper,
    extensions,
  });

  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  // Register the faux provider so AgentSession's auth preflight accepts it.
  // Streaming itself goes through the scripted stream function below.
  modelRuntime.registerProvider(model.provider, {
    name: "Faux",
    baseUrl: model.baseUrl,
    api: model.api,
    apiKey: "faux-key",
    models: [
      {
        id: model.id,
        name: model.name,
        api: model.api,
        reasoning: model.reasoning,
        input: [...model.input],
        cost: model.cost,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        baseUrl: model.baseUrl,
      },
      // A second model under the same provider, so tests can switch models.
      {
        id: "faux-alt",
        name: "Faux Alt",
        api: model.api,
        reasoning: model.reasoning,
        input: [...model.input],
        cost: model.cost,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        baseUrl: model.baseUrl,
      },
    ],
  });

  const extensionRunnerRef: { current?: ExtensionRunner } = {};
  const agent = new Agent({
    getApiKey: () => "faux-key",
    initialState: {
      model,
      tools: [],
      // Seed the transcript exactly like the SDK does, so resumed sessions keep history.
      messages: sessionManager.buildSessionContext().messages,
    },
    streamFn,
    // Bridge the extension context hooks, the same way createAgentSession does.
    transformContext: async (messages) => {
      const runner = extensionRunnerRef.current;
      return runner ? await runner.emitContext(messages) : messages;
    },
  });

  const session = new AgentSession({
    agent,
    sessionManager,
    settingsManager,
    cwd: options.cwd,
    modelRuntime,
    resourceLoader,
    extensionRunnerRef,
    sessionStartEvent: options.sessionStartEvent,
  });
  session.subscribe(() => {});
  // Isolate getAgentDir() so the extension reads this harness's global
  // configuration directory instead of the real one, and capture extension
  // errors reported through Pi's error channel.
  const previousAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const extensionErrors: ExtensionError[] = [];
  await session.bindExtensions({
    mode: "json",
    uiContext: options.uiContext,
    onError: (error) => extensionErrors.push(error),
  });

  return {
    session,
    sessionManager,
    faux: state,
    sessionFile: sessionManager.getSessionFile() ?? "",
    agentDir,
    extensionErrors,
    cleanup: () => {
      session.dispose();
      if (previousAgentDirEnv === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDirEnv;
      }
      rmSync(agentDir, { recursive: true, force: true });
    },
  };
}

/** Temporary project directory fixture. */
export interface Project {
  dir: string;
  write(relativePath: string, content: string): string;
  read(relativePath: string): string;
  path(relativePath: string): string;
  cleanup(): void;
}

export function makeProject(base?: string): Project {
  const dir = mkdtempSync(join(base ?? tmpdir(), "pi-agents-autoload-project-"));
  return {
    dir,
    write(relativePath, content) {
      const absolute = join(dir, relativePath);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, content, "utf8");
      return absolute;
    },
    read(relativePath) {
      return readFileSync(join(dir, relativePath), "utf8");
    },
    path(relativePath) {
      return join(dir, relativePath);
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

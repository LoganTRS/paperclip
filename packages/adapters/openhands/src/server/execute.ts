/**
 * Server-side execution logic for the OpenHands adapter.
 *
 * Spawns the OpenHands one-shot SDK helper (scripts/oh_one_shot.py) as a
 * child process via the venv Python that owns the `openhands-sdk` package.
 * The helper performs a single non-interactive agent turn against an
 * OpenAI-compatible endpoint (the LiteLLM proxy) and prints a single JSON
 * object to stdout describing the result; all human logging goes to stderr.
 *
 * Why the SDK and not the CLI:
 *   - The `openhands` CLI is interactive-only (a prompt_toolkit TUI). It has
 *     no one-shot / non-interactive flag.
 *   - `openhands serve` is a Docker GUI server.
 *   - `openhands-sdk` is the programmatic, headless path: LLM + Agent +
 *     LocalConversation, with a resumable `conversation_id`.
 *
 * Credentials are injected via environment (OPENHANDS_LITELLM_PROXY_*) and
 * never passed on the command line or printed.
 */

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  UsageSummary,
} from "@paperclipai/adapter-utils";

import {
  runChildProcess,
  buildPaperclipEnv,
  buildRuntimeToolsEnv,
  renderTemplate,
  ensureAbsoluteDirectory,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  selectPaperclipPromptSections,
  asString,
  asNumber,
  asBoolean,
} from "@paperclipai/adapter-utils/server-utils";

import {
  DEFAULT_PYTHON,
  FALLBACK_PYTHON,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_SEC,
  DEFAULT_GRACE_SEC,
  DEFAULT_MAX_ITERATIONS,
  ENV_BASE_URL,
  ENV_API_KEY,
  ENV_MODEL,
} from "../shared/constants.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cfgString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function cfgNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
function cfgBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
function cfgEnvString(v: unknown): string | undefined {
  if (typeof v === "string" && v.length > 0) return v;
  if (v && typeof v === "object" && "value" in v) {
    const value = (v as { value?: unknown }).value;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }
  return undefined;
}

/**
 * Resolve the Python interpreter that owns the OpenHands SDK.
 * Order: OPENHANDS_PYTHON env > adapterConfig.python > default venv path.
 * (The caller verifies existence and falls back to `python3`.)
 */
export function resolvePython(
  config: Record<string, unknown>,
  env: Record<string, string>,
): string {
  return (
    env.OPENHANDS_PYTHON?.trim() ||
    cfgString(config.python) ||
    DEFAULT_PYTHON
  );
}

/** Resolve the path to the bundled oh_one_shot.py helper. */
function resolveHelperPath(): string {
  // The helper lives at packages/adapters/openhands/scripts/oh_one_shot.py.
  // This module is at <pkg>/src/server (source) or a compiled equivalent, so
  // walk up to the package root, then into scripts/. Prefer the layout that
  // actually exists so both source and dist layouts resolve.
  const here = path.dirname(new URL(import.meta.url).pathname);
  const candidates = [
    // <pkg>/src/server -> <pkg> (2 up)
    path.resolve(here, "..", "..", "scripts", "oh_one_shot.py"),
    // <pkg>/src/server -> <pkg>/src -> <pkg> via a deeper layout (3 up), kept
    // for layouts where this file is nested one level deeper.
    path.resolve(here, "..", "..", "..", "scripts", "oh_one_shot.py"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `oh_one_shot.py helper not found. Tried: ${candidates.join(", ")}`,
  );
}

// ---------------------------------------------------------------------------
// Wake-up prompt builder (mirrors the Hermes adapter's Paperclip prompt)
// ---------------------------------------------------------------------------

const OPENHANDS_SYSTEM_PROMPT_TEMPLATE = [
  "Paperclip API guidance:",
  "- You are \"{{agentName}}\", an AI agent employee in a Paperclip-managed company.",
  "- Paperclip runtime identity: Agent ID {{agentId}}, Company ID {{companyId}}, Run ID {{runId}}, API base {{paperclipApiUrl}}.",
  "- Use `curl` from the terminal for Paperclip API calls; browser/web tools may not reach localhost.",
  "- Use `$PAPERCLIP_API_URL`, `$PAPERCLIP_API_KEY`, `$PAPERCLIP_RUN_ID`, `$PAPERCLIP_TASK_ID`; do not hard-code local ports or copy secrets into comments.",
  "- Include `-H \"Authorization: Bearer $PAPER...EY\"` and `-H \"X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID\"` on mutating requests.",
  "- When finished, state what you changed and what you verified, then stop.",
].join("\n");

function buildPrompt(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown>,
  opts: { resumedSession: boolean },
): string {
  const template =
    cfgString(config.promptTemplate) ?? DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE;
  const userEnvForPrompt = config.env as Record<string, unknown> | undefined;
  const promptConfig: Record<string, unknown> = { ...config };
  if (!cfgString(promptConfig.paperclipApiUrl) && userEnvForPrompt && typeof userEnvForPrompt === "object") {
    const configuredPaperclipApiUrl = cfgEnvString(userEnvForPrompt.PAPERCLIP_API_URL);
    if (configuredPaperclipApiUrl) {
      promptConfig.paperclipApiUrl = configuredPaperclipApiUrl;
    }
  }

  const paperclipApiUrl =
    cfgString(promptConfig.paperclipApiUrl) ||
    asString(process.env.PAPERCLIP_API_URL, "http://localhost:3100");

  const vars: Record<string, string> = {
    agentId: ctx.agent.id,
    agentName: ctx.agent.name,
    companyId: ctx.agent.companyId,
    companyName: asString(promptConfig.companyName, ctx.agent.companyId),
    runId: ctx.runId,
    taskId: "",
    taskTitle: "",
    taskBody: "",
    projectName: "",
    paperclipApiUrl,
  };

  const context = (ctx as unknown as { context?: Record<string, unknown> }).context ?? {};
  vars.taskId = asString(context.taskId, "") || asString(context.issueId, "");
  vars.taskTitle = asString(context.taskTitle, "");
  vars.taskBody = asString(context.taskBody, "");
  vars.projectName = asString(context.projectName, "");

  const renderedTemplate = renderTemplate(template, { ...promptConfig, ...vars });

  const { taskContextNote, wakePrompt } = selectPaperclipPromptSections(context, {
    resumedSession: opts.resumedSession,
  });

  return [renderedTemplate, taskContextNote, wakePrompt].filter(Boolean).join("\n\n");
}

// ---------------------------------------------------------------------------
// Output parser
// ---------------------------------------------------------------------------

interface ParsedOpenHands {
  ok: boolean;
  response: string;
  conversationId: string | null;
  usage: UsageSummary | null;
  errorMessage: string | null;
}

export function parseOpenHandsOutput(
  stdout: string,
  stderr: string,
): ParsedOpenHands {
  const empty: ParsedOpenHands = {
    ok: false,
    response: "",
    conversationId: null,
    usage: null,
    errorMessage: null,
  };

  // The helper emits a single JSON line to stdout. Find the last JSON object.
  const trimmed = (stdout ?? "").trim();
  const jsonLines = trimmed.split("\n").filter((l) => l.trim().startsWith("{"));
  let parsed: any = null;
  for (let i = jsonLines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(jsonLines[i]);
      if (obj && typeof obj === "object" && ("ok" in obj || "response" in obj)) {
        parsed = obj;
        break;
      }
    } catch {
      continue;
    }
  }

  if (!parsed) {
    // No JSON result — treat as a failure with the last stderr lines for context.
    const tail = (stderr ?? "").trim().split("\n").slice(-12).join("\n");
    return { ...empty, errorMessage: tail || "OpenHands helper produced no JSON result." };
  }

  const usageRaw = parsed.usage;
  let usage: UsageSummary | null = null;
  if (usageRaw && typeof usageRaw === "object") {
    const input = Number(usageRaw.input_tokens ?? 0);
    const output = Number(usageRaw.output_tokens ?? 0);
    if (Number.isFinite(input) || Number.isFinite(output)) {
      usage = { inputTokens: input || 0, outputTokens: output || 0 };
    }
  }

  return {
    ok: parsed.ok === true,
    response: typeof parsed.response === "string" ? parsed.response : "",
    conversationId: typeof parsed.conversation_id === "string" ? parsed.conversation_id : null,
    usage,
    errorMessage: typeof parsed.error === "string" ? parsed.error : null,
  };
}

// ---------------------------------------------------------------------------
// execute
// ---------------------------------------------------------------------------

export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const config = ctx.config ?? {};

  const model = cfgString(config.model) || DEFAULT_MODEL;
  const timeoutSec = cfgNumber(config.timeoutSec) ?? DEFAULT_TIMEOUT_SEC;
  const graceSec = cfgNumber(config.graceSec) ?? DEFAULT_GRACE_SEC;
  const maxIterations = cfgNumber(config.maxIterationsPerRun) ?? DEFAULT_MAX_ITERATIONS;
  const persistSession = cfgBoolean(config.persistSession) !== false;

  const base_url =
    cfgEnvString((config.env as Record<string, unknown> | undefined)?.[ENV_BASE_URL]) ||
    cfgString(config.baseUrl) ||
    asString(process.env[ENV_BASE_URL], "");
  const api_key =
    cfgEnvString((config.env as Record<string, unknown> | undefined)?.[ENV_API_KEY]) ||
    cfgString(config.apiKey) ||
    asString(process.env[ENV_API_KEY], "");
  const resolvedModel =
    cfgEnvString((config.env as Record<string, unknown> | undefined)?.[ENV_MODEL]) ||
    model;

  // ── Resolve Python + helper ─────────────────────────────────────────────
  const python = resolvePython(config, process.env as Record<string, string>);
  const helperPath = resolveHelperPath();

  // ── Build prompt ────────────────────────────────────────────────────────
  const prevSessionId = persistSession
    ? (ctx.runtime.sessionParams?.sessionId as string | undefined) ??
      ctx.runtime.sessionId ??
      undefined
    : undefined;
  const prompt = buildPrompt(ctx, config, { resumedSession: Boolean(prevSessionId) });

  // ── Build environment ───────────────────────────────────────────────────
  const userEnv = config.env as Record<string, string> | undefined;
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...(userEnv && typeof userEnv === "object" ? userEnv : {}),
    ...buildPaperclipEnv(ctx.agent, ctx.agentIdentity),
    ...buildRuntimeToolsEnv(ctx.runtimeTools),
  };

  // LLM credentials (env only; never on argv).
  if (base_url) env[ENV_BASE_URL] = base_url;
  if (api_key) env[ENV_API_KEY] = api_key;
  if (resolvedModel) env[ENV_MODEL] = resolvedModel;

  // Paperclip identity for the agent's own API calls.
  if (ctx.runId) env.PAPERCLIP_RUN_ID = ctx.runId;
  delete env.PAPERCLIP_API_KEY;
  delete env.PAPERCLIP_WAKE_PAYLOAD_JSON;
  if (ctx.authToken) env.PAPERCLIP_API_KEY = ctx.authToken;

  const ctxContext = (ctx as unknown as { context?: Record<string, unknown> }).context ?? {};
  const envTaskId =
    cfgString(ctxContext.taskId) || cfgString(ctxContext.issueId) || cfgString(config.taskId);
  if (envTaskId) env.PAPERCLIP_TASK_ID = envTaskId;
  const envWakeReason =
    cfgString(ctxContext.wakeReason) || cfgString(config.wakeReason);
  if (envWakeReason) env.PAPERCLIP_WAKE_REASON = envWakeReason;

  // ── Resolve working directory ───────────────────────────────────────────
  const workspace = (ctx as unknown as { context?: { paperclipWorkspace?: { cwd?: string } } }).context?.paperclipWorkspace;
  const workspaceCwd = workspace && typeof workspace === "object" ? workspace.cwd : undefined;
  const cwd =
    cfgString(config.cwd) || workspaceCwd || cfgString(config.workspaceDir) || ".";
  try {
    await ensureAbsoluteDirectory(cwd);
  } catch {
    // Non-fatal
  }

  // ── Write prompt to a temp file (avoids argv-length + quoting issues) ───
  const promptDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-oh-"));
  const promptFile = path.join(promptDir, "prompt.txt");
  try {
    await fs.writeFile(promptFile, prompt, "utf8");
  } finally {
    // Best-effort cleanup after the run (below); keep a reference.
  }

  // ── Build args ──────────────────────────────────────────────────────────
  const args: string[] = [
    helperPath,
    "--prompt-file", promptFile,
    "--workdir", cwd,
    "--max-iterations", String(maxIterations),
  ];
  if (prevSessionId) args.push("--conversation-id", prevSessionId);

  // ── Log start ───────────────────────────────────────────────────────────
  await ctx.onLog(
    "stdout",
    `[openhands] Starting OpenHands (model=${resolvedModel}, timeout=${timeoutSec}s${prevSessionId ? `, resume=${prevSessionId}` : ""})\n`,
  );

  // ── Execute ─────────────────────────────────────────────────────────────
  const wrappedOnLog = async (stream: "stdout" | "stderr", chunk: string) => {
    // Keep the JSON result line from stdout out of the noisy transcript.
    if (stream === "stdout" && chunk.trim().startsWith("{")) return;
    return ctx.onLog(stream, chunk);
  };

  let result = { exitCode: null as number | null, timedOut: false, stdout: "", stderr: "", signal: null as string | null };
  try {
    result = await runChildProcess(ctx.runId, python, args, {
      cwd,
      env,
      timeoutSec,
      graceSec,
      onLog: wrappedOnLog,
      onSpawn: ctx.onSpawn,
    });
  } finally {
    try {
      await fs.rm(promptDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  // ── Parse output ────────────────────────────────────────────────────────
  const parsed = parseOpenHandsOutput(result.stdout || "", result.stderr || "");

  await ctx.onLog(
    "stdout",
    `[openhands] Exit code: ${result.exitCode ?? "null"}, timed out: ${result.timedOut}\n`,
  );
  if (parsed.conversationId) {
    await ctx.onLog("stdout", `[openhands] Conversation: ${parsed.conversationId}\n`);
  }

  // ── Build result ────────────────────────────────────────────────────────
  const executionResult: AdapterExecutionResult = {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    provider: "openhands",
    model: resolvedModel,
  };

  if (parsed.errorMessage) {
    executionResult.errorMessage = parsed.errorMessage;
  } else if (result.timedOut) {
    executionResult.errorMessage = `OpenHands run timed out after ${timeoutSec}s`;
  } else if (typeof result.exitCode === "number" && result.exitCode !== 0) {
    const tail = (result.stderr || "").trim().split("\n").slice(-8).join("\n");
    executionResult.errorMessage = tail || `OpenHands exited with code ${result.exitCode}`;
  }

  if (parsed.usage) executionResult.usage = parsed.usage;

  if (parsed.response) {
    executionResult.summary = parsed.response.slice(0, 2000);
  }

  executionResult.resultJson = {
    result: parsed.response || "",
    session_id: parsed.conversationId || null,
    usage: parsed.usage || null,
  };

  // Session persistence: always emit the conversation id so Paperclip can
  // resume the next heartbeat. On an unknown/expired resume the helper starts
  // fresh (new id); we surface that fresh id as the new session.
  if (parsed.conversationId) {
    executionResult.sessionId = parsed.conversationId;
    executionResult.sessionParams = { sessionId: parsed.conversationId };
    executionResult.sessionDisplayId = parsed.conversationId;
  }

  return executionResult;
}

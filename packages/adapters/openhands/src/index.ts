/**
 * OpenHands adapter for Paperclip.
 *
 * Runs OpenHands (https://github.com/All-Hands-AI/OpenHands) as a managed
 * employee in a Paperclip company. OpenHands is a Python agent with a rich
 * terminal/file/web toolset. The `openhands` CLI is interactive-only (TUI) and
 * `openhands serve` is a Docker GUI server, so this adapter drives the
 * headless `openhands-sdk` (LLM + Agent + LocalConversation) via a Python
 * helper, performing a single non-interactive agent turn per Paperclip
 * heartbeat.
 *
 * @packageDocumentation
 */

import type {
  AdapterRuntimeCommandSpec,
  AdapterSessionManagement,
  ServerAdapterModule,
} from "@paperclipai/adapter-utils";

import { ADAPTER_TYPE, ADAPTER_LABEL, DEFAULT_PYTHON } from "./shared/constants.js";
import {
  execute,
  testEnvironment,
  sessionCodec,
  getConfigSchema,
  resolvePython,
} from "./server/index.js";

export const type = ADAPTER_TYPE;
export const label = ADAPTER_LABEL;

/**
 * Models available through OpenHands.
 *
 * OpenHands supports any model through any OpenAI-compatible endpoint, so the
 * Paperclip UI should prefer manual entry over a curated list.
 */
export const models: { id: string; label: string }[] = [];

const sessionManagement: AdapterSessionManagement = {
  supportsSessionResume: true,
  nativeContextManagement: "confirmed",
  defaultSessionCompaction: {
    enabled: true,
    maxSessionRuns: 0,
    maxRawInputTokens: 0,
    maxSessionAgeHours: 0,
  },
};

function getRuntimeCommandSpec(config: Record<string, unknown>): AdapterRuntimeCommandSpec {
  const command = resolvePython(config, process.env as Record<string, string>) || DEFAULT_PYTHON;
  return {
    command,
    detectCommand: command,
    installCommand: null,
  };
}

/**
 * Documentation shown in the Paperclip UI when configuring an OpenHands agent.
 */
export const agentConfigurationDoc = `# OpenHands Configuration

OpenHands is an open-source AI software engineering agent. This adapter runs
OpenHands headlessly through its Python SDK (the CLI is interactive-only),
performing one non-interactive agent turn per Paperclip heartbeat.

## When to use / when not to use

Use this adapter for **implementation** work: writing code, editing files,
running commands, and fixing bugs inside a repository workspace. It is the
target for GitHub issues labeled \`code\`.

Do **not** use it for planning/wayfinding work (label \`wayfinder\`) — route
those to a Hermes agent instead.

## Prerequisites

- A Python interpreter that owns the \`openhands-sdk\` package (default:
  \`${DEFAULT_PYTHON}\`, override with \`python\` or \`OPENHANDS_PYTHON\`).
- An OpenAI-compatible LLM endpoint (the LiteLLM proxy) reachable from the
  interpreter.
- SSL trust for the proxy certificate is inherited from the interpreter
  environment (SSL_CERT_FILE / REQUESTS_CA_BUNDLE).

## Core Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| model | string | (default) | Model name exposed by the OpenAI-compatible endpoint (e.g. trs-balanced). |
| timeoutSec | number | 1800 | Execution timeout in seconds. |
| graceSec | number | 10 | Grace period after SIGTERM before SIGKILL. |
| maxIterationsPerRun | number | 500 | OpenHands SDK max iterations for tool-calling in a single turn. |

## Credentials (env only — never in prompts)

Configure these through \`adapterConfig.env\` or the host environment:

| Variable | Description |
|----------|-------------|
| OPENHANDS_LITELLM_PROXY_BASE | OpenAI-compatible base URL (e.g. https://<host>:<port>/v1). |
| OPENHANDS_LITELLM_PROXY_KEY | API key for the endpoint. |
| OPENHANDS_LITELLM_PROXY_MODEL | Model name. |

Paperclip identity (\`PAPERCLIP_API_URL\`, \`PAPERCLIP_API_KEY\`,
\`PAPERCLIP_RUN_ID\`, \`PAPERCLIP_TASK_ID\`) is injected by the runtime.

## Session & Workspace

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| cwd | string | (task workspace) | Absolute working directory override. |
| persistSession | boolean | true | Resume OpenHands conversations across heartbeats. |

## Advanced

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| python | string | ${DEFAULT_PYTHON} | Path to the Python interpreter owning openhands-sdk. |
| paperclipApiUrl | string | (PAPERCLIP_API_URL) | Optional API base override. |
| promptTemplate | string | (default) | Custom prompt template with {{variable}} placeholders. |
| env | object | {} | Extra environment variables. |

## Available Template Variables

- \`{{agentId}}\` — Paperclip agent ID
- \`{{agentName}}\` — Agent display name
- \`{{companyId}}\` — Paperclip company ID
- \`{{companyName}}\` — Company display name
- \`{{runId}}\` — Current heartbeat run ID
- \`{{taskId}}\` — Current task/issue ID (if assigned)
- \`{{taskTitle}}\` — Task title (if assigned)
- \`{{taskBody}}\` — Task description (if assigned)
- \`{{projectName}}\` — Project name (if scoped to a project)
`;

/**
 * External adapter plugin entrypoint expected by Paperclip's adapter manager.
 */
export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    execute,
    testEnvironment,
    sessionCodec,
    sessionManagement,
    models,
    supportsLocalAgentJwt: true,
    getRuntimeCommandSpec,
    agentConfigurationDoc,
    getConfigSchema,
  };
}

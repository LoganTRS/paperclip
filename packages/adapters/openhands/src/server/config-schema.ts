import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";

import {
  DEFAULT_GRACE_SEC,
  DEFAULT_TIMEOUT_SEC,
  DEFAULT_MAX_ITERATIONS,
} from "../shared/constants.js";

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "model",
        label: "Model",
        type: "text",
        hint: "Model name exposed by the OpenAI-compatible endpoint (e.g. trs-balanced). Defaults to the LiteLLM proxy default.",
      },
      {
        key: "timeoutSec",
        label: "Timeout seconds",
        type: "number",
        default: DEFAULT_TIMEOUT_SEC,
      },
      {
        key: "graceSec",
        label: "Grace seconds",
        type: "number",
        default: DEFAULT_GRACE_SEC,
        hint: "Seconds to wait after SIGTERM before killing the OpenHands process.",
      },
      {
        key: "maxIterationsPerRun",
        label: "Max iterations per run",
        type: "number",
        default: DEFAULT_MAX_ITERATIONS,
        hint: "OpenHands SDK max iterations for tool-calling iterations in a single turn.",
      },
      {
        key: "persistSession",
        label: "Persist session",
        type: "toggle",
        default: true,
        hint: "Resume OpenHands conversations across Paperclip heartbeats.",
      },
      {
        key: "cwd",
        label: "Working directory",
        type: "text",
        hint: "Absolute working directory override; otherwise use Paperclip's resolved task workspace.",
      },
      {
        key: "paperclipApiUrl",
        label: "Paperclip API URL",
        type: "text",
        hint: "Optional API base override. Defaults to PAPERCLIP_API_URL.",
      },
      {
        key: "promptTemplate",
        label: "Prompt template",
        type: "textarea",
        hint: "Optional custom prompt template with {{variable}} placeholders.",
      },
      {
        key: "python",
        label: "Python interpreter",
        type: "text",
        hint: "Path to the Python interpreter that owns the openhands-sdk package. Defaults to the image venv (OPENHANDS_PYTHON or /opt/agent-tools/bin/python3).",
      },
    ],
  };
}

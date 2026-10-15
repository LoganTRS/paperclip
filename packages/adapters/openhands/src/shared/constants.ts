/**
 * Shared constants for the OpenHands adapter.
 */

/** Adapter type identifier registered with Paperclip. */
export const ADAPTER_TYPE = "openhands_local";

/** Human-readable label shown in the Paperclip UI. */
export const ADAPTER_LABEL = "OpenHands";

/**
 * Python interpreter that owns the OpenHands SDK.
 *
 * OpenHands is a Python package (requests/urllib3 stack). The SDK
 * (`openhands-sdk`) is what allows a clean, non-interactive one-shot agent
 * turn; the `openhands` CLI is interactive-only (TUI) and `openhands serve`
 * is a Docker GUI server. So the adapter spawns the SDK via a Python helper.
 *
 * The default is the interpreter of the venv where OpenHands is installed in
 * the Paperclip image. Override with OPENHANDS_PYTHON or adapterConfig.
 */
export const DEFAULT_PYTHON = "/opt/agent-tools/bin/python3";

/** Fallback interpreter if the venv path is not present. */
export const FALLBACK_PYTHON = "python3";

/** Default model. Leave as-is for the LiteLLM proxy deployment. */
export const DEFAULT_MODEL = "trs-balanced";

/** Default LiteLLM proxy base URL (OpenAI-compatible). */
export const DEFAULT_BASE_URL = "https://10.69.95.194:8443/v1";

/** Default timeout for a single execution run (seconds). */
export const DEFAULT_TIMEOUT_SEC = 1800;

/** Grace period after SIGTERM before SIGKILL (seconds). */
export const DEFAULT_GRACE_SEC = 10;

/** Max iterations per OpenHands conversation run (SDK default is 500). */
export const DEFAULT_MAX_ITERATIONS = 500;

/** Environment variable that carries the OpenHands LLM base URL to the helper. */
export const ENV_BASE_URL = "OPENHANDS_LITELLM_PROXY_BASE";
/** Environment variable that carries the OpenHands LLM API key to the helper. */
export const ENV_API_KEY = "OPENHANDS_LITELLM_PROXY_KEY";
/** Environment variable that carries the OpenHands model to the helper. */
export const ENV_MODEL = "OPENHANDS_LITELLM_PROXY_MODEL";

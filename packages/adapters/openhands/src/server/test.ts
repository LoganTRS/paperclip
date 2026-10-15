/**
 * Environment test for the OpenHands adapter.
 *
 * Verifies that the Python interpreter owning the OpenHands SDK is present and
 * that the SDK can be imported, and that LLM credentials are configured, before
 * allowing the adapter to be used.
 */

import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterEnvironmentCheck,
} from "@paperclipai/adapter-utils";

import { execFile } from "node:child_process";
import { promises as fsp } from "node:fs";
import { promisify } from "node:util";

import {
  DEFAULT_PYTHON,
  FALLBACK_PYTHON,
  ENV_BASE_URL,
  ENV_API_KEY,
  ENV_MODEL,
  ADAPTER_TYPE,
} from "../shared/constants.js";
import { resolvePython } from "./execute.js";

const execFileAsync = promisify(execFile);

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function envFromConfig(
  config: Record<string, unknown>,
  processEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  const userEnv = config.env as Record<string, string> | undefined;
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(processEnv)) {
    if (typeof v === "string") merged[k] = v;
  }
  if (userEnv && typeof userEnv === "object") {
    for (const [k, v] of Object.entries(userEnv)) {
      if (typeof v === "string") merged[k] = v;
    }
  }
  return merged;
}

async function checkPython(python: string): Promise<AdapterEnvironmentCheck> {
  try {
    const { stdout } = await execFileAsync(python, ["--version"], { timeout: 10_000 });
    const version = stdout.trim();
    const match = version.match(/(\d+)\.(\d+)/);
    if (match) {
      const major = parseInt(match[1], 10);
      const minor = parseInt(match[2], 10);
      if (major < 3 || (major === 3 && minor < 10)) {
        return {
          code: "openhands_python_old",
          level: "error",
          message: `Python ${version} found — OpenHands requires Python 3.10+`,
          hint: "Upgrade Python to 3.10 or later, or set adapterConfig.python to a suitable interpreter.",
        };
      }
    }
    return { code: "openhands_python", level: "info", message: `Python interpreter: ${version}` };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return {
        code: "openhands_python_not_found",
        level: "error",
        message: `Python interpreter "${python}" not found`,
        hint: "Set adapterConfig.python or the OPENHANDS_PYTHON env var to the interpreter that owns the openhands-sdk package (e.g. /opt/agent-tools/bin/python3).",
      };
    }
    return {
      code: "openhands_python_failed",
      level: "error",
      message: `Python interpreter "${python}" failed to run: ${e.message}`,
    };
  }
}

async function checkSdkImport(python: string): Promise<AdapterEnvironmentCheck> {
  const probe =
    "import importlib.util,sys; sys.exit(0 if importlib.util.find_spec('openhands.sdk') else 1)";
  try {
    await execFileAsync(python, ["-c", probe], { timeout: 30_000 });
    return {
      code: "openhands_sdk",
      level: "info",
      message: "openhands-sdk is importable",
    };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
    // exit code 1 => not found; other => error
    if (e.killed || e.signal) {
      return {
        code: "openhands_sdk_timeout",
        level: "warn",
        message: "Timed out probing openhands-sdk import",
      };
    }
    return {
      code: "openhands_sdk_missing",
      level: "error",
      message: "openhands-sdk is not importable in the resolved Python interpreter",
      hint: "Install openhands-sdk into the venv that owns the OpenHands CLI (e.g. /opt/agent-tools), or set adapterConfig.python.",
    };
  }
}

function checkCredentials(
  config: Record<string, unknown>,
  processEnv: NodeJS.ProcessEnv,
): AdapterEnvironmentCheck[] {
  const env = envFromConfig(config, processEnv);
  const base = asString(config.baseUrl) || asString(env[ENV_BASE_URL]) || asString(processEnv[ENV_BASE_URL]);
  const key = asString((config.env as Record<string, unknown> | undefined)?.[ENV_API_KEY]) || asString(config.apiKey) || asString(env[ENV_API_KEY]) || asString(processEnv[ENV_API_KEY]);
  const model = asString(config.model) || asString(env[ENV_MODEL]) || asString(processEnv[ENV_MODEL]);

  const checks: AdapterEnvironmentCheck[] = [];
  if (!base) {
    checks.push({
      code: "openhands_base_missing",
      level: "error",
      message: "No OpenAI-compatible base URL configured",
      hint: `Set ${ENV_BASE_URL} in adapterConfig.env or adapterConfig.baseUrl (e.g. the LiteLLM proxy https://<host>:<port>/v1).`,
    });
  }
  if (!key) {
    checks.push({
      code: "openhands_key_missing",
      level: "error",
      message: "No OpenAI-compatible API key configured",
      hint: `Set ${ENV_API_KEY} in adapterConfig.env or adapterConfig.apiKey. Never hard-code it in prompts.`,
    });
  }
  if (!model) {
    checks.push({
      code: "openhands_model_missing",
      level: "warn",
      message: "No model configured; the adapter will fall back to its default",
      hint: "Set adapterConfig.model (e.g. trs-balanced) or the OPENHANDS_LITELLM_PROXY_MODEL env var.",
    });
  }
  return checks;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const config = ctx.config ?? {};
  const processEnv = process.env;
  const env = envFromConfig(config, processEnv);
  const python = resolvePython(config, env) || DEFAULT_PYTHON;
  const checks: AdapterEnvironmentCheck[] = [];

  // Python interpreter
  checks.push(await checkPython(python));

  // SDK import (only if python is present)
  if (python === FALLBACK_PYTHON || (await fsp.access(python).then(() => true).catch(() => false))) {
    checks.push(await checkSdkImport(python));
  }

  // Credentials
  checks.push(...checkCredentials(config, processEnv));

  const status = checks.some((c) => c.level === "error")
    ? "fail"
    : checks.some((c) => c.level === "warn")
      ? "warn"
      : "pass";

  return {
    adapterType: ADAPTER_TYPE,
    status,
    checks,
    testedAt: new Date().toISOString(),
  };
}

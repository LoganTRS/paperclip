/**
 * Build adapter configuration from UI form values for OpenHands.
 */

import type { CreateConfigValues } from "@paperclipai/adapter-utils";

import { DEFAULT_TIMEOUT_SEC, DEFAULT_MAX_ITERATIONS } from "../shared/constants.js";

export function buildOpenHandsConfig(
  v: CreateConfigValues,
): Record<string, unknown> {
  const ac: Record<string, unknown> = {};

  if (v.model.trim()) {
    ac.model = v.model.trim();
  }

  ac.timeoutSec = DEFAULT_TIMEOUT_SEC;
  ac.maxIterationsPerRun = DEFAULT_MAX_ITERATIONS;
  ac.persistSession = true;

  if (v.cwd) {
    ac.cwd = v.cwd;
  }
  if (v.promptTemplate) {
    ac.promptTemplate = v.promptTemplate;
  }

  return ac;
}

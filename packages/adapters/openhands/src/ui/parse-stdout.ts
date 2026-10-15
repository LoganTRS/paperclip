/**
 * Parse OpenHands helper stdout into TranscriptEntry objects for the Paperclip UI.
 *
 * The helper streams OpenHands' own logs to stderr (which Paperclip renders)
 * and a single JSON result object to stdout. The adapter filters the JSON line
 * out of the transcript, so the parser mostly normalizes stderr/log lines and
 * surfaces a final assistant message.
 */

import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function stripAnsi(text: string): string {
  return text
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

export function parseOpenHandsStdoutLine(
  line: string,
  ts: string,
): TranscriptEntry[] {
  const trimmed = stripAnsi(line).trim();
  if (!trimmed) return [];

  // Adapter log lines ([openhands] ...) → system.
  if (trimmed.startsWith("[openhands]")) {
    return [{ kind: "system", ts, text: trimmed }];
  }

  // Errors / tracebacks → stderr entry.
  if (/^(Error:|ERROR:|Traceback|Exception)/.test(trimmed)) {
    return [{ kind: "stderr", ts, text: trimmed }];
  }

  // Default: a plain stdout line.
  return [{ kind: "stdout", ts, text: trimmed }];
}

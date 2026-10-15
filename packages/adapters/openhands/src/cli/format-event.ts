/**
 * CLI output formatting for the OpenHands adapter.
 */

import pc from "picocolors";

export function printOpenHandsStreamEvent(raw: string, debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  if (!debug) {
    console.log(line);
    return;
  }

  if (line.startsWith("[openhands]")) {
    console.log(pc.blue(line));
    return;
  }

  if (/^(Error:|ERROR:|Traceback|Exception)/.test(line)) {
    console.log(pc.red(line));
    return;
  }

  console.log(pc.gray(line));
}

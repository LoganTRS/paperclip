
import { createServerAdapter, type, agentConfigurationDoc } from "@paperclipai/openhands-paperclip-adapter";
const m = createServerAdapter();
const checks = {
  type: m.type,
  hasExecute: typeof m.execute === "function",
  hasTestEnvironment: typeof m.testEnvironment === "function",
  hasSessionCodec: !!m.sessionCodec,
  hasAgentDoc: typeof agentConfigurationDoc === "string" && agentConfigurationDoc.length > 100,
  hasConfigSchema: typeof m.getConfigSchema === "function" && !!m.getConfigSchema()?.fields,
  sessionManagement: !!m.sessionManagement,
  models: Array.isArray(m.models),
  commandSpec: (() => { const s = m.getRuntimeCommandSpec?.({}); return !!(s && s.command); })(),
};
console.log(JSON.stringify(checks, null, 2));
// verify session codec round-trips
const sc = m.sessionCodec!;
const ser = sc.serialize({ sessionId: "abc-123" });
const des = sc.deserialize(ser);
console.log("codec_roundtrip:", JSON.stringify(des));

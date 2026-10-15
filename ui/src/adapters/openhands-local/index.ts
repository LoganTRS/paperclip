import type { UIAdapterModule } from "../types";
import { parseOpenHandsStdoutLine, buildOpenHandsConfig } from "@paperclipai/openhands-paperclip-adapter/ui";
import { SchemaConfigFields } from "../schema-config-fields";

export const openHandsLocalUIAdapter: UIAdapterModule = {
  type: "openhands_local",
  label: "OpenHands",
  parseStdoutLine: parseOpenHandsStdoutLine,
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildOpenHandsConfig,
};

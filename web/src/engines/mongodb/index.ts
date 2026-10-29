import descriptor from "../../../../crates/tablepeek-engine/src/engines/mongodb/descriptor.json";
import type { Engine, EngineDescriptor } from "../types";
import { mongoErrorRules } from "./errorHelp";
import { icon } from "./icon";

// MongoDB: documents, opened in the document workbench (no SQL).
export const mongodb: Engine = {
  ...(descriptor as EngineDescriptor),
  icon,
  workbench: "document",
  subtitle: "기본 포트 27017",
  errorHelp: {
    detect: /MongoDB|mongo_\d+|E11000|Authentication failed|SCRAM failure|Server selection timeout/,
    hints: {},
    rules: mongoErrorRules,
  },
};

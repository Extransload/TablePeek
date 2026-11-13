import descriptor from "../../../../crates/tablepeek-engine/src/engines/redis/descriptor.json";
import type { Engine, EngineDescriptor } from "../types";
import { redisErrorRules } from "./errorHelp";
import { icon } from "./icon";

// Redis (and Valkey): keys of typed values, opened in the key-value
// workbench (key browser, key views, redis-cli console, server info).
export const redis: Engine = {
  ...(descriptor as EngineDescriptor),
  icon,
  workbench: "keyvalue",
  subtitle: "기본 포트 6379",
  errorHelp: {
    detect: /\bredis_[A-Za-z]+\b|\bWRONGTYPE\b|\bNOAUTH\b|\bWRONGPASS\b|\bREADONLY You can't write\b|\bLOADING Redis\b|\bMISCONF\b/,
    hints: {},
    rules: redisErrorRules,
  },
};

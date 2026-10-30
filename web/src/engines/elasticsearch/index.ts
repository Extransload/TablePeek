import descriptor from "../../../../crates/tablepeek-engine/src/engines/elasticsearch/descriptor.json";
import type { Engine, EngineDescriptor, EngineErrorHelp } from "../types";
import { searchErrorRules } from "./errorHelp";
import { icon } from "./icon";

// The rules both search engines share: their errors carry `es_<type>` codes.
export const searchErrorHelp: EngineErrorHelp = {
  detect: /\bes_[a-z_]+_exception\b|\bes_http_\d{3}\b|Elasticsearch|elasticsearch_error/,
  hints: {},
  rules: searchErrorRules,
};

// Elasticsearch: indices of JSON documents, opened in the search workbench
// (Query DSL, Dev Tools console, SQL).
export const elasticsearch: Engine = {
  ...(descriptor as EngineDescriptor),
  icon,
  workbench: "search",
  subtitle: "기본 포트 9200",
  errorHelp: searchErrorHelp,
};

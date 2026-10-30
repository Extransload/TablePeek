import descriptor from "../../../../crates/tablepeek-engine/src/engines/elasticsearch/opensearch.json";
import { searchErrorHelp } from "../elasticsearch";
import type { Engine, EngineDescriptor } from "../types";
import { icon } from "./icon";

// OpenSearch: the same driver and workbench as Elasticsearch, with its own
// mark and defaults.
export const opensearch: Engine = {
  ...(descriptor as EngineDescriptor),
  icon,
  workbench: "search",
  subtitle: "기본 포트 9200",
  errorHelp: { ...searchErrorHelp, detect: /\bes_[a-z_]+_exception\b|\bes_http_\d{3}\b|OpenSearch|opensearch_error/ },
};

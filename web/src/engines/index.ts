import { t } from "../i18n";
import { cassandra } from "./cassandra";
import { clickhouse } from "./clickhouse";
import { cockroach } from "./cockroach";
import { elasticsearch } from "./elasticsearch";
import { mongodb } from "./mongodb";
import { mssql } from "./mssql";
import { mysql } from "./mysql";
import { opensearch } from "./opensearch";
import { oracle } from "./oracle";
import { postgres } from "./postgres";
import { scylladb } from "./scylladb";
import { sqlite } from "./sqlite";
import type { SqlDialect } from "./sqlDialect";
import type { Capabilities, Engine, EngineDescriptor } from "./types";

export type {
  Capabilities,
  ConnectionField,
  ConnectionSpec,
  Engine,
  EngineDescriptor,
  EngineErrorHelp,
  EngineIcon,
  ErrorHint,
  FieldOption,
  FieldType,
  FieldValue,
  Workbench,
} from "./types";
export type { SqlDialect } from "./sqlDialect";

// Every engine this page can show, in the order the pickers list them. Adding
// an engine is its folder plus one line here.
const BUILT_IN: readonly Engine[] = [postgres, mysql, mssql, oracle, clickhouse, cassandra, scylladb, mongodb, elasticsearch, opensearch, cockroach, sqlite];

let registry: readonly Engine[] = BUILT_IN;

export function engines(): readonly Engine[] {
  return registry;
}

// The engine with this id or alias (any case), or undefined for one this page
// doesn't know.
export function engineById(id: string): Engine | undefined {
  const key = id.toLowerCase();
  return registry.find((engine) => engine.id === key) ?? registry.find((engine) => engine.aliases.includes(key));
}

export function unsupportedEngine(id: string): string {
  return t("지원하지 않는 엔진: {id}", { id });
}

// The engine with this id or alias; an unknown one is an error, never a stand-in.
export function requireEngine(id: string): Engine {
  const engine = engineById(id);
  if (engine === undefined) {
    throw new Error(unsupportedEngine(id));
  }
  return engine;
}

// An engine's SQL dialect; an unknown engine, or one without SQL, is an error.
export function requireSqlDialect(id: string): SqlDialect {
  const dialect = requireEngine(id).sql;
  if (dialect === undefined) {
    throw new Error(unsupportedEngine(id));
  }
  return dialect;
}

// What a connection can do: the server's actual values once connected, the
// engine's own defaults from servers that don't send them; nothing for an
// engine this page doesn't know.
export function capabilitiesOf(meta: { kind: string; capabilities?: Capabilities }): Capabilities | undefined {
  return meta.capabilities ?? engineById(meta.kind)?.capabilities;
}

// The engine a connection URL's scheme names ("postgresql://…", "jdbc:mysql://…").
export function engineForUrl(url: string): Engine | undefined {
  const scheme = /^(?:jdbc:)?([a-z][a-z0-9+.-]*):\/\//i.exec(url.trim());
  if (scheme === null) {
    return undefined;
  }
  const name = scheme[1].toLowerCase();
  return registry.find((engine) => engine.url_schemes.includes(name));
}

// The server's own descriptions (GET /api/engines) replace the bundled copies of
// the shared fields. Engines the server doesn't offer are dropped; ones this
// page has no screens for are left out.
export function applyServerEngines(descriptors: EngineDescriptor[]): void {
  const byId = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  registry = BUILT_IN.flatMap((engine) => {
    const descriptor = byId.get(engine.id);
    return descriptor === undefined ? [] : [{ ...engine, ...descriptor }];
  });
}

import { useEffect, useState } from "react";
import type { SqlDialect } from "../engines/sqlDialect";
import { t } from "../i18n";
import { store } from "../store";
import { Select } from "./Select";

// The cluster a connection's structure changes run on unless one is picked:
// its `cluster` setting, on an engine with clusters (SqlDialect.clusters).
export async function defaultCluster(conn: string, dialect: SqlDialect): Promise<string | null> {
  if (dialect.clusters === undefined) {
    return null;
  }
  const info = await store.connectionInfo(conn).catch(() => null);
  const value = info?.config.cluster;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

// `statements` as they run on `cluster`'s servers; as they are for none.
export function onCluster(dialect: SqlDialect, statements: string[], cluster: string | null): string[] {
  const clusters = dialect.clusters;
  return cluster === null || clusters === undefined
    ? statements
    : statements.map((statement) => clusters.onCluster(statement, cluster));
}

// The clusters the server lists and the one picked, the connection's
// setting at first. Nothing on an engine without clusters.
export function useCluster(
  conn: string,
  dialect: SqlDialect,
): { clusters: string[]; cluster: string | null; setCluster(cluster: string | null): void } {
  const [clusters, setClusters] = useState<string[]>([]);
  const [cluster, setCluster] = useState<string | null>(null);
  useEffect(() => {
    const ddl = dialect.clusters;
    if (ddl === undefined) {
      return;
    }
    let live = true;
    void Promise.all([
      store.exec(conn, ddl.listSql).then(
        (result) => result.rows.map((row) => String(row[0])),
        () => [] as string[],
      ),
      defaultCluster(conn, dialect),
    ]).then(([listed, preset]) => {
      if (!live) {
        return;
      }
      // A setting naming a cluster the server doesn't list is still offered,
      // so the statements say what will run.
      setClusters(preset !== null && !listed.includes(preset) ? [...listed, preset] : listed);
      setCluster(preset);
    });
    return () => {
      live = false;
    };
  }, [conn, dialect]);
  return { clusters, cluster, setCluster };
}

interface ClusterPickerProps {
  clusters: string[];
  cluster: string | null;
  onChange(cluster: string | null): void;
  disabled?: boolean;
  // One compact list for a footer, each choice naming ON CLUSTER itself.
  inline?: boolean;
}

// ON CLUSTER for one change: this server only, or every server of a cluster.
export function ClusterPicker({ clusters, cluster, onChange, disabled, inline }: ClusterPickerProps) {
  if (clusters.length === 0) {
    return null;
  }
  const select = (
    <Select
      value={cluster ?? ""}
      disabled={disabled}
      aria-label="ON CLUSTER"
      title="ON CLUSTER"
      onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
    >
      <option value="">{t("이 서버만")}</option>
      {clusters.map((name) => (
        <option key={name} value={name}>
          {inline === true ? `ON CLUSTER ${name}` : name}
        </option>
      ))}
    </Select>
  );
  if (inline === true) {
    return <span className="field cluster-picker inline">{select}</span>;
  }
  return (
    <label className="field cluster-picker">
      <span>ON CLUSTER</span>
      {select}
    </label>
  );
}

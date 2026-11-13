// A key's value by type, RedisInsight-style: a string or a RedisJSON
// document in the value panel (formatters, Quick Look's JSON explorer, a
// CodeMirror editor: ValuePanel.tsx); a hash, list, set, sorted set or
// stream as rows edited in place, new rows typed above them, a long value
// opened in the same panel, "Load more" below; a
// module's type as a note. Every change goes through /api/kv/edit with the
// safe-mode question first and is hidden on a read-only replica.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ErrorNotice, notifyError } from "../../../components/ErrorNotice";
import { Gauge } from "../../../components/Gauge";
import { CodeIcon, DownloadIcon, PlusIcon, SearchIcon, UpDownIcon } from "../../../components/icons";
import { Select } from "../../../components/Select";
import { formatBytes } from "../../../format";
import { t } from "../../../i18n";
import { edit, isAbort, read, type HashEntry, type KeyPage, type ListItem, type StreamEntry, type ZsetEntry } from "../api";
import { binBytes, binId, binText, consoleArg, isText, type Bin } from "../bin";
import { matchPattern } from "../keytree";
import { jsonError, minifyJson, stripBom } from "../valueFormat";
import { askWrite, copyText, downloadKey, type RedisHost } from "./common";
import { StreamAddModal } from "./Dialogs";
import { BinCell, RowsTable, type Col } from "./RowsTable";
import { BarButton, Bar, ValuePanel } from "./ValuePanel";

export interface ViewProps {
  host: RedisHost;
  db: number;
  keyName: Bin;
  // The key as messages show it.
  path: string;
  reloadSeq: number;
  // A change was saved: the key's facts (length, size) read again.
  onEdited(): void;
  onBusy(busy: boolean): void;
  onOpenCli(text: string): void;
}

const PAGE = 200;
const SCORE = /^\s*([+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?|[+-]?inf)\s*$/i;

// ---- pieces every view shares ----

// A MATCH filter for a hash's fields or a set's members, applied on ↩.
function FilterBox({ value, onApply, placeholder }: { value: string; onApply(text: string): void; placeholder: string }) {
  const [text, setText] = useState(value);
  return (
    <form
      className="kv-search kv-search-small"
      onSubmit={(event) => {
        event.preventDefault();
        onApply(text);
      }}
    >
      <SearchIcon size={11} />
      <input
        value={text}
        spellCheck={false}
        placeholder={placeholder}
        title={t("↩로 서버에서 찾습니다 (MATCH)")}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && text !== "") {
            event.preventDefault();
            setText("");
            onApply("");
          }
        }}
      />
    </form>
  );
}

function Body({ loading, error, onRetry, children }: { loading: boolean; error: unknown; onRetry(): void; children: ReactNode }) {
  return (
    <div className="kv-value-body">
      {error !== null ? (
        <div className="kv-value-error">
          <ErrorNotice error={error} context="data" engine="redis" variant="banner" onRetry={onRetry} />
        </div>
      ) : null}
      {children}
      {loading ? (
        <div className="kv-loading gauge-host" role="status">
          <Gauge busy />
          {t("불러오는 중…")}
        </div>
      ) : null}
    </div>
  );
}

// How many rows are shown (of how many), and "Load more": in the toolbar.
function Count({ shown, total, more, onMore }: { shown: number; total: number | null; more: boolean; onMore(): void }) {
  return (
    <span className="kv-count">
      <span>{total !== null ? t("{shown} / {total}개", { shown: shown.toLocaleString(), total: total.toLocaleString() }) : t("{shown}개", { shown: shown.toLocaleString() })}</span>
      {more ? (
        <button type="button" className="kv-link" onClick={onMore}>
          {t("더 불러오기")}
        </button>
      ) : null}
    </span>
  );
}

// One read at a time, the older one aborted; busy and errors reported.
function useReader(props: ViewProps) {
  const ctlRef = useRef<AbortController | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const { onBusy } = props;
  useEffect(() => onBusy(loading), [loading, onBusy]);
  useEffect(() => () => ctlRef.current?.abort(), []);
  const run = useCallback(
    async <P extends KeyPage["type"]>(req: Omit<Parameters<typeof read>[1], "db" | "key">, type: P): Promise<Extract<KeyPage, { type: P }> | null> => {
      ctlRef.current?.abort();
      const ctl = new AbortController();
      ctlRef.current = ctl;
      setLoading(true);
      setError(null);
      try {
        const page = await read(props.host.conn, { db: props.db, key: props.keyName, count: PAGE, ...req }, ctl.signal);
        // The key changed type meanwhile: the details read its facts again.
        if (page.type !== type) {
          props.onEdited();
          return null;
        }
        return page as Extract<KeyPage, { type: P }>;
      } catch (reason) {
        if (!isAbort(reason)) {
          setError(reason);
        }
        return null;
      } finally {
        if (ctlRef.current === ctl) {
          setLoading(false);
        }
      }
    },
    // The key's identity is its bytes; the props object changes every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.host.conn, props.db, binId(props.keyName)],
  );
  return { run, loading, error };
}

// The safe-mode question before a change (level 2 asks before every write).
function askSave(props: ViewProps, command: string): Promise<boolean> {
  return askWrite(props.host, { title: t("변경 저장"), message: t("{key}를 바꿉니다.", { key: props.path }), command, okLabel: t("저장") });
}

// Sends a change; a failure is thrown for the row to show.
async function save(props: ViewProps, op: Parameters<typeof edit>[3]): Promise<{ changed: number; id?: string }> {
  const done = await edit(props.host.conn, props.db, props.keyName, op);
  props.onEdited();
  props.host.onKeyChange({ kind: "changed", db: props.db, key: props.keyName });
  return done;
}

function byteCol<R>(id: string, label: string, get: (row: R) => Bin, extra: Partial<Col<R>> = {}, multiline = false): Col<R> {
  return { id, label, cell: (row, open) => <BinCell bin={get(row)} onOpen={open} />, open: get, edit: { value: (row) => (row === null ? "" : get(row)), multiline, placeholder: label }, ...extra };
}

// ---- string ----

export function StringView(props: ViewProps) {
  const { host, keyName, db } = props;
  const { run, loading, error } = useReader(props);
  const [page, setPage] = useState<Extract<KeyPage, { type: "string" }> | null>(null);
  const [whole, setWhole] = useState(false);

  const load = useCallback(async () => {
    const next = await run(whole ? { max_bytes: 64 * 1024 * 1024 } : {}, "string");
    if (next !== null) {
      setPage(next);
    }
  }, [run, whole]);
  useEffect(() => {
    void load();
  }, [load, props.reloadSeq]);

  return (
    <ValuePanel
      host={host}
      value={page?.value ?? null}
      label={t("값")}
      identity={binId(keyName)}
      editable={!host.readOnly && page !== null && !page.truncated}
      onSave={async (value) => {
        if (!(await askSave(props, `SET ${consoleArg(keyName)} ${consoleArg(value)} KEEPTTL`))) {
          return false;
        }
        try {
          await save(props, { op: "set_string", value });
          host.notify(t("저장했습니다"));
          void load();
          return true;
        } catch (reason) {
          notifyError(reason, { context: "data" });
          return false;
        }
      }}
      notes={
        page?.truncated === true ? (
          <span className="kv-bar-note">
            {t("앞 {shown} / 전체 {total}만 불러왔습니다 (편집하려면 모두 불러오세요)", { shown: formatBytes(binBytes(page.value).length) ?? "", total: formatBytes(page.total) ?? "" })}
            <button type="button" className="kv-link" onClick={() => setWhole(true)}>
              {t("모두 불러오기")}
            </button>
          </span>
        ) : null
      }
      actions={[{ label: t("값을 파일로 내려받기"), icon: <DownloadIcon size={11} />, onSelect: () => void downloadKey(host, db, keyName, "text") }]}
      frame={(content) => (
        <Body loading={loading} error={error} onRetry={() => void load()}>
          {content}
        </Body>
      )}
    />
  );
}

// ---- RedisJSON ----

// The document in the same viewer as a JSON string; saved with JSON.SET at
// the root.
export function JsonView(props: ViewProps) {
  const { host, keyName } = props;
  const { run, loading, error } = useReader(props);
  const [text, setText] = useState<string | null>(null);
  const load = useCallback(async () => {
    const page = await run({}, "json");
    if (page !== null) {
      setText(page.text);
    }
  }, [run]);
  useEffect(() => {
    void load();
  }, [load, props.reloadSeq]);
  return (
    <ValuePanel
      host={host}
      value={text}
      label="JSON"
      identity={binId(keyName)}
      editable={!host.readOnly && text !== null}
      onSave={async (value) => {
        const compact = isText(value) && jsonError(stripBom(value)) === null ? minifyJson(value) : null;
        if (compact === null) {
          notifyError(t("JSON 형식이 올바르지 않습니다"));
          return false;
        }
        if (!(await askSave(props, `JSON.SET ${consoleArg(keyName)} $ ${consoleArg(compact)}`))) {
          return false;
        }
        try {
          await save(props, { op: "json_set", path: "$", value: compact });
          host.notify(t("저장했습니다"));
          void load();
          return true;
        } catch (reason) {
          notifyError(reason, { context: "data" });
          return false;
        }
      }}
      frame={(content) => (
        <Body loading={loading} error={error} onRetry={() => void load()}>
          {content}
        </Body>
      )}
    />
  );
}

// ---- a module's type ----

export function OtherView({ kind, keyName, onOpenCli }: { kind: string; keyName: Bin; onOpenCli(text: string): void }) {
  return (
    <div className="kv-empty-state">
      <div className="kv-empty-title">{t("이 타입은 볼 수 없습니다: {kind}", { kind })}</div>
      <p className="panel-dim">{t("모듈이 만든 타입입니다. CLI에서 그 모듈의 명령으로 다루세요.")}</p>
      <button type="button" className="kv-btn" onClick={() => onOpenCli(`TYPE ${consoleArg(keyName)}`)}>
        <CodeIcon size={11} />
        {t("CLI에서 열기")}
      </button>
    </div>
  );
}

// ---- hash ----

const hashId = (entry: HashEntry) => binId(entry.field);

export function HashView(props: ViewProps) {
  const { host, keyName } = props;
  const { run, loading, error } = useReader(props);
  const [filter, setFilter] = useState("");
  const [entries, setEntries] = useState<HashEntry[]>([]);
  const [cursor, setCursor] = useState("0");
  const [total, setTotal] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const pattern = matchPattern(filter);

  const load = useCallback(
    async (from: string | null) => {
      const page = await run({ ...(from !== null ? { cursor: from } : {}), pattern }, "hash");
      if (page === null) {
        return;
      }
      setTotal(page.total);
      setCursor(page.cursor);
      setEntries((prev) => {
        if (from === null) {
          return page.entries;
        }
        const seen = new Set(prev.map(hashId));
        return [...prev, ...page.entries.filter((entry) => !seen.has(hashId(entry)))];
      });
    },
    [run, pattern],
  );
  useEffect(() => {
    void load(null);
  }, [load, props.reloadSeq]);

  const cols: Col<HashEntry>[] = [byteCol("field", t("필드"), (row) => row.field, { className: "kv-col-key" }), byteCol("value", t("값"), (row) => row.value, {}, true)];

  return (
    <div className="kv-value">
      <Bar count={<Count shown={entries.length} total={pattern === null ? total : null} more={cursor !== "0"} onMore={() => void load(cursor)} />} end={<FilterBox value={filter} onApply={setFilter} placeholder={t("필드 찾기")} />}>
        {!host.readOnly ? <BarButton icon={<PlusIcon size={11} />} label={t("필드 추가")} disabled={adding} onClick={() => setAdding(true)} /> : null}
      </Bar>
      <Body loading={loading} error={error} onRetry={() => void load(null)}>
        <RowsTable
          rows={entries}
          rowId={hashId}
          cols={cols}
          readOnly={host.readOnly}
          host={host}
          path={props.path}
          adding={adding}
          addLabel={t("필드 저장")}
          onAddClose={() => setAdding(false)}
          onAdd={async (list) => {
            if (!(await askSave(props, list.map((v) => `HSET ${consoleArg(keyName)} ${consoleArg(v.field)} …`).join("\n")))) {
              return;
            }
            let created = 0;
            for (const v of list) {
              created += (await save(props, { op: "hash_set", field: v.field, value: v.value })).changed;
            }
            setTotal((n) => (n === null ? n : n + created));
            const added = new Set(list.map((v) => binId(v.field)));
            setEntries((prev) => [...list.map((v) => ({ field: v.field, value: v.value })), ...prev.filter((entry) => !added.has(hashId(entry)))]);
            host.notify(t("저장했습니다"));
          }}
          onSave={async (row, v) => {
            const renamed = binId(row.field) !== binId(v.field);
            if (!(await askSave(props, renamed ? `HRENAME ${consoleArg(keyName)} ${consoleArg(row.field)} → ${consoleArg(v.field)}` : `HSET ${consoleArg(keyName)} ${consoleArg(v.field)} …`))) {
              return false;
            }
            if (renamed) {
              await save(props, { op: "hash_rename", field: row.field, to: v.field });
            }
            if (renamed || binId(row.value) !== binId(v.value)) {
              await save(props, { op: "hash_set", field: v.field, value: v.value });
            }
            setEntries((prev) => prev.map((entry) => (entry === row ? { field: v.field, value: v.value } : entry)));
            host.notify(t("저장했습니다"));
          }}
          onDelete={async (row) => {
            if (!(await askSave(props, `HDEL ${consoleArg(keyName)} ${consoleArg(row.field)}`))) {
              return;
            }
            await save(props, { op: "hash_delete", fields: [row.field] });
            setEntries((prev) => prev.filter((entry) => entry !== row));
            setTotal((n) => (n === null ? n : Math.max(0, n - 1)));
          }}
          onCopy={(row) => void copyText(host, binText(row.value))}
          empty={loading ? "" : pattern !== null ? t("조건에 맞는 필드가 없습니다") : t("필드가 없습니다")}
        />
      </Body>
    </div>
  );
}

// ---- list ----

const listId = (item: ListItem) => String(item.index);

export function ListView(props: ViewProps) {
  const { host, keyName } = props;
  const { run, loading, error } = useReader(props);
  const [items, setItems] = useState<ListItem[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [where, setWhere] = useState<"tail" | "head">("tail");

  const load = useCallback(
    async (offset: number) => {
      const page = await run({ offset }, "list");
      if (page !== null) {
        setItems((prev) => (offset === 0 ? page.items : [...prev, ...page.items]));
        setTotal(page.total);
      }
    },
    [run],
  );
  // After a change the indices may shift: the rows read so far are read again.
  const reload = useCallback(async () => {
    const page = await run({ offset: 0, count: Math.max(PAGE, items.length) }, "list");
    if (page !== null) {
      setItems(page.items);
      setTotal(page.total);
    }
  }, [run, items.length]);
  useEffect(() => {
    void load(0);
  }, [load, props.reloadSeq]);

  const cols: Col<ListItem>[] = [{ id: "index", label: "#", className: "kv-col-num", cell: (row) => row.index }, byteCol("value", t("요소"), (row) => row.value, {}, true)];

  return (
    <div className="kv-value">
      <Bar count={<Count shown={items.length} total={total} more={total !== null && items.length < total} onMore={() => void load(items.length)} />}>
        {!host.readOnly ? (
          <>
            <BarButton icon={<PlusIcon size={11} />} label={t("요소 넣기")} disabled={adding} onClick={() => setAdding(true)} />
            {adding ? (
              <Select className="kv-format" aria-label={t("넣을 자리")} value={where} onChange={(event) => setWhere(event.target.value as "tail" | "head")}>
                <option value="tail">{t("끝에 (RPUSH)")}</option>
                <option value="head">{t("앞에 (LPUSH)")}</option>
              </Select>
            ) : null}
          </>
        ) : null}
      </Bar>
      <Body loading={loading} error={error} onRetry={() => void load(0)}>
        <RowsTable
          rows={items}
          rowId={listId}
          cols={cols}
          readOnly={host.readOnly}
          host={host}
          path={props.path}
          adding={adding}
          addLabel={where === "head" ? t("앞에 넣기") : t("끝에 넣기")}
          onAddClose={() => setAdding(false)}
          onAdd={async (list) => {
            if (!(await askSave(props, `${where === "head" ? "LPUSH" : "RPUSH"} ${consoleArg(keyName)} …`))) {
              return;
            }
            await save(props, { op: "list_push", values: list.map((v) => v.value), head: where === "head" });
            host.notify(t("저장했습니다"));
            void reload();
          }}
          onSave={async (row, v) => {
            if (!(await askSave(props, `LSET ${consoleArg(keyName)} ${row.index} …`))) {
              return false;
            }
            await save(props, { op: "list_set", index: row.index, value: v.value, expect: row.value });
            setItems((prev) => prev.map((item) => (item === row ? { index: row.index, value: v.value } : item)));
            host.notify(t("저장했습니다"));
          }}
          onDelete={async (row) => {
            if (!(await askSave(props, `LSET ${consoleArg(keyName)} ${row.index} <marker> + LREM ${consoleArg(keyName)} 1 <marker>`))) {
              return;
            }
            await save(props, { op: "list_remove", index: row.index, expect: row.value });
            void reload();
          }}
          onCopy={(row) => void copyText(host, binText(row.value))}
          empty={loading ? "" : t("요소가 없습니다")}
        />
      </Body>
    </div>
  );
}

// ---- set ----

export function SetView(props: ViewProps) {
  const { host, keyName } = props;
  const { run, loading, error } = useReader(props);
  const [filter, setFilter] = useState("");
  const [members, setMembers] = useState<Bin[]>([]);
  const [cursor, setCursor] = useState("0");
  const [total, setTotal] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const pattern = matchPattern(filter);

  const load = useCallback(
    async (from: string | null) => {
      const page = await run({ ...(from !== null ? { cursor: from } : {}), pattern }, "set");
      if (page === null) {
        return;
      }
      setTotal(page.total);
      setCursor(page.cursor);
      setMembers((prev) => {
        if (from === null) {
          return page.members;
        }
        const seen = new Set(prev.map(binId));
        return [...prev, ...page.members.filter((member) => !seen.has(binId(member)))];
      });
    },
    [run, pattern],
  );
  useEffect(() => {
    void load(null);
  }, [load, props.reloadSeq]);

  const cols: Col<Bin>[] = [byteCol("member", t("멤버"), (row) => row)];

  return (
    <div className="kv-value">
      <Bar count={<Count shown={members.length} total={pattern === null ? total : null} more={cursor !== "0"} onMore={() => void load(cursor)} />} end={<FilterBox value={filter} onApply={setFilter} placeholder={t("멤버 찾기")} />}>
        {!host.readOnly ? <BarButton icon={<PlusIcon size={11} />} label={t("멤버 추가")} disabled={adding} onClick={() => setAdding(true)} /> : null}
      </Bar>
      <Body loading={loading} error={error} onRetry={() => void load(null)}>
        <RowsTable
          rows={members}
          rowId={binId}
          cols={cols}
          readOnly={host.readOnly}
          host={host}
          path={props.path}
          adding={adding}
          addLabel={t("멤버 저장")}
          onAddClose={() => setAdding(false)}
          onAdd={async (list) => {
            if (!(await askSave(props, `SADD ${consoleArg(keyName)} ${list.map((v) => consoleArg(v.member)).join(" ")}`))) {
              return;
            }
            const done = await save(props, { op: "set_add", members: list.map((v) => v.member) });
            const added = new Set(list.map((v) => binId(v.member)));
            setMembers((prev) => [...list.map((v) => v.member), ...prev.filter((member) => !added.has(binId(member)))]);
            setTotal((n) => (n === null ? n : n + done.changed));
            host.notify(t("저장했습니다"));
          }}
          onSave={async (row, v) => {
            if (binId(row) === binId(v.member) || !(await askSave(props, `SREM ${consoleArg(keyName)} ${consoleArg(row)} + SADD …`))) {
              return false;
            }
            await save(props, { op: "set_replace", member: row, to: v.member });
            setMembers((prev) => prev.map((member) => (member === row ? v.member : member)));
            host.notify(t("저장했습니다"));
          }}
          onDelete={async (row) => {
            if (!(await askSave(props, `SREM ${consoleArg(keyName)} ${consoleArg(row)}`))) {
              return;
            }
            await save(props, { op: "set_remove", members: [row] });
            setMembers((prev) => prev.filter((member) => member !== row));
            setTotal((n) => (n === null ? n : Math.max(0, n - 1)));
          }}
          onCopy={(row) => void copyText(host, binText(row))}
          empty={loading ? "" : pattern !== null ? t("조건에 맞는 멤버가 없습니다") : t("멤버가 없습니다")}
        />
      </Body>
    </div>
  );
}

// ---- sorted set ----

const zsetId = (entry: ZsetEntry) => binId(entry.member);

export function ZsetView(props: ViewProps) {
  const { host, keyName } = props;
  const { run, loading, error } = useReader(props);
  const [filter, setFilter] = useState("");
  const [rev, setRev] = useState(false);
  const [entries, setEntries] = useState<ZsetEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const pattern = matchPattern(filter);

  // By score a page at a time; with a filter, by ZSCAN's cursor.
  const load = useCallback(
    async (from: string | number | null) => {
      const page = await run(pattern !== null ? { pattern, ...(typeof from === "string" ? { cursor: from } : {}) } : { offset: typeof from === "number" ? from : 0, rev }, "zset");
      if (page === null) {
        return;
      }
      setTotal(page.total);
      setCursor(page.cursor);
      setEntries((prev) => {
        if (from === null || from === 0) {
          return page.entries;
        }
        const seen = new Set(prev.map(zsetId));
        return [...prev, ...page.entries.filter((entry) => !seen.has(zsetId(entry)))];
      });
    },
    [run, pattern, rev],
  );
  useEffect(() => {
    void load(null);
  }, [load, props.reloadSeq]);

  const cols: Col<ZsetEntry>[] = [
    byteCol("member", t("멤버"), (row) => row.member),
    { id: "score", label: t("점수"), className: "kv-col-score num", cell: (row) => <span className="mono">{row.score}</span>, edit: { value: (row) => row?.score ?? "0", plain: true, valid: (text) => SCORE.test(text), placeholder: "0" } },
  ];
  const more = pattern !== null ? cursor !== null && cursor !== "0" : total !== null && entries.length < total;

  return (
    <div className="kv-value">
      <Bar count={<Count shown={entries.length} total={pattern === null ? total : null} more={more} onMore={() => void load(pattern !== null ? cursor : entries.length)} />}
        end={
          <>
            <button type="button" className={`kv-btn${rev ? " on" : ""}`} disabled={pattern !== null} title={t("점수 순서 바꾸기")} aria-pressed={rev} onClick={() => setRev(!rev)}>
              <UpDownIcon size={10} />
              {rev ? t("점수 높은 순") : t("점수 낮은 순")}
            </button>
            <FilterBox value={filter} onApply={setFilter} placeholder={t("멤버 찾기")} />
          </>
        }
      >
        {!host.readOnly ? <BarButton icon={<PlusIcon size={11} />} label={t("멤버 추가")} disabled={adding} onClick={() => setAdding(true)} /> : null}
      </Bar>
      <Body loading={loading} error={error} onRetry={() => void load(null)}>
        <RowsTable
          rows={entries}
          rowId={zsetId}
          cols={cols}
          readOnly={host.readOnly}
          host={host}
          path={props.path}
          adding={adding}
          addLabel={t("멤버 저장")}
          onAddClose={() => setAdding(false)}
          onAdd={async (list) => {
            if (!(await askSave(props, `ZADD ${consoleArg(keyName)} ${list.map((v) => `${binText(v.score)} ${consoleArg(v.member)}`).join(" ")}`))) {
              return;
            }
            for (const v of list) {
              await save(props, { op: "zset_add", member: v.member, score: binText(v.score) });
            }
            host.notify(t("저장했습니다"));
            void load(null);
          }}
          onSave={async (row, v) => {
            const renamed = binId(row.member) !== binId(v.member);
            const score = binText(v.score);
            if (!(await askSave(props, renamed ? `ZREM ${consoleArg(keyName)} ${consoleArg(row.member)} + ZADD …` : `ZADD ${consoleArg(keyName)} ${score} ${consoleArg(v.member)}`))) {
              return false;
            }
            if (renamed) {
              await save(props, { op: "zset_rename", member: row.member, to: v.member, score });
            } else {
              await save(props, { op: "zset_add", member: v.member, score });
            }
            host.notify(t("저장했습니다"));
            void load(null);
          }}
          onDelete={async (row) => {
            if (!(await askSave(props, `ZREM ${consoleArg(keyName)} ${consoleArg(row.member)}`))) {
              return;
            }
            await save(props, { op: "zset_remove", members: [row.member] });
            setEntries((prev) => prev.filter((entry) => entry !== row));
            setTotal((n) => (n === null ? n : Math.max(0, n - 1)));
          }}
          onCopy={(row) => void copyText(host, binText(row.member))}
          empty={loading ? "" : pattern !== null ? t("조건에 맞는 멤버가 없습니다") : t("멤버가 없습니다")}
        />
      </Body>
    </div>
  );
}

// ---- stream ----

// "1700000000000-0" → when the entry was added.
function idTime(id: string): string {
  const ms = Number(id.split("-")[0]);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toLocaleString() : "";
}

export function StreamView(props: ViewProps) {
  const { host, keyName } = props;
  const { run, loading, error } = useReader(props);
  const [rev, setRev] = useState(false);
  const [entries, setEntries] = useState<StreamEntry[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(
    async (from: string | null) => {
      const page = await run({ rev, ...(from !== null ? { from } : {}) }, "stream");
      if (page !== null) {
        setEntries((prev) => {
          if (from === null) {
            return page.entries;
          }
          const seen = new Set(prev.map((entry) => entry.id));
          return [...prev, ...page.entries.filter((entry) => !seen.has(entry.id))];
        });
        setNext(page.next);
        setTotal(page.total);
      }
    },
    [run, rev],
  );
  useEffect(() => {
    void load(null);
  }, [load, props.reloadSeq]);

  // One column per field name the page has, in the order they first appear.
  const fields = useMemo(() => {
    const names: string[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      for (const [field] of entry.fields) {
        const name = binText(field);
        if (!seen.has(name) && names.length < 12) {
          seen.add(name);
          names.push(name);
        }
      }
    }
    return names;
  }, [entries]);

  const cols: Col<StreamEntry>[] = [
    { id: "id", label: "ID", className: "kv-col-id", cell: (row) => <span className="mono" title={idTime(row.id)}>{row.id}</span> },
    ...fields.map(
      (name): Col<StreamEntry> => ({
        id: `f:${name}`,
        label: name,
        cell: (row, open) => {
          const pair = row.fields.find(([field]) => binText(field) === name);
          return pair === undefined ? <span className="panel-dim">—</span> : <BinCell bin={pair[1]} onOpen={open} />;
        },
        open: (row) => row.fields.find(([field]) => binText(field) === name)?.[1] ?? "",
      }),
    ),
  ];

  return (
    <div className="kv-value">
      <Bar count={<Count shown={entries.length} total={total} more={next !== null} onMore={() => void load(next)} />}
        end={
          <button type="button" className={`kv-btn${rev ? " on" : ""}`} title={t("최신 항목부터 (XREVRANGE)")} aria-pressed={rev} onClick={() => setRev(!rev)}>
            <UpDownIcon size={10} />
            {rev ? t("최신 순") : t("오래된 순")}
          </button>
        }
      >
        {!host.readOnly ? <BarButton icon={<PlusIcon size={11} />} label={t("항목 추가")} onClick={() => setAdding(true)} /> : null}
      </Bar>
      <Body loading={loading} error={error} onRetry={() => void load(null)}>
        <RowsTable
          rows={entries}
          rowId={(entry) => entry.id}
          cols={cols}
          readOnly={host.readOnly}
          host={host}
          path={props.path}
          canEdit={false}
          adding={false}
          addLabel=""
          onAddClose={() => undefined}
          onAdd={async () => undefined}
          onSave={async () => undefined}
          onDelete={async (row) => {
            if (!(await askSave(props, `XDEL ${consoleArg(keyName)} ${row.id}`))) {
              return;
            }
            await save(props, { op: "stream_delete", ids: [row.id] });
            setEntries((prev) => prev.filter((entry) => entry !== row));
            setTotal((n) => (n === null ? n : Math.max(0, n - 1)));
          }}
          onCopy={(row) => void copyText(host, JSON.stringify({ id: row.id, fields: Object.fromEntries(row.fields.map(([f, v]) => [binText(f), binText(v)])) }, null, 2))}
          empty={loading ? "" : t("항목이 없습니다")}
        />
      </Body>
      {adding ? (
        <StreamAddModal
          path={props.path}
          onSave={async (id, pairs) => {
            if (!(await askSave(props, `XADD ${consoleArg(keyName)} ${id} …`))) {
              return;
            }
            const done = await save(props, { op: "stream_add", id, fields: pairs });
            host.notify(done.id !== undefined ? t("항목 {id}을(를) 추가했습니다", { id: done.id }) : t("저장했습니다"));
            void load(null);
          }}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </div>
  );
}

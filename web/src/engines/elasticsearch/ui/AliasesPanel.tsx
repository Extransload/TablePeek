// The 별칭 sub-tab of an index tab: the aliases of this index (or, when the
// tab is an alias, the indices behind it) with their filter, routing and
// write index; adding or changing one and removing one through `_aliases`.
// Removing an index (`remove_index`) is never offered here.

import { useEffect, useMemo, useState } from "react";
import { ErrorNotice, FieldError, fieldErrorProps, notifyError } from "../../../components/ErrorNotice";
import { PencilIcon, PlusIcon, RefreshIcon, TrashIcon } from "../../../components/icons";
import { LoadingState, Spinner } from "../../../components/Spinner";
import { SuggestInput } from "../../../components/SuggestInput";
import { t } from "../../../i18n";
import { JsonSyntaxError, parseJson, stringifyJson } from "../../mongodb/bson";
import { AdminModal } from "../../mongodb/ui/AdminModal";
import { aliases, getMapping, indices, isAbort, updateAliases, type AliasRow } from "../api";
import { completeDsl, type DslCompletion, type MappedField } from "../dsl";
import type { Json } from "../json";
import { ConsoleText, needsConfirm, requestText, type SearchHost } from "./common";
import { allMappedFields } from "./MappingPanel";
import { SearchEditor } from "./SearchEditor";
import type { IndexPanelProps, TargetKind } from "./types";
import "../../mongodb/mongodb.css";
import "../../mongodb/ui/panels.css";
import "./panels.css";

// `logs-*,metrics` as a test of one index name.
function nameMatcher(pattern: string): (name: string) => boolean {
  const tests = pattern
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .map((p) => {
      if (!p.includes("*")) {
        return p;
      }
      const literal = p.split("*").map((piece) => piece.replace(/[.+?^$()|[\]{}\\]/g, "\\$&"));
      return new RegExp(`^${literal.join(".*")}$`);
    });
  return (name) => tests.some((test) => (typeof test === "string" ? test === name : test.test(name)));
}

// An alias name as Elasticsearch takes it (the index name rules).
function aliasNameProblem(name: string): string | null {
  if (name === "") {
    return t("별칭 이름을 쓰세요");
  }
  if (name !== name.toLowerCase()) {
    return t("별칭 이름은 소문자만 쓸 수 있습니다");
  }
  if (/[\\/*?"<>| ,#:]/.test(name)) {
    return t("별칭 이름에 쓸 수 없는 글자가 있습니다 (\\ / * ? \" < > | 공백 , # :)");
  }
  if (/^[-_+]/.test(name) || name === "." || name === "..") {
    return t("별칭 이름은 -, _, +로 시작하거나 . 또는 ..일 수 없습니다");
  }
  return null;
}

function routingText(row: AliasRow): string {
  if (row.index_routing === null && row.search_routing === null) {
    return "";
  }
  return row.index_routing === row.search_routing ? (row.index_routing ?? "") : t("색인 {index} · 검색 {search}", { index: row.index_routing ?? "—", search: row.search_routing ?? "—" });
}

// The `add` action that keeps an alias as it is apart from its write flag.
function addAction(row: AliasRow, isWriteIndex: boolean | null): Json {
  const add: { [key: string]: Json } = { index: row.index, alias: row.alias };
  if (row.filter !== null && row.filter !== undefined) {
    add.filter = row.filter as Json;
  }
  if (row.index_routing !== null) {
    add.index_routing = row.index_routing;
  }
  if (row.search_routing !== null) {
    add.search_routing = row.search_routing;
  }
  if (isWriteIndex !== null) {
    add.is_write_index = isWriteIndex;
  }
  if (row.is_hidden) {
    add.is_hidden = true;
  }
  return { add };
}

export function AliasesPanel({ host, index, kind, refreshSeq, onChanged }: IndexPanelProps) {
  const [rows, setRows] = useState<AliasRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reloadSeq, setReloadSeq] = useState(0);
  const [fields, setFields] = useState<MappedField[]>([]);
  const [dialog, setDialog] = useState<{ row: AliasRow | null } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [openFilters, setOpenFilters] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const ctl = new AbortController();
    setError(null);
    aliases(host.conn, ctl.signal).then(
      (list) => setRows(list),
      (e: unknown) => {
        if (!isAbort(e)) {
          setError(e);
        }
      },
    );
    return () => ctl.abort();
  }, [host.conn, index, refreshSeq, reloadSeq]);

  // The fields offered while writing a filter.
  useEffect(() => {
    const ctl = new AbortController();
    getMapping(host.conn, index, ctl.signal).then(
      (reply) => setFields(allMappedFields(reply)),
      () => setFields([]),
    );
    return () => ctl.abort();
  }, [host.conn, index, refreshSeq]);

  const shown = useMemo(() => {
    if (rows === null) {
      return null;
    }
    const isTarget = nameMatcher(index);
    return rows.filter((row) => (kind === "alias" ? row.alias === index : isTarget(row.index))).sort((a, b) => a.alias.localeCompare(b.alias) || a.index.localeCompare(b.index));
  }, [rows, index, kind]);

  async function remove(row: AliasRow): Promise<void> {
    const actions: Json[] = [{ remove: { index: row.index, alias: row.alias } }];
    const ok = await host.confirm({
      title: t("별칭 삭제"),
      message: t("{index}에서 별칭 {alias}를 뗄까요?\n이 별칭으로 검색하거나 쓰던 곳은 더 이상 이 인덱스에 닿지 않습니다. 인덱스와 문서는 그대로입니다.", { index: row.index, alias: row.alias }),
      command: requestText("POST", "/_aliases", { actions }),
      okLabel: t("삭제"),
    });
    if (!ok) {
      return;
    }
    const key = `${row.alias}\u0000${row.index}`;
    setRemoving(key);
    try {
      await updateAliases(host.conn, actions);
      host.notify(t("별칭 {alias}를 뗐습니다", { alias: row.alias }));
      setReloadSeq((n) => n + 1);
      onChanged();
    } catch (e) {
      notifyError(e, { context: "structure" });
    } finally {
      setRemoving(null);
    }
  }

  function toggleFilter(key: string): void {
    setOpenFilters((set) => {
      const next = new Set(set);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  let body;
  if (error !== null) {
    body = <ErrorNotice error={error} context="structure" engine="elasticsearch" onRetry={() => setReloadSeq((n) => n + 1)} />;
  } else if (shown === null) {
    body = <LoadingState />;
  } else if (shown.length === 0) {
    body = <div className="panel-empty">{kind === "alias" ? t("이 별칭 뒤에 인덱스가 없습니다") : t("이 인덱스에는 별칭이 없습니다")}</div>;
  } else {
    body = (
      <section className="structure-section">
        <table className="panel-table es-alias-table">
          <thead>
            <tr>
              <th>{kind === "alias" ? t("인덱스 [하나]") : t("별칭")}</th>
              {kind !== "alias" && index.includes("*") ? <th>{t("인덱스 [하나]")}</th> : null}
              <th>{t("필터")}</th>
              <th>{t("라우팅")}</th>
              <th>{t("쓰기 인덱스")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => {
              const key = `${row.alias}\u0000${row.index}`;
              const filterOpen = openFilters.has(key);
              return (
                <tr key={key}>
                  <td className="mono">
                    {kind === "alias" ? row.index : row.alias}
                    {row.is_hidden ? <span className="es-chip dim">{t("숨김")}</span> : null}
                  </td>
                  {kind !== "alias" && index.includes("*") ? <td className="mono">{row.index}</td> : null}
                  <td className="es-alias-filter">
                    {row.filter === null || row.filter === undefined ? (
                      <span className="panel-dim">—</span>
                    ) : filterOpen ? (
                      <div className="es-filter-open">
                        <pre className="panel-pre">
                          <ConsoleText text={stringifyJson(row.filter, 2)} />
                        </pre>
                        <button type="button" className="icon-text-button" onClick={() => toggleFilter(key)}>
                          {t("접기")}
                        </button>
                      </div>
                    ) : (
                      <button type="button" className="es-filter-line mono" title={t("펼치기")} onClick={() => toggleFilter(key)}>
                        {stringifyJson(row.filter)}
                      </button>
                    )}
                  </td>
                  <td className="mono">{routingText(row) || <span className="panel-dim">—</span>}</td>
                  <td>{row.is_write_index === true ? <span className="mg-flag ok">{t("쓰기")}</span> : <span className="panel-dim">{row.is_write_index === false ? t("아니오") : "—"}</span>}</td>
                  <td className="num es-row-actions">
                    {host.readOnly ? null : (
                      <>
                        <button type="button" className="icon-text-button" disabled={removing !== null} onClick={() => setDialog({ row })}>
                          <PencilIcon size={10} />
                          {t("편집 [버튼]")}
                        </button>
                        <button type="button" className="icon-text-button mg-danger-text" disabled={removing !== null} onClick={() => void remove(row)}>
                          {removing === key ? <Spinner size={10} /> : <TrashIcon size={10} />}
                          {t("삭제")}
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    );
  }

  return (
    <div className="mg-pane es-pane">
      <div className="mg-agg-bar">
        <span className="mg-agg-count">{shown === null ? t("별칭") : kind === "alias" ? t("인덱스 {count}개", { count: shown.length }) : t("별칭 {count}개", { count: shown.length })}</span>
        <span className="spacer" />
        <button type="button" className="icon-button" title={t("새로고침")} aria-label={t("새로고침")} onClick={() => setReloadSeq((n) => n + 1)}>
          <RefreshIcon size={12} />
        </button>
        {host.readOnly || index.includes("*") || index.includes(",") ? null : (
          <button type="button" className="primary mg-find" onClick={() => setDialog({ row: null })}>
            <PlusIcon size={9} />
            {kind === "alias" ? t("인덱스 추가") : t("별칭 추가")}
          </button>
        )}
      </div>
      <div className="es-body">{body}</div>
      {dialog !== null && rows !== null ? (
        <AliasDialog
          host={host}
          index={index}
          kind={kind}
          row={dialog.row}
          rows={rows}
          fields={fields}
          onClose={() => setDialog(null)}
          onSaved={(alias) => {
            setDialog(null);
            host.notify(t("별칭 {alias}를 저장했습니다", { alias }));
            setReloadSeq((n) => n + 1);
            onChanged();
          }}
        />
      ) : null}
    </div>
  );
}

// The filter is a query: completion reads it as the value of `query`.
const FILTER_WRAP = '{"query":';

function AliasDialog({
  host,
  index,
  kind,
  row,
  rows,
  fields,
  onClose,
  onSaved,
}: {
  host: SearchHost;
  index: string;
  kind: TargetKind;
  // The alias being changed, or null for a new one.
  row: AliasRow | null;
  // Every alias of the cluster (for the write index already set).
  rows: AliasRow[];
  fields: MappedField[];
  onClose(): void;
  onSaved(alias: string): void;
}) {
  const [alias, setAlias] = useState(row?.alias ?? (kind === "alias" ? index : ""));
  const [target, setTarget] = useState(row?.index ?? (kind === "alias" ? "" : index));
  const [filter, setFilter] = useState(row?.filter !== null && row?.filter !== undefined ? stringifyJson(row.filter, 2) : "");
  const [routing, setRouting] = useState(row !== null && row.index_routing === row.search_routing ? (row.index_routing ?? "") : "");
  const [indexRouting, setIndexRouting] = useState(row?.index_routing ?? "");
  const [searchRouting, setSearchRouting] = useState(row?.search_routing ?? "");
  const [splitRouting, setSplitRouting] = useState(row !== null && row.index_routing !== row.search_routing);
  const [writeIndex, setWriteIndex] = useState(row?.is_write_index === true);
  const [indexNames, setIndexNames] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  // Data stream aliases take no routing.
  const routable = kind !== "data_stream";
  // Which side the user names: the alias for an index tab, the index for an
  // alias tab; the other is fixed (and both are when changing one).
  const askAlias = row === null && kind !== "alias";
  const askIndex = row === null && kind === "alias";

  useEffect(() => {
    if (!askIndex) {
      return;
    }
    const ctl = new AbortController();
    indices(host.conn, false, ctl.signal).then(
      (list) => setIndexNames(list.map((i) => i.name).filter((name) => !rows.some((r) => r.alias === index && r.index === name)).sort()),
      () => setIndexNames([]),
    );
    return () => ctl.abort();
  }, [askIndex, host.conn, index, rows]);

  const name = alias.trim();
  const on = target.trim();
  const nameProblem = askAlias ? aliasNameProblem(name) ?? (name === index ? t("인덱스와 같은 이름은 별칭으로 쓸 수 없습니다") : null) : null;
  const indexProblem = askIndex && on === "" ? t("인덱스를 고르세요") : null;

  const parsedFilter = useMemo((): { value: Json | null } | { error: string; at: number | null } => {
    if (filter.trim() === "") {
      return { value: null };
    }
    let value: unknown;
    try {
      value = parseJson(filter);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e), at: e instanceof JsonSyntaxError ? e.offset : null };
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { error: t("필터는 쿼리 객체여야 합니다 (예: {\"term\": {\"status\": \"paid\"}})"), at: null };
    }
    return { value: value as Json };
  }, [filter]);
  const filterProblem = "error" in parsedFilter ? parsedFilter.error : null;

  // The write flag moves: the index that has it now gives it up in the same
  // request, keeping the rest of its alias as it is.
  const previousWriter = writeIndex ? rows.find((r) => r.alias === name && r.index !== on && r.is_write_index === true) : undefined;

  const actions = useMemo((): Json[] | null => {
    if (nameProblem !== null || indexProblem !== null || !("value" in parsedFilter)) {
      return null;
    }
    const add: { [key: string]: Json } = { index: on, alias: name };
    if (parsedFilter.value !== null) {
      add.filter = parsedFilter.value;
    }
    if (routable) {
      if (splitRouting) {
        if (indexRouting.trim() !== "") {
          add.index_routing = indexRouting.trim();
        }
        if (searchRouting.trim() !== "") {
          add.search_routing = searchRouting.trim();
        }
      } else if (routing.trim() !== "") {
        add.routing = routing.trim();
      }
    }
    if (writeIndex) {
      add.is_write_index = true;
    } else if (row?.is_write_index === true) {
      add.is_write_index = false;
    }
    if (row?.is_hidden) {
      add.is_hidden = true;
    }
    return [...(previousWriter !== undefined ? [addAction(previousWriter, false)] : []), { add }];
  }, [nameProblem, indexProblem, parsedFilter, on, name, routable, splitRouting, indexRouting, searchRouting, routing, writeIndex, row, previousWriter]);

  const command = actions === null ? null : requestText("POST", "/_aliases", { actions });

  function complete(text: string, pos: number): DslCompletion | null {
    const result = completeDsl(FILTER_WRAP + text, pos + FILTER_WRAP.length, { fields, root: "search" });
    return result === null ? null : { ...result, from: result.from - FILTER_WRAP.length, to: result.to - FILTER_WRAP.length };
  }

  async function submit(): Promise<void> {
    if (busy || actions === null || command === null) {
      return;
    }
    if (needsConfirm("write", host.safeMode)) {
      const ok = await host.confirm({
        title: row === null ? t("별칭 추가") : t("별칭 편집"),
        message: t("{index}에 별칭 {alias}를 저장할까요?", { index: on, alias: name }),
        command,
        okLabel: t("저장"),
      });
      if (!ok) {
        return;
      }
    }
    setBusy(true);
    setFailure(null);
    try {
      await updateAliases(host.conn, actions);
      onSaved(name);
    } catch (e) {
      setFailure(e);
      setBusy(false);
    }
  }

  return (
    <AdminModal
      title={row !== null ? t("별칭 편집") : kind === "alias" ? t("별칭에 인덱스 추가") : t("별칭 추가")}
      path={askAlias ? index : askIndex ? name : `${name} → ${on}`}
      className="es-modal wide"
      busy={busy}
      onClose={onClose}
      foot={
        <>
          <span className="spacer" />
          <button type="button" onClick={onClose} disabled={busy}>
            {t("취소")}
          </button>
          <button type="button" className="primary" disabled={busy || actions === null} onClick={() => void submit()}>
            {busy ? <Spinner size={10} /> : null}
            {t("저장")}
          </button>
        </>
      }
    >
      {askAlias ? (
        <label className="mg-form-row">
          <span className="mg-form-label">{t("별칭 이름")}</span>
          <input
            type="text"
            className="mg-input mono"
            spellCheck={false}
            autoFocus
            value={alias}
            {...fieldErrorProps("es-alias-name", name === "" ? null : nameProblem)}
            onChange={(event) => {
              setAlias(event.target.value);
              setFailure(null);
            }}
          />
          <FieldError id="es-alias-name" error={name === "" ? null : nameProblem} />
        </label>
      ) : null}
      {askIndex ? (
        <label className="mg-form-row">
          <span className="mg-form-label">{t("인덱스 [하나]")}</span>
          <SuggestInput
            type="text"
            className="mg-input mono"
            spellCheck={false}
            autoFocus
            suggestions={indexNames}
            placeholder={t("인덱스 이름")}
            value={target}
            onChange={(event) => {
              setTarget(event.target.value);
              setFailure(null);
            }}
          />
        </label>
      ) : null}
      <div className="mg-form-row">
        <span className="mg-form-label">{t("필터 (선택, 이 쿼리에 맞는 문서만 별칭으로 보입니다)")}</span>
        <SearchEditor
          value={filter}
          onChange={(next) => {
            setFilter(next);
            setFailure(null);
          }}
          onRun={() => void submit()}
          complete={complete}
          error={"error" in parsedFilter && parsedFilter.at !== null ? { from: parsedFilter.at, to: parsedFilter.at + 1 } : null}
          placeholder={'{ "term": { "status": "paid" } }'}
          className="es-filter-editor"
          ariaLabel={t("필터")}
        />
        <FieldError id="es-alias-filter" error={filterProblem} />
      </div>
      {routable ? (
        splitRouting ? (
          <div className="mg-form-grid">
            <label className="mg-form-row">
              <span className="mg-form-label">{t("색인 라우팅 (index_routing)")}</span>
              <input type="text" className="mg-input mono" spellCheck={false} value={indexRouting} onChange={(event) => setIndexRouting(event.target.value)} />
            </label>
            <label className="mg-form-row">
              <span className="mg-form-label">{t("검색 라우팅 (search_routing)")}</span>
              <input type="text" className="mg-input mono" spellCheck={false} value={searchRouting} onChange={(event) => setSearchRouting(event.target.value)} />
            </label>
          </div>
        ) : (
          <label className="mg-form-row">
            <span className="mg-form-label">{t("라우팅 (선택, 색인과 검색 모두)")}</span>
            <input type="text" className="mg-input mono" spellCheck={false} value={routing} onChange={(event) => setRouting(event.target.value)} />
          </label>
        )
      ) : null}
      <div className="mg-checks">
        <label>
          <input type="checkbox" checked={writeIndex} onChange={(event) => setWriteIndex(event.target.checked)} />
          {t("쓰기 인덱스 (is_write_index: 이 별칭으로 쓰는 문서가 여기로)")}
        </label>
        {routable ? (
          <label>
            <input
              type="checkbox"
              checked={splitRouting}
              onChange={(event) => {
                setSplitRouting(event.target.checked);
                if (event.target.checked) {
                  setIndexRouting(routing);
                  setSearchRouting(routing);
                } else {
                  setRouting(indexRouting);
                }
              }}
            />
            {t("색인·검색 라우팅 따로")}
          </label>
        ) : null}
      </div>
      {previousWriter !== undefined ? <div className="mg-verdict warn">{t("지금 쓰기 인덱스인 {index}는 같은 요청에서 쓰기 인덱스를 내려놓습니다", { index: previousWriter.index })}</div> : null}
      <div className="mg-form-label">{t("보낼 요청")}</div>
      <pre className="panel-pre mg-ix-preview">{command !== null ? <ConsoleText text={command} /> : <span className="panel-dim">{name === "" && askAlias ? nameProblem : askIndex ? indexProblem ?? "—" : "—"}</span>}</pre>
      {failure !== null ? <ErrorNotice error={failure} context="structure" engine="elasticsearch" variant="compact" /> : null}
    </AdminModal>
  );
}

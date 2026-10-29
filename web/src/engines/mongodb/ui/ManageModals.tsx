// Database and collection management (MONGODB.md §6.2 데이터베이스·컬렉션
// 관리): making a database (with its first collection), a collection
// (capped, time series, collation, clustered, a validation rule) or a view,
// renaming, dropping a collection or a database (typing its name to
// confirm), a collection's statistics, and the import and export dialogs.
// Each dialog shows the mongosh command it will send. The sidebar, the
// connection's ⋯ menu and App ask for one through `DocAdminRequest`; what
// changed comes back as a `DocAdminEffect` so App can refresh the sidebar
// and close or retarget the tabs involved.

import { useEffect, useMemo, useState } from "react";
import { Select } from "../../../components/Select";
import { Spinner } from "../../../components/Spinner";
import { formatBytes } from "../../../format";
import { t } from "../../../i18n";
import type { SafeMode } from "../../../sqlTools";
import { collStats, createCollection, dropCollection, dropDatabase, listCollections, renameCollection, type CollStats, type CollectionInfo } from "../api";
import { Int32, Int64, isDocument, type BsonDocument } from "../bson";
import { toShell, toShellPretty } from "../format";
import { parseValue } from "../shell/parse";
import { AdminModal, CommandPreview, Failure, collectionNameProblem, databaseNameProblem, shellNamespace } from "./AdminModal";
import { ExportModal } from "./ExportModal";
import { ImportModal } from "./ImportModal";
import { MongoEditor } from "./MongoEditor";
import { ShellText } from "./ShellText";

export type DocAdminRequest =
  | { kind: "createDatabase" }
  | { kind: "createCollection"; db: string; view?: boolean }
  | { kind: "rename"; db: string; coll: string }
  // `coll` null: the whole database.
  | { kind: "drop"; db: string; coll: string | null; view?: boolean }
  | { kind: "stats"; db: string; coll: string }
  // `coll` null: the dialog asks which collection.
  | { kind: "import"; db: string; coll: string | null }
  | { kind: "export"; db: string; coll: string };

export type DocAdminEffect =
  | { kind: "created"; db: string; coll: string; view: boolean }
  | { kind: "dropped"; db: string; coll: string | null }
  | { kind: "renamed"; db: string; from: string; to: string }
  | { kind: "imported"; db: string; coll: string };

// Databases MongoDB keeps for itself; they are never dropped from here.
export const SYSTEM_DATABASES: Record<string, true> = { admin: true, local: true, config: true };

// ---- 만들기 ----

type CollKind = "plain" | "capped" | "timeseries" | "view";

const VALIDATOR_DRAFT = `{
  $jsonSchema: {
    bsonType: "object",
    required: [],
    properties: {}
  }
}`;

// 데이터베이스 만들기 (db null: its name is asked too, with the first
// collection MongoDB needs to keep it), 컬렉션 만들기 and 뷰 만들기.
function CreateModal({ conn, db, view, onEffect, onClose }: { conn: string; db: string | null; view: boolean; onEffect(effect: DocAdminEffect): void; onClose(): void }) {
  const [dbName, setDbName] = useState(db ?? "");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<CollKind>(view ? "view" : "plain");
  const [cappedSize, setCappedSize] = useState("1048576");
  const [cappedMax, setCappedMax] = useState("");
  const [timeField, setTimeField] = useState("timestamp");
  const [metaField, setMetaField] = useState("");
  const [granularity, setGranularity] = useState("");
  const [expire, setExpire] = useState("");
  const [viewOn, setViewOn] = useState("");
  const [pipelineText, setPipelineText] = useState("[\n  { $match: {} }\n]");
  const [locale, setLocale] = useState("");
  const [strength, setStrength] = useState("");
  const [clustered, setClustered] = useState(false);
  const [validatorOn, setValidatorOn] = useState(false);
  const [validatorText, setValidatorText] = useState(VALIDATOR_DRAFT);
  const [validationLevel, setValidationLevel] = useState("strict");
  const [validationAction, setValidationAction] = useState("error");
  const [sources, setSources] = useState<CollectionInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  // The collections a view can be made on.
  useEffect(() => {
    if (db === null) {
      return;
    }
    const controller = new AbortController();
    listCollections(conn, db, controller.signal).then(
      (list) => {
        const names = list.filter((c) => !c.name.startsWith("system.")).sort((a, b) => a.name.localeCompare(b.name));
        setSources(names);
        setViewOn((current) => current || (names[0]?.name ?? ""));
      },
      () => setSources([]),
    );
    return () => controller.abort();
  }, [conn, db]);

  const target = dbName.trim();
  const collName = name.trim();
  const plan = useMemo((): { options: BsonDocument; command: string } | { error: string } => {
    const problem = databaseNameProblem(target) ?? collectionNameProblem(collName);
    if (problem !== null) {
      return { error: problem };
    }
    const options: BsonDocument = {};
    const integer = (text: string, label: string, min: number): Int32 | Int64 | null | { error: string } => {
      const trimmed = text.trim();
      if (trimmed === "") {
        return null;
      }
      if (!/^\d+$/.test(trimmed) || Number(trimmed) < min) {
        return { error: t("{label}: {min} 이상의 정수를 쓰세요", { label, min }) };
      }
      return Number(trimmed) <= 2147483647 ? new Int32(Number(trimmed)) : new Int64(trimmed);
    };
    if (kind === "view") {
      if (viewOn === "") {
        return { error: t("뷰의 바탕 컬렉션을 고르세요") };
      }
      const parsed = parseValue(pipelineText);
      if (!parsed.ok) {
        return { error: t("파이프라인: {message}", { message: parsed.error.message }) };
      }
      if (!Array.isArray(parsed.value) || !parsed.value.every(isDocument)) {
        return { error: t("파이프라인은 단계 문서의 배열이어야 합니다") };
      }
      options.viewOn = viewOn;
      options.pipeline = parsed.value;
    }
    if (kind === "capped") {
      const size = integer(cappedSize, t("최대 크기"), 1);
      const max = integer(cappedMax, t("최대 문서 수"), 1);
      if (size === null) {
        return { error: t("capped 컬렉션은 최대 크기(바이트)가 있어야 합니다") };
      }
      if ("error" in size) {
        return size;
      }
      if (max !== null && "error" in max) {
        return max;
      }
      options.capped = true;
      options.size = size;
      if (max !== null) {
        options.max = max;
      }
    }
    if (kind === "timeseries") {
      if (timeField.trim() === "") {
        return { error: t("시간 필드를 쓰세요") };
      }
      const ts: BsonDocument = { timeField: timeField.trim() };
      if (metaField.trim() !== "") {
        ts.metaField = metaField.trim();
      }
      if (granularity !== "") {
        ts.granularity = granularity;
      }
      options.timeseries = ts;
      const seconds = integer(expire, t("만료"), 1);
      if (seconds !== null && "error" in seconds) {
        return seconds;
      }
      if (seconds !== null) {
        options.expireAfterSeconds = seconds;
      }
    }
    if (locale.trim() !== "") {
      const collation: BsonDocument = { locale: locale.trim() };
      if (strength !== "") {
        collation.strength = new Int32(Number(strength));
      }
      options.collation = collation;
    }
    if (kind === "plain" && clustered) {
      options.clusteredIndex = { key: { _id: new Int32(1) }, unique: true };
    }
    if (kind !== "view" && validatorOn) {
      const parsed = parseValue(validatorText);
      if (!parsed.ok) {
        return { error: t("검증 규칙: {message}", { message: parsed.error.message }) };
      }
      if (!isDocument(parsed.value)) {
        return { error: t("검증 규칙은 문서여야 합니다") };
      }
      options.validator = parsed.value;
      options.validationLevel = validationLevel;
      options.validationAction = validationAction;
    }
    const base = `db.getSiblingDB(${JSON.stringify(target)})`;
    let command: string;
    if (kind === "view") {
      const { viewOn: on, pipeline, ...rest } = options;
      command = `${base}.createView(${JSON.stringify(collName)}, ${JSON.stringify(on)}, ${toShellPretty(pipeline)}${Object.keys(rest).length > 0 ? `, ${toShell(rest)}` : ""})`;
    } else {
      command = `${base}.createCollection(${JSON.stringify(collName)}${Object.keys(options).length > 0 ? `, ${toShellPretty(options)}` : ""})`;
    }
    return { options, command };
  }, [target, collName, kind, viewOn, pipelineText, cappedSize, cappedMax, timeField, metaField, granularity, expire, locale, strength, clustered, validatorOn, validatorText, validationLevel, validationAction]);

  const submit = async () => {
    if (busy || "error" in plan) {
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      await createCollection(conn, target, collName, plan.options);
      onEffect({ kind: "created", db: target, coll: collName, view: kind === "view" });
      onClose();
    } catch (error) {
      setFailure(error);
      setBusy(false);
    }
  };

  const title = db === null ? t("데이터베이스 만들기") : kind === "view" ? t("뷰 만들기") : t("컬렉션 만들기");
  const kinds: { id: CollKind; label: string }[] = [
    { id: "plain", label: t("일반") },
    { id: "capped", label: "capped" },
    { id: "timeseries", label: t("시계열") },
    ...(db !== null ? [{ id: "view" as const, label: t("뷰") }] : []),
  ];
  const sizeText = formatBytes(Number(cappedSize));
  return (
    <AdminModal
      title={title}
      path={db ?? undefined}
      className="mg-create-modal"
      busy={busy}
      onClose={onClose}
      foot={
        <>
          <span className="spacer" />
          <button type="button" onClick={onClose} disabled={busy}>
            {t("취소")}
          </button>
          <button type="button" className="primary" disabled={busy || "error" in plan} onClick={() => void submit()}>
            {busy ? <Spinner size={10} /> : null}
            {t("만들기")}
          </button>
        </>
      }
    >
      <div className="mg-form-grid">
        {db === null ? (
          <label className="mg-form-row">
            <span className="mg-form-label">{t("데이터베이스 이름")}</span>
            <input type="text" className="mg-input" placeholder={t("예: analytics")} spellCheck={false} autoFocus value={dbName} onChange={(event) => setDbName(event.target.value)} />
          </label>
        ) : null}
        <label className="mg-form-row">
          <span className="mg-form-label">{db === null ? t("첫 컬렉션 이름") : kind === "view" ? t("뷰 이름") : t("컬렉션 이름")}</span>
          <input type="text" className="mg-input" placeholder={t("예: events")} spellCheck={false} autoFocus={db !== null} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
      </div>
      {db === null ? <span className="panel-dim">{t("MongoDB는 컬렉션이 하나 이상 있어야 데이터베이스를 남깁니다")}</span> : null}
      <div className="mg-subtabs mg-seg" role="radiogroup" aria-label={t("종류")}>
        {kinds.map((k) => (
          <button key={k.id} type="button" role="radio" aria-checked={kind === k.id} className={kind === k.id ? "active" : undefined} onClick={() => setKind(k.id)}>
            {k.label}
          </button>
        ))}
      </div>
      {kind === "capped" ? (
        <div className="mg-form-grid">
          <label className="mg-form-row">
            <span className="mg-form-label">
              {t("최대 크기 (바이트)")}
              {sizeText !== null ? ` · ${sizeText}` : ""}
            </span>
            <input type="text" inputMode="numeric" className="mg-input mono" value={cappedSize} onChange={(event) => setCappedSize(event.target.value)} />
          </label>
          <label className="mg-form-row">
            <span className="mg-form-label">{t("최대 문서 수 (비우면 제한 없음)")}</span>
            <input type="text" inputMode="numeric" className="mg-input mono" value={cappedMax} onChange={(event) => setCappedMax(event.target.value)} />
          </label>
        </div>
      ) : null}
      {kind === "timeseries" ? (
        <div className="mg-form-grid">
          <label className="mg-form-row">
            <span className="mg-form-label">{t("시간 필드 (timeField)")}</span>
            <input type="text" className="mg-input mono" spellCheck={false} value={timeField} onChange={(event) => setTimeField(event.target.value)} />
          </label>
          <label className="mg-form-row">
            <span className="mg-form-label">{t("메타 필드 (metaField, 선택)")}</span>
            <input type="text" className="mg-input mono" spellCheck={false} value={metaField} onChange={(event) => setMetaField(event.target.value)} />
          </label>
          <label className="mg-form-row">
            <span className="mg-form-label">{t("단위 (granularity)")}</span>
            <Select className="mg-input" value={granularity} onChange={(event) => setGranularity(event.target.value)}>
              <option value="">{t("기본 (seconds)")}</option>
              <option value="seconds">seconds</option>
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
            </Select>
          </label>
          <label className="mg-form-row">
            <span className="mg-form-label">{t("만료 초 (expireAfterSeconds, 선택)")}</span>
            <input type="text" inputMode="numeric" className="mg-input mono" value={expire} onChange={(event) => setExpire(event.target.value)} />
          </label>
        </div>
      ) : null}
      {kind === "view" ? (
        <>
          <label className="mg-form-row">
            <span className="mg-form-label">{t("바탕 컬렉션 (viewOn)")}</span>
            <Select className="mg-input" value={viewOn} onChange={(event) => setViewOn(event.target.value)}>
              {sources.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </Select>
          </label>
          <div className="mg-form-label">{t("파이프라인")}</div>
          <MongoEditor value={pipelineText} onChange={setPipelineText} role="pipeline" className="mg-admin-editor" ariaLabel={t("파이프라인")} />
        </>
      ) : null}
      <div className="mg-form-grid">
        <label className="mg-form-row">
          <span className="mg-form-label">{t("콜레이션 로캘 (선택, 예: ko)")}</span>
          <input type="text" className="mg-input mono" spellCheck={false} value={locale} onChange={(event) => setLocale(event.target.value)} />
        </label>
        <label className="mg-form-row">
          <span className="mg-form-label">{t("비교 강도 (strength)")}</span>
          <Select className="mg-input" value={strength} disabled={locale.trim() === ""} onChange={(event) => setStrength(event.target.value)}>
            <option value="">{t("기본 (3)")}</option>
            <option value="1">{t("1 — 기본 글자만")}</option>
            <option value="2">{t("2 — 악센트 구분")}</option>
            <option value="3">{t("3 — 대소문자 구분")}</option>
            <option value="4">4</option>
            <option value="5">{t("5 — 모두 구분")}</option>
          </Select>
        </label>
      </div>
      {kind !== "view" ? (
        <div className="mg-checks">
          {kind === "plain" ? (
            <label title={t("_id 순서로 저장합니다 (MongoDB 5.3+)")}>
              <input type="checkbox" checked={clustered} onChange={(event) => setClustered(event.target.checked)} />
              {t("클러스터드 (_id 순서로 저장)")}
            </label>
          ) : null}
          <label>
            <input type="checkbox" checked={validatorOn} onChange={(event) => setValidatorOn(event.target.checked)} />
            {t("검증 규칙")}
          </label>
          {validatorOn ? (
            <>
              <Select className="mg-input" aria-label="validationLevel" value={validationLevel} onChange={(event) => setValidationLevel(event.target.value)}>
                <option value="strict">strict</option>
                <option value="moderate">moderate</option>
                <option value="off">off</option>
              </Select>
              <Select className="mg-input" aria-label="validationAction" value={validationAction} onChange={(event) => setValidationAction(event.target.value)}>
                <option value="error">error</option>
                <option value="warn">warn</option>
              </Select>
            </>
          ) : null}
        </div>
      ) : null}
      {kind !== "view" && validatorOn ? <MongoEditor value={validatorText} onChange={setValidatorText} role="filter" className="mg-admin-editor" ariaLabel={t("검증 규칙")} /> : null}
      <CommandPreview command={"error" in plan ? null : plan.command} problem={"error" in plan ? plan.error : null} />
      <Failure error={failure} />
    </AdminModal>
  );
}

// ---- 이름 바꾸기 ----

function RenameModal({ conn, db, coll, onEffect, onClose }: { conn: string; db: string; coll: string; onEffect(effect: DocAdminEffect): void; onClose(): void }) {
  const [name, setName] = useState(coll);
  const [dropTarget, setDropTarget] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const to = name.trim();
  const problem = to === coll ? t("다른 이름을 쓰세요") : collectionNameProblem(to);
  const command = `${shellNamespace(db, coll)}.renameCollection(${JSON.stringify(to)}${dropTarget ? ", true" : ""})`;

  const submit = async () => {
    if (busy || problem !== null) {
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      await renameCollection(conn, db, coll, to, dropTarget);
      onEffect({ kind: "renamed", db, from: coll, to });
      onClose();
    } catch (error) {
      setFailure(error);
      setBusy(false);
    }
  };

  return (
    <AdminModal
      title={t("컬렉션 이름 바꾸기")}
      path={`${db}.${coll}`}
      busy={busy}
      onClose={onClose}
      foot={
        <>
          <span className="spacer" />
          <button type="button" onClick={onClose} disabled={busy}>
            {t("취소")}
          </button>
          <button type="button" className={`primary${dropTarget ? " danger" : ""}`} disabled={busy || problem !== null} onClick={() => void submit()}>
            {busy ? <Spinner size={10} /> : null}
            {t("바꾸기")}
          </button>
        </>
      }
    >
      <label className="mg-form-row">
        <span className="mg-form-label">{t("새 이름")}</span>
        <input
          type="text"
          className="mg-input"
          spellCheck={false}
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void submit();
            }
          }}
        />
      </label>
      <div className="mg-checks">
        <label>
          <input type="checkbox" checked={dropTarget} onChange={(event) => setDropTarget(event.target.checked)} />
          {t("같은 이름의 컬렉션이 있으면 지우고 바꾸기 (dropTarget)")}
        </label>
      </div>
      <CommandPreview command={command} problem={problem} />
      <Failure error={failure} />
    </AdminModal>
  );
}

// ---- 삭제 ----

// Dropping a collection, a view or a database. With safe mode on the name
// must be typed before the button works; with it off the dialog is a plain
// yes/no, as the SQL side's table and database drops are.
function DropModal({ conn, db, coll, view, safeMode, onEffect, onClose }: { conn: string; db: string; coll: string | null; view: boolean; safeMode: SafeMode; onEffect(effect: DocAdminEffect): void; onClose(): void }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [scope, setScope] = useState<string | null>(null);
  const name = coll ?? db;

  // What goes with it: the collections of a database, the documents of a collection.
  useEffect(() => {
    const controller = new AbortController();
    if (coll === null) {
      listCollections(conn, db, controller.signal).then(
        (list) => setScope(t("컬렉션 {count}개가 함께 지워집니다.", { count: list.filter((c) => !c.name.startsWith("system.")).length })),
        () => setScope(null),
      );
    } else if (!view) {
      collStats({ conn, db, coll }, controller.signal).then(
        (stats) => setScope(t("문서 {count}개와 인덱스 {indexes}개가 함께 지워집니다.", { count: stats.count.toLocaleString(), indexes: stats.nindexes })),
        () => setScope(null),
      );
    }
    return () => controller.abort();
  }, [conn, db, coll, view]);

  const command = coll === null ? `db.getSiblingDB(${JSON.stringify(db)}).dropDatabase()` : `${shellNamespace(db, coll)}.drop()`;
  const title = coll === null ? t("데이터베이스 삭제") : view ? t("뷰 삭제") : t("컬렉션 삭제");
  const askName = safeMode !== 0;
  const ready = !askName || typed === name;

  const submit = async () => {
    if (busy || !ready) {
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      if (coll === null) {
        await dropDatabase(conn, db);
      } else {
        await dropCollection(conn, db, coll);
      }
      onEffect({ kind: "dropped", db, coll });
      onClose();
    } catch (error) {
      setFailure(error);
      setBusy(false);
    }
  };

  return (
    <AdminModal
      title={title}
      path={coll === null ? db : `${db}.${coll}`}
      busy={busy}
      danger
      onClose={onClose}
      foot={
        <>
          <span className="spacer" />
          <button type="button" onClick={onClose} disabled={busy}>
            {t("취소")}
          </button>
          <button type="button" className="primary danger" disabled={busy || !ready} onClick={() => void submit()}>
            {busy ? <Spinner size={10} /> : null}
            {t("삭제")}
          </button>
        </>
      }
    >
      <p className="review-lead">
        {coll === null ? t("{name} 데이터베이스와 그 안의 모든 것을 지웁니다. 되돌릴 수 없습니다.", { name }) : view ? t("{name} 뷰를 지웁니다. 바탕 컬렉션의 문서는 남습니다.", { name }) : t("{name} 컬렉션과 그 인덱스를 지웁니다. 되돌릴 수 없습니다.", { name })}
        {scope !== null ? ` ${scope}` : ""}
      </p>
      {askName ? (
        <label className="mg-form-row">
          <span className="mg-form-label">{t("확인하려면 이름을 그대로 입력하세요: {name}", { name })}</span>
          <input
            type="text"
            className="mg-input mono"
            spellCheck={false}
            autoComplete="off"
            autoFocus
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submit();
              }
            }}
          />
        </label>
      ) : null}
      <CommandPreview command={command} problem={null} />
      <Failure error={failure} />
    </AdminModal>
  );
}

// ---- 통계 ----

function StatsModal({ conn, db, coll, onClose }: { conn: string; db: string; coll: string; onClose(): void }) {
  const [stats, setStats] = useState<CollStats | null>(null);
  const [info, setInfo] = useState<CollectionInfo | null>(null);
  const [failure, setFailure] = useState<unknown>(null);

  useEffect(() => {
    const controller = new AbortController();
    collStats({ conn, db, coll }, controller.signal).then(setStats, (error: unknown) => setFailure(error));
    listCollections(conn, db, controller.signal).then(
      (list) => setInfo(list.find((c) => c.name === coll) ?? null),
      () => setInfo(null),
    );
    return () => controller.abort();
  }, [conn, db, coll]);

  const rows: [string, string][] =
    stats === null
      ? []
      : [
          [t("문서"), stats.count.toLocaleString()],
          [t("크기 (BSON)"), formatBytes(stats.size) ?? "—"],
          [t("평균 문서 크기"), formatBytes(stats.avgObjSize) ?? "—"],
          [t("디스크 크기"), formatBytes(stats.storageSize) ?? "—"],
          [t("인덱스"), stats.nindexes.toLocaleString()],
          [t("인덱스 크기"), formatBytes(stats.totalIndexSize) ?? "—"],
        ];
  const options = info !== null && Object.keys(info.options).length > 0 ? info.options : null;
  return (
    <AdminModal
      title={t("컬렉션 통계")}
      path={`${db}.${coll}`}
      busy={false}
      onClose={onClose}
      foot={
        <>
          <span className="spacer" />
          <button type="button" className="primary" onClick={onClose}>
            {t("닫기")}
          </button>
        </>
      }
    >
      {stats === null && failure === null ? <Spinner size={12} /> : null}
      <Failure error={failure} />
      {stats !== null ? (
        <>
          <div className="mg-stats-grid">
            {rows.map(([k, v]) => (
              <div key={k} className="mg-stats-cell">
                <div className="mg-form-label">{k}</div>
                <div className="mono">{v}</div>
              </div>
            ))}
            {info !== null ? (
              <div className="mg-stats-cell">
                <div className="mg-form-label">{t("종류")}</div>
                <div className="mono">{info.type === "timeseries" ? t("시계열") : info.type === "view" ? t("뷰") : options?.capped === true ? "capped" : t("일반")}</div>
              </div>
            ) : null}
          </div>
          {Object.keys(stats.indexSizes).length > 0 ? (
            <table className="panel-table mg-stats-table">
              <thead>
                <tr>
                  <th>{t("인덱스")}</th>
                  <th className="num">{t("크기")}</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(stats.indexSizes).map(([index, size]) => (
                  <tr key={index}>
                    <td className="mono">{index}</td>
                    <td className="num mono">{formatBytes(size) ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </>
      ) : null}
      {options !== null ? (
        <>
          <div className="mg-form-label">{t("컬렉션 옵션")}</div>
          <pre className="panel-pre mg-export-code mg-ix-preview">
            <ShellText text={toShellPretty(options)} />
          </pre>
        </>
      ) : null}
      <CommandPreview command={`${shellNamespace(db, coll)}.stats()`} problem={null} />
    </AdminModal>
  );
}

// The dialog for a request.
export function DocAdminDialogs({ conn, request, safeMode, notify, onEffect, onClose }: { conn: string; request: DocAdminRequest; safeMode: SafeMode; notify(message: string): void; onEffect(effect: DocAdminEffect): void; onClose(): void }) {
  switch (request.kind) {
    case "createDatabase":
      return <CreateModal conn={conn} db={null} view={false} onEffect={onEffect} onClose={onClose} />;
    case "createCollection":
      return <CreateModal conn={conn} db={request.db} view={request.view === true} onEffect={onEffect} onClose={onClose} />;
    case "rename":
      return <RenameModal conn={conn} db={request.db} coll={request.coll} onEffect={onEffect} onClose={onClose} />;
    case "drop":
      return <DropModal conn={conn} db={request.db} coll={request.coll} view={request.view === true} safeMode={safeMode} onEffect={onEffect} onClose={onClose} />;
    case "stats":
      return <StatsModal conn={conn} db={request.db} coll={request.coll} onClose={onClose} />;
    case "import":
      return <ImportModal conn={conn} db={request.db} coll={request.coll} notify={notify} onImported={(coll) => onEffect({ kind: "imported", db: request.db, coll })} onClose={onClose} />;
    case "export":
      return <ExportModal ns={{ conn, db: request.db, coll: request.coll }} source={{ kind: "find", filter: {}, projection: null, sort: null, limit: null }} notify={notify} onClose={onClose} />;
  }
}

import type { ColumnDraft, DiffResult, FkDraft, IndexDraft } from "../ddl";
import { draftKey } from "../ddl";
import { t } from "../i18n";
import { FieldError } from "./ErrorNotice";
import { UpIcon } from "./icons";

interface ColumnsEditorProps {
  columns: ColumnDraft[];
  // The engine's columns have no NOT NULL or default (CQL).
  noConstraints?: boolean;
  // The type a new column starts as (SqlDialect.newColumnType).
  newType?: string;
  onChange(columns: ColumnDraft[]): void;
}

function moveItem<T>(items: T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (target < 0 || target >= items.length) {
    return items;
  }
  const next = items.slice();
  const tmp = next[index];
  next[index] = next[target];
  next[target] = tmp;
  return next;
}

export function ColumnsEditor({ columns, noConstraints = false, newType = "TEXT", onChange }: ColumnsEditorProps) {
  const constraintTitle = noConstraints ? t("이 엔진의 컬럼에는 NOT NULL과 기본값이 없습니다") : undefined;
  function patch(index: number, part: Partial<ColumnDraft>): void {
    onChange(columns.map((column, i) => (i === index ? { ...column, ...part } : column)));
  }

  return (
    <div className="draft-table">
      <div className="draft-row draft-head">
        <span className="draft-move" />
        <span>{t("이름")}</span>
        <span>{t("타입")}</span>
        <span className="draft-nn">NN</span>
        <span className="draft-pk">PK</span>
        <span>{t("기본값")}</span>
        <span />
      </div>
      {columns.map((column, index) => (
        <div className={column.orig === null ? "draft-row draft-new" : "draft-row"} key={column.key}>
          <span className="draft-move">
            <button
              type="button"
              title={t("위로")}
              disabled={index === 0}
              onClick={() => onChange(moveItem(columns, index, -1))}
            >
              <UpIcon size={9} />
            </button>
            <button
              type="button"
              className="down"
              title={t("아래로")}
              disabled={index === columns.length - 1}
              onClick={() => onChange(moveItem(columns, index, 1))}
            >
              <UpIcon size={9} />
            </button>
          </span>
          <input
            value={column.name}
            spellCheck={false}
            placeholder={t("컬럼 이름")}
            onChange={(event) => patch(index, { name: event.target.value })}
          />
          <input
            value={column.type}
            spellCheck={false}
            placeholder={t("타입")}
            onChange={(event) => patch(index, { type: event.target.value })}
          />
          <label className="draft-check draft-nn" title={constraintTitle}>
            <input
              type="checkbox"
              checked={column.notNull}
              disabled={noConstraints}
              onChange={(event) => patch(index, { notNull: event.target.checked })}
            />
          </label>
          <label className="draft-check draft-pk">
            <input
              type="checkbox"
              checked={column.pk}
              onChange={(event) => patch(index, { pk: event.target.checked })}
            />
          </label>
          <input
            value={column.def}
            spellCheck={false}
            placeholder={t("기본값")}
            disabled={noConstraints}
            title={constraintTitle}
            onChange={(event) => patch(index, { def: event.target.value })}
          />
          <button
            type="button"
            className="draft-remove"
            title={t("컬럼 삭제")}
            onClick={() => onChange(columns.filter((_, i) => i !== index))}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="draft-add"
        onClick={() =>
          onChange([
            ...columns,
            {
              key: draftKey(),
              orig: null,
              name: "",
              type: newType,
              notNull: false,
              pk: false,
              def: "",
            },
          ])
        }
      >
        {t("+ 컬럼 추가")}
      </button>
    </div>
  );
}

interface IndexesEditorProps {
  indexes: IndexDraft[];
  onChange(indexes: IndexDraft[]): void;
}

export function IndexesEditor({ indexes, onChange }: IndexesEditorProps) {
  function patch(index: number, part: Partial<IndexDraft>): void {
    onChange(indexes.map((entry, i) => (i === index ? { ...entry, ...part } : entry)));
  }

  return (
    <div className="draft-table">
      <div className="draft-row draft-head">
        <span>{t("이름")}</span>
        <span className="draft-unique">UNIQUE</span>
        <span>{t("컬럼 (쉼표 구분)")}</span>
        <span />
      </div>
      {indexes.map((index, i) => (
        <div className={index.orig === null ? "draft-row draft-new" : "draft-row"} key={index.key}>
          <input
            value={index.name}
            spellCheck={false}
            placeholder={t("인덱스 이름")}
            onChange={(event) => patch(i, { name: event.target.value })}
          />
          <label className="draft-check draft-unique">
            <input
              type="checkbox"
              checked={index.unique}
              onChange={(event) => patch(i, { unique: event.target.checked })}
            />
          </label>
          <input
            value={index.columns}
            spellCheck={false}
            placeholder="col1, col2"
            onChange={(event) => patch(i, { columns: event.target.value })}
          />
          <button
            type="button"
            className="draft-remove"
            title={t("인덱스 삭제")}
            onClick={() => onChange(indexes.filter((_, j) => j !== i))}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="draft-add"
        onClick={() =>
          onChange([
            ...indexes,
            { key: draftKey(), orig: null, name: "", unique: false, columns: "" },
          ])
        }
      >
        {t("+ 인덱스 추가")}
      </button>
    </div>
  );
}

interface FksEditorProps {
  fks: FkDraft[];
  onChange(fks: FkDraft[]): void;
}

export function FksEditor({ fks, onChange }: FksEditorProps) {
  function patch(index: number, part: Partial<FkDraft>): void {
    onChange(fks.map((entry, i) => (i === index ? { ...entry, ...part } : entry)));
  }

  return (
    <div className="draft-table">
      <div className="draft-row draft-head">
        <span>{t("이름")}</span>
        <span>{t("컬럼 (쉼표 구분)")}</span>
        <span>{t("참조 테이블")}</span>
        <span>{t("참조 컬럼")}</span>
        <span />
      </div>
      {fks.map((fk, i) => (
        <div className={fk.orig === null ? "draft-row draft-new" : "draft-row"} key={fk.key}>
          <input
            value={fk.name}
            spellCheck={false}
            placeholder={t("제약 이름")}
            onChange={(event) => patch(i, { name: event.target.value })}
          />
          <input
            value={fk.columns}
            spellCheck={false}
            placeholder="col1, col2"
            onChange={(event) => patch(i, { columns: event.target.value })}
          />
          <input
            value={fk.refTable}
            spellCheck={false}
            placeholder="ref_table"
            onChange={(event) => patch(i, { refTable: event.target.value })}
          />
          <input
            value={fk.refColumns}
            spellCheck={false}
            placeholder="ref_col"
            onChange={(event) => patch(i, { refColumns: event.target.value })}
          />
          <button
            type="button"
            className="draft-remove"
            title={t("외래 키 삭제")}
            onClick={() => onChange(fks.filter((_, j) => j !== i))}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="draft-add"
        onClick={() =>
          onChange([
            ...fks,
            { key: draftKey(), orig: null, name: "", columns: "", refTable: "", refColumns: "" },
          ])
        }
      >
        {t("+ 외래 키 추가")}
      </button>
    </div>
  );
}

interface DdlPreviewProps {
  result: DiffResult;
}

export function DdlPreview({ result }: DdlPreviewProps) {
  return (
    <div className="panel-code">
      <div className="panel-code-head">
        <span className="dim">{t("실행할 문장 {count}개", { count: result.statements.length })}</span>
      </div>
      <FieldError id="ddl-preview-problems" error={result.errors.join("\n")} />
      <pre className="panel-pre">
        {result.statements.length === 0
          ? t("변경 사항이 없습니다")
          : result.statements.map((statement) => `${statement};`).join("\n")}
      </pre>
    </div>
  );
}

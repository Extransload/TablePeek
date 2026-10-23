import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { formatBytes, formatRowEstimate } from "../format";
import { t } from "../i18n";
import type { TableDetail, TableSchema } from "../store";
import { TableIcon } from "./icons";
import { Spinner } from "./Spinner";

interface TableInfoCardProps {
  table: TableSchema;
  // undefined while it's read; null when it couldn't be.
  detail: TableDetail | null | undefined;
  kind: string;
  // The hovered row's top and the sidebar's right edge, in viewport terms.
  top: number;
  left: number;
}

const EDGE = 8;

// What a sidebar table holds, shown beside the sidebar after a moment's hover:
// its full name, rows, size and what it's made of.
export function TableInfoCard({ table, detail, kind, top, left }: TableInfoCardProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [place, setPlace] = useState({ top, left });

  // Level with the row, moved up when the window ends first.
  useLayoutEffect(() => {
    const height = cardRef.current?.offsetHeight ?? 0;
    setPlace({ top: Math.max(EDGE, Math.min(top, window.innerHeight - height - EDGE)), left });
  }, [top, left, detail]);

  const loading = detail === undefined;
  const name = detail?.schema && !table.name.includes(".") ? `${detail.schema}.${table.name}` : table.name;
  const primary = table.columns.filter((column) => column.pk).map((column) => column.name);
  const parts = [
    detail?.data_bytes != null ? `${t("데이터")} ${formatBytes(detail.data_bytes)}` : null,
    detail?.index_bytes != null ? `${t("인덱스")} ${formatBytes(detail.index_bytes)}` : null,
  ].filter((part): part is string => part !== null);
  const pending = <Spinner size={10} className="delayed-in" />;

  const facts: [string, ReactNode][] = [
    [
      t("행 수"),
      loading ? pending : (formatRowEstimate(detail?.row_count_estimate ?? null, kind === "sqlite") ?? "—"),
    ],
    [
      t("크기"),
      loading ? (
        pending
      ) : detail?.size_bytes != null ? (
        <>
          {formatBytes(detail.size_bytes)}
          {parts.length > 0 ? <span className="table-card-dim"> ({parts.join(" · ")})</span> : null}
        </>
      ) : (
        "—"
      ),
    ],
    [t("컬럼"), (detail?.columns.length ?? table.columns.length).toLocaleString()],
    [t("기본 키"), primary.length > 0 ? primary.join(", ") : "—"],
    [t("인덱스"), loading ? pending : (detail?.indexes.length ?? 0).toLocaleString()],
    [t("외래 키"), loading ? pending : (detail?.foreign_keys.length ?? 0).toLocaleString()],
  ];
  if (detail?.triggers !== undefined && detail.triggers.length > 0) {
    facts.push([t("트리거"), detail.triggers.length.toLocaleString()]);
  }

  return createPortal(
    <div className="table-card" role="tooltip" ref={cardRef} style={{ top: place.top, left: place.left }}>
      <div className="table-card-head">
        <TableIcon size={12} className="table-card-icon" />
        <span className="table-card-name">{name}</span>
        {kind !== "" ? <span className="table-card-kind">{kind}</span> : null}
      </div>
      <dl className="table-card-facts">
        {facts.map(([label, value]) => (
          <div className="table-card-fact" key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {detail?.comment ? <p className="table-card-comment">{detail.comment}</p> : null}
    </div>,
    document.body,
  );
}

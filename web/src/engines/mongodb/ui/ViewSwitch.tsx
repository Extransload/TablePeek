// The ☰ / {} / ⊞ switch at the right end of the results toolbar: icons
// only, the name in the tooltip and the accessible name (⌃1–3).

import { ListIcon } from "../../../components/icons";
import { t } from "../../../i18n";
import { BracesIcon, GridIcon } from "./icons";

export type DocView = "cards" | "json" | "table";

const VIEWS: { id: DocView; label: string; tip: string; key: string }[] = [
  { id: "cards", label: "목록", tip: "목록 — 문서를 카드로 (⌃1)", key: "1" },
  { id: "json", label: "JSON", tip: "JSON — 문서마다 코드 블록 (⌃2)", key: "2" },
  { id: "table", label: "표", tip: "표 — 하위 필드로 들어가 볼 수 있는 표 (⌃3)", key: "3" },
];

// The view ⌃1–3 asks for, or null for any other key.
export function viewForKey(event: KeyboardEvent): DocView | null {
  if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
    return null;
  }
  return VIEWS.find((v) => v.key === event.key)?.id ?? null;
}

export function ViewSwitch({ view, onChange }: { view: DocView; onChange(view: DocView): void }) {
  return (
    <div className="segmented mg-viewseg" role="group" aria-label={t("보기")}>
      {VIEWS.map((v) => (
        <button key={v.id} type="button" className={view === v.id ? "active" : undefined} title={t(v.tip)} aria-label={t(v.label)} aria-pressed={view === v.id} onClick={() => onChange(v.id)}>
          {v.id === "cards" ? <ListIcon size={11} /> : v.id === "json" ? <BracesIcon size={11} /> : <GridIcon size={11} />}
        </button>
      ))}
    </div>
  );
}

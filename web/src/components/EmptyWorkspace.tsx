import { t } from "../i18n";
import { BrandMark } from "./BrandLogo";
import { DatabaseIcon, HomeIcon, PlusIcon } from "./icons";

interface EmptyWorkspaceProps {
  onNewQuery(): void;
  onHome(): void;
}

export function EmptyWorkspace({ onNewQuery, onHome }: EmptyWorkspaceProps) {
  return (
    <div className="empty-workspace">
      {/* The same faded brand as the home's start window. */}
      <div className="empty-workspace-brand" aria-hidden="true">
        <BrandMark size={56} className="empty-workspace-logo" />
        <div className="empty-workspace-word">
          Table<span className="brand-word-peek">Peek</span>
        </div>
      </div>
      <div className="empty-workspace-title">{t("탭이 없습니다")}</div>
      <div className="empty-workspace-hint">
        {t("왼쪽에서 테이블을 선택하거나 새 쿼리를 시작하세요")}
      </div>
      <div className="empty-workspace-actions">
        <button type="button" className="primary" onClick={onNewQuery}>
          <PlusIcon size={11} />
          {t("새 쿼리")}
        </button>
        <button type="button" onClick={onHome}>
          <HomeIcon size={11} />
          {t("연결 홈")}
        </button>
        <span className="empty-workspace-key">⌘T</span>
      </div>
      <div className="empty-workspace-foot">
        <DatabaseIcon size={11} />
        <span>{t("연결 열기")}</span>
      </div>
    </div>
  );
}

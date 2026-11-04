import type { PointerEvent } from "react";
import { t } from "../i18n";
import { DownloadIcon, FileIcon, PlusIcon } from "./icons";

interface HomeWelcomeProps {
  onNewConnection(): void;
  onOpenFile(): void;
  onImportFile(): void;
  onOpenDemo(): void;
}

// The first button leans toward the pointer and lights where it is
// (see .launcher-welcome-actions button.primary in styles.css).
function pull(event: PointerEvent<HTMLButtonElement>): void {
  const button = event.currentTarget;
  const rect = button.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  button.style.setProperty("--spot-x", `${x}px`);
  button.style.setProperty("--spot-y", `${y}px`);
  button.style.setProperty("--pull-x", `${(x / rect.width - 0.5) * 8}px`);
  button.style.setProperty("--pull-y", `${(y / rect.height - 0.5) * 5}px`);
}

function release(event: PointerEvent<HTMLButtonElement>): void {
  event.currentTarget.style.removeProperty("--pull-x");
  event.currentTarget.style.removeProperty("--pull-y");
}

// First run: nothing saved, nothing open, no groups yet. Just the ways in.
export function HomeWelcome({ onNewConnection, onOpenFile, onImportFile, onOpenDemo }: HomeWelcomeProps) {
  return (
    <div className="launcher-welcome">
      <div className="launcher-welcome-actions">
        <button type="button" className="primary" onClick={onNewConnection} onPointerMove={pull} onPointerLeave={release}>
          <PlusIcon size={11} />
          {t("새 연결…")}
        </button>
        <button type="button" onClick={onOpenFile}>
          <FileIcon size={10} />
          {t("SQLite 파일 열기")}
        </button>
        <button type="button" onClick={onImportFile}>
          <DownloadIcon size={10} />
          {t("연결 가져오기…")}
        </button>
      </div>
      <button type="button" className="launcher-welcome-demo" onClick={onOpenDemo}>
        {t("데모 데이터로 둘러보기")}
        <span className="launcher-welcome-demo-arrow" aria-hidden="true">
          →
        </span>
      </button>
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";
import { t } from "../i18n";
import { store, type FsListing } from "../store";
import { ErrorNotice } from "./ErrorNotice";
import { LoadingState } from "./Spinner";
import { FileIcon, FolderIcon, UpIcon } from "./icons";

interface FsModalProps {
  onClose(): void;
  onOpenDb(path: string | null): void;
}

const DB_FILE_PATTERN = /\.(db|sqlite|sqlite3|db3)$/i;

function formatSize(size: number | null): string {
  if (size === null) {
    return "";
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function FsModal({ onClose, onOpenDb }: FsModalProps) {
  const [listing, setListing] = useState<FsListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (dir?: string): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const next = await store.listDir(dir);
      setListing(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("폴더를 불러오지 못했습니다"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(undefined);
  }, [load]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const parent = listing?.parent ?? null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">{t("데이터베이스 열기")}</span>
          <span className="modal-path">{listing?.path ?? ""}</span>
        </div>
        <div className="fs-list">
          {loading ? (
            <LoadingState variant="compact" />
          ) : error ? (
            <div className="fs-error-slot">
              <ErrorNotice message={error} variant="compact" />
            </div>
          ) : listing ? (
            <>
              {parent && (
                <button type="button" className="fs-entry" onClick={() => void load(parent)}>
                  <UpIcon size={12} className="icon" />
                  <span>{t("상위 폴더")}</span>
                </button>
              )}
              {listing.entries.map((entry) =>
                entry.kind === "dir" ? (
                  <button
                    type="button"
                    key={entry.path}
                    className="fs-entry"
                    onClick={() => void load(entry.path)}
                  >
                    <FolderIcon size={12} className="icon" />
                    <span>{entry.name}</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    key={entry.path}
                    className="fs-entry"
                    disabled={!DB_FILE_PATTERN.test(entry.name)}
                    onClick={() => onOpenDb(entry.path)}
                  >
                    <FileIcon size={12} className="icon dim" />
                    <span>{entry.name}</span>
                    <span className="size">{formatSize(entry.size)}</span>
                  </button>
                ),
              )}
              {listing.entries.length === 0 && !parent ? (
                <div className="fs-empty">{t("폴더가 비어 있습니다")}</div>
              ) : null}
            </>
          ) : null}
        </div>
        <div className="modal-foot">
          <button type="button" onClick={() => onOpenDb(null)}>
            {t("데모 열기")}
          </button>
          <button type="button" onClick={onClose}>
            {t("닫기")}
          </button>
        </div>
      </div>
    </div>
  );
}

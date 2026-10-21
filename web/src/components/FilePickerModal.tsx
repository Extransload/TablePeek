import { useCallback, useEffect, useState } from "react";
import { t } from "../i18n";
import { store, type FsListing } from "../store";
import { ErrorNotice } from "./ErrorNotice";
import { FileIcon, FolderIcon, UpIcon } from "./icons";
import { Spinner } from "./Spinner";

interface FilePickerModalProps {
  title: string;
  // Current value of the field; the picker opens in its folder.
  current: string;
  // Folder under the home directory to open when there is no current value (e.g. ".ssh").
  homeSubdir?: string;
  onPick(path: string): void;
  onClose(): void;
}

function parentOf(path: string): string | null {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : null;
}

export function FilePickerModal({ title, current, homeSubdir, onPick, onClose }: FilePickerModalProps) {
  const [listing, setListing] = useState<FsListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hidden, setHidden] = useState(homeSubdir?.startsWith(".") ?? false);
  const [pathInput, setPathInput] = useState("");

  const load = useCallback(
    async (dir: string | undefined, showHidden: boolean): Promise<boolean> => {
      setLoading(true);
      setError(null);
      try {
        const next = await store.listDir(dir, showHidden);
        setListing(next);
        setPathInput(next.path);
        return true;
      } catch (err) {
        setError(err instanceof Error && err.message ? err.message : t("폴더를 불러오지 못했습니다"));
        return false;
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void (async () => {
      const start = parentOf(current.trim());
      if (start !== null && (await load(start, hidden))) {
        return;
      }
      if (homeSubdir === undefined) {
        await load(undefined, hidden);
        return;
      }
      const home = await store.listDir(undefined, hidden).catch(() => null);
      if (home === null || !(await load(`${home.path}/${homeSubdir}`, hidden))) {
        await load(undefined, hidden);
      }
    })();
    // Only the initial folder depends on these; later navigation is user-driven.
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    }
    // Capture phase so Escape closes only the picker, not the dialog under it.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const parent = listing?.parent ?? null;

  return (
    <div
      className="modal-backdrop picker-backdrop"
      onClick={(event) => {
        // The picker sits inside another dialog's backdrop; don't close that one too.
        event.stopPropagation();
        onClose();
      }}
    >
      <div className="modal picker-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">{title}</span>
        </div>
        <form
          className="picker-path"
          onSubmit={(event) => {
            event.preventDefault();
            void load(pathInput.trim() || undefined, hidden);
          }}
        >
          <input
            value={pathInput}
            spellCheck={false}
            onChange={(event) => setPathInput(event.target.value)}
            aria-label={t("폴더 경로")}
          />
          <label className="picker-hidden">
            <input
              type="checkbox"
              checked={hidden}
              onChange={(event) => {
                setHidden(event.target.checked);
                void load(listing?.path, event.target.checked);
              }}
            />
            {t("숨김 파일")}
          </label>
        </form>
        <div className="fs-list">
          {loading && listing === null ? (
            <div className="fs-empty">
              <Spinner size={12} />
            </div>
          ) : error ? (
            <div className="fs-error-slot">
              <ErrorNotice message={error} variant="compact" />
            </div>
          ) : listing ? (
            <>
              {parent && (
                <button type="button" className="fs-entry" onClick={() => void load(parent, hidden)}>
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
                    onClick={() => void load(entry.path, hidden)}
                  >
                    <FolderIcon size={12} className="icon" />
                    <span>{entry.name}</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    key={entry.path}
                    className={`fs-entry${entry.path === current ? " selected" : ""}`}
                    onClick={() => onPick(entry.path)}
                  >
                    <FileIcon size={12} className="icon dim" />
                    <span>{entry.name}</span>
                  </button>
                ),
              )}
              {listing.entries.length === 0 ? (
                <div className="fs-empty">{t("폴더가 비어 있습니다")}</div>
              ) : null}
            </>
          ) : null}
        </div>
        <div className="modal-foot">
          <span className="picker-hint">{t("파일을 클릭하면 선택됩니다")}</span>
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            {t("취소")}
          </button>
        </div>
      </div>
    </div>
  );
}

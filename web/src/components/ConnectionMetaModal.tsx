import { useEffect, useState } from "react";
import {
  ENVIRONMENT_OPTIONS,
  getConnMeta,
  setConnMeta,
  type ConnectionEnvironment,
} from "../connMeta";

interface ConnectionMetaModalProps {
  id: string;
  name: string;
  onClose(): void;
}

export function ConnectionMetaModal({ id, name, onClose }: ConnectionMetaModalProps) {
  const initial = getConnMeta(id);
  const [group, setGroup] = useState(initial?.group ?? "");
  const [color, setColor] = useState(initial?.color ?? "#4082ee");
  const [tags, setTags] = useState((initial?.tags ?? []).join(", "));
  const [environment, setEnvironment] = useState<ConnectionEnvironment>(
    initial?.environment ?? "",
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal conn-meta-modal"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          setConnMeta(id, {
            group,
            color,
            tags: tags.split(","),
            environment,
          });
          onClose();
        }}
      >
        <div className="modal-head">
          <span className="modal-title">연결 정보</span>
          <span className="modal-path">{name}</span>
        </div>
        <div className="modal-body conn-meta-body">
          <label className="field">
            <span>그룹</span>
            <input
              autoFocus
              value={group}
              placeholder="예: 운영"
              onChange={(event) => setGroup(event.target.value)}
            />
          </label>
          <label className="field">
            <span>환경</span>
            <select
              value={environment}
              onChange={(event) =>
                setEnvironment(event.target.value as ConnectionEnvironment)
              }
            >
              {ENVIRONMENT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>색상</span>
            <input type="color" value={color} onChange={(event) => setColor(event.target.value)} />
          </label>
          <label className="field">
            <span>태그</span>
            <input
              value={tags}
              placeholder="쉼표로 구분"
              onChange={(event) => setTags(event.target.value)}
            />
          </label>
        </div>
        <div className="modal-foot">
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            취소
          </button>
          <button type="submit" className="primary">
            저장
          </button>
        </div>
      </form>
    </div>
  );
}

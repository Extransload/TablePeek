import { useEffect, useState } from "react";
import { t } from "../i18n";

interface ParamModalProps {
  params: string[];
  initial: Record<string, string>;
  onSubmit(values: Record<string, string>): void;
  onClose(): void;
}

export function ParamModal({ params, initial, onSubmit, onClose }: ParamModalProps) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const next: Record<string, string> = {};
    for (const name of params) {
      next[name] = initial[name] ?? "";
    }
    return next;
  });

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
        className="modal param-modal"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(values);
        }}
      >
        <div className="modal-head">
          <span className="modal-title">{t("쿼리 파라미터")}</span>
          <span className="modal-path">{t("{count}개", { count: params.length })}</span>
        </div>
        <div className="modal-body param-body">
          {params.map((name, index) => (
            <label className="field" key={name}>
              <span className="mono">{`:${name}`}</span>
              <input
                autoFocus={index === 0}
                value={values[name] ?? ""}
                placeholder={t("값 (문자열은 자동 따옴표)")}
                onChange={(event) =>
                  setValues((prev) => ({ ...prev, [name]: event.target.value }))
                }
              />
            </label>
          ))}
          <p className="helper">{t("값은 SQL 리터럴로 바인딩됩니다. :name 형식만 지원합니다.")}</p>
        </div>
        <div className="modal-foot">
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            {t("취소")}
          </button>
          <button type="submit" className="primary">
            {t("실행")}
          </button>
        </div>
      </form>
    </div>
  );
}

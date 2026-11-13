// The Browser's right pane: the selected key, RedisInsight-style. Header:
// type, name (click to rename in place), time left (click to change in
// place, × removes it; counts down), length and size, refresh, delete
// (after a small confirm) and a menu (copy, export, CLI). Below it the
// value's view for its type.

import { useCallback, useEffect, useRef, useState } from "react";
import { ContextMenu, type ContextMenuItem } from "../../../components/ContextMenu";
import { ErrorNotice } from "../../../components/ErrorNotice";
import { Gauge } from "../../../components/Gauge";
import { CloseIcon, MoreIcon, RefreshIcon, TrashIcon } from "../../../components/icons";
import { t } from "../../../i18n";
import { isAbort, keyInfo, type KeyInfo } from "../api";
import { binFromHex, binText, consoleArg, hexOf, isText, type Bin } from "../bin";
import { ConfirmPopover, copyText, deleteKeys, downloadKey, parseDuration, persistKey, renameKey, setKeyTtl, sizeText, ttlText, TypeBadge, type RedisHost } from "./common";
import { HashView, JsonView, ListView, OtherView, SetView, StreamView, StringView, ZsetView, type ViewProps } from "./ValueViews";

const LENGTH_LABEL: Record<string, string> = {
  string: "바이트",
  hash: "필드",
  list: "요소",
  set: "멤버",
  zset: "멤버",
  stream: "항목",
};

export function KeyDetails({ host, db, keyName, refreshSeq, onBusy, onOpenCli }: { host: RedisHost; db: number; keyName: Bin; refreshSeq: number; onBusy(busy: boolean): void; onOpenCli(text: string): void }) {
  const [info, setInfo] = useState<{ value: KeyInfo; at: number } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [infoSeq, setInfoSeq] = useState(0);
  const [reloadSeq, setReloadSeq] = useState(0);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [naming, setNaming] = useState<string | null>(null);
  const [timing, setTiming] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<HTMLElement | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[]; anchor: Element } | null>(null);
  const name = binText(keyName);
  const binaryName = !isText(keyName);
  const nameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => onBusy(busy || (info === null && error === null)), [busy, info, error, onBusy]);

  useEffect(() => {
    const ctl = new AbortController();
    keyInfo(host.conn, db, keyName, ctl.signal).then(
      (value) => {
        setInfo({ value, at: Date.now() });
        setError(null);
      },
      (reason: unknown) => {
        if (!isAbort(reason)) {
          setError(reason);
        }
      },
    );
    return () => ctl.abort();
    // The key's identity is its bytes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host.conn, db, name, binaryName, infoSeq, refreshSeq]);

  // The time left counts down; at zero the key is read again (it is gone).
  const ttl = info === null || info.value.ttl_ms < 0 ? null : Math.max(0, info.value.ttl_ms - (now - info.at));
  useEffect(() => {
    if (info === null || info.value.ttl_ms < 0) {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [info]);
  const expired = ttl !== null && ttl <= 0;
  useEffect(() => {
    if (expired) {
      setInfoSeq((n) => n + 1);
    }
  }, [expired]);

  const onEdited = useCallback(() => setInfoSeq((n) => n + 1), []);
  const onViewBusy = useCallback((value: boolean) => setBusy(value), []);
  const writable = !host.readOnly;

  const submitName = async () => {
    if (naming === null) {
      return;
    }
    const to = binaryName ? binFromHex(naming) : naming;
    setNaming(null);
    if (to !== null && to !== "" && binText(to) !== name) {
      await renameKey(host, db, keyName, to);
    }
  };

  const submitTtl = async () => {
    if (timing === null) {
      return;
    }
    const text = timing.trim();
    setTiming(null);
    if (text === "" || /^(-1|0|없음|none|no limit)$/i.test(text)) {
      if (ttl !== null && (await persistKey(host, db, keyName))) {
        onEdited();
      }
      return;
    }
    const seconds = parseDuration(text);
    if (seconds !== null && (await setKeyTtl(host, db, keyName, seconds))) {
      onEdited();
    }
  };

  const actions = (): ContextMenuItem[] => [
    { label: t("이름 복사"), onSelect: () => void copyText(host, name) },
    { label: t("CLI에서 열기"), onSelect: () => onOpenCli(`TYPE ${consoleArg(keyName)}`) },
    { label: t("JSON으로 내보내기"), separatorBefore: true, onSelect: () => void downloadKey(host, db, keyName, "json") },
    { label: t("텍스트로 내보내기"), onSelect: () => void downloadKey(host, db, keyName, "text") },
  ];

  const type = info?.value.type ?? null;
  const viewProps: ViewProps = { host, db, keyName, path: name, reloadSeq: reloadSeq + refreshSeq, onEdited, onBusy: onViewBusy, onOpenCli };
  let body;
  if (error !== null && info === null) {
    body = (
      <div className="kv-pad">
        <ErrorNotice error={error} context="data" engine="redis" onRetry={() => setInfoSeq((n) => n + 1)} />
      </div>
    );
  } else if (info === null || type === null) {
    body = (
      <div className="kv-loading gauge-host" role="status">
        <Gauge busy />
        {t("불러오는 중…")}
      </div>
    );
  } else if (!info.value.exists) {
    body = (
      <div className="kv-empty-state">
        <div className="kv-empty-title">{t("키가 없습니다 (지워졌거나 만료되었습니다)")}</div>
        <button type="button" className="kv-btn" onClick={() => setInfoSeq((n) => n + 1)}>
          <RefreshIcon size={11} />
          {t("다시 읽기")}
        </button>
      </div>
    );
  } else if (type === "string") {
    body = <StringView {...viewProps} />;
  } else if (type === "hash") {
    body = <HashView {...viewProps} />;
  } else if (type === "list") {
    body = <ListView {...viewProps} />;
  } else if (type === "set") {
    body = <SetView {...viewProps} />;
  } else if (type === "zset") {
    body = <ZsetView {...viewProps} />;
  } else if (type === "stream") {
    body = <StreamView {...viewProps} />;
  } else if (type === "ReJSON-RL" || type === "json") {
    body = <JsonView {...viewProps} />;
  } else {
    body = <OtherView kind={type} keyName={keyName} onOpenCli={onOpenCli} />;
  }

  const exists = info !== null && info.value.exists;
  const lengthLabel = type !== null && Object.hasOwn(LENGTH_LABEL, type) ? t(LENGTH_LABEL[type]) : t("길이");

  return (
    <div className="kv-details">
      <div className="kv-details-head">
        <div className="kv-details-title">
          {type !== null ? <TypeBadge type={type} /> : null}
          {naming !== null ? (
            <input
              ref={nameRef}
              className="kv-name-input mono"
              autoFocus
              spellCheck={false}
              aria-label={binaryName ? t("새 이름 (16진수)") : t("새 이름")}
              value={naming}
              onChange={(event) => setNaming(event.target.value)}
              onBlur={() => void submitName()}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submitName();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setNaming(null);
                }
              }}
            />
          ) : (
            <button type="button" className="kv-key-title mono" title={writable && exists ? t("눌러서 이름 바꾸기") : name} disabled={!writable || !exists} onClick={() => setNaming(binaryName ? hexOf(keyName) : name)}>
              {name}
            </button>
          )}
          {exists && info !== null ? (
            <div className="kv-details-facts">
              {timing !== null ? (
                <span className="kv-fact editing">
                  <span className="kv-fact-k">TTL</span>
                  <input
                    className="kv-ttl-input mono"
                    autoFocus
                    spellCheck={false}
                    placeholder={t("초, 30m, 2h, 7d · 비우면 없앰")}
                    value={timing}
                    onChange={(event) => setTiming(event.target.value)}
                    onBlur={() => void submitTtl()}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void submitTtl();
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        setTiming(null);
                      }
                    }}
                  />
                </span>
              ) : (
                <span className="kv-fact">
                  <button type="button" className="kv-fact-btn" title={writable ? t("눌러서 만료 시간 바꾸기") : "TTL"} disabled={!writable} onClick={() => setTiming(ttl === null ? "" : String(Math.ceil(ttl / 1000)))}>
                    <span className="kv-fact-k">TTL</span>
                    <span className={`kv-fact-v${ttl !== null ? " live" : ""}`}>{ttl === null ? t("제한 없음") : ttlText(ttl)}</span>
                  </button>
                  {ttl !== null && writable ? (
                    <button type="button" className="kv-icon small" title={t("만료 없애기 (PERSIST)")} onClick={() => void persistKey(host, db, keyName).then((ok) => ok && onEdited())}>
                      <CloseIcon size={9} />
                    </button>
                  ) : null}
                </span>
              )}
              {info.value.length !== null ? (
                <span className="kv-fact kv-fact-length">
                  <span className="kv-fact-k">{lengthLabel}</span>
                  <span className="kv-fact-v">{info.value.length.toLocaleString()}</span>
                </span>
              ) : null}
              <span className="kv-fact kv-fact-size" title="MEMORY USAGE">
                <span className="kv-fact-k">{t("크기")}</span>
                <span className="kv-fact-v">{sizeText(info.value.memory)}</span>
              </span>
              {info.value.encoding !== null ? (
                <span className="kv-fact kv-fact-encoding" title="OBJECT ENCODING">
                  <span className="kv-fact-k">{t("인코딩")}</span>
                  <span className="kv-fact-v">{info.value.encoding}</span>
                </span>
              ) : null}
              {host.readOnly ? <span className="kv-ro">{t("읽기 전용")}</span> : null}
            </div>
          ) : null}
          <span className="spacer" />
          <button type="button" className="kv-icon" title={t("새로고침 (F5)")} aria-label={t("새로고침")} onClick={() => {
            setInfoSeq((n) => n + 1);
            setReloadSeq((n) => n + 1);
          }}>
            <RefreshIcon size={12} />
          </button>
          {writable && exists ? (
            <button type="button" className="kv-icon danger" title={t("키 삭제")} aria-label={t("키 삭제")} onClick={(event) => setConfirm(event.currentTarget)}>
              <TrashIcon size={12} />
            </button>
          ) : null}
          <button
            type="button"
            className="kv-icon"
            title={t("키 작업")}
            aria-haspopup="menu"
            onClick={(event) => {
              const anchor = event.currentTarget;
              const rect = anchor.getBoundingClientRect();
              setMenu(menu !== null ? null : { x: rect.right - 200, y: rect.bottom + 4, items: actions(), anchor });
            }}
          >
            <MoreIcon size={13} />
          </button>
        </div>
      </div>
      <div className="kv-details-body">{body}</div>
      {confirm !== null ? (
        <ConfirmPopover
          anchor={confirm}
          message={t("{key} 키를 지웁니다. 되돌릴 수 없습니다.", { key: name })}
          okLabel={t("삭제")}
          onClose={() => setConfirm(null)}
          onConfirm={() => void deleteKeys(host, db, [keyName], false)}
        />
      ) : null}
      {menu !== null ? <ContextMenu x={menu.x} y={menu.y} anchor={menu.anchor} items={menu.items} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}

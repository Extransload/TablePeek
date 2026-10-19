import { useState } from "react";
import { getPasscodeHash, sha256Hex } from "../settings";

interface LockScreenProps {
  onUnlock(): void;
}

export function LockScreen({ onUnlock }: LockScreenProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(true);
    const hash = getPasscodeHash();
    const entered = await sha256Hex(value);
    setBusy(false);
    if (hash !== null && entered === hash) {
      setError(null);
      setValue("");
      onUnlock();
      return;
    }
    setError("암호가 올바르지 않습니다");
  }

  return (
    <div className="lock-screen">
      <form
        className="lock-card"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="lock-brand">wrendb</div>
        <p className="lock-hint">잠금 상태입니다. 암호를 입력하세요.</p>
        <input
          type="password"
          autoFocus
          value={value}
          placeholder="암호"
          onChange={(event) => setValue(event.target.value)}
        />
        {error !== null ? <div className="lock-error">{error}</div> : null}
        <button type="submit" className="primary" disabled={busy || value.length === 0}>
          잠금 해제
        </button>
      </form>
    </div>
  );
}

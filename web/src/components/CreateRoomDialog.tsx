// 새 방 만들기. 방은 워크스페이스 안에 생기고, 만든 뒤 비서실에서 비서를 배치한다.
import { useState, type FormEvent } from "react";
import { Icon } from "./icons.js";

interface Props {
  onClose: () => void;
  onCreate: (name: string, description: string) => Promise<void>;
}

export function CreateRoomDialog({ onClose, onCreate }: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!name.trim()) {
      setError("방 이름을 입력하세요.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onCreate(name.trim(), description.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "방을 만들지 못했습니다.");
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="create-room-title" onSubmit={submit}>
        <div className="dialog-head">
          <h2 id="create-room-title" className="text-[15px] font-extrabold">
            새 방 만들기
          </h2>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="닫기">
            <Icon name="close" size={16} />
          </button>
        </div>
        <p className="panel-note mt-1">방은 주제별 대화·정책·순번을 따로 가집니다. 만든 뒤 비서실에서 비서를 배치하세요.</p>
        <div className="mt-3">
          <label className="label" htmlFor="new-room-name">
            방 이름
          </label>
          <input
            id="new-room-name"
            className="field"
            autoFocus
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="예: 배포 준비방"
          />
        </div>
        <div className="mt-2">
          <label className="label" htmlFor="new-room-desc">
            설명 (선택)
          </label>
          <input
            id="new-room-desc"
            className="field"
            maxLength={500}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="이 방의 용도 한 줄"
          />
        </div>
        {error ? (
          <p role="alert" className="auth-error mt-2">
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            취소
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "만드는 중…" : "방 만들기"}
          </button>
        </div>
      </form>
    </div>
  );
}

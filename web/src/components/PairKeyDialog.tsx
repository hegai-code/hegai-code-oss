import { useEffect, useRef, useState } from 'react';
import { Lock, X } from '../icons.js';
import { addPairingCode, forgetMachine, hasKeyFor, onPairRequest, PairingError, type PairRequest } from '../e2ee/ring.js';

/**
 * «Ввести код пары» - pairs this browser with a private machine (docs/E2EE.md).
 *
 * The code is the machine's key (`hcp1.<machine>.<key>`, printed by
 * `--pair` on the machine). It is imported once as a non-extractable key and
 * never stored as text. Opened from the machine's card and from the banner a
 * session shows while this device holds no key.
 *
 * After pairing the page reloads: every frame that already arrived was a
 * placeholder, and a fresh snapshot and history read are the honest way to
 * show what the key now opens.
 */
export function PairKeyDialog() {
  const [req, setReq] = useState<PairRequest | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    onPairRequest((r) => {
      setReq(r);
      setCode('');
      setError(null);
    });
    return () => onPairRequest(undefined);
  }, []);
  useEffect(() => {
    if (req) input.current?.focus();
  }, [req]);

  if (!req) return null;
  const close = () => {
    setReq(null);
    setCode('');
  };
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await addPairingCode(code, req.machineId);
      window.location.reload();
    } catch (e) {
      setError(e instanceof PairingError ? e.message : 'Не удалось сохранить ключ в этом браузере.');
      setBusy(false);
    }
  };

  // The machine stopped being private (or the owner rotated away): its output is
  // clear again, but a browser that still holds the key refuses clear content for
  // it. Forgetting the key here is how this device goes back to reading it.
  const forget = async () => {
    setBusy(true);
    try {
      if (req.machineId) await forgetMachine(req.machineId);
    } finally {
      window.location.reload();
    }
  };

  return (
    <div className="modal-backdrop" onClick={close}>
      <form
        className="modal pair-key-dialog"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim() && !busy) void submit();
        }}
      >
        <h3>
          <Lock size={18} /> Код пары{req.machineName ? ` · ${req.machineName}` : ''}
        </h3>
        <p className="tool-reason">
          Сессии этой машины зашифрованы: сервер хранит и передаёт их, но прочитать не может. Выполните на машине{' '}
          <code>node agent.mjs --pair</code> и вставьте напечатанный код сюда. Кто видит код, тот читает сессии —
          не пересылайте его открытым текстом.
        </p>
        <label className="np-field">
          <span>Код</span>
          <input
            ref={input}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="hcp1.…"
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
            aria-invalid={!!error}
          />
          {error && <small className="np-hint">{error}</small>}
        </label>
        <div className="modal-actions">
          {req.machineId && hasKeyFor(req.machineId) && (
            <button type="button" className="btn" onClick={() => void forget()} disabled={busy}>
              Забыть ключ этой машины
            </button>
          )}
          <button type="button" className="btn" onClick={close} disabled={busy}>
            <X size={15} /> Отмена
          </button>
          <button type="submit" className="btn primary" disabled={busy || !code.trim()}>
            Сохранить ключ
          </button>
        </div>
      </form>
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import type { AgentReleaseStatus } from '@cc-remote/shared';
import { ApiError, teamApi } from './teamApi.js';
import { toMillis } from './lib.js';
import { askConfirm } from './dialogs.js';

/**
 * «Обновления агента» — the external edition's gate on what runs on the
 * customer's machines. Hidden on the internal hub (the endpoint is 404 there).
 *
 * A new agent build waits here until the owner types a code from their
 * authenticator. The hub has already checked our release signature; the code is
 * the owner's own yes. Agents notice an approval when they reconnect or at
 * their next half-hourly check — there is no push, and the page says so.
 */

/** Hub refusal codes, in the words of the person reading them. */
const REFUSAL: Record<string, string> = {
  authenticator_required: 'Сначала подключите приложение-аутентификатор в своём профиле: без него обновления агента подтвердить нельзя.',
  invalid_code: 'Код не подошёл. Возьмите свежий код из приложения.',
  too_many_attempts: 'Слишком много неверных кодов. Подождите 15 минут.',
  offer_changed: 'Предложенная сборка изменилась или не подписана. Страница обновлена.',
  already_approved: 'Эта сборка уже одобрена.',
  no_previous: 'Откатываться некуда: предыдущей сборки нет.',
};

const short = (sha?: string): string => (sha ? sha.slice(0, 12) : '—');

function fmtWhen(ts: number): string {
  return new Date(toMillis(ts)).toLocaleString('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/**
 * The signed-in admin has no authenticator yet: show the QR code, take the first
 * code, show the recovery codes once. The same authenticator signs in locally and
 * approves agent updates.
 */
function EnrollAuthenticator({ onDone }: { onDone: () => void }) {
  const [begun, setBegun] = useState<{ secret: string; otpauthUri: string; qrSvg?: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [recovery, setRecovery] = useState<string[] | null>(null);

  const start = async () => {
    setBusy(true);
    setErr('');
    try {
      setBegun(await teamApi.totpBegin());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    setBusy(true);
    setErr('');
    try {
      setRecovery((await teamApi.totpConfirm(code.replace(/\s/g, ''))).recoveryCodes);
    } catch (e) {
      setErr((e as Error).message);
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  if (recovery) {
    return (
      <div className="team-note">
        <b>Аутентификатор подключён.</b> Запишите коды восстановления — они показываются один раз:
        <pre>{recovery.join('\n')}</pre>
        <button className="btn primary" onClick={onDone}>Я записал(а)</button>
      </div>
    );
  }
  if (!begun) {
    return (
      <div className="team-note">
        Чтобы одобрять и откатывать сборки, подключите приложение-аутентификатор (Google Authenticator и подобные).{' '}
        <button className="btn" disabled={busy} onClick={() => void start()}>Подключить</button>
        {err && <div>{err}</div>}
      </div>
    );
  }
  return (
    <div className="team-note">
      Отсканируйте код в приложении и введите шесть цифр, которые оно покажет.
      {begun.qrSvg && <div dangerouslySetInnerHTML={{ __html: begun.qrSvg }} style={{ maxWidth: 220, background: '#fff', padding: 8 }} />}
      <div><small>Если камеры нет, введите ключ вручную: <code>{begun.secret}</code></small></div>
      <form className="team-form" onSubmit={(e) => { e.preventDefault(); void confirm(); }}>
        <input inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} disabled={busy} onChange={(e) => setCode(e.target.value)} placeholder="Код из приложения, 6 цифр" aria-label="Код из приложения-аутентификатора" />
        <button className="btn primary" disabled={busy || !/^\d{6}$/.test(code.replace(/\s/g, ''))}>Подтвердить</button>
      </form>
      {err && <div>{err}</div>}
    </div>
  );
}

export function AgentRelease() {
  // `null` = not loaded yet or this hub has no such page (internal edition).
  const [status, setStatus] = useState<AgentReleaseStatus | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    try {
      setStatus(await teamApi.agentRelease());
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) setNote((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(t);
  }, [load]);

  if (!status) return note ? <div className="team-note">{note}</div> : null;

  const enrolled = status.authenticatorEnrolled !== false;
  const pending = status.pending;
  const canApprove = !!pending?.signatureOk && !!pending.sha;
  const codeOk = /^\d{6}$/.test(code.replace(/\s/g, ''));

  const act = async (label: string, fn: () => Promise<AgentReleaseStatus>) => {
    if (busy) return;
    setBusy(true);
    setNote('');
    try {
      const next = await fn();
      setStatus({ ...next, authenticatorEnrolled: status.authenticatorEnrolled });
      setCode('');
      setNote(`${label}: готово. Агенты подхватят сборку при переподключении или в течение получаса.`);
    } catch (e) {
      const msg = (e as Error).message;
      setNote(`${label}: ${REFUSAL[msg] ?? msg}`);
      setCode('');
      if (e instanceof ApiError && e.status === 409) await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="team-card" aria-label="Обновления агента">
      <h3>Обновления агента</h3>

      <div className="team-row static access-row">
        <span>
          <b>Установлено: {status.approved ? status.approved.version : 'ничего не одобрено'}</b>
          {status.approved && (
            <small>
              <span className="access-date">{short(status.approved.sha)}</span>
              {' · одобрено '}
              <span className="access-date">{fmtWhen(status.approved.approvedAt)}</span>
              {status.approved.approvedBy === 'system' ? ' · при первом запуске' : ` · ${status.approved.approvedBy}`}
            </small>
          )}
        </span>
        {status.previous && <span className="role-chip" title={`Для отката: ${short(status.previous.sha)}`}>предыдущая {status.previous.version}</span>}
      </div>

      {status.trustedKeys === 0 && (
        <div className="team-note">В этот хаб не вкомпилирован ключ подписи релизов — ни одна сборка не будет признана подписанной.</div>
      )}

      {pending && (
        <div className="team-row static access-row">
          <span>
            <b>Ждёт одобрения: {pending.version ?? 'неизвестная сборка'}</b>
            <small>
              <span className="access-date">{short(pending.sha)}</span>
              {pending.signatureOk ? ' · подпись релиза верна' : ` · подпись не подходит${pending.error ? `: ${pending.error}` : ''} — такая сборка не отдаётся агентам`}
            </small>
          </span>
          <span className={`role-chip ${pending.signatureOk ? 'control' : 'attn'}`}>{pending.signatureOk ? 'подписано' : 'не подписано'}</span>
        </div>
      )}

      {status.approvedLost && (
        <div className="team-note">
          Раньше здесь одобряли сборку агента, но одобренная копия пропала или повреждена. Установка агентов не работает, пока вы не одобрите сборку заново.
        </div>
      )}

      {(canApprove || status.previous || status.approvedLost) && !enrolled && <EnrollAuthenticator onDone={() => void load()} />}

      {(canApprove || status.previous) && enrolled && (
        <form className="team-form" onSubmit={(e) => e.preventDefault()}>
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
            value={code}
            disabled={busy}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Код из приложения, 6 цифр"
            aria-label="Код из приложения-аутентификатора"
          />
          {canApprove && (
            <button
              className="btn primary"
              disabled={busy || !codeOk}
              onClick={() => void act('Одобрено', () => teamApi.approveAgentRelease(pending.sha!, code.replace(/\s/g, '')))}
            >
              Одобрить
            </button>
          )}
          {status.previous && (
            <button
              className="btn"
              disabled={busy || !codeOk}
              onClick={async () => {
                if (await askConfirm(`Вернуть агентам сборку ${status.previous!.version}?\n\nМашины, уже получившие новую, переустановят старую.`, { confirmLabel: 'Откатить', danger: true })) {
                  void act('Откат', () => teamApi.rollbackAgentRelease(code.replace(/\s/g, '')));
                }
              }}
            >
              Откатить
            </button>
          )}
        </form>
      )}

      <div className="team-row static">
        <span>
          <b>Машины</b>
          <small>Версия агента, которую машина сообщила при последнем подключении.</small>
        </span>
      </div>
      {status.machines.length === 0 && <div className="team-empty">Пока нет подключённых машин.</div>}
      {status.machines.map((m) => (
        <div className="team-row static access-row" key={`${m.name}-${m.agentVersion}`}>
          <span><b>{m.name}</b></span>
          <span className="role-chip">{m.agentVersion}</span>
          <span className={`role-chip ${m.online ? 'control' : ''}`}>{m.online ? 'в сети' : 'не в сети'}</span>
        </div>
      ))}
      {note && <div className="team-note">{note}</div>}
    </section>
  );
}

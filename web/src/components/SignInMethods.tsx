import { useEffect, useState } from 'react';
import { TelegramSignInDialog } from './TelegramSignIn.js';
import { relTimeRu } from '../lib.js';
import { ApiError } from '../api.js';
import {
  googleLinkUrl,
  identitiesApi,
  identityError,
  providerName,
  takeLinkResult,
  type IdentitiesResponse,
  type LinkedIdentity,
} from '../identities.js';
import { askConfirm } from '../dialogs.js';
import { isExternal, usePublicConfig } from '../publicConfig.js';

/** Providers a person can add from here, in the order the page offers them. */
const LINKABLE = ['google', 'telegram', 'apple'] as const;

/**
 * Настройки → «Способы входа»: every way into this ONE account, a «Привязать»
 * for each provider not linked yet and «Отвязать» for each linked one (never
 * for the last — an account nobody can open is lost). Linking a way in that
 * already opens an EMPTY account of its own (made by an earlier sign-in)
 * moves it here; the hub closes that empty account.
 */
export function SignInMethods({ onChanged }: { onChanged?: () => void }) {
  const [data, setData] = useState<IdentitiesResponse | undefined>();
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [telegram, setTelegram] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const config = usePublicConfig();

  const load = () => identitiesApi.list().then(setData, (e: Error) => setError(e instanceof ApiError && e.status === 404
    ? 'Сервер пока не показывает способы входа.'
    : e.message));
  useEffect(() => {
    const result = takeLinkResult();
    if (result) {
      if (result.ok) setNote(`${providerName(result.provider)} привязан — через него теперь можно входить в эту учётку.`);
      else setError(result.message);
    }
    void load();
  }, []);

  const identities = data?.identities ?? [];
  const has = (provider: string) => identities.some((i) => i.provider === provider);
  // Our own sign-in is not something a customer's hub has: hide its row unless
  // that hub actually switched it on — and do not count it as a way in either,
  // or the last USABLE method could be unlinked next to a hidden dead one.
  const shown = isExternal(config) && !config?.auth.hegaiSso ? identities.filter((i) => i.provider !== 'hegai') : identities;
  const last = shown.length <= 1;

  const unlink = async (identity: LinkedIdentity) => {
    if (!(await askConfirm(`Отвязать ${providerName(identity.provider)}${identity.label ? ` (${identity.label})` : ''}? Входить через него в эту учётку будет нельзя.`, { confirmLabel: 'Отвязать', danger: true }))) return;
    setError(''); setNote('');
    setBusy(`${identity.provider}:${identity.subject}`);
    identitiesApi.unlink(identity.provider, identity.subject)
      .then(() => { setNote(`${providerName(identity.provider)} отвязан.`); onChanged?.(); return load(); })
      .catch((e: Error) => setError(identityError(e.message)))
      .finally(() => setBusy(null));
  };

  return <section className="team-card settings-section">
    <h3>Способы входа</h3>
    <p className="team-help">Всё это — входы в одну и ту же учётку: можно входить любым из них.</p>
    {data === undefined && !error && <p className="team-help">Загружаю…</p>}
    {shown.map((identity) => {
      const key = `${identity.provider}:${identity.subject}`;
      return <div className="team-row static" key={key}>
        <span><b>{providerName(identity.provider)}</b>
          <small>{identity.label ? `${identity.label} · ` : ''}привязан {relTimeRu(identity.linkedAt)}{identity.lastUsedAt ? ` · вход ${relTimeRu(identity.lastUsedAt)}` : ''}</small></span>
        <button className="btn" disabled={last || busy === key} title={last ? 'Последний способ входа отвязать нельзя' : undefined}
          onClick={() => unlink(identity)}>Отвязать</button>
      </div>;
    })}
    {data && <div className="team-actions">
      {LINKABLE.filter((p) => !has(p)).map((provider) => {
        if (provider === 'google') {
          return data.available.google
            ? <a key={provider} className="btn" href={googleLinkUrl()}>Привязать Google</a>
            : null;
        }
        if (provider === 'telegram') {
          return data.available.telegram
            ? <button key={provider} type="button" className="btn" onClick={() => setTelegram(true)}>Привязать Telegram</button>
            : null;
        }
        return data.available.apple
          ? <span key={provider} className="team-help">Apple привязывается в приложении на iPhone: Настройки → Управление аккаунтом.</span>
          : null;
      })}
    </div>}
    {note && <div className="team-note">{note}</div>}
    {error && <div className="team-note">{error}</div>}
    {telegram && <TelegramSignInDialog intent="link" onClose={() => setTelegram(false)} onLinked={(t, movedFrom) => {
      setNote(movedFrom
        ? `Telegram ${t} привязан. Пустая учётка, которую он открывал раньше, закрыта.`
        : `Telegram ${t} привязан — через него теперь можно входить.`);
      onChanged?.();
      void load();
    }} />}
  </section>;
}

import { useState } from 'react';
import type { ViewerContext } from '@cc-remote/shared';
import { linkProps } from '../router.js';
import { viewerName } from '../lib.js';
import { storageRemove, storageSet } from '../storage.js';

/**
 * «Здравствуй» — the one card a community seat reads once.
 *
 * It says four true things in the order a newcomer needs them: what the
 * machine is (a Linux box, not magic), what we can see on it (everything —
 * said plainly, so secrets stay off it), who pays for the models (the
 * community, and where the share is shown), and how to leave with the code.
 * Nothing here sells; the only two buttons are «Понятно» and the first thing
 * worth doing.
 *
 * Dismissal is per person, not per browser: the key holds the user id, so a
 * shared laptop greets the next person and a returning one is not greeted
 * twice. Settings can bring it back through `resetWelcome()`.
 */
const KEY = 'cc-welcome';

export function resetWelcome(): void {
  // Storage unavailable — nothing to reset.
  storageRemove(KEY);
}

function seenBy(userId: string): boolean {
  try {
    return localStorage.getItem(KEY) === userId;
  } catch {
    // no storage means no way to remember a dismissal; do not nag every paint
    return true;
  }
}

/** Whether Home should carry the card at all — an active community seat that
 *  has not dismissed it. Employees never see it: their machine is their own. */
export function shouldWelcome(viewer: ViewerContext | null | undefined): boolean {
  if (!viewer?.access) return false;
  if (viewer.access.state !== 'active' || viewer.access.plan !== 'community') return false;
  return !seenBy(viewer.userId);
}

export function Welcome({ viewer }: { viewer: ViewerContext }) {
  const [seen, setSeen] = useState(() => seenBy(viewer.userId));
  if (seen) return null;
  // First name, else the address's local part; a Telegram-only account may
  // have neither.
  const firstName = viewerName(viewer, 'друг');
  const machine = viewer.access?.sandbox?.machineName;
  const dismiss = () => {
    // No storage: fine — it just shows again next time.
    storageSet(KEY, viewer.userId);
    setSeen(true);
  };
  const create = linkProps({ kind: 'new', create: true });
  return (
    <section className="home-card welcome">
      <div className="eyebrow eyebrow--mark">Здравствуй</div>
      <div className="welcome-body">
        <p>
          Здравствуй, {firstName}. Тебе выделена машина {machine ? <code>{machine}</code> : 'в песочнице'} —
          обычный Linux-сервер в нашем облаке с агентом Hegai Code и Codex. Она твоя: терминал, файлы, git.
          Чудес нет: сессия — это процесс Codex в папке проекта, а эта вкладка — пульт к нему.
        </p>
        <p>
          Честно про приватность. Машина стоит на нашем хосте, и администратор хоста технически может
          прочитать всё, что на ней лежит. Мы этого не делаем без твоей просьбы — но секреты и чужие
          данные туда лучше не класть.
        </p>
        <p>
          Модели — твои. Подписку на Claude Code или Codex ты подключаешь свою: на экране «Начало» напротив
          каждого стоит кнопка «Войти». Мы даём машину и пульт к ней, а не чужой лимит, который кончится в самый
          неподходящий момент.
        </p>
        <p>
          Уйти можно в любой момент вместе с кодом: отправь проект в свой репозиторий или подключи свою
          машину — всё в «Настройках → Забрать своё». Проект твой, а не наш.
        </p>
      </div>
      <div className="welcome-actions">
        <button className="btn" onClick={dismiss}>Понятно</button>
        {/* The card is dismissed forever after one read, so it has to hand off
            the things it does not cover — connecting your own machine, the
            clients — rather than be the only place they were ever mentioned. */}
        <a className="btn" {...linkProps({ kind: 'start' })}>Начало</a>
        <a
          className="btn primary"
          href={create.href}
          onClick={(e) => {
            // Read it, acted on it — the greeting has done its work either way.
            dismiss();
            create.onClick(e);
          }}
        >
          Создать первый проект
        </a>
      </div>
    </section>
  );
}

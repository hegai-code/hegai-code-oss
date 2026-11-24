/**
 * A screen, on its own, in a real browser.
 *
 * Why this exists: every screen in this app lives behind an SSO session and a
 * live hub socket, so "does it actually look right" was unanswerable without
 * signing in and finding the state by hand — and the honest report at the end
 * of a change was "typecheck and tests pass, I did not look". This mounts ONE
 * panel against stubbed data, with the real `styles.css`, at a real viewport,
 * so a headless browser can be pointed at it.
 *
 * `?screen=` picks the panel, `?theme=dark` picks the theme — both from the URL
 * rather than from the OS, so a screenshot run asks for what it wants instead
 * of depending on how this machine happens to be set up.
 *
 * It is dev-only: `npm run build` builds `index.html`, and Vite never reaches
 * this file. Nothing in `src/` may import it.
 */
// First: it must stand in for WebSocket before noVNC is evaluated.
import './screens-socket.js';
import { TabStrip } from './src/components/TabStrip.js';
import type { TabGroup } from './src/tabs.js';
import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IconContext } from '@phosphor-icons/react';
import type { ActiveRunInfo, HistoryMessage, MachineSnapshot, SessionSummary } from '@cc-remote/shared';
import './src/styles.css';
import { Panel, TeamMembers, WorkspaceSettings } from './src/TeamViews.js';
import { MyUsageView, PeriodSwitch, UsageList } from './src/UsageViews.js';
import type { UsageReport } from '@cc-remote/shared';
import { Hardware } from './src/components/Hardware.js';
import { Onboarding } from './src/components/Onboarding.js';
import { AppsTab } from './src/components/AppsTab.js';
import { AppPage } from './src/AppPage.js';
import { SetupPage } from './src/SetupPage.js';
import { SettingsTabs } from './src/TeamViews.js';
import { Appearance } from './src/Appearance.js';
import type { SettingsTab } from './src/router.js';
import { Landing } from './src/Landing.js';
import { ProjectList } from './src/components/ProjectList.js';
import { setScopeAvailable, useSessionScope } from './src/components/MineOnly.js';
import type { SessionScope } from './src/lib.js';
import { indexRuns, sessionKey } from './src/lib.js';
import { LiveLine, LiveRunRow, MessageView, ToolRunRow, groupHistory, groupLive } from './src/render/Blocks.js';
import type { TranscriptLine } from './src/central-reducers.js';
import { foldImageGen } from './src/central-reducers.js';
import { EnrichStrip } from './src/render/EnrichStrip.js';
import { UsageMeter } from './src/components/UsageMeter.js';
import { AttachmentContext } from './src/render/Attachment.js';
import { FilePeekContext, type PeekFile } from './src/render/FilePreviews.js';
import { Plus, MicIcon, ArrowUpIcon, Menu, Bell, MoreIcon, X } from './src/icons.js';
import { RunPicker } from './src/components/RunPicker.js';
import { ContextRing } from './src/panels/ContextRing.js';
import { EFFORT_LABEL } from './src/components/run-settings.js';
import { DictationStrip, VoiceButton } from './src/composer.js';
import { useRecorder } from './src/useRecorder.js';
import { SidePanel } from './src/shell/SidePanel.js';
import { ContextMenu } from './src/components/ContextMenu.js';
import { SessionDrawer } from './src/shell/SessionDrawer.js';
import { SessionWorkspace } from './src/shell/SessionWorkspace.js';
import { TopBar } from './src/shell/TopBar.js';
import { StartScreen } from './src/components/StartScreen.js';
import { SideSheet } from './src/components/SideSheet.js';
import { ChangesPanel } from './src/components/review/ChangesPanel.js';
import { FileList } from './src/components/files/FileList.js';
import { SaveStatusBar } from './src/components/files/SaveStatusBar.js';
import { FileGrid } from './src/components/files/FileGrid.js';
import { TeamAccess } from './src/TeamAccess.js';
import { Board } from './src/components/board/Board.js';
import type { CentralState } from './src/useCentral.js';
import { BrowserSheet } from './src/components/browser/BrowserSheet.js';
import { BrowserSettings } from './src/components/browser/BrowserSettings.js';

/** Answers the handful of `/api/*` calls a mounted panel makes on its own, so
 *  the screen renders full rather than as an error note. Anything unstubbed
 *  fails loudly — a silent empty panel would be the thing worth catching. */
function boardFixture() {
  const h = 3600_000;
  const now = Date.now();
  const owners = {
    owner: { userId: 'u1', label: 'Владелец', email: 'owner@x.test', fullName: 'Владелец Орлов' },
    ilia: { userId: 'u2', label: 'Илья', email: 'ilia@example.com', fullName: 'Илья Потоцкий' },
    marat: { userId: 'u3', label: 'Марат', email: 'm@clientco.com' },
  };
  const m = {
    stage: { machineId: 'm-stage', name: 'stage' },
    buildbox: { machineId: 'm-relo', name: 'buildbox-pc' },
    ilia: { machineId: 'm-ilia', name: 'Моя машина' },
    marat: { machineId: 'm-marat', name: 'Рабочий компьютер' },
  };
  const ev = (commits: number, pushed: boolean, deployed: boolean, verified: boolean, editedFiles = commits * 3, humanTurns = 6) => ({
    commits, pushed, deployed, verified, editedFiles, humanTurns, ...(commits ? { lastCommitAt: now - 2 * h } : {}),
  });
  const sess = (machineId: string, sessionId: string, title: string, ago: number, role: 'origin' | 'continuation' = 'origin') => ({
    machineId, sessionId, source: 'claude' as const, title, lastModified: now - ago, role,
  });
  const card = (
    id: string, title: string, summary: string, status: string, project: string, area: string | undefined,
    owner: (typeof owners)[keyof typeof owners] | undefined, machines: Array<{ machineId: string; name: string }>,
    ago: number, evidence: ReturnType<typeof ev>, extra: Record<string, unknown> = {},
  ) => ({
    cardId: id, title, summary, status, attention: 'none', project, ...(area ? { area } : {}), ...(owner ? { owner } : {}),
    machines, firstSeen: now - ago - 30 * h, lastActivity: now - ago, stale: false, evidence, confidence: 0.82, manualOverride: false,
    sessions: [sess(machines[0]!.machineId, `s-${id}`, `Сессия про ${title.toLowerCase()}`, ago)],
    events: [{ at: now - ago, actor: 'assembler', kind: 'created', to: status, reason: 'первый разбор' }],
    ...extra,
  });
  return {
    generatedAt: now,
    lastRun: { runId: 'run_1', mode: 'incremental', finishedAt: now - 20 * 60_000, llmCalls: 2 },
    areas: [
      { id: 'platform', name: 'a.test — платформа', blurb: 'Сообщество, CRM, платежи, нетворкинг, сайт', projects: ['hegai', 'a.test'] },
      { id: 'ccremote', name: 'cc-remote', blurb: 'Пульт управления Claude-сессиями', projects: ['claudehegai', 'remotehegai'] },
      { id: 'transcribe', name: 'Транскрибация', blurb: 'голос, Zoom-транскрипты', projects: ['hegaivoice'] },
      { id: 'unassigned', name: 'Без проекта', blurb: 'Сессии без рабочей папки', projects: [] },
    ],
    owners: [
      { ...owners.owner, cards: 14 },
      { ...owners.ilia, cards: 4 },
      { ...owners.marat, cards: 3 },
    ],
    cards: [
      card('crd_01', 'Диктовка на телефоне не глотает пробелы', 'Хотели, чтобы надиктованный с телефона текст приходил целиком. Сделано и выложено: пробелы и начало фразы больше не теряются. Осталось проверить на iPhone с включённой автозаменой.', 'testing', 'hegaivoice', 'transcribe', owners.owner, [m.buildbox], 3 * h, ev(2, true, false, false), { attention: 'question', attentionNote: 'Ассистент спрашивает, оставить ли старый способ ввода как запасной.' }),
      card('crd_02', 'Кнопка «Обновить приложение» в Mac и Windows', 'Люди сидели на старых версиях и не знали об этом. Теперь в приложении есть кнопка обновления, она проверена на обеих системах и выложена.', 'done', 'remotehegai', 'ccremote', owners.owner, [m.stage], 26 * h, ev(8, true, true, true, 20, 6), { doneAt: now - 26 * h, sessions: [sess('m-stage', 's-02a', 'Кнопка обновления приложения', 26 * h), sess('m-stage', 's-02b', 'Desktop window controls', 40 * h, 'continuation')], events: [{ at: now - 26 * h, actor: 'assembler', kind: 'status', from: 'testing', to: 'done', reason: 'коммит после последней реплики, выкат, проверка в браузере' }, { at: now - 40 * h, actor: 'assembler', kind: 'created', to: 'in_progress', reason: 'первый разбор' }] }),
      card('crd_03', 'Уведомления Windows-приложения без шума', 'Приходило много служебных уведомлений. Оставили только те, где нужен человек. Выложено, ждёт, чтобы кто-то пожил с этим день.', 'testing', 'remotehegai', 'ccremote', owners.owner, [m.stage], 30 * h, ev(10, true, true, false, 14, 9)),
      card('crd_04', 'Доступ Данису Латыпову к code.acme.test', 'Открыли доступ и проверили вход; Данис пока не заходил.', 'in_progress', 'remotehegai', 'ccremote', owners.owner, [m.stage], 5 * h, ev(8, true, false, false, 6, 18), { attention: 'blocked', attentionNote: 'Нужно письмо Данису с ссылкой — ассистент сам отправить не может.' }),
      card('crd_05', 'Веб-сервис анализа рукописей wtw.acme.test', 'Обсудили, что writeistheway станет сервисом на поддомене. Написали план, к коду не приступали.', 'planning', 'writeistheway', undefined, owners.owner, [m.stage], 60 * h, ev(0, false, false, false, 0, 9)),
      card('crd_06', 'Агент проверки новостей в Telegram', 'Идея: бот раз в день смотрит новости в чатах и присылает выжимку. Наговорено голосом, постановка есть, работы не было.', 'backlog', 'hegai', 'platform', owners.owner, [m.stage], 80 * h, ev(0, false, false, false, 0, 1), { confidence: 0.4 }),
      card('crd_07', 'Админка юридического бюро', 'Сделали раздел дел, клиентов и счетов для бюро. Выложено на legal.acme.test, Марат проверял вход.', 'done', 'hegai', 'platform', owners.marat, [m.marat, m.stage], 50 * h, ev(26, true, true, true, 60, 30), { doneAt: now - 50 * h }),
      card('crd_08', 'Отчёт NPS декабрь–январь', 'Разобрали архив с ответами NPS, собрали отчёт по темам и выложили в профиль. Осталось решить, показывать ли его всему сообществу.', 'in_progress', 'hegai', 'platform', owners.owner, [m.stage], 9 * h, ev(35, true, true, false, 40, 39), { manualOverride: true, sessions: [sess('m-stage', 's-08a', 'NPS дек 2025–янв 2026', 9 * h), sess('m-stage', 's-08b', 'Раздел отчетов в профиле', 100 * h, 'continuation')] }),
      card('crd_09', 'Приложение для автомойки: экран записи', 'Илья собирает приложение для клиента: сделан экран записи на мойку, идёт работа над оплатой.', 'in_progress', 'Автомойка апп', undefined, owners.ilia, [m.ilia], 2 * h, ev(4, false, false, false, 12, 22)),
      card('crd_10', 'Ссылка на hegai_network у Ксюши', 'Договорились оставить у Ксюши ссылку на сеть в профиле. Разговор без правок.', 'backlog', 'hegai', 'platform', owners.owner, [m.stage], 120 * h, ev(0, false, false, false, 0, 4)),
      card('crd_11', 'Контракты для Timoshino app', 'Подготовили два договора — на разработку и на обучение. Файлы у Владельца, подписания не было.', 'testing', 'hegai', 'platform', owners.owner, [m.stage], 28 * h, ev(0, false, false, false, 2, 6), { stale: false, evidence: ev(1, false, false, false, 2, 6) }),
      card('crd_12', 'Главная hegai.media иногда открывается пустой', 'Иногда главная страница открывается без новостей. Причину ищем; правок пока нет.', 'in_progress', 'hegai.media', undefined, owners.owner, [m.stage], 90 * h, ev(0, false, false, false, 0, 3), { stale: true, confidence: 0.45 }),
      card('crd_13', 'Mac mini отваливался от хаба каждые полминуты', 'Разобрались: это блокировка сети на порту, а не служба. Обошли через запасной порт, машина держится в сети.', 'done', 'remotehegai', 'ccremote', owners.owner, [m.stage], 70 * h, ev(3, true, true, true, 4, 6), { doneAt: now - 70 * h }),
      card('crd_14', 'Презентация про переезд для конференции', 'Собрали выступление на десять минут и слайды. Владелец выступил.', 'done', 'hegai', 'platform', owners.owner, [m.stage], 190 * h, ev(11, true, false, false, 11, 12), { doneAt: now - 190 * h, events: [{ at: now - 190 * h, actor: 'u1', kind: 'status', from: 'testing', to: 'done', reason: 'выступил' }], manualOverride: true }),
      card('crd_15', 'Сессии без владельца видны всем в команде', 'Разбираемся, почему чужие сессии попадают в общий список. Нашли место, правка в работе.', 'in_progress', 'remotehegai', 'ccremote', owners.ilia, [m.stage], 1 * h, ev(1, false, false, false, 2, 5)),
      card('crd_16', 'Договор аренды офиса: проверка условий', 'Марат прогнал договор через ассистента и получил список рисков. Правок в документах не было.', 'done', 'legal', undefined, undefined, [m.marat], 15 * h, ev(0, false, false, false, 0, 4), { doneAt: now - 15 * h, confidence: 0.6 }),
    ],
  };
}

const RESPONSES: Record<string, unknown> = {
  '/api/devices': {
    devices: [
      { machineId: 'm1', name: 'buildbox-pc', os: 'windows', lastSeen: Date.now() - 4 * 60_000 },
      { machineId: 'm2', name: 'mac mini', os: 'darwin', lastSeen: Date.now() - 3 * 3600_000 },
      { machineId: 'm3', name: 'старый ноут', os: 'darwin', lastSeen: Date.now() - 40 * 86400_000, revoked: true },
    ],
  },
  '/api/enrollments': { code: 'HGA-4417', expiresAt: Date.now() + 15 * 60_000 },
  // The access tab. One row per awkward shape: no `fullName` (the address is
  // the title), a long Cyrillic name with four chips and a button in one row,
  // a note long enough to need its ellipsis, and an employee.
  // The task board: every status, both attention flags, all three evidence
  // shapes, a card without an owner, a long Cyrillic title, a low-confidence
  // card and a hand-pinned one — the combinations a real fortnight produces.
  '/api/board': boardFixture(),
  '/api/admin/access': {
    counts: { waitlist: 12, active: 34, suspended: 2 },
    pending: [
      { email: 'anna.ivanova@example.com', note: 'друг Владельца, делает бота для расписания', createdAt: Date.now() - 2 * 86400_000, createdBy: 'u1' },
      { email: 'v@a.test', createdAt: Date.now() - 3600_000, createdBy: 'u1' },
    ],
    users: [
      {
        userId: 'a1', email: 'konstantin.verestchagin@example.com', fullName: 'Константин Верещагин-Полторацкий',
        state: 'waitlist', plan: 'community', requestedAt: Date.now() - 9 * 86400_000,
        note: 'Хочу собрать внутренний ассистент для отдела продаж: он читает переписку в амо, готовит саммари по сделке и подсказывает, что спросить на следующем звонке. Сейчас это руками делает стажёр, и половина звонков уходит впустую.',
        seat: { status: 'failed', error: 'gateway 502' }, sandbox: { status: 'queued' }, invitedTo: ['HegAI'],
      },
      { userId: 'a2', email: 'm@example.com', state: 'waitlist', plan: 'community', requestedAt: Date.now() - 4 * 86400_000, seat: { status: 'none' }, sandbox: { status: 'none' } },
      { userId: 'a3', email: 'egor@a.test', fullName: 'Егор', state: 'waitlist', plan: 'employee', requestedAt: Date.now() - 86400_000, seat: { status: 'none' }, sandbox: { status: 'none' } },
    ],
  },
  '/api/admin/provisioning/jobs': {
    jobs: [
      { jobId: 'j1', userId: 'a1', email: 'konstantin.verestchagin@example.com', kind: 'sandbox_create', status: 'failed', attempts: 3, host: 'stage', createdAt: Date.now() - 7200_000, finishedAt: Date.now() - 6900_000, error: 'stage=enroll retryable=false: useradd: user sb-konstantin already exists' },
    ],
  },
};

/* ---- the cloud browser ---------------------------------------------------
   No hub, so no screen: the VNC socket is `screens-socket.ts`. The empty state
   is the same sheet with no profiles. */
const SCREEN_PARAM = new URLSearchParams(location.search).get('screen') ?? '';
{
  const nowSec = Math.floor(Date.now() / 1000);
  RESPONSES['/api/browser'] = { enabled: true, egress: SCREEN_PARAM !== 'browserNoEgress' };
  RESPONSES['/api/browser/profiles'] = {
    profiles: SCREEN_PARAM === 'browserEmpty' ? [] : [
      { id: '0123456789abcdef', name: 'Браузер', created_at: nowSec - 9 * 86400, last_used_at: nowSec - 600, running: true },
      { id: 'fedcba9876543210', name: 'Рабочий Google', created_at: nowSec - 2 * 86400, last_used_at: nowSec - 3 * 86400, running: false },
    ],
  };
}

/* ---- a customer's own hub (external edition) ----------------------------
   `?screen=...Ext` pretends the hub answered `/api/public-config` as a
   self-hosted one: no desktop builds, no HegAI sign-in. */
const EXTERNAL_SCREENS = new Set(['accessExt', 'appPagePhoneExt', 'appPageExt', 'setupDonePhone', 'settingsAccountExt', 'teamPeopleExt', 'settingsAppsExt', 'onboardPhoneExt', 'onboardMachineOnlineExt']);
if (EXTERNAL_SCREENS.has(SCREEN_PARAM)) {
  RESPONSES['/api/public-config'] = {
    edition: 'external', brandName: 'Hegai Code', publicUrl: location.origin,
    auth: { local: true, google: false, telegram: false, apple: false, hegaiSso: false }, desktopApps: false,
  };
  RESPONSES['/api/me/identities'] = {
    identities: [
      { provider: 'local', subject: 'u1', label: 'owner@example.com', linkedAt: Date.now() - 9 * 86400_000, lastUsedAt: Date.now() - 3600_000 },
      { provider: 'hegai', subject: 'h1', linkedAt: Date.now() - 9 * 86400_000 },
    ],
    available: { google: false, apple: false, telegram: false },
  };
  RESPONSES['/api/auth/sessions'] = { sessions: [
    { id: 's1', label: 'Chrome · Linux', createdAt: Date.now() - 86400_000, lastSeen: Date.now() - 60_000, current: true },
  ] };
  RESPONSES['/api/workspaces/w1/members'] = { members: [
    { userId: 'u1', email: 'owner@example.com', fullName: 'Анна', role: 'owner', joinedAt: Date.now() - 9 * 86400_000 },
    { userId: 'u2', email: 'colleague@example.com', role: 'member', joinedAt: Date.now() - 86400_000 },
  ] };
}

window.fetch = (async (input: RequestInfo | URL) => {
  const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
  const body = RESPONSES[new URL(path, location.origin).pathname];
  if (!body) throw new Error(`preview: no stub for ${path}`);
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const central = {
  viewer: {
    userId: 'u1',
    email: 'owner@x.test',
    fullName: 'Владелец',
    platformAdmin: true,
    workspace: { workspaceId: 'w1', name: 'HegAI', kind: 'organization', role: 'owner' },
  },
  machines: [],
  activeRuns: [],
  machineStats: {},
  // What each machine's Claude/Codex ARE, keyed by machine (24.09.2026). Every
  // screen with the limits pill or a machine card reads it, so a stub without
  // it renders NOTHING — `start`, `hardwareFull` and `usage` all came back as
  // blank frames, and the onboarding pictures shipped 600-byte empties.
  runtimes: {},
} as unknown as CentralState;

/* ---- transcript stub ----------------------------------------------------
   A turn of prose, a fold of machinery, more prose — the shape the reading
   layout has to survive. Written out rather than generated so the measure, the
   wrapping and the fold count stay the same picture between two runs. */
const T0 = Date.UTC(2026, 8, 1, 8, 52);
const call = (i: number, name: string, input: unknown) => ({ kind: 'tool_use' as const, id: `t${i}`, name, input });
const HISTORY: HistoryMessage[] = [
  {
    type: 'user',
    uuid: 'u-1',
    ts: T0,
    blocks: [{ kind: 'text', text: 'посмотри, почему распознавание глотает конец фразы' }],
  },
  /* A human turn with a screenshot in it. The picture is what this fixture is
     for: the marker used to render as a grey «image» chip you could not open,
     and the stub provider below answers the same way a live session does. */
  {
    type: 'user',
    uuid: 'u-img',
    ts: T0 + 10_000,
    blocks: [
      { kind: 'text', text: 'вот что видно на экране' },
      { kind: 'image', ref: 'u-img#1' },
    ],
  },
  {
    type: 'assistant',
    uuid: 'a-1',
    ts: T0 + 40_000,
    blocks: [
      {
        kind: 'text',
        text: 'Берусь. Сначала два факта, которые надо знать до всяких экспериментов: с какими параметрами мы вообще зовём распознавание и что не так со звуком объективно.',
      },
    ],
  },
  {
    type: 'assistant',
    uuid: 'a-2',
    ts: T0 + 95_000,
    blocks: [
      call(1, 'Read', { file_path: 'src/asr/session.ts' }),
      call(2, 'Grep', { pattern: 'endpointing', path: 'src' }),
      call(3, 'Read', { file_path: 'src/asr/vad.ts' }),
      call(4, 'Bash', { command: 'ffprobe -hide_banner sample.wav' }),
      call(5, 'Edit', { file_path: 'src/asr/vad.ts' }),
      call(6, 'Bash', { command: 'npm test -- asr' }),
    ],
  },
  /* The runtime's own turn, and the shape that used to break: a tool result
     wrapped together with a line of harness noise. The noise is stripped on
     render, so what is left is a bare tool chip — and the SIDE used to be
     decided from the raw blocks, which still had the noise in them, so the
     chip was classed as a human turn and floated right. It belongs on the
     agent's side, in the flow, like every other piece of machinery. */
  {
    type: 'user',
    uuid: 'u-2',
    ts: T0 + 250_000,
    blocks: [
      { kind: 'text', text: '<system-reminder>служебная строка рантайма</system-reminder>' },
      { kind: 'tool_result', text: 'ok', toolUseId: 't6' },
    ],
  },
  {
    type: 'assistant',
    uuid: 'a-3',
    ts: T0 + 260_000,
    blocks: [
      {
        kind: 'text',
        text: 'Конец фразы срезает **VAD**, а не модель: порог тишины стоит 180 мс, и на медленной речи пауза перед последним словом читается как конец реплики. Поднял до 420 мс и заодно перестал обрезать хвост буфера — тест на медленной дорожке проходит.',
      },
    ],
  },
  {
    type: 'assistant',
    uuid: 'a-4',
    ts: T0 + 300_000,
    blocks: [call(7, 'Bash', { command: 'git diff --stat' }), call(8, 'Read', { file_path: 'src/asr/vad.ts' })],
  },
  {
    type: 'assistant',
    uuid: 'a-5',
    ts: T0 + 330_000,
    blocks: [{ kind: 'text', text: 'Изменение в одном файле, восемь строк.' }],
  },
  // Та же минута, тот же говорящий — ход, на котором штамп обязан промолчать.
  // Без этой пары стенд не отличает «время у каждой реплики» от «время дважды
  // подряд одной строкой», а именно второе и пришлось чинить.
  {
    type: 'assistant',
    uuid: 'a-6',
    ts: T0 + 345_000,
    blocks: [{ kind: 'text', text: 'Раскатывать?' }],
  },
];

/**
 * The composer, in its ACTIVE-run state — mirroring the markup Chat.tsx emits
 * at :660-877 and composer.tsx at :298-328.
 *
 * It is hand-rolled rather than mounted, because the real one is wired
 * straight into a live `useCentral` socket (model list, effort list, context
 * window, run id) and there is no standalone component to import. That makes
 * this a copy, and copies drift — so it stays deliberately thin: every class
 * here exists in Chat.tsx, and nothing here styles itself.
 *
 * Without it, the Колонки fixture showed a transcript floating above nothing,
 * while in the product a third of every pane's bottom edge is this control.
 */
/** A recorder frozen in one state, for the fixture. `getLevel` is a sine on a
 *  counter and not the microphone, so the bars land in the same places every
 *  run and two PNGs are worth comparing. */
const stubRecorder = (state: 'recording' | 'transcribing') => {
  let i = 0;
  return {
    state,
    polishing: false,
    toggle: () => {},
    cancel: () => {},
    sendNow: () => {},
    retry: () => {},
    canRetry: false,
    getLevel: () => 0.25 + 0.55 * Math.abs(Math.sin(i++ / 3)),
    // Live dictation: a phrase read, the next one pending — the strip's
    // text row is part of what the fixture photographs.
    liveText: 'Смотри, дорожка теперь во всю ширину,',
    livePending: state === 'recording',
  };
};

function ComposerStub({ openPicker, idle, dictating, unknownEffort }: { openPicker?: boolean; idle?: boolean; dictating?: 'recording' | 'transcribing'; unknownEffort?: boolean }) {
  // The REAL RunPicker, not a mirror of its closed state. The mirror is what let
  // the popover ship clipped away by an ancestor's `overflow: hidden`: a fixture
  // that only ever draws the trigger cannot answer "and does it open".
  const tools = useRef<HTMLDivElement>(null);
  const clicked = useRef(false);
  useEffect(() => {
    if (!openPicker || clicked.current) return;
    // The trigger TOGGLES, and StrictMode runs this effect twice on mount — two
    // clicks leave the menu shut and the fixture quietly photographs nothing,
    // which is how this view failed the first time it was taken. Asking the DOM
    // "is it open yet" does not help: both invocations happen in the same commit,
    // before React has re-rendered. A ref survives the double-invoke; nothing
    // else here does.
    clicked.current = true;
    tools.current?.querySelector<HTMLButtonElement>('.run-pick')?.click();
  }, [openPicker]);
  return (
    <div className="composer">
      <div className={`composer-box cg ${idle ? 'idle' : ''} ${dictating ? 'dict' : ''}`}>
        {/* The REAL strip, not a mirror of it: it takes only a recorder, so
            there is nothing here worth faking except the microphone itself.
            CSS hides the textarea beside it — that swap is half the feature. */}
        {dictating ? <DictationStrip recorder={stubRecorder(dictating)} /> : null}
        <textarea rows={1} placeholder="Напишите сообщение…" readOnly />
        <div className="composer-actions">
          {/* `attach` / `mic` are not decoration: the collapsed one-row
              composer orders these by class (see styles.css), and a stub
              missing them photographed the microphone in front of the field. */}
          <button className="round-btn attach" type="button" aria-label="Прикрепить файл">
            <Plus size={20} weight="bold" />
          </button>
          <div className="composer-tools" ref={tools}>
            {/* `effortLabel` below is the REAL dictionary, not a copy of it.
                The copy that stood here had drifted twice over — it still said
                «Максимальное» for xhigh months after the product stopped — so
                the picture asserted a label the product does not use.

                `unknownEffort` pins nothing and reports nothing — the state the
                slider used to draw as a thumb sitting on `low`. There is no way
                to check that but to look: the bug and the fix differ only in
                whether a thumb is drawn, and both satisfy every assertion about
                the value underneath. */}
            {/* Mirrors Chat.tsx: the context ring sits beside the model. */}
            <ContextRing
              usage={{ percentage: 39, totalTokens: 78_000, maxTokens: 200_000, autoCompactEnabled: true, autoCompactThreshold: 0.92 } as never}
              cost={null}
              compacting={false}
              onCompact={() => {}}
            />
            <RunPicker
              modelLabel="Opus 5.5"
              models={[
                { id: 'opus', name: 'Opus 5.5' },
                { id: 'sonnet', name: 'Sonnet 5' },
                { id: 'haiku', name: 'Haiku 4.5' },
              ]}
              model="opus"
              accountLabel="Opus 5.5"
              effort={unknownEffort ? '' : 'high'}
              efforts={['low', 'medium', 'high', 'xhigh']}
              effortLabel={EFFORT_LABEL}
              effortOff={false}
              allowUltracode
              onModel={() => {}}
              onEffort={() => {}}
              plan={{ on: true, onToggle: () => {} }}
            />
          </div>
          <button className="round-btn mic" type="button" aria-label="Голосовой ввод">
            <MicIcon size={21} />
          </button>
          <button className="send-round" type="button" aria-label="Отправить">
            <ArrowUpIcon size={16} weight="bold" />
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The REAL recorder against a real microphone — everything but the network.
 * `?fail=1` makes the transcription refuse, which is the path that used to end
 * in a silent return to idle and now has a strip that must clear itself.
 */
function LiveDictation() {
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const fail = new URLSearchParams(location.search).get('fail') === '1';
  const transcribe = useCallback(
    async (blob: Blob) => {
      // Long enough that the smoke can observe `transcribing` before it ends.
      await new Promise((r) => setTimeout(r, 900));
      if (fail) throw new Error('transcribe refused');
      return `распознано ${blob.size > 0 ? 'ок' : 'пусто'}`;
    },
    [fail],
  );
  // Split exactly as the product splits it: the microphone stops INTO the
  // composer, send stops and DELIVERS. `sent` is the fixture's outbox, so the
  // smoke can tell the two apart — the bug worth guarding is the transcript
  // quietly taking the draft route when send was pressed.
  const [sent, setSent] = useState('');
  const recorder = useRecorder(
    transcribe,
    (t, immediate) => (immediate ? setSent(t) : setText(t)),
    setErr,
  );
  return (
    <div className="chat">
      <div className="log">
        <div className="log-inner">
          <p data-testid="text">{text}</p>
          <p data-testid="sent">{sent}</p>
          <p data-testid="err">{err}</p>
        </div>
      </div>
      <div className="composer">
        <div className={`composer-box cg ${recorder.state !== 'idle' ? 'dict' : ''}`}>
          <DictationStrip recorder={recorder} />
          <textarea rows={1} placeholder="Напишите сообщение…" readOnly />
          <div className="composer-actions">
            <VoiceButton recorder={recorder} />
            <button
              className="send-round"
              disabled={recorder.state === 'transcribing'}
              onClick={recorder.state === 'recording' ? recorder.sendNow : () => {}}
              aria-label="Отправить"
            >
              <ArrowUpIcon size={16} weight="bold" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * A session on a phone, in the app's REAL nesting: `.app > .body > …`, with
 * the drawer as a SIBLING of `.body` inside `.app`.
 *
 * That nesting is the whole point of taking a slot rather than letting the
 * `drawer` view render this and the drawer side by side, which is what it did
 * before: the rule that pushes the app aside when the drawer opens is
 * `.app:has(> .sdrawer) > .body`, so a fixture with the drawer outside `.app`
 * photographed the one arrangement the product never has — and photographed it
 * as if nothing had changed.
 */
function SessionScreen({
  drawer,
  live = false,
  info = false,
  desk = false,
  other = false,
  helpers = false,
}: {
  /** The turn with helpers: two sub-agent cards, a Codex child with no card,
   *  and the session's own card under them (14.10.2026). */
  helpers?: boolean;
  drawer?: React.ReactNode;
  live?: boolean;
  /** The public page's scene (DESK_*) instead of the layout transcript. */
  desk?: boolean;
  other?: boolean;
  /** Open the panel behind the session TITLE. Below 1200px that is a sheet, and
   *  it had no picture at all — which is exactly how nine label/value rows and
   *  a scrollbar ended up standing between a tap and the three buttons that tap
   *  was for. The REAL SessionWorkspace, so the fixture cannot drift from it. */
  info?: boolean;
}) {
  return (
    <div className="app">
      <div className="body">
        <div className="main-col">
          <main className="main">
            {live || info || desk || other || helpers ? <SessionWorkspace
              central={helpers ? HELPERS_CENTRAL : desk ? DESK_CENTRAL : other ? { ...BUSY_CENTRAL, background: [], viewer: { ...BUSY_CENTRAL.viewer, userId: SIDEBAR_VIEWER } } as CentralState : BUSY_CENTRAL}
              session={desk ? DESK_SESSION : other ? { ...BUSY_SESSION, project: 'hegai-platform', owner: { userId: 'u3', fullName: 'Александра-Екатерина Смирнова' } } : BUSY_SESSION}
              selected={desk ? { machineId: 'd1', sessionId: 'cart' } : { machineId: 'inset-machine', sessionId: BUSY_SESSION.sessionId }}
              runIndex={indexRuns([])}
              infoOpen={info}
              onToggleInfo={() => {}}
              canEdit canDrive ownsSelected
              onRename={() => {}}
              onDelete={() => {}}
              onToggleClosed={() => {}}
              onOpenDrawer={() => {}}
            /> : <div className="workspace">
              <div className="ws-main">
                <div className="ws-head">
                  <div className="ws-titlebar">
                    <button className="icon-btn ws-menu" type="button" aria-label="Сессии">
                      <Menu size={18} />
                    </button>
                    <button className="ws-title" type="button" title="О сессии">
                      <span className="ws-live" />
                      <span className="ws-title-text">Zoom интеграция и загрузка видео из облака</span>
                    </button>
                    {/* The «Открыть рядом» + is NOT drawn here any more. It
                        enters Колонки, which is desk-only, and below 861px the
                        real header hides it (`!phone` in SessionWorkspace) —
                        every row this fixture has at this screen is 390px, so
                        leaving it in was the fixture asserting the opposite of
                        the product. */}
                  </div>
                </div>
                <div className="panel">
                  {/* At REST — the state a session opens in, and the one the
                      composer folds to a single row for. */}
                  <Log composer idleComposer />
                </div>
              </div>
            </div>}
          </main>
        </div>
      </div>
      {drawer}
    </div>
  );
}

// Mount the production Chat, including textarea measurement, the composer
// ResizeObserver and the hidden footer. A copied composer cannot test whether
// an active run changes the space below the input on a touch device.
const BUSY_SESSION = {
  sessionId: 'inset-busy', cwd: '/fixture', source: 'claude',
  title: 'Zoom интеграция и загрузка видео из облака', lastModified: T0,
} as SessionSummary;
const BUSY_CENTRAL = {
  ...central,
  status: 'open', busy: true, lines: [], sessionCost: null,
  active: { machineId: 'inset-machine', sessionId: BUSY_SESSION.sessionId, runId: 'inset-run' },
  machines: [{ machine: { machineId: 'inset-machine', name: 'Fixture' }, online: true }],
  runFor: () => ({ state: 'working', since: BUSY_SINCE }),
  rpc: async (_machineId: string, method: string) => {
    if (method === 'session.messages') return { messages: HISTORY };
    if (method === 'models.list') return { models: [] };
    throw new Error(`preview: no RPC stub for ${method}`);
  },
} as unknown as CentralState;
const BUSY_SINCE = Date.now() - 64_000;

/* A turn with helpers (14.10.2026): a background Explore still running (its
   card is on screen, so the panel does NOT repeat it), a finished one whose
   card keeps its report, a Codex child with no card (a panel row), and the
   session's own card under the transcript. */
const HELPERS_T = Date.now();
const HELPERS_CENTRAL = {
  ...BUSY_CENTRAL,
  lines: [
    // A finished turn above: its «Что сделано» recap stays (19.10.2026).
    { id: 101, kind: 'user', text: 'проверь сборку', ts: HELPERS_T - 400_000 },
    { id: 102, kind: 'tool_use', text: 'Bash {"command":"npm run build --workspace web","description":"собираю веб"}' },
    { id: 103, kind: 'tool_use', text: 'Read {"file_path":"/srv/main-source/web/vite.config.ts"}' },
    { id: 104, kind: 'tool_use', text: 'Bash {"command":"cd /srv/main-source; deploy/term.sh dev-mac-mini-001 30 \'du -sk ~/*\'"}' },
    { id: 105, kind: 'assistant', text: 'Сборка чистая, предупреждений нет.', ts: HELPERS_T - 92_000 },
    { id: 1, kind: 'user', text: 'разберись, почему пропадают помощники', ts: HELPERS_T - 70_000 },
    { id: 2, kind: 'assistant', text: 'Запускаю двух помощников и смотрю сам.', ts: HELPERS_T - 66_000 },
    { id: 3, kind: 'tool_use', text: 'Agent {"description":"Digest assistant flow","subagent_type":"Explore","prompt":"…","run_in_background":true}', data: { id: 'toolu_A' } },
    { id: 4, kind: 'tool_use', text: 'Agent {"description":"Map Teo state","subagent_type":"Explore","prompt":"…"}', data: { id: 'toolu_B' } },
    // The session's own checklist (07.11.2026): the strip over the composer counts it.
    { id: 41, kind: 'tool_use', text: `mcp__hegai__plan ${JSON.stringify({ todos: [
      { content: 'Найти, где теряются помощники', status: 'completed', activeForm: 'Ищу, где теряются помощники' },
      { content: 'Починить кэш завершённых', status: 'completed', activeForm: 'Чиню кэш завершённых' },
      { content: 'Проверить на iOS и в вебе', status: 'in_progress', activeForm: 'Проверяю на iOS и в вебе' },
      { content: 'Тесты и ревью', status: 'pending', activeForm: 'Гоняю тесты и ревью' },
      { content: 'Выкатить', status: 'pending', activeForm: 'Выкатываю' },
    ] })}` },
    { id: 5, kind: 'tool_use', text: 'Bash {"command":"cd /srv/main-source && git log -1 --format=%h","description":"смотрю последний коммит"}' },
    { id: 6, kind: 'tool_use', text: 'Read {"file_path":"web/src/panels/Chat.tsx"}' },
    { id: 7, kind: 'tool_use', text: 'Grep {"pattern":"subagents"}' },
  ],
  subagents: [
    {
      id: 'task-A', toolUseId: 'toolu_A', kind: 'Explore', description: 'Digest assistant flow', status: 'running', background: true,
      startedAt: HELPERS_T - 65_000, toolUses: 15, tokens: 92_000, model: 'claude-sonnet-5-5',
      recent: ['Bash · cd /srv/acme/src/lib/assistant-v2; ls scenarios', 'Bash · cd /srv/acme; ls docs/features/assistant-v2/'],
      lastAction: 'Bash · cd /srv/acme; sed -n 1,20p src/lib/assistant-v2/index.ts', activeAt: HELPERS_T - 2_000,
      plan: { done: 2, total: 5, active: 'Читаю сценарии assistant-v2' },
    },
    {
      id: 'task-B', toolUseId: 'toolu_B', kind: 'Explore', description: 'Map Teo state', status: 'completed', background: true,
      startedAt: HELPERS_T - 64_000, endedAt: HELPERS_T - 3_000, toolUses: 10, tokens: 44_000, model: 'claude-sonnet-5-5',
      steps: ['Bash · git branch -a --contains 4f1c', 'Bash · git log -1'],
      summary: 'Тео держит состояние в fleet--teo-state.md; ветка teo-front-door влита, открытых вопросов два.',
    },
    {
      id: 'thread-C', kind: 'worker', description: 'Прогнать тесты парсеров', status: 'running', background: true,
      startedAt: HELPERS_T - 20_000, lastAction: '$ npm test', activeAt: HELPERS_T - 1_000,
    },
  ],
  background: [],
  runSettings: { activeModel: 'claude-opus-5-5', activeEffort: 'high' },
} as unknown as CentralState;

/* The live tail in the shape that put a gear at the HEAD of a paragraph and a
   «Bash не выполнен» line into the reading (04.10.2026): a refusal between two
   stretches of machinery, prose, then the run that is still going. */
const LIVE_T = Date.UTC(2026, 9, 4, 0, 23);
const tool = (id: number, name: string, input: unknown): TranscriptLine => ({ id, kind: 'tool_use', text: `${name} ${JSON.stringify(input)}` });
const LIVE: TranscriptLine[] = [
  { id: 1, kind: 'user', text: 'добей парсеры', ts: LIVE_T - 120_000 },
  { id: 2, kind: 'assistant', text: 'Смотрю, где теряются нули.', ts: LIVE_T - 110_000 },
  tool(3, 'Read', { file_path: 'src/parse.ts' }),
  tool(4, 'Bash', { command: 'rm -rf dist' }),
  { id: 5, kind: 'status', code: 'permission_denied', text: 'Bash не выполнен — запрещено правилом в настройках' },
  tool(6, 'Read', { file_path: 'src/num.ts' }),
  tool(7, 'Edit', { file_path: 'src/num.ts' }),
  tool(8, 'Bash', { command: 'npm test' }),
  tool(9, 'Read', { file_path: 'test/num.test.ts' }),
  { id: 10, kind: 'assistant', text: 'Нули на месте. Теперь строгие парсеры и тесты к ним.', ts: LIVE_T },
  ...Array.from({ length: 15 }, (_, i) => tool(11 + i, i % 2 ? 'Edit' : 'Read', { file_path: `src/strict${i}.ts` })),
];

function LiveLog() {
  return (
    <div className="chat">
      <div className="log">
        <div className="log-inner">
          {groupLive(LIVE).map((it) =>
            it.kind === 'line' ? (
              <LiveLine
                key={it.id}
                line={it.line}
                cont={it.cont}
                showStamp={it.showStamp}
                runBefore={it.runBefore}
                runAfter={it.runAfter?.lines}
                runCurrent={!!it.runAfter?.tail}
              />
            ) : (
              <LiveRunRow key={it.id} lines={it.lines} current={it.tail} />
            ),
          )}
        </div>
      </div>
    </div>
  );
}

/* ---- generated pictures ---------------------------------------------------
   History carries one finished picture (portrait) behind the Bash call that
   made it; the live tail has a second one drawing (placeholder + bar), a third
   already done (landscape) and a fourth that failed. The stub provider answers
   per ref, so the loader, the retry and the lightbox are the product's own. */
const GEN_PORTRAIT = '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';
const GEN_LANDSCAPE = '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';
const GEN_HISTORY: HistoryMessage[] = [
  { type: 'user', uuid: 'g-u', ts: T0, blocks: [{ kind: 'text', text: 'нарисуй лису на снегу, потом ещё две' }] },
  { type: 'assistant', uuid: 'g-a', ts: T0 + 5_000, blocks: [{ kind: 'text', text: 'Рисую. Первая готова, следующие две в работе.' }, call(1, 'Bash', { command: 'hegai-image "рыжая лиса на снегу, мягкий зимний свет" fox.png' })] },
  { type: 'assistant', uuid: 'g-i', ts: T0 + 50_000, blocks: [{ kind: 'image', ref: 'gen:hist', generated: true, prompt: 'Рыжая лиса на снегу, мягкий зимний свет, лёгкая дымка над полем, сзади тёмный ельник и бледное небо перед рассветом' }] },
];
const GEN_NOW = Date.now();
const GEN_LIVE: TranscriptLine[] = (() => {
  let n = 0;
  const next = () => ++n;
  let lines: TranscriptLine[] = [];
  const ev = (state: string, extra: Record<string, unknown>) =>
    (lines = foldImageGen(lines, { id: extra['id'] ?? 'ig_1', state, ...extra }, '', next, () => GEN_NOW));
  ev('started', { id: 'ig_2', startedAt: GEN_NOW - 47_000, prompt: 'Лиса в лесу, вид сбоку, акварель' });
  ev('started', { id: 'ig_3', startedAt: GEN_NOW - 70_000, prompt: 'Лиса у реки' });
  ev('done', { id: 'ig_3', ref: 'gen:live' });
  ev('started', { id: 'ig_4', startedAt: GEN_NOW - 5_000 });
  ev('failed', { id: 'ig_4', error: 'запрос отклонён модерацией' });
  return lines;
})();

function GenLog() {
  return (
    <AttachmentContext.Provider
      value={async (ref) => ({ mediaType: 'image/png', dataB64: ref === 'gen:hist' ? GEN_PORTRAIT : GEN_LANDSCAPE })}
    >
      <div className="chat">
        <div className="log">
          <div className="log-inner">
            {groupHistory(GEN_HISTORY).map((it) =>
              it.kind === 'msg' ? (
                <MessageView key={it.id} msg={it.msg} cont={it.cont} showStamp={it.showStamp} runBefore={it.runBefore} runAfter={it.runAfter} />
              ) : (
                <ToolRunRow key={it.id} blocks={it.blocks} />
              ),
            )}
            {groupLive(GEN_LIVE).map((it) =>
              it.kind === 'line' ? (
                <LiveLine key={it.id} line={it.line} cont={it.cont} showStamp={it.showStamp} />
              ) : (
                <LiveRunRow key={it.id} lines={it.lines} current={it.tail} />
              ),
            )}
          </div>
        </div>
      </div>
    </AttachmentContext.Provider>
  );
}

/** The transcript as the app renders it — the real components, the real CSS. */
function Log({ strip, composer, openPicker, idleComposer, dictating, unknownEffort }: { strip?: React.ReactElement; composer?: boolean; openPicker?: boolean; idleComposer?: boolean; dictating?: 'recording' | 'transcribing'; unknownEffort?: boolean }) {
  return (
    <div className="chat">
      <div className="log">
        <div className="log-inner">
          {groupHistory(HISTORY).map((it) =>
            it.kind === 'msg' ? (
              <MessageView
                key={it.id}
                msg={it.msg}
                cont={it.cont}
                showStamp={it.showStamp}
                runBefore={it.runBefore}
                runAfter={it.runAfter}
              />
            ) : (
              <ToolRunRow key={it.id} blocks={it.blocks} />
            ),
          )}
          {strip}
        </div>
      </div>
      {composer ? <ComposerStub openPicker={openPicker} idle={idleComposer} dictating={dictating} unknownEffort={unknownEffort} /> : null}
    </div>
  );
}

/** What the hub's LLM pass answers for the stub tail («…Раскатывать?»).
 *
 *  All three kinds at once, because the point of the strip is that they are
 *  NOT the same gesture: two answers to the question asked, a continuation of
 *  this work, and two ideas nobody asked for — which tapping starts. A fixture
 *  with replies only would not show whether the ideas read as a different
 *  thing, which is the entire reason they render apart. */
/** A stand-in screenshot for the attachment fixture: a checkerboard, inline,
 *  so the picture path renders without a hub or a transcript behind it. */
const SHOT_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAUAAAADICAIAAAAWZq/8AAADY0lEQVR42u3csQkAIBAEQcsxEAswEPuvyh40OJQB84F7NrXU3o7fWPP4cbnce7cYmssVsKG5XAFzuVwBc7kCNjSXK2BDc7kC5nK5AuZyBWxoLlfAXC5XwFyugA3N5QrY0FyugLlcroC5XAEbmssVsANzuQLmcrkC5nI/CdhYXO67roC5XAEbmssVMJfLFTCXK2BDc7kCNjSXK2AulytgLlfAhuZyBczlcgXM5QrY0FyugA3N5QqYy+UKmMsVsKG5XAE7MJcrYC6XK2Au95eAjcXl+pXS0FyugLlcroC5XAEbmssVsKG5XAFzuVwBc7kCNjSXK2AulytgLlfAhuZyBWxoLlfAXC5XwFyugA3N5QrYgblcAXO5XAFzuQI2NJebDthYXK5fKQ3N5QqYy+UKmMsVsKG5XAEbmssVMJfLFTCXK2BDc7kC5nK5AuZyBWxoLlfAhuZyBczlcgXM5QrY0FyugB2YyxUwl8sVMJcrYENzuemAjcXl+pXS0FyugLlcroC5XAEbmssVsKG5XAFzuVwBc7kCNjSXK2AulytgLlfAhuZyBWxoLlfAXC5XwFyugA3N5QrYgblcAXO5XAFzuQI2NJebDthYXK5fKQ3N5QqYy+UKmMsVsKG5XAEbmssVMJfLFTCXK2BDc7kC5nK5AuZyBWxoLlfAhuZyBczlcgXM5QrY0FyugB2YyxUwl8sVMJcrYENzuemAjcXl+pXS0FyugLlcroC5XAEbmssVsKG5XAFzuVwBc7kCNjSXK2AulytgLlfAhuZyBWxoLlfAXC5XwFyugA3N5QrYgblcAXO5XAFzuQI2NJebDthYXK5fKQ3N5QqYy+UKmMsVsKG5XAEbmssVMJfLFTCXK2BDc7kC5nK5AuZyBWxoLlfAhuZyBczlcgXM5QrY0FyugB2YyxUwl8sVMJcrYENzuemAjcXl+pXS0FyugLlcroC5XAEbmssVsKG5XAFzuVwBc7kCNjSXK2AulytgLlfAhuZyBWxoLlfAXC5XwFyugA3N5QrYgblcAXO5XAFzuQI2NJebDthYXK5fKQ3N5QqYy+UKmMsVsKG5XAEbmssVMJfLFTCXK2BDc7kC5nK5AuZyBWxoLlfAhuZyBczlcgXM5QrY0FyugB2YyxUwl8sVMJcrYENzuWF3AzF6Wvi1vP0+AAAAAElFTkSuQmCC';

/* ---- file previews ---------------------------------------------------------
   An answer that names a screenshot on its last line, a markdown plan in the
   project, a file that is gone and a relative path that is only a guess. The
   stub reader answers like `fs.peek` would: bytes for the first two, a refusal
   for the others — the strip, the lightbox and the sheet are the product's own. */
const PREVIEW_SHOT = '/tmp/agents-0/-srv-shop-app/296c3cd6-4e13-4628-b670-8e8d7d23976f/scratchpad/mail.png';
const PREVIEW_MD = [
  '# План выкатки',
  '',
  'Три шага, **по порядку**:',
  '',
  '1. Собрать `shared` и веб.',
  '2. Прогнать смоук на одноразовом хабе.',
  '3. Выкатить кнопкой в боте.',
  '',
  '| Шаг | Кто | Время |',
  '| --- | --- | --- |',
  '| Сборка | CI | 6 мин |',
  '| Смоук | агент | 4 мин |',
  '',
  '```bash',
  'npm run build --workspace web',
  '```',
].join('\n');
const PREVIEW_HISTORY: HistoryMessage[] = [
  { type: 'user', uuid: 'f-u', ts: T0, blocks: [{ kind: 'text', text: 'проверь, что письмо приходит, и покажи план' }] },
  {
    type: 'assistant',
    uuid: 'f-a',
    ts: T0 + 40_000,
    blocks: [
      {
        kind: 'text',
        text: [
          'Письмо пришло, шапка и кнопка на месте. План выкатки лежит в `docs/plan.md`, ещё один файл потерялся: /srv/shop-app/out/missing.png, а в `docs/nothere.md` я только предполагал.',
          '',
          `Скриншот: ${PREVIEW_SHOT}`,
        ].join('\n'),
      },
    ],
  },
];
const previewPeek: PeekFile = Object.assign(
  async (path: string, _max: number, clip: boolean) => {
    if (/missing|nothere/.test(path)) throw new Error('file not found');
    if (path.endsWith('.md')) return { blob: new Blob([PREVIEW_MD], { type: 'text/markdown' }), truncated: clip && false };
    const bin = atob(SHOT_B64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return { blob: new Blob([bytes], { type: 'image/png' }), truncated: false };
  },
  { scope: 'fixture', window: () => async () => { throw new Error('fixture'); } },
);

const FILES_TEXT = [
  'Трейлер собран: `output/trailer-final/anomalia-story.mp4`, отчёт лежит в output/report.pdf, а архив output/broken.zip не скачивается (сбой сокета в фикстуре).',
].join('\n');
const FILES_HISTORY: HistoryMessage[] = [
  { type: 'user', uuid: 'v-u', ts: T0, blocks: [{ kind: 'text', text: 'собери трейлер и отчёт' }] },
  { type: 'assistant', uuid: 'v-a', ts: T0 + 40_000, blocks: [{ kind: 'text', text: FILES_TEXT }] },
];
const FIXTURE_FILE_BYTES = 1500;
const filesPeek: PeekFile = Object.assign(previewPeek, {
  window: (path: string) => async (offset: number, length: number) => {
    // The probe asks for one byte; a real download asks for a whole window.
    if (/broken/.test(path) && length > 1) throw new Error('socket closed');
    const bytes = Math.max(0, Math.min(length, FIXTURE_FILE_BYTES - offset));
    return {
      path, offset, data: btoa('x'.repeat(bytes)), bytes, size: FIXTURE_FILE_BYTES, mtime: 1, eof: offset + bytes >= FIXTURE_FILE_BYTES,
    };
  },
});

const ENRICHED = (
  <EnrichStrip
    enrichment={{
      quickReplies: [
        { label: 'Да, раскатывай', send: 'Да, раскатывай', kind: 'answer' },
        { label: 'Сначала покажи диф', send: 'Сначала покажи диф', kind: 'answer' },
        { label: 'Прогони смоук на медленной дорожке', send: 'Прогони смоук на медленной дорожке', kind: 'next' },
        { label: 'Замерить, где ещё режется хвост', send: 'Проверь, не режет ли тот же порог хвост в стриминге', kind: 'idea' },
        { label: 'Сверить с телефоном', send: 'Сравни поведение VAD на телефонном микрофоне', kind: 'idea' },
      ],
    }}
    onReply={() => {}}
  />
);

/** Three panes in three different states — the point of the lens is telling
 *  them apart at a glance, so a fixture where all three read the same proves
 *  nothing about it. `dot`/`label` mirror DOT and STATE_LABEL in
 *  components/SessionColumn.tsx; keep them in step. */
const COLS = [
  { title: 'Zoom интеграция и загрузка видео из облака', sub: 'stage · hegai', state: 'working', label: 'Работает' },
  { title: 'Обновленный код и подключение к хабу', sub: 'buildbox-pc · claudehegai', state: 'needs_attention', label: 'Нужен ответ' },
  { title: 'ВПС с фингерпринтом для кабинета Меты', sub: 'buildbox-pc · winvps', state: 'idle', label: 'Готово' },
  { title: 'Аудит Google Ads по площадкам', sub: 'stage · hegai', state: 'working', label: 'Работает' },
];

/** Three providers, as the limits pill shows them in the bar. */
const USAGE = [
  { name: 'Claude', pct: 30 },
  { name: 'Codex', pct: 32 },
  { name: 'Gateway', pct: 38 },
];

/** One directory, with the shapes that are awkward: a dotfile, a symlink, a
 *  long name, a size that has to stay aligned. */
const FILE_ENTRIES = [
  { name: 'components', kind: 'dir' as const, mtime: Date.now() - 3600_000 },
  { name: 'render', kind: 'dir' as const, mtime: Date.now() - 2 * 86400_000 },
  { name: 'shell', kind: 'dir' as const, mtime: Date.now() - 86400_000, link: true },
  { name: '.gitignore', kind: 'file' as const, size: 412, mtime: Date.now() - 6 * 86400_000 },
  { name: 'App.tsx', kind: 'file' as const, size: 33_104, mtime: Date.now() - 12 * 60_000 },
  { name: 'lib.ts', kind: 'file' as const, size: 20_480, mtime: Date.now() - 3 * 3600_000 },
  { name: 'очень-длинное-имя-файла-которое-не-помещается.md', kind: 'file' as const, size: 1_048_576, mtime: Date.now() - 40 * 86400_000 },
];

/** A directory with real variety: folders, code, documents, pictures, an
 *  archive — the case the icon view exists for. */
const GRID_ENTRIES = [
  { name: 'interview-screens', kind: 'dir' as const, mtime: Date.now() - 3600_000 },
  { name: 'invoices', kind: 'dir' as const, mtime: Date.now() - 86400_000 },
  { name: 'App.tsx', kind: 'file' as const, size: 33_104, mtime: Date.now() - 12 * 60_000 },
  { name: 'Владелец Орлов.pdf', kind: 'file' as const, size: 1_992_294, mtime: Date.now() - 60_000 },
  { name: 'обложка.png', kind: 'file' as const, size: 842_000, mtime: Date.now() - 3 * 3600_000 },
  { name: 'результаты опроса хакатон.xlsx', kind: 'file' as const, size: 24_500, mtime: Date.now() - 2 * 86400_000 },
  { name: 'render-pdf.mjs', kind: 'file' as const, size: 4_210, mtime: Date.now() - 5 * 3600_000 },
  { name: 'README.md', kind: 'file' as const, size: 2_048, mtime: Date.now() - 9 * 86400_000 },
  { name: 'styles.css', kind: 'file' as const, size: 132_000, mtime: Date.now() - 40 * 60_000 },
  { name: 'архив-2025.zip', kind: 'file' as const, size: 88_000_000, mtime: Date.now() - 300 * 86400_000 },
  { name: 'заметки.txt', kind: 'file' as const, size: 900, mtime: Date.now() - 20 * 60_000 },
  { name: 'data.json', kind: 'file' as const, size: 15_300, mtime: Date.now() - 4 * 86400_000 },
];

/* ---- sidebar stub -------------------------------------------------------
   The context column, with the four cases that decide whether it is right:
   a project holding more live sessions than a card may list; a live session
   with NO owner on my own machine (a VS Code window — must stay under «моё»);
   a teammate's session (must fall into «Команда»); and a run the inventory
   has not reported yet (must not blink out of the column). */
const SIDEBAR_VIEWER = 'u1';
const mkSession = (s: Partial<SessionSummary> & { sessionId: string; title: string }): SessionSummary => ({
  lastModified: Date.now() - 60_000,
  ...s,
});
const SIDEBAR_MACHINES = [
  {
    machine: { machineId: 'm1', name: 'dev-mac-mini-001', os: 'darwin', agentVersion: '1' },
    online: true,
    owner: { userId: SIDEBAR_VIEWER, fullName: 'Владелец' },
    sessions: [
      // Twelve live editor windows: the ~18-in-VSCode case, so the ceiling
      // and the «ещё N в работе» line are both on screen.
      ...Array.from({ length: 12 }, (_, i) =>
        mkSession({
          sessionId: `live-${i}`,
          title: `Живая сессия в редакторе номер ${i + 1}`,
          project: 'claudehegai',
          livePid: 1000 + i,
          entrypoint: 'claude-vscode',
          lastModified: Date.now() - i * 60_000,
        }),
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        mkSession({
          sessionId: `old-${i}`,
          title: `Спящая ветка обсуждения ${i + 1}`,
          project: 'claudehegai',
          lastModified: Date.now() - (2 + i) * 3600_000,
        }),
      ),
    ],
  },
  {
    machine: { machineId: 'm2', name: 'stage', os: 'linux', agentVersion: '1' },
    online: true,
    owner: { userId: SIDEBAR_VIEWER, fullName: 'Владелец' },
    sessions: [
      // Live but quiet for an hour — the card must still lift it above the
      // fresher dormant row below, and the project above the quiet ones.
      mkSession({
        sessionId: 'vs-1',
        title: 'Design system',
        project: 'remotehegai',
        livePid: 77,
        entrypoint: 'claude-vscode',
        lastModified: Date.now() - 3600_000,
      }),
      mkSession({ sessionId: 'd-1', title: 'Актуальность проекта с гитом', project: 'remotehegai', lastModified: Date.now() - 90_000 }),
      // A teammate's work on MY machine: owner wins over the machine.
      mkSession({
        sessionId: 't-1',
        title: 'Сверстать лендинг конференции',
        project: 'a.test',
        owner: { userId: 'u2', fullName: 'Маша Котова' },
        livePid: 91,
        entrypoint: 'cli',
      }),
      mkSession({
        sessionId: 't-2',
        title: 'Реклама на сегодня',
        project: 'a.test',
        owner: { userId: 'u2', fullName: 'Маша Котова' },
        lastModified: Date.now() - 4 * 3600_000,
      }),
    ],
  },
] as unknown as MachineSnapshot[];
/** The panel as it had grown by 30.09.2026: a dozen and a half projects of
 *  every age, a session in `/root`, an editor left open for days. The fresh
 *  ones must be cards newest-first, the rest fold under «Раньше». */
const NOISY_MACHINES = [
  ...SIDEBAR_MACHINES,
  {
    machine: { machineId: 'm4', name: 'dev-box-1', os: 'linux', agentVersion: '1' },
    online: true,
    owner: { userId: SIDEBAR_VIEWER, fullName: 'Владелец' },
    sessions: [
      ...['crm', 'hegai', 'a.test', 'owner', 'hegai.media', 'orthostart', 'growth', 'shop-app', 'accounting', 'design-system', 'writeistheway', 'tg-projects', 'orthdont', 'composit'].map(
        (project, i) =>
          mkSession({
            sessionId: `n-${i}`,
            title: `Последний разговор в ${project}`,
            project,
            cwd: `/srv/${project}`,
            lastModified: Date.now() - (i < 5 ? (i + 1) * 5 * 3600_000 : (i + 3) * 86_400_000),
          }),
      ),
      // An editor window open for nine days: live, but it must not lead.
      mkSession({ sessionId: 'n-open', title: 'Окно VS Code, открытое давно', project: 'clonerouter', cwd: '/srv/router-copy', livePid: 4242, entrypoint: 'claude-vscode', lastModified: Date.now() - 9 * 86_400_000 }),
      mkSession({ sessionId: 'n-root', title: 'Проверь диск на сервере', project: 'root', cwd: '/root', lastModified: Date.now() - 2 * 3600_000 }),
    ],
  },
] as unknown as MachineSnapshot[];
/** «Мои · Команда · Все»: the sidebar fleet plus the shared employee box —
 *  owned by the viewer, three people working on it, and two terminal sessions
 *  nobody is recorded against (they must land under «Без автора», last). */
const TEAM_MACHINES = [
  ...SIDEBAR_MACHINES,
  {
    machine: { machineId: 'm3', name: 'devbox', os: 'linux', agentVersion: '1' },
    online: true,
    shared: true,
    owner: { userId: SIDEBAR_VIEWER, fullName: 'Владелец' },
    sessions: [
      mkSession({ sessionId: 'a-1', title: 'Оплата картой в личном кабинете', project: 'hegai-platform', owner: { userId: 'u3', fullName: 'Анна Смирнова' }, livePid: 301, liveStatus: 'busy', entrypoint: 'cli', lastModified: Date.now() - 3 * 60_000 }),
      mkSession({ sessionId: 'a-2', title: 'Миграция таблицы users', project: 'hegai-platform', owner: { userId: 'u3', fullName: 'Анна Смирнова' }, lastModified: Date.now() - 2 * 3600_000 }),
      mkSession({ sessionId: 'a-3', title: 'Новый первый экран лендинга', project: 'landing', owner: { userId: 'u3', fullName: 'Анна Смирнова' }, lastModified: Date.now() - 26 * 3600_000 }),
      mkSession({ sessionId: 'o-1', title: 'Импорт лидов из таблицы', project: 'crm', owner: { userId: 'u4', fullName: 'Олег Петров' }, lastModified: Date.now() - 5 * 3600_000 }),
      mkSession({ sessionId: 'o-2', title: 'Дубли контактов после импорта', project: 'crm', owner: { userId: 'u4', fullName: 'Олег Петров' }, lastModified: Date.now() - 30 * 3600_000 }),
      mkSession({ sessionId: 'x-1', title: 'git pull и перезапуск', project: 'hegai-platform', lastModified: Date.now() - 40 * 60_000 }),
      mkSession({ sessionId: 'x-2', title: 'Посмотреть логи nginx', lastModified: Date.now() - 50 * 3600_000 }),
      ...['infra', 'docs', 'monitoring'].map((project, i) => mkSession({ sessionId: `x-extra-${i}`, title: `Проверить ${project}`, project, lastModified: Date.now() - (51 + i) * 3600_000 })),
    ],
  },
] as unknown as MachineSnapshot[];

/** Puts the scope store where a screen needs it — before the children read it,
 *  so the first paint is already the mode being photographed. */
function Scoped({ scope, children }: { scope: SessionScope; children: React.ReactNode }) {
  const [, set] = useSessionScope();
  // Once, before the children's first read — not on every render, or it would
  // undo any change the screen itself makes.
  useState(() => {
    setScopeAvailable(true);
    set(scope);
    return null;
  });
  return <>{children}</>;
}

/** The real bar, including the limits next to the segment and the phone chip. */
function ScopeBar({ scope }: { scope: SessionScope }) {
  return (
    <Scoped scope={scope}>
      <div className="app">
        <TopBar
          central={START_CENTRAL} gatewayQuota={null}
          themePref="system" onChooseTheme={() => {}}
          notifOpen={false} setNotifOpen={() => {}}
          settingsOpen={false} setSettingsOpen={() => {}}
          displayName="Владелец" setDisplayName={() => {}}
          token="" setToken={() => {}} localDev={false}
          totalSessions={20} onJump={() => {}} accountInitials="ПХ"
          sidebarCollapsed={false} onToggleSidebar={() => {}} actionsInPanel
          onOpenDrawer={window.innerWidth <= 860 ? () => {} : undefined}
          othersWork
        />
      </div>
    </Scoped>
  );
}

/** The Windows app's title bar: icon, «Файл · Вид · Перейти», the bar, the
 *  window buttons — and a bell with three unread. The shell's bridge is faked
 *  here (each screen is its own page load, so nothing leaks into the next). */
function WinTitleBar() {
  const w = window as { __HEGAI_WINDOW__?: unknown; __HEGAI_SHELL__?: string; __HEGAI_OWN_WINDOWS__?: number };
  const ok = () => Promise.resolve();
  w.__HEGAI_WINDOW__ ??= { startDragging: ok, minimize: ok, toggleMaximize: ok, close: ok, isMaximized: () => Promise.resolve(false) };
  w.__HEGAI_SHELL__ = 'windows';
  w.__HEGAI_OWN_WINDOWS__ = 1;
  // The 0.1.27 shell's menu bridge: «Правка», «Выход», «Справка».
  (w as { __HEGAI_APP__?: unknown }).__HEGAI_APP__ ??= {
    version: '0.1.27', quit: ok, update: ok,
    updateRow: () => Promise.resolve({ label: 'Обновлений нет · 0.1.27', enabled: true }),
  };
  return (
    <Scoped scope="mine">
      <div className="app">
        <TopBar
          central={{ ...START_CENTRAL, unread: 3 } as typeof START_CENTRAL}
          gatewayQuota={null}
          themePref="system" onChooseTheme={() => {}}
          notifOpen={false} setNotifOpen={() => {}}
          settingsOpen={false} setSettingsOpen={() => {}}
          displayName="Владелец" setDisplayName={() => {}}
          token="" setToken={() => {}} localDev={false}
          totalSessions={20} onJump={() => {}} accountInitials="ПХ"
          sidebarCollapsed={false} onToggleSidebar={() => {}} actionsInPanel
          othersWork onNewChat={() => {}} onOpenPalette={() => {}}
        />
      </div>
    </Scoped>
  );
}

/** One of these has no session in the inventory — the several-second window
 *  after «Новая сессия» that the removed pinned block used to cover. */
const SIDEBAR_RUNS = [
  { runId: 'r-1', machineId: 'm2', machineName: 'stage', sessionId: 'vs-1', state: 'needs_attention', since: Date.now() - 3600_000, project: 'remotehegai' },
  { runId: 'r-2', machineId: 'm2', machineName: 'stage', sessionId: 'brand-new', title: 'Только что запущенная из браузера', state: 'working', origin: 'web', since: Date.now() - 4_000, project: 'remotehegai', ownerUserId: SIDEBAR_VIEWER },
] as unknown as ActiveRunInfo[];

/* ---- the public page's picture ---------------------------------------------
   `desk` is photographed for code.acme.test, where a stranger decides from it
   what this product IS. The sidebar fixtures above are built to stress layout
   — twelve «Живая сессия в редакторе номер N», «Спящая ветка обсуждения» —
   and read as filler the moment they leave the harness (24.09.2026: «чтобы там
   сессии реальные были, текст какой-то адекватный»). So this scene is its own:
   two machines, four projects, work a person would actually recognise, and
   one open session with a real bug found and fixed. Nothing in it names a real
   person, machine or client; the page is public. */
const DESK_VIEWER = 'u1';
const DESK_MIN = 60_000;
const DESK_MACHINES = [
  {
    machine: { machineId: 'd1', name: 'macbook', os: 'darwin', agentVersion: '1' },
    online: true,
    owner: { userId: DESK_VIEWER, fullName: 'Вы' },
    sessions: [
      mkSession({ sessionId: 'cart', title: 'Скидка по акции не доходит до корзины', project: 'shop-frontend', livePid: 11, entrypoint: 'claude-vscode', lastModified: Date.now() - 20_000 }),
      mkSession({ sessionId: 'pager', title: 'Каталог на серверную пагинацию', project: 'shop-frontend', livePid: 12, entrypoint: 'cli', lastModified: Date.now() - 12 * DESK_MIN }),
      mkSession({ sessionId: 'dark', title: 'Тёмная тема в личном кабинете', project: 'shop-frontend', lastModified: Date.now() - 3 * 3600_000 }),
      mkSession({ sessionId: 'twice', title: 'Бот отвечает дважды на одно сообщение', project: 'telegram-bot', source: 'codex', livePid: 13, entrypoint: 'cli', lastModified: Date.now() - 4 * DESK_MIN }),
      mkSession({ sessionId: 'remind', title: 'Напоминание о записи за сутки', project: 'telegram-bot', source: 'codex', lastModified: Date.now() - 26 * 3600_000 }),
    ],
  },
  {
    machine: { machineId: 'd2', name: 'сервер', os: 'linux', agentVersion: '1' },
    online: true,
    owner: { userId: DESK_VIEWER, fullName: 'Вы' },
    sessions: [
      mkSession({ sessionId: 'pg', title: 'Миграция на Postgres 17', project: 'api', livePid: 21, entrypoint: 'cli', lastModified: Date.now() - 2 * DESK_MIN }),
      mkSession({ sessionId: 'n500', title: 'Разобрать ночные ошибки 500', project: 'api', lastModified: Date.now() - 40 * DESK_MIN }),
      mkSession({ sessionId: 'rl', title: 'Лимит запросов для публичного API', project: 'api', lastModified: Date.now() - 2 * 86400_000 }),
      mkSession({ sessionId: 'bkp', title: 'Бэкапы базы в S3 каждые 6 часов', project: 'infra', lastModified: Date.now() - 5 * 3600_000 }),
    ],
  },
] as unknown as MachineSnapshot[];
const DESK_RUNS = [
  { runId: 'dr-1', machineId: 'd1', machineName: 'macbook', sessionId: 'twice', state: 'needs_attention', since: Date.now() - 4 * DESK_MIN, project: 'telegram-bot' },
  { runId: 'dr-2', machineId: 'd2', machineName: 'сервер', sessionId: 'pg', state: 'working', origin: 'web', since: Date.now() - 2 * DESK_MIN, project: 'api', ownerUserId: DESK_VIEWER },
] as unknown as ActiveRunInfo[];
const DESK_T0 = Date.now() - 9 * DESK_MIN;
const DESK_HISTORY: HistoryMessage[] = [
  { type: 'user', uuid: 'du-1', ts: DESK_T0, blocks: [{ kind: 'text', text: 'в корзине не применяется скидка на товары из акции, хотя на карточке цена уже со скидкой. посмотри' }] },
  { type: 'assistant', uuid: 'da-1', ts: DESK_T0 + 20_000, blocks: [{ kind: 'text', text: 'Посмотрю, где считается цена на карточке и где — в корзине. Похоже, это два разных расчёта.' }] },
  {
    type: 'assistant', uuid: 'da-2', ts: DESK_T0 + 90_000,
    blocks: [
      call(21, 'Grep', { pattern: 'priceWithPromo', path: 'src' }),
      call(22, 'Read', { file_path: 'src/catalog/price.ts' }),
      call(23, 'Read', { file_path: 'src/cart/totals.ts' }),
      call(24, 'Edit', { file_path: 'src/cart/totals.ts' }),
      call(25, 'Write', { file_path: 'src/cart/totals.test.ts' }),
      call(26, 'Bash', { command: 'npm test -- cart' }),
    ],
  },
  {
    type: 'assistant', uuid: 'da-3', ts: DESK_T0 + 300_000,
    blocks: [{ kind: 'text', text: 'Так и есть. Карточка берёт цену через `priceWithPromo()`, а корзина считает сама и учитывает только персональные скидки — акционные туда не попадают. Перевёл корзину на ту же функцию, чтобы цена считалась в одном месте, и добавил тест: товар из акции в корзине стоит столько же, сколько на карточке.' }],
  },
  { type: 'assistant', uuid: 'da-4', ts: DESK_T0 + 320_000, blocks: [{ kind: 'text', text: 'Изменены два файла, тесты корзины проходят — **48 из 48**. Закоммитить и открыть PR?' }] },
];
const DESK_SESSION = { sessionId: 'cart', cwd: '/Users/you/shop-frontend', source: 'claude', title: 'Скидка по акции не доходит до корзины', lastModified: Date.now() - 20_000 } as SessionSummary;
const DESK_CENTRAL = {
  ...central,
  status: 'open', busy: false, lines: [], sessionCost: null,
  active: { machineId: 'd1', sessionId: 'cart', runId: 'dr-0' },
  machines: DESK_MACHINES,
  activeRuns: DESK_RUNS,
  runFor: () => undefined,
  // An idle session asks for reply suggestions; the picture has none.
  enrich: async () => null,
  rpc: async (_machineId: string, method: string) => {
    if (method === 'session.messages') return { messages: DESK_HISTORY };
    if (method === 'models.list') return { models: [
      { id: 'default', name: 'Default', resolved: 'claude-opus-5-5' },
      { id: 'opus', name: 'Opus 5.5', resolved: 'claude-opus-5-5', efforts: ['low', 'medium', 'high'] },
    ] };
    throw new Error(`preview: no RPC stub for ${method}`);
  },
} as unknown as CentralState;

/** A diff the review sheet can be photographed on (what `git.diff` answers). */
const REVIEW_DIFF = {
  truncated: false,
  files: [
    {
      path: 'server/src/login.ts',
      status: 'modified',
      additions: 4,
      deletions: 2,
      hunks: [
        {
          header: '@@ -10,7 +10,9 @@ export async function login(req: Request) {',
          lines: [
            { kind: ' ', old: 10, new: 10, text: '  const body = await req.json();' },
            { kind: '-', old: 11, text: '  if (!body.email) throw new Error("no email");' },
            { kind: '-', old: 12, text: '  const user = await db.find(body.email);' },
            { kind: '+', new: 11, text: '  const email = String(body.email ?? "").trim().toLowerCase();' },
            { kind: '+', new: 12, text: '  if (!email) throw new HttpError(400, "email required");' },
            { kind: '+', new: 13, text: '  const user = await db.find(email, { timeoutMs: 3000 });' },
            { kind: '+', new: 14, text: '  if (!user) throw new HttpError(401, "unknown user, check the address and try again later please");' },
            { kind: ' ', old: 13, new: 15, text: '  return issueSession(user);' },
            { kind: ' ', old: 14, new: 16, text: '}' },
          ],
        },
      ],
    },
    {
      path: 'server/test/login.test.ts',
      status: 'added',
      additions: 3,
      deletions: 0,
      hunks: [
        {
          header: '@@ -0,0 +1,3 @@',
          lines: [
            { kind: '+', new: 1, text: "test('empty email is a 400', async () => {" },
            { kind: '+', new: 2, text: '  await assert.rejects(login(req({})), /400/);' },
            { kind: '+', new: 3, text: '});' },
          ],
        },
      ],
    },
    { path: 'docs/logo.png', status: 'modified', binary: true, additions: 0, deletions: 0, hunks: [] },
  ],
};
const REVIEW_CENTRAL = {
  ...DESK_CENTRAL,
  rpc: async (_m: string, method: string) => {
    if (method === 'git.status') return { isRepo: true, branch: 'agent/fix-login-1030', ahead: 2, behind: 0, files: [{ path: 'server/src/login.ts', code: ' M', staged: false }, { path: 'server/test/login.test.ts', code: '??', staged: false }] };
    if (method === 'git.diff') return REVIEW_DIFF;
    if (method === 'git.branches') return { current: 'agent/fix-login-1030', all: ['main', 'agent/fix-login-1030'] };
    throw new Error(`preview: no RPC stub for ${method}`);
  },
} as unknown as CentralState;
const DESK_USAGE = [
  { name: 'Claude', pct: 24 },
  { name: 'Codex', pct: 41 },
];

/**
 * The fleet as ГЛАВНАЯ sees it: the sidebar machines, their runs, and usage for
 * two providers so the limits pill has something to fold.
 *
 * The usage numbers are picked to exercise the pill's own logic rather than to
 * look tidy — Codex is nearer its ceiling than Claude, so the compact pill must
 * choose Codex, and 91% must come out `crit` (red) rather than merely amber.
 */
const START_CENTRAL = {
  ...central,
  /* `projectTargets` only offers a box that says it can start work, and only a
     session that has a `cwd` — the sidebar fixture needs neither, because the
     tree groups by `project`. Without both, the shelf below the composer is
     simply absent, which is the half of this screen «ещё N» lives on. */
  machines: SIDEBAR_MACHINES.map((m) => ({
    ...m,
    canStart: true,
    canControl: true,
    /* Spread across EIGHT folders on the mac mini, not one. Five is the card's
       ceiling (`CARD_PROJECTS`), so a single folder would never draw «ещё N» —
       and «ещё N» is the control that used to jump to a search popover and now
       has to lengthen the card in place. A fixture that cannot reach the state
       cannot check it. */
    sessions: m.sessions.map((s, i) => {
      const dir =
        m.machine.machineId === 'm1'
          ? ['claudehegai', 'remotehegai', 'hegai-site', 'crm', 'tilda2vc', 'asr-lab', 'a.test', 'sandbox'][i % 8]
          : (s as { project?: string }).project ?? 'work';
      /* `project` is dropped, not kept: `projectTargets` prefers it over the
         path's basename, so leaving it on would label all eight folders
         «claudehegai» and make the card a column of one name disambiguated by
         its parent — a picture of nothing. */
      const { project: _drop, ...rest } = s as { project?: string };
      return { ...rest, cwd: s.cwd ?? (m.machine.machineId === 'm1' ? `/Users/owner/${dir}` : `/srv/${dir}`) };
    }),
  })),
  activeRuns: SIDEBAR_RUNS,
  status: 'open',
  unread: 3,
  showAutomated: false,
  showClosed: false,
  automatedHidden: 4,
  closedHidden: 2,
  markRead: () => {},
  requestNotifyPermission: () => {},
  /* The composer's run/model picker asks the agent what it can run. There is no
     agent here, so it answers nothing and the picker keeps its defaults — the
     alternative is a fixture that throws where the product would merely wait. */
  rpc: async () => ({}),
  usage: {
    m1: {
      limits: [
        { key: 'session', label: 'Session (5hr)', group: 'session', percent: 38, resetsAt: Date.now() + 2 * 3600_000 },
        { key: 'weekly_all', label: 'Weekly (7 day)', group: 'weekly', percent: 77, resetsAt: Date.now() + 2 * 86400_000 },
        { key: 'weekly:fable', label: 'Weekly Fable', group: 'weekly', percent: 34, resetsAt: Date.now() + 2 * 86400_000 },
      ],
      account: 'owner@x.test',
      subscription: 'Max 20x',
      updatedAt: Date.now(),
    },
  },
  codexUsage: {
    m2: {
      limits: [
        { key: 'session', label: 'Session', group: 'session', percent: 91, resetsAt: Date.now() + 40 * 60_000 },
        { key: 'weekly_all', label: 'Weekly (7 day)', group: 'weekly', percent: 74, resetsAt: Date.now() + 86400_000 },
      ],
      subscription: 'Pro',
      updatedAt: Date.now(),
    },
  },
} as unknown as CentralState;

const TAB_TITLES: Record<string, string> = {
  a: 'Рефакторинг кода проекта',
  w: 'Stop Reddit from opening',
  q: 'Как с хигсф через эти скиллы работать?',
  n: 'Обновлённый код',
  z: 'ВПС с фингерпринтом',
};
const TAB_GROUPS: TabGroup[] = [
  {
    tabs: [
      { kind: 'session', machineId: 'm', sessionId: 'a' },
      { kind: 'session', machineId: 'm', sessionId: 'w' },
      { kind: 'session', machineId: 'm', sessionId: 'q' },
    ],
    active: 2,
  },
  { tabs: [{ kind: 'session', machineId: 'm', sessionId: 'n' }], active: 0 },
  { tabs: [{ kind: 'board' }, { kind: 'session', machineId: 'm', sessionId: 'z' }], active: 1 },
];

/** The whole shell with three columns — with `tabs`, a tab strip over each. */
function fullShell(tabs: boolean) {
  return (
    <div className="app">
      <div className="body">
        <SidePanel
          othersWork
          unread={3}
          onBell={() => {}}
          central={{ ...central, machines: SIDEBAR_MACHINES, activeRuns: SIDEBAR_RUNS } as never}
          machines={SIDEBAR_MACHINES}
          machineFilter="all"
          onMachineFilter={() => {}}
          selected={new Set()}
          runIndex={indexRuns(SIDEBAR_RUNS)}
          favorites={new Set()}
          onSelect={() => {}}
          onToggleFav={() => {}}
          drilled={false}
          onDrillChange={() => {}}
          onSessionMenu={() => {}}
          viewerId={SIDEBAR_VIEWER}
          width={320}
          resizing={false}
          onStartResize={() => {}}
          active="sessions"
          onNewSession={() => {}}
          onAddColumn={() => {}}
          foot={{ initials: 'ВО', name: 'Владелец Орлов', accountOpen: false, onToggleAccount: () => {} }}
        />
        <div className="main-col">
          {/* The top bar is back on this screen. The split used to merge its
              chrome into a lens bar it rendered itself; with the switcher gone
              there is one bar, the same one every other screen has. Mirrors
              TopBar's markup — the limits pill is the part with layout
              pressure, so it is the part reproduced. */}
          <header className="topbar">
            <div className="spacer" />
            <div className="usage">
              <button className="usage-pill" type="button">
                {USAGE.map((u, i) => (
                  <span className="usage-provider" key={u.name}>
                    {i > 0 ? <span className="usage-sep" /> : null}
                    <span className="usage-provider-name">{u.name}</span>
                    <span className="meterlet">
                      <span className="meterlet-bar">
                        <span className="meterlet-fill" style={{ width: `${u.pct}%` }} />
                      </span>
                      <span className="meterlet-val">{u.pct}%</span>
                    </span>
                  </span>
                ))}
              </button>
            </div>
            {/* No bell: with the panel open it lives in the panel's head. */}
          </header>
          <main className="main">
            {/* Three, not four. With the panel beside them a fourth pane is
                under the 340px floor at this width — which is the trade the
                collapse exists for, and the fixture should show the honest
                side of it. */}
            <div className="session-columns">
              {COLS.slice(0, 3).map((c, i) => (
                <section className="session-col" key={c.title}>
                  {tabs && (
                    <TabStrip
                      group={TAB_GROUPS[i]!}
                      groupIndex={i}
                      focused={i === 0}
                      info={(p) => ({
                        title: p.kind === 'session' ? TAB_TITLES[p.sessionId] ?? p.sessionId : 'Доска',
                        working: p.kind === 'session' && p.sessionId === 'w',
                        attention: p.kind === 'session' && p.sessionId === 'q',
                        source: 'claude',
                      })}
                    />
                  )}
                  <header className="sc-col-head" title={c.sub}>
                    <div className="sc-col-titles">
                      <span className="sc-col-proj">{c.sub.split(' · ')[1]}</span>
                      <span className="sc-col-sep" aria-hidden>/</span>
                      <div className="sc-col-title-slot"><div className="sc-col-title">{c.title}</div></div>
                    </div>
                    <span className={`sc-col-state ${c.state}`}>{c.label}</span>
                    <button type="button" className="icon-btn sc-col-more" aria-label="Действия с сессией"><MoreIcon size={16} weight="bold" /></button>
                    <button type="button" className="icon-btn sc-col-close" aria-label="Закрыть колонку"><X size={16} /></button>
                  </header>
                  <Log composer />
                </section>
              ))}
            </div>
          </main>
        </div>
      </div>
    </div>
  
  );
}

/** The sheet over the desk shell; on a phone the sheet is the whole screen,
 *  so there is no desk shell (a 1440 fixture) to squeeze under it. */
function BrowserOverShell() {
  const phone = matchMedia('(max-width: 860px)').matches;
  return <>{phone ? null : fullShell(false)}<BrowserSheet onClose={() => {}} /></>;
}

/** «Расходы» on stub data: a heavy user, one who keeps hitting the Claude
 *  window, a quiet member without a key, and one with gateway errors. */
const USAGE_NOW = Date.now();
const usageDays = (v: number[]) => v.map((tokens, i) => ({ day: new Date(USAGE_NOW - (6 - i) * 86_400_000).toISOString().slice(0, 10), tokens, requests: Math.ceil(tokens / 9000) }));
const SPEND: UsageReport = {
  from: new Date(USAGE_NOW - 6 * 86_400_000).toISOString().slice(0, 10),
  to: new Date(USAGE_NOW).toISOString().slice(0, 10),
  configured: true,
  scope: 'all',
  collectedAt: USAGE_NOW - 240_000,
  members: [
    {
      userId: 'u1', email: 'anna@example.com', fullName: 'Анна Громова', role: 'member', hitsLimit: true,
      gateway: { requests: 412, errors: 3, promptTokens: 3_100_000, completionTokens: 410_000, cachedTokens: 1_900_000, totalTokens: 3_510_000,
        models: [{ model: 'gpt-5.6-sol', requests: 300, tokens: 2_900_000 }, { model: 'gpt-6.1-terra', requests: 112, tokens: 610_000 }], days: usageDays([220_000, 640_000, 410_000, 0, 880_000, 960_000, 400_000]) },
      limit: { active: true, tokens: 5_000_000, tokensUsed: 3_900_000, tokensWindow: '7d', percent: 78, resetAt: USAGE_NOW + 3 * 86_400_000 },
      subscriptions: [
        { provider: 'claude', account: 'anna@example.com', windows: [
          { key: 'session', label: 'Сессия (5 ч)', percent: 96, resetsAt: USAGE_NOW + 55 * 60_000, sampledAt: USAGE_NOW - 120_000, hitDays: 4, peakPercent: 100 },
          { key: 'weekly_all', label: 'Неделя (7 дней)', percent: 74, resetsAt: USAGE_NOW + 2 * 86_400_000, sampledAt: USAGE_NOW - 120_000, hitDays: 0, peakPercent: 74 } ] },
        { provider: 'codex', account: 'anna@example.com', windows: [
          { key: 'session', label: 'Сессия (5 ч)', percent: 31, resetsAt: USAGE_NOW + 3 * 3_600_000, sampledAt: USAGE_NOW - 300_000, hitDays: 0, peakPercent: 62 } ] },
      ],
    },
    {
      userId: 'u2', email: 'oleg@example.com', fullName: 'Олег Ким', role: 'manager', hitsLimit: false,
      gateway: { requests: 58, errors: 0, promptTokens: 400_000, completionTokens: 60_000, cachedTokens: 0, totalTokens: 460_000,
        models: [{ model: 'gpt-5.6-sol', requests: 58, tokens: 460_000 }], days: usageDays([0, 0, 90_000, 120_000, 0, 150_000, 100_000]) },
      limit: { active: true, tokens: 5_000_000, tokensUsed: 460_000, tokensWindow: '7d', percent: 9, resetAt: USAGE_NOW + 5 * 86_400_000 },
      subscriptions: [{ provider: 'codex', windows: [{ key: 'weekly_all', label: 'Неделя (7 дней)', percent: 18, resetsAt: USAGE_NOW - 3_600_000, sampledAt: USAGE_NOW - 7_200_000, hitDays: 0, peakPercent: 41 }] }],
    },
    {
      userId: 'u3', email: 'ira@example.com', role: 'member', hitsLimit: false,
      gateway: { requests: 0, errors: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, models: [], days: [] },
      subscriptions: [],
    },
  ],
};
const spendPage = () => <Panel title="Команда" tab="usage" usage subtitle="Токены шлюза и лимиты подписок по людям.">
  <PeriodSwitch value={7} onChange={() => {}} />
  <UsageList report={SPEND} now={USAGE_NOW} />
</Panel>;

/** Two machines: a long-named server whose Claude and Codex are both signed
 *  out (the state Owner photographed), and an offline Windows PC. */
const EXT_ORG = { workspaceId: 'w1', name: 'Моя команда', kind: 'organization', role: 'owner', selfServe: true };
const EXT_CENTRAL = { ...central, viewer: { ...central.viewer, fullName: 'Анна', email: 'owner@example.com', platformAdmin: true, workspace: EXT_ORG, workspaces: [EXT_ORG] } };
/** One online machine of the person's own, nothing on it yet. */
const EMPTY_HOME_CENTRAL = {
  ...START_CENTRAL,
  viewer: { ...central.viewer, platformAdmin: false, workspaces: [] },
  activeRuns: [], usage: {}, codexUsage: {}, unread: 0,
  machines: [{ machine: { machineId: 'e1', name: 'Мой сервер', os: 'linux', agentVersion: '0.3.0' }, online: true, canControl: true, canStart: true, sessions: [] }],
  runtimes: {},
  rpc: async (_m: string, method: string) => {
    if (method === 'projects.list') return { projects: [], roots: ['/home/agent/projects'] };
    return {};
  },
} as unknown as CentralState;

const HW_CENTRAL = {
  ...central,
  watchStats: () => () => {},
  machines: [
    { machine: { machineId: 'm1', name: 'korobovtsev-server', os: 'linux', agentVersion: '0.3.0' }, online: true, canControl: true },
    { machine: { machineId: 'm2', name: 'Марат — рабочий ПК', os: 'windows', agentVersion: '0.3.0' }, online: false, canControl: true },
  ],
  machineStats: {
    m1: { ts: Date.now(), platform: 'linux', cpuCount: 8, uptimeSec: 320_000, cpuPercent: 17, load1: 0.42, memUsed: 6.1e9, memTotal: 25e9, swapTotal: 0, swapUsed: 0, diskTotal: 3.1e11, diskUsed: 4.4e10, agentRss: 1.04e8, agentCpuPercent: 0.1 },
  },
  runtimes: {
    m1: {
      claude: { present: true, version: '2.1.0', auth: 'none', checkedAt: Date.now() },
      codex: { present: true, path: '/usr/local/bin/codex', version: '0.154.0', auth: 'none', error: 'not_logged_in', checkedAt: Date.now() },
    },
  },
};

/** The owner's own machine plus two team machines (one offline) — the manager's
 *  view of «Машины команды». Hub-stripped: no process list, no accounts. */
const HW_TEAM_CENTRAL = {
  ...HW_CENTRAL,
  machines: [HW_CENTRAL.machines[0]],
  teamMachines: [
    {
      machine: { machineId: 't1', name: 'MacBook Pro — Анна', os: 'darwin', agentVersion: '0.3.5' },
      owner: { userId: 'u2', email: 'anna@example.com', fullName: 'Анна Соколова' },
      online: true,
      lastSeen: Date.now(),
      stats: { ts: Date.now(), platform: 'darwin', cpuCount: 10, uptimeSec: 90_000, cpuPercent: 41, load1: 2.1, memUsed: 1.3e10, memTotal: 1.7e10, swapTotal: 0, swapUsed: 0, diskTotal: 5e11, diskUsed: 3.9e11, agentRss: 9e7, agentCpuPercent: 0.2, top: [] },
      runtimes: {
        claude: { present: true, version: '2.1.0', auth: 'oauth', checkedAt: Date.now() },
        codex: { present: false, auth: 'none', checkedAt: Date.now() },
      },
    },
    {
      machine: { machineId: 't2', name: 'dev-windows-очень-длинное-имя-машины', os: 'windows', agentVersion: '0.3.5' },
      owner: { userId: 'u3', email: 'ivan.petrov@example.com' },
      online: false,
      lastSeen: Date.now() - 3 * 3600_000,
    },
  ],
};

/** The strip + one tab, as `ControlPlaneApp` mounts them. */
function SettingsFrame({ tab, children }: { tab: SettingsTab; children: React.ReactNode }) {
  return <div className="settings-shell"><SettingsTabs active={tab} />{children}</div>;
}

/* The QR is a server route (`/app/qr.svg`) the preview has no hub for: swap the
   address for a data picture of the same size, so the layout is photographed
   with the plate and the modules in place. It is NOT a scannable code. */
{
  const cells = Array.from({ length: 21 * 21 }, (_, i) => (((i * 2654435761) >>> 7) % 3 === 0 ? i : -1)).filter((i) => i >= 0);
  const qr = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21" shape-rendering="crispEdges">${cells.map((i) => `<rect x="${i % 21}" y="${Math.floor(i / 21)}" width="1" height="1"/>`).join('')}</svg>`)}`;
  const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!;
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    ...desc,
    set(v: string) { desc.set!.call(this, v === '/app/qr.svg' || v.endsWith('/app/qr.svg') ? qr : v); },
  });
  const attr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name: string, value: string) {
    return attr.call(this, name, name === 'src' && value === '/app/qr.svg' ? qr : value);
  };
}

function filesScreen(bar: React.ReactNode): React.ReactElement {
  return (

    <div className="files">
      <div className="files-bar">
        <nav className="fcrumbs">
          <a className="fcrumb" href="#">Все машины</a>
          <span className="fcrumb-sep">/</span>
          <a className="fcrumb" href="#">claudehegai</a>
          <span className="fcrumb-sep">/</span>
          <a className="fcrumb" href="#">web</a>
          <span className="fcrumb-sep">/</span>
          <a className="fcrumb" href="#">src</a>
        </nav>
      </div>
      {bar}
      <div className="files-panes">
        <nav className="ftree">
          {['claudehegai', 'agent', 'server-rs', 'web', 'shared'].map((n, i) => (
            <div key={n} className={`ftree-row${i === 3 ? ' active' : ''}`} style={{ paddingLeft: i === 0 ? 8 : 20 }}>
              <span className="tw">{i === 0 || i === 3 ? '▾' : '▸'}</span>
              <span className="ftree-name">{n}</span>
            </div>
          ))}
        </nav>
        <main className="files-main">
          <FileList
            entries={FILE_ENTRIES}
            truncated
            total={41522}
            selected={new Set(['lib.ts'])}
            active={5}
            sort={{ key: 'name', dir: 1 }}
            renaming={null}
            canWrite
            onSort={() => {}}
            onOpen={() => {}}
            onSelect={() => {}}
            onActivate={() => {}}
            onKeyNav={() => {}}
            onDragFiles={(e) => [e.name]}
            onMoveInto={() => {}}
            onDropUpload={() => {}}
            onRenameCommit={() => {}}
            onRenameCancel={() => {}}
            onSpring={() => {}}
            actions={[
              { label: 'Скачать', run: () => {} },
              { label: 'Переименовать', run: () => {} },
              { label: 'Удалить', run: () => {}, danger: true },
            ]}
            emptyHint="Перетащите файлы сюда"
          />
          <div className="files-up">
            <div className="files-up-row sending">
              <span className="files-up-name">logo@2x.png</span>
              <span className="files-up-size">1.2 MB</span>
              <span className="barrow-track"><span className="files-up-fill" style={{ width: '62%' }} /></span>
            </div>
            <div className="files-up-row failed">
              <span className="files-up-name">архив проекта.zip</span>
              <span className="files-up-size">240 MB</span>
              <span className="files-up-err">слишком большой — используйте git или scp</span>
              <button type="button" className="ghost">Повторить</button>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

const SCREENS: Record<string, () => React.ReactElement> = {
  /** «Расходы»: the team tab, and the personal card in Настройки. */
  spend: spendPage,
  spendMine: () => <div className="team-page"><MyUsageView report={{ ...SPEND, scope: 'self', members: [SPEND.members[0]!] }} error="" period={7} onPeriod={() => {}} /></div>,
  /** The cloud browser's sheet over the whole shell: connecting, the line
   *  dropped, no exit to the internet, and no browser yet. */
  browser: () => <BrowserOverShell />,
  browserLost: () => <BrowserOverShell />,
  browserNoEgress: () => <BrowserOverShell />,
  browserEmpty: () => <BrowserOverShell />,
  browserSettings: () => <BrowserSettings />,
  settings: () => <WorkspaceSettings central={central} onWorkspaceCreated={() => {}} />,
  /** «Доступ» — the fifth Команда tab, platform admins only. Mounted straight
   *  from the REST identity, which is exactly how the app renders it: this is
   *  the one team tab that does not wait for the socket. */
  access: () => <TeamAccess viewer={central.viewer} />,
  /** First run, step 1: no machine. The desktop app is the primary path, the
   *  `/go` block the secondary one. */
  onboardMachine: () => <Onboarding central={{ ...central, machines: [], runtimes: {}, machineStats: {} } as never} viewer={null} onFinish={() => {}} />,
  /** Step 2: a machine is online, neither coder is signed in. */
  onboardRuntimes: () => <Onboarding central={HW_CENTRAL as never} viewer={null} onFinish={() => {}} initialStep={1} />,
  /** Step 3: the phone. */
  onboardPhone: () => <Onboarding central={HW_CENTRAL as never} viewer={null} onFinish={() => {}} initialStep={2} />,
  /** Step 1 with a machine already online, a customer's hub. */
  onboardMachineOnlineExt: () => <Onboarding central={HW_CENTRAL as never} viewer={null} onFinish={() => {}} />,
  /** Step 3 on a customer's hub: both phone lines, no notifications promise. */
  onboardPhoneExt: () => <Onboarding central={HW_CENTRAL as never} viewer={null} onFinish={() => {}} initialStep={2} />,
  settingsAppsExt: () => <SettingsFrame tab="apps"><AppsTab /></SettingsFrame>,
  /** Настройки → Аккаунт on a customer's hub: one «команда», no org form, quiet delete. */
  settingsAccountExt: () => <SettingsFrame tab="overview"><WorkspaceSettings central={EXT_CENTRAL as never} viewer={EXT_CENTRAL.viewer as never} onWorkspaceCreated={() => {}} /></SettingsFrame>,
  /** Команда → Люди on a customer's hub. */
  teamPeopleExt: () => <TeamMembers central={EXT_CENTRAL as never} workspace={EXT_CENTRAL.viewer.workspace as never} canInvite viewer={EXT_CENTRAL.viewer as never} onOpen={() => {}} />,
  /** «Новый проект»: the machine, a name and where it will be made. */
  newProject: () => <StartScreen central={EMPTY_HOME_CENTRAL} onNewSession={() => true} viewer={EMPTY_HOME_CENTRAL.viewer} initialCreate />,
  /** Home with a machine and no project: the empty state. */
  startEmpty: () => <StartScreen central={EMPTY_HOME_CENTRAL} onNewSession={() => true} viewer={EMPTY_HOME_CENTRAL.viewer} />,
  /** What the QR code opens on a computer. */
  appPage: () => <AppPage />,
  /** What the QR opens ON A PHONE on a customer's hub: «Открыть в приложении». */
  appPagePhoneExt: () => <AppPage />,
  /** The same page on a computer, customer's hub: QR + stores + how to connect. */
  appPageExt: () => <AppPage />,
  /** `/setup` finished on a phone: hand the hub to the app. */
  setupDonePhone: () => <SetupPage initialPhase={{ kind: 'done' }} />,
  /** «Доступ» on a customer's hub: «Добавить человека» (local login). */
  accessExt: () => <TeamAccess viewer={central.viewer} />,
  /** The four Настройки tabs inside the real strip. */
  settingsMachines: () => <SettingsFrame tab="hardware"><Hardware central={HW_CENTRAL as never} viewer={null} /></SettingsFrame>,
  settingsApps: () => <SettingsFrame tab="apps"><AppsTab /></SettingsFrame>,
  settingsAccount: () => <SettingsFrame tab="overview"><WorkspaceSettings central={central} onWorkspaceCreated={() => {}} /></SettingsFrame>,
  settingsLook: () => <SettingsFrame tab="look"><Appearance pref="system" onChoose={() => {}} /></SettingsFrame>,
  /** THE public page — one now, where there were three. It is what a stranger
   *  sees first and what every pasted invitation opens. */
  landing: () => <Landing />,
  /** «Доска» — the task board on its own data. Three states: the columns, a
   *  card open in the drawer (a right column at 1440, a sheet at 390), and the
   *  phone, where the columns are a tab strip and one column at a time. */
  board: () => <Board route={{ kind: 'board' }} />,
  boardDrawer: () => <Board route={{ kind: 'board', card: 'crd_01' }} />,
  boardPhone: () => <Board route={{ kind: 'board', col: 'in_progress' }} />,
  /** Железо with an empty fleet — the state the new «Как подключить железо»
   *  block replaces, and the one nobody could look at before. */
  hardware: () => <Hardware central={{ ...central, machines: [], machineStats: {} } as never} viewer={null} />,
  /** Железо with machines: the block must be folded away under the grid. */
  hardwareTeam: () => <Hardware central={HW_TEAM_CENTRAL as never} viewer={null} />,
  hardwareFull: () => <Hardware central={HW_CENTRAL as never} viewer={null} />,
  /**
   * The session list: live work first inside each project, «Команда» folded
   * away underneath. It is mounted at the real panel width because that is
   * the constraint — a card that reads fine at 400px is unusable at 260.
   */
  sessions: () => (
    <aside className="sidebar sidepanel" style={{ ['--sidebar-w' as string]: '320px' }}>
      <div className="sidebar-scroll">
        <ProjectList
          machines={SIDEBAR_MACHINES}
          selected={new Set()}
          runIndex={indexRuns(SIDEBAR_RUNS)}
          activeRuns={SIDEBAR_RUNS}
          favorites={new Set()}
          onSelect={() => {}}
          onToggleFav={() => {}}
          onSessionMenu={() => {}}
          viewerId={SIDEBAR_VIEWER}
        />
      </div>
    </aside>
  ),
  /** Recency, the folded «Раньше» and «Без проекта» on a crowded fleet. */
  sessionsNoisy: () => (
    <aside className="sidebar sidepanel" style={{ ['--sidebar-w' as string]: '320px' }}>
      <div className="sidebar-scroll">
        <ProjectList
          machines={NOISY_MACHINES}
          selected={new Set()}
          runIndex={indexRuns(SIDEBAR_RUNS)}
          activeRuns={SIDEBAR_RUNS}
          favorites={new Set()}
          onSelect={() => {}}
          onToggleFav={() => {}}
          onSessionMenu={() => {}}
          viewerId={SIDEBAR_VIEWER}
        />
      </div>
    </aside>
  ),
  /** «Команда»: a card per person, their projects inside, «Без автора» last. */
  sessionsTeam: () => (
    <Scoped scope="team">
      <aside className="sidebar sidepanel" style={{ ['--sidebar-w' as string]: `${Number(new URLSearchParams(location.search).get('panel')) || 320}px` }}>
        <div className="sidebar-scroll">
          <ProjectList
            machines={TEAM_MACHINES}
            selected={new Set()}
            runIndex={indexRuns(SIDEBAR_RUNS)}
            activeRuns={SIDEBAR_RUNS}
            favorites={new Set()}
            onSelect={() => {}}
            onToggleFav={() => {}}
            onSessionMenu={() => {}}
            viewerId={SIDEBAR_VIEWER}
          />
        </div>
      </aside>
    </Scoped>
  ),
  /** «Все»: project cards with the author named on every row that is not mine. */
  sessionsAll: () => (
    <Scoped scope="all">
      <aside className="sidebar sidepanel" style={{ ['--sidebar-w' as string]: `${Number(new URLSearchParams(location.search).get('panel')) || 320}px` }}>
        <div className="sidebar-scroll">
          <ProjectList
            machines={TEAM_MACHINES}
            selected={new Set(['m3::a-1'])}
            runIndex={indexRuns(SIDEBAR_RUNS)}
            activeRuns={SIDEBAR_RUNS}
            favorites={new Set()}
            onSelect={() => {}}
            onToggleFav={() => {}}
            onSessionMenu={() => {}}
            viewerId={SIDEBAR_VIEWER}
          />
        </div>
      </aside>
    </Scoped>
  ),
  /** The top bar's switch beside the limits, quiet on «Мои». */
  scopeBarMine: () => <ScopeBar scope="mine" />,
  /** …lit off «Мои»; and the phone's «Команда ✕» reminder at 390. */
  scopeBarTeam: () => <ScopeBar scope="team" />,
  scopeBarAll: () => <ScopeBar scope="all" />,
  /** The account popover, open: Настройки, the places, Браузер, the theme. */
  accountMenu: () => (
    <div className="app">
      <TopBar
        central={START_CENTRAL} gatewayQuota={null}
        themePref="system" onChooseTheme={() => {}}
        notifOpen={false} setNotifOpen={() => {}}
        settingsOpen setSettingsOpen={() => {}}
        displayName="Владелец" setDisplayName={() => {}}
        token="" setToken={() => {}} localDev={false}
        totalSessions={20} onJump={() => {}} accountInitials="ПХ"
        sidebarCollapsed onToggleSidebar={() => {}}
      />
    </div>
  ),
  /** The side panel with «Мои · Команда · Все» under its search. */
  sideScope: () => <Scoped scope="mine">{fullShell(false)}</Scoped>,
  /** …lit off «Мои». */
  sideScopeTeam: () => <Scoped scope="team">{fullShell(false)}</Scoped>,
  /** The Windows title bar with its menu bar and an unread bell. */
  winTitleBar: () => <WinTitleBar />,
  sessionOther: () => <Scoped scope="team"><SessionScreen other /></Scoped>,
  /**
   * The session row's context menu, OPEN, over the panel it is summoned from.
   *
   * A menu that only ever gets photographed shut is a menu nobody checks — the
   * model picker shipped clipped out of existence that way. This one is the
   * ONLY door to the split now, so "can it be read, and is «Добавить в
   * колонку» findable in it" is a shipping question, not a detail. The real
   * `ContextMenu`, with the real action list's shape: a disabled row and a
   * destructive one, because both have their own colour and both have to hold.
   */
  sessionmenu: () => (
    <div className="app">
      <div className="body">
        <aside className="sidebar sidepanel" style={{ ['--sidebar-w' as string]: '320px' }}>
          <div className="sidebar-scroll">
            <ProjectList
              machines={SIDEBAR_MACHINES}
              selected={new Set()}
              runIndex={indexRuns(SIDEBAR_RUNS)}
              activeRuns={SIDEBAR_RUNS}
              favorites={new Set()}
              onSelect={() => {}}
              onToggleFav={() => {}}
              onSessionMenu={() => {}}
              viewerId={SIDEBAR_VIEWER}
            />
          </div>
        </aside>
        <ContextMenu
          at={{ target: null, x: 180, y: 220 }}
          onClose={() => {}}
          label="Действия с сессией"
          actions={[
            { label: 'Открыть', run: () => {} },
            { label: 'Открыть в новой вкладке', run: () => {} },
            { label: 'Добавить в колонку', run: () => {}, disabled: () => 'Эта сессия уже в колонках' },
            { label: 'Копировать ссылку', run: () => {}, separated: true },
            { label: 'В избранное', run: () => {} },
            { label: 'Переименовать', run: () => {}, separated: true },
            { label: 'Закрыть сессию', run: () => {} },
            { label: 'Удалить', run: () => {}, danger: true },
          ]}
        />
      </div>
    </div>
  ),
  /** The split: the same transcript at a pane's width, which is where the
   *  gutter and the reading measure are actually under pressure. */
  columns: () => (
    <div className="session-columns">
      {COLS.map((c) => (
        <section className="session-col" key={c.title}>
          {/* Mirrors SessionColumn.tsx's header exactly — it used to carry an
              Avatar the real component never had, which made this fixture
              answer a question nobody was asking. */}
          <header className="sc-col-head" title={c.sub}>
            <div className="sc-col-titles">
              <span className="sc-col-proj">{c.sub.split(' · ')[1]}</span>
              <span className="sc-col-sep" aria-hidden>/</span>
              <div className="sc-col-title-slot"><div className="sc-col-title">{c.title}</div></div>
            </div>
            <span className={`sc-col-state ${c.state}`}>{c.label}</span>
          </header>
          <Log composer />
        </section>
      ))}
    </div>
  ),
  /** The split in a narrow window: tabs over one pane (SessionColumns
   *  `stacked`). Mirrors its markup, like `columns` above. */
  columnsStacked: () => (
    <div className="session-columns stacked">
      <div className="cols-tabs" role="tablist">
        {COLS.map((c, i) => (
          <div key={c.title} className={`cols-tab${i === 0 ? ' on' : ''}`}>
            <button type="button" className="cols-tab-main">
              <span className="cols-tab-title">{c.title}</span>
            </button>
            <button type="button" className="cols-tab-x" aria-label="Закрыть">×</button>
          </div>
        ))}
      </div>
      <section className="session-col">
        <header className="sc-col-head" title={COLS[0]!.sub}>
          <div className="sc-col-titles">
            <span className="sc-col-proj">{COLS[0]!.sub.split(' · ')[1]}</span>
            <span className="sc-col-sep" aria-hidden>/</span>
            <div className="sc-col-title-slot"><div className="sc-col-title">{COLS[0]!.title}</div></div>
          </div>
        </header>
        <Log composer />
      </section>
    </div>
  ),
  /**
   * THE WHOLE SCREEN — the side panel and three panes at once.
   *
   * Every other fixture here shows one part against stubs, which is right for
   * asking "does this component hold". It is the wrong instrument for "does the
   * screen read", and the screen is what a person actually meets: the panel's
   * weight against the panes, the session list against the titles, composers
   * stacked along one bottom edge. Judging those from a cropped transcript is
   * how a redesign turns into styling.
   *
   * This is THE shot for the new layout: the panel and the split used to be
   * mutually exclusive — a split dropped the session column to claim its width
   * — so "several conversations beside the list you picked them from" is a
   * picture nobody had seen before. Real `SidePanel`, not a copy.
   */
  full: () => fullShell(false),
  /** The split with editor tabs over each column (tabs.ts): the VS Code theme
   *  shows a strip even for one tab; the Hegai themes only from two. */
  tabs: () => fullShell(true),
  /**
   * The product as a laptop shows it: the panel, the bar with the limits pill,
   * and ONE open session — the REAL `SessionWorkspace`, not a copy. This is
   * the picture the public page uses for «Сессии найдутся сами»: the previous
   * one was a 420×560 crop of the side panel alone, which read as a list of
   * eleven identical rows floating in nothing. `full` is three panes of the
   * same transcript, a layout check rather than a thing anyone recognises.
   */
  desk: () => (
    <div className="app">
      <div className="body">
        <SidePanel
          central={DESK_CENTRAL as never}
          machines={DESK_MACHINES}
          machineFilter="all"
          onMachineFilter={() => {}}
          selected={new Set([sessionKey('d1', 'cart')])}
          runIndex={indexRuns(DESK_RUNS)}
          favorites={new Set()}
          onSelect={() => {}}
          onToggleFav={() => {}}
          drilled={false}
          onDrillChange={() => {}}
          onSessionMenu={() => {}}
          viewerId={DESK_VIEWER}
          width={320}
          resizing={false}
          onStartResize={() => {}}
          active="sessions"
          onNewSession={() => {}}
          onAddColumn={() => {}}
          foot={{ initials: 'ВО', name: 'Владелец Орлов', accountOpen: false, onToggleAccount: () => {} }}
        />
        <div className="main-col">
          <header className="topbar">
            <div className="spacer" />
            <div className="usage">
              <button className="usage-pill" type="button">
                {DESK_USAGE.map((u, i) => (
                  <span className="usage-provider" key={u.name}>
                    {i > 0 ? <span className="usage-sep" /> : null}
                    <span className="usage-provider-name">{u.name}</span>
                    <span className="meterlet">
                      <span className="meterlet-bar">
                        <span className="meterlet-fill" style={{ width: `${u.pct}%` }} />
                      </span>
                      <span className="meterlet-val">{u.pct}%</span>
                    </span>
                  </span>
                ))}
              </button>
            </div>
            <button className="icon-btn" type="button" title="Уведомления" aria-label="Уведомления">
              <Bell size={18} />
              <span className="nbadge">3</span>
            </button>
          </header>
          <main className="main">
            <SessionWorkspace
              central={DESK_CENTRAL}
              session={DESK_SESSION}
              selected={{ machineId: 'd1', sessionId: 'cart' }}
              runIndex={indexRuns([])}
              infoOpen={false}
              onToggleInfo={() => {}}
              canEdit canDrive ownsSelected
              onRename={() => {}}
              onDelete={() => {}}
              onToggleClosed={() => {}}
              onOpenDrawer={() => {}}
            />
          </main>
        </div>
      </div>
    </div>
  ),
  /**
   * A SESSION, as a phone meets it — the screen this product is actually used
   * on, and the one fixture that did not exist. Everything about the session
   * view was judged here from the 1440px `full` shot or from the transcript on
   * its own, which is how a phone ended up with two pinned rows of chrome above
   * the conversation before anyone looked.
   *
   * ⚠ This MIRRORS `shell/SessionWorkspace.tsx` — it does not mount it. That is
   * the fixture's standing hazard and it has already fired: on 2026-09-19 this
   * screen still drew «···», the ⓘ button and «⏎ отправить» for hours after all
   * three were deleted from the real header, because a copy cannot go stale
   * loudly. The stylesheet IS shared, so CSS changes show up here and markup
   * changes do not — which is the most misleading half-truth a fixture can
   * tell. Change the header or the composer foot → change it here, same commit.
   *
   * Mirrors `shell/SessionWorkspace.tsx`'s header markup (the title, hidden
   * under 860px by CSS, is deliberately present so the fixture would catch it
   * coming back). No top bar: `.main-col:has(.workspace) > .topbar` removes it
   * at this width, and the fixture must not claim otherwise.
   */
  session: () => <SessionScreen />,
  deskPhone: () => <SessionScreen desk />,
  /**
   * The model/effort menu, OPEN. Its own view because a popover that only ever
   * gets photographed shut is a popover nobody checks: this one shipped clipped
   * out of existence by `.composer-tools { overflow: hidden }` — present in the
   * layout, invisible, and not even tappable. The fixture clicks the real
   * trigger, so the picture is of the real thing opening.
   */
  modelpick: () => (
    <div className="app">
      <div className="body">
        <div className="main-col">
          <main className="main">
            <div className="workspace">
              <div className="ws-main">
                <div className="panel">
                  {/* idle AND open: the composer is folded by default and the
                      menu is up with nothing focused — the state where a rule
                      hung on `:focus-within` alone folds the row out from under
                      the menu. Photographed so it stays fixed. */}
                  <Log composer idleComposer openPicker />
                </div>
              </div>
            </div>
          </main>
        </div>
      </div>
    </div>
  ),
  /**
   * The same menu with the level UNKNOWN — nothing pinned, nothing reported.
   *
   * Its own view because this is the state that shipped wrong and could not be
   * caught by a test: the thumb was parked on the first stop, so a Codex session
   * running at `medium` read as `low` and differed from a real `low` by nothing
   * but opacity. What this picture has to show is an empty track: a scale with
   * no thumb and no marked stop, still draggable.
   */
  modelpickunset: () => (
    <div className="app">
      <div className="body">
        <div className="main-col">
          <main className="main">
            <div className="workspace">
              <div className="ws-main">
                <div className="panel">
                  <Log composer idleComposer openPicker unknownEffort />
                </div>
              </div>
            </div>
          </main>
        </div>
      </div>
    </div>
  ),
  /**
   * ГЛАВНАЯ on a phone: the real `TopBar` over the real `StartScreen`.
   *
   * This screen had no fixture at all, which is how three of its rules went in
   * unseen — the limits pill being deleted from the phone, the shelf's «ещё N»
   * jumping into a popover, and a header of icons nobody taps. It is also the
   * only fixture that can show «Сейчас в работе» against a realistic fleet:
   * `SIDEBAR_MACHINES` carries twelve `livePid` sessions on one box, which is
   * exactly the case that decides whether that section is a glance or a second
   * session list.
   */
  start: () => (
    <div className="app">
      <div className="body">
        <div className="main-col">
          <TopBar
            central={START_CENTRAL}
            gatewayQuota={null}
            themePref="system"
            onChooseTheme={() => {}}
            notifOpen={false}
            setNotifOpen={() => {}}
            // `?pop=1` opens the account popover — the theme and text-size rows.
            settingsOpen={new URLSearchParams(location.search).has('pop')}
            setSettingsOpen={() => {}}
            displayName="Владелец"
            setDisplayName={() => {}}
            token=""
            setToken={() => {}}
            localDev={false}
            totalSessions={20}
            accountInitials="ПХ"
            sidebarCollapsed={false}
            onToggleSidebar={() => {}}
            onJump={() => {}}
            /* Non-undefined is what puts this bar in its phone shape: limits
               compact, the three chrome icons gone. Same signal App uses. */
            onOpenDrawer={() => {}}
          />
          <main className="main">
            <StartScreen central={START_CENTRAL} onNewSession={() => true} viewer={START_CENTRAL.viewer} />
          </main>
        </div>
      </div>
    </div>
  ),
  /** A new chat inside the narrowest desktop split pane. The viewport stays
   *  wide here on purpose: viewport media queries cannot see this constraint,
   *  which is how the composer controls came to overlap in column mode. */
  startColumn: () => (
    <div className="app">
      <div className="body">
        <div className="main-col">
          <main className="main">
            <div className="session-columns">
              <section className="session-col focused" style={{ flex: '0 0 300px' }}>
                <header className="sc-col-head">
                  <div className="sc-col-titles">
                    <div className="sc-col-title-slot"><div className="sc-col-title">Новый чат</div></div>
                  </div>
                </header>
                <div className="pane-body main">
                  <StartScreen central={START_CENTRAL} onNewSession={() => true} viewer={START_CENTRAL.viewer} />
                </div>
              </section>
            </div>
          </main>
        </div>
      </div>
    </div>
  ),
  /** The start screen on a git project: «В отдельной ветке (worktree)». */
  startWorktree: () => {
    const c = {
      ...START_CENTRAL,
      machines: DESK_MACHINES.map((m) => ({
        ...m,
        canStart: true,
        canControl: true,
        sessions: m.sessions.map((s) => {
          const { project, ...rest } = s as { project?: string };
          return { ...rest, cwd: m.machine.machineId === 'd1' ? `/Users/you/${project}` : `/srv/${project}` };
        }),
      })),
      activeRuns: DESK_RUNS,
      rpc: async (_m: string, method: string) => {
        if (method === 'git.status') return { isRepo: true, branch: 'main', ahead: 0, behind: 0, files: [] };
        if (method === 'git.worktree.list') return { worktrees: [
          { path: '/Users/you/.hegai-worktrees/cart/agent-fix-login-1030', branch: 'agent/fix-login-1030', head: 'a1b2c3d4e5f6', main: false, dirty: 2, ahead: 2, behind: 0 },
          { path: '/Users/you/.hegai-worktrees/cart/agent-refactor-1029', branch: 'agent/refactor-1029', head: 'f6e5d4c3b2a1', main: false, dirty: 0, ahead: 5, behind: 1, busy: true },
        ] };
        throw new Error(`preview: no RPC stub for ${method}`);
      },
    } as unknown as CentralState;
    return (
      <div className="app">
        <div className="body">
          <div className="main-col">
            <main className="main">
              <StartScreen central={c} onNewSession={() => true} viewer={c.viewer} />
            </main>
          </div>
        </div>
      </div>
    );
  },
  /** The diff review sheet with a note on a line. */
  changes: () => (
    <div className="app">
      <SideSheet title="Изменения" wide bodyClassName="rv-body" onClose={() => {}}>
        <ChangesPanel central={REVIEW_CENTRAL} machineId="d1" cwd="/Users/you/.hegai-worktrees/cart/agent-fix-login-1030" settledKey="x" onSendReview={() => true} canDrive canPublish />
      </SideSheet>
    </div>
  ),
  startColumnPick: () => SCREENS.startColumn!(),
  startExpanded: () => SCREENS.start!(),
  /** The start screen on the public page's scene (see DESK_MACHINES): the same
   *  StartScreen as `start`, fed recognisable work instead of the layout
   *  stress data, which reads as filler once it is on code.acme.test. */
  deskStart: () => {
    const c = {
      ...START_CENTRAL,
      machines: DESK_MACHINES.map((m) => ({
        ...m,
        canStart: true,
        canControl: true,
        sessions: m.sessions.map((s) => {
          const { project, ...rest } = s as { project?: string };
          return { ...rest, cwd: m.machine.machineId === 'd1' ? `/Users/you/${project}` : `/srv/${project}` };
        }),
      })),
      activeRuns: DESK_RUNS,
      rpc: DESK_CENTRAL.rpc,
    } as unknown as CentralState;
    return (
      <div className="app">
        <div className="body">
          <div className="main-col">
            <main className="main">
              <StartScreen central={c} onNewSession={() => true} viewer={c.viewer} />
            </main>
          </div>
        </div>
      </div>
    );
  },
  /**
   * ГЛАВНАЯ with the model menu OPEN (the shot row clicks `.run-pick`).
   *
   * `modelpick` photographs this same control in a SESSION. The start composer
   * now shares its bottom-edge posture, but its dock also carries the category
   * shelf and can grow differently under a phone keyboard. Keep the second
   * fixture so the upward menu remains inside the viewport in both contexts.
   */
  startpick: () => SCREENS.start!(),
  /** The same screen with the drawer open — the real component over the real
   *  session, because the question is whether it covers the conversation
   *  legibly, not whether it renders. */
  /** The same drawer, photographed WITH a phone's top inset (`sat` in the
   *  shot rows). Its own key rather than a flag on `drawer`, so both the
   *  inset and the flat layout stay on file and a regression in either is a
   *  changed picture. */
  drawerInset: () => SCREENS.drawer!(),
  /** And the two screens the phone actually sits on, under the same clock:
   *  the session (its own `.ws-head` is the chrome) and the list (the floating
   *  `.topbar`). Both grew their inset rules years before anything could see
   *  them — `black-translucent` is what finally makes the browser honour them,
   *  so this is where "does the content clear the clock" gets answered. */
  sessionInset: () => SCREENS.session!(),
  sessionBusyInset: () => <SessionScreen live />,
  sessionHelpers: () => <SessionScreen helpers />,
  /** What the session TITLE opens on a phone. */
  sessionInfo: () => <SessionScreen info />,
  fullInset: () => SCREENS.full!(),
  drawer: () => (
    <SessionScreen
      drawer={
        <SessionDrawer
        central={{ ...central, machines: SIDEBAR_MACHINES, activeRuns: SIDEBAR_RUNS } as never}
        machines={SIDEBAR_MACHINES}
        selected={new Set(['m2::vs-1'])}
        runIndex={indexRuns(SIDEBAR_RUNS)}
        favorites={new Set()}
        onSelect={() => {}}
        onToggleFav={() => {}}
        onSessionMenu={() => {}}
        viewerId={SIDEBAR_VIEWER}
        onClose={() => {}}
        onNewSession={() => {}}
        onSearch={() => {}}
          themePref="system"
          onCycleTheme={() => {}}
          onOpenNotifications={() => {}}
        />
      }
    />
  ),
  /** The drawer's ⚙ menu open (shot.mjs clicks it): bell, theme and the
   *  cloud browser's row live here on a phone. */
  drawerMenu: () => SCREENS.drawer!(),
  /** The drawer in «Команда»: the switch as a full-width row under the search,
   *  and the person cards at a phone's width. */
  drawerTeam: () => (
    <Scoped scope="team">
      <SessionScreen
        drawer={
          <SessionDrawer
            central={{ ...central, machines: TEAM_MACHINES, activeRuns: SIDEBAR_RUNS } as never}
            machines={TEAM_MACHINES}
            selected={new Set()}
            runIndex={indexRuns(SIDEBAR_RUNS)}
            favorites={new Set()}
            onSelect={() => {}}
            onToggleFav={() => {}}
            onSessionMenu={() => {}}
            viewerId={SIDEBAR_VIEWER}
            onClose={() => {}}
            onNewSession={() => {}}
            onSearch={() => {}}
            themePref="system"
            onCycleTheme={() => {}}
            onOpenNotifications={() => {}}
            othersWork
          />
        }
      />
    </Scoped>
  ),
  /** The same transcript at full width — what a pane's layout must not cost. */
  transcript: () => <Log />,
  /** The live tail: no gear at a paragraph's head, no refusal line in the reading. */
  liveTail: () => <LiveLog />,
  /** Generated pictures: finished, drawing, done live, failed (click `.gen-open` for the lightbox). */
  imageGen: () => <GenLog />,
  imageGenBox: () => <GenLog />,
  /**
   * Dictation, the two states that used to look like nothing: the mic live, and
   * the clip being read back. Both at the FULL composer and — via the 390px
   * rows in shot.mjs — in the folded one-row phone composer, where the wave has
   * to share 390px with the attach button, the model glyph, the mic and send.
   */
  /** The composer EXPANDED — the state a phone is in while the keyboard is up,
   *  and the only one where the model trigger exists at all (`.composer-tools`
   *  is `display: none` while folded). Not photographed: it is here so
   *  `scripts/picker-focus-check.mjs` can open the picker out of a focused
   *  field, which is the situation the focus handling is FOR. Every other
   *  phone fixture is either folded or mid-dictation. */
  composerOpen: () => <Log composer />,
  dictation: () => <Log composer dictating="recording" />,
  dictationBusy: () => <Log composer dictating="transcribing" />,
  /** The folded phone row: `idle` MEANS the draft is empty, so the wave taking
   *  the field's slot here can never hide anything typed. */
  dictationIdle: () => <Log composer idleComposer dictating="recording" />,
  /**
   * NOT a screenshot view — `dictation-smoke.ts` drives this one in a real
   * Chrome with `--use-fake-device-for-media-stream`. The stubs stop at the
   * network: the microphone, the AudioContext, the analyser, the rAF loop and
   * every state transition are the product's own, because those are the parts
   * that can be silently dead while the markup looks perfect.
   */
  dictationLive: () => <LiveDictation />,
  /** The enrichment strip under the tail turn, in its LLM-refined state. */
  /** The REAL limits meter, not a copy of its markup.
   *
   *  The `full` fixture mirrors the pill by hand, which is fine for judging the
   *  bar against the chrome around it and useless for judging the panel behind
   *  it — that panel had no fixture at all, and a row in the 75–89% band was
   *  quietly wearing the transcript warning banner's plate and padding. The
   *  shot clicks the pill open (see `click` in shot.mjs). */
  usage: () => (
    <div style={{ padding: 24, display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-end' }}>
      <UsageMeter central={START_CENTRAL} />
    </div>
  ),
  filePreview: () => (
    <FilePeekContext.Provider value={previewPeek}>
      <div className="chat">
        <div className="log">
          <div className="log-inner">
            {groupHistory(PREVIEW_HISTORY).map((it) =>
              it.kind === 'msg' ? (
                <MessageView key={it.id} msg={it.msg} cont={it.cont} showStamp={it.showStamp} runBefore={it.runBefore} runAfter={it.runAfter} />
              ) : (
                <ToolRunRow key={it.id} blocks={it.blocks} />
              ),
            )}
          </div>
        </div>
      </div>
    </FilePeekContext.Provider>
  ),
  fileChips: () => (
    <FilePeekContext.Provider value={filesPeek}>
      <div className="chat">
        <div className="log">
          <div className="log-inner">
            {groupHistory(FILES_HISTORY).map((it) =>
              it.kind === 'msg' ? (
                <MessageView key={it.id} msg={it.msg} cont={it.cont} showStamp={it.showStamp} runBefore={it.runBefore} runAfter={it.runAfter} />
              ) : (
                <ToolRunRow key={it.id} blocks={it.blocks} />
              ),
            )}
          </div>
        </div>
      </div>
    </FilePeekContext.Provider>
  ),
  enrich: () => (
    // A stub for the session's fetch: one tiny inline PNG, so the attachment
    // path renders end to end here without a hub, a machine or a transcript.
    <AttachmentContext.Provider value={async () => ({ mediaType: 'image/png', dataB64: SHOT_B64 })}>
      <Log strip={ENRICHED} />
    </AttachmentContext.Provider>
  ),
  /**
   * «Файлы»: the directory listing that is the section's work surface, plus the
   * upload tray mid-flight. Stubbed rather than live because the interesting
   * states — a truncated directory, a failed upload — are the ones a real
   * machine will not produce on demand.
   */
  files: () => filesScreen(null),
  filesDownloading: () => filesScreen(<SaveStatusBar state={{ phase: 'loading', name: 'anomalia-story.mp4', pct: 45 }} onSave={() => {}} onDismiss={() => {}} />),
  filesReady: () => filesScreen(<SaveStatusBar state={{ phase: 'ready', name: 'anomalia-story.mp4', blob: new Blob() }} onSave={() => {}} onDismiss={() => {}} />),
  filesError: () => filesScreen(<SaveStatusBar state={{ phase: 'error', name: 'anomalia-story.mp4', message: 'socket closed' }} onSave={() => {}} onDismiss={() => {}} />),
  /** The icon view — Finder's default, and the reason a folder of photos reads
   *  as photos rather than as rows of paths. */
  'files-grid': () => (
    <div className="files">
      <div className="files-bar">
        <nav className="fcrumbs">
          <a className="fcrumb" href="#">Все машины</a>
          <span className="fcrumb-sep">/</span>
          <span className="fcrumb fcrumb-machine">stage</span>
          <span className="fcrumb-sep">/</span>
          <a className="fcrumb" href="#">hegai</a>
          <span className="fcrumb-sep">/</span>
          <a className="fcrumb" href="#">content</a>
        </nav>
      </div>
      <div className="files-panes">
        <nav className="ftree">
          {['hegai', 'content', 'docs', 'invoices', 'logs'].map((n, i) => (
            <div key={n} className={`ftree-row${i === 1 ? ' active' : ''}`} style={{ paddingLeft: i === 0 ? 8 : 20 }}>
              <span className="tw">{i === 0 || i === 1 ? '▾' : '▸'}</span>
              <span className="ftree-name">{n}</span>
            </div>
          ))}
        </nav>
        <main className="files-main">
          <FileGrid
            entries={GRID_ENTRIES}
            selected={new Set(['Владелец Орлов.pdf'])}
            active={3}
            renaming={null}
            canWrite
            dirKey="stub"
            readObjectUrl={() => new Promise(() => {})}
            onOpen={() => {}}
            onSelect={() => {}}
            onActivate={() => {}}
            onKeyNav={() => {}}
            onContext={() => {}}
            onDragFiles={(e) => [e.name]}
            onMoveInto={() => {}}
            onDropUpload={() => {}}
            onSpring={() => {}}
            emptyHint="Перетащите файлы сюда"
          />
        </main>
      </div>
    </div>
  ),
  /** The shelf: which machine, which project. */
  'files-shelf': () => (
    <div className="board files-shelf">
      <div className="board-head">
        <span className="eyebrow eyebrow--mark">Файлы</span>
      </div>
      {[
        { machine: 'mac mini', online: true, roots: ['claudehegai', 'hegainews', 'legalos'] },
        { machine: 'stage', online: false, roots: ['crm', 'events'] },
      ].map((m) => (
        <section className="files-shelf-group" key={m.machine}>
          <div className="files-shelf-head">
            <span className={`hw-dot${m.online ? ' on' : ''}`} />
            {m.machine}
          </div>
          <div className="files-shelf-grid">
            {m.roots.map((r) => (
              <a className="root-card" key={r} href="#">
                <span className="root-card-name">📁 {r}</span>
                <span className="root-card-path">/Users/devuser-0001/{r}</span>
              </a>
            ))}
          </div>
        </section>
      ))}
    </div>
  ),
};

/** Screens that render the entire shell themselves — see the note at the mount. */
const BARE = new Set([
  'full', 'tabs', 'fullInset', 'desk', 'deskStart', 'deskPhone', 'session', 'sessionInset', 'sessionBusyInset', 'sessionHelpers', 'sessionInfo', 'drawer', 'drawerMenu', 'drawerTeam', 'drawerInset', 'modelpick', 'start', 'startpick', 'startWorktree', 'changes',
  'startColumn', 'startColumnPick', 'startExpanded',
  'scopeBarMine', 'scopeBarTeam', 'scopeBarAll', 'sessionOther', 'sideScope', 'sideScopeTeam', 'winTitleBar', 'accountMenu',
  'browser', 'browserLost', 'browserNoEgress', 'browserEmpty',
  'onboardMachine', 'onboardRuntimes', 'onboardPhone', 'appPage',
  // The public pages are whole documents: `App()` returns each one straight
  // into `#root`, with no shell around it. Wrapping them anyway put them
  // inside `main.main`, a flex container, where `min-width: auto` let the
  // install command size the box — photographed as an 846px page in a 390px
  // frame and reported as horizontal overflow on the two links people paste
  // into chats. The pages were fine; the fixture was lying, exactly the way
  // the note at the mount below predicts.
  'landing',
]);
const which = new URLSearchParams(location.search).get('screen') ?? 'settings';
const Screen = SCREENS[which] ?? SCREENS.settings;

/**
 * `?audit=1` — name every element sticking out past the viewport, into the
 * document title so `--dump-dom` can read it back.
 *
 * Horizontal overflow is the one layout bug a screenshot shows but does not
 * explain: the picture is clipped and the culprit is off-frame by definition.
 * `body { overflow: hidden }` means it does not even scroll — it is simply
 * gone.
 */
function audit() {
  const w = document.documentElement.clientWidth;
  const over = [...document.querySelectorAll<HTMLElement>('body *')]
    .filter((el) => el.getBoundingClientRect().right > w + 1)
    // Something DELIBERATELY pushed off the side, and its children with it —
    // the app card while the phone's drawer is open is the only such thing so
    // far. The rule this audit enforces is "nothing is unreachable by
    // accident"; an element moved by a transform was moved on purpose, and the
    // phone's `html, body { overflow-x: hidden }` is what keeps it from
    // becoming a scrollbar. Anything laid out past the edge still fails.
    .filter((el) => !el.closest('.app:has(> .sdrawer) > .body'))
    .map((el) => `${el.tagName.toLowerCase()}.${el.className || '—'}@${Math.round(el.getBoundingClientRect().right)}`);
  document.title = `AUDIT vw=${w} scroll=${document.body.scrollWidth} :: ${over.slice(0, 12).join(' | ') || 'clean'}`;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Regular weight, set the same way main.tsx sets it — a preview rendering
        filled glyphs would be checking the wrong picture. */}
    <IconContext.Provider value={{ weight: 'regular' }}>
      {/* Most fixtures are ONE panel and need the shell around them to sit in.
          A full-screen fixture brings its own `.app` — wrapping it again nests a
          second shell inside the first, and the inner one then sizes to its own
          content instead of to the viewport. That is not a hypothetical: it
          stretched `full` to 1600px inside a 1440px window and read exactly like
          a layout bug in the product, down to a clipped fourth pane. */}
      {BARE.has(which) ? (
        Screen()
      ) : (
        <div className="app">
          <div className="main-col">
            <main className="main">{Screen()}</main>
          </div>
        </div>
      )}
    </IconContext.Provider>
  </StrictMode>,
);

if (new URLSearchParams(location.search).has('audit')) requestAnimationFrame(() => setTimeout(audit, 300));

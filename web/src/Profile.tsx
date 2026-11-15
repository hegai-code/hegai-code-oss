import { useMemo, useState } from 'react';
import { GaugeIcon, MoonIcon } from './icons.js';
import type { BuilderProfile, NamedCount } from '@cc-remote/shared';
import type { CentralState } from './useCentral.js';
import { relTimeRu } from './lib.js';

interface Props {
  central: CentralState;
}

// The agent sends archetypes (and badges) by their English name — that is the
// wire value; only what the screen calls them is translated here.
const ARCHETYPE_NAME: Record<string, string> = {
  'Night Owl': 'Сова',
  'Quality Guardian': 'Страж качества',
  'Velocity Machine': 'Скоростная машина',
  Architect: 'Архитектор',
  Scholar: 'Исследователь',
  Debugger: 'Отладчик',
  Polyglot: 'Полиглот',
  Marathoner: 'Марафонец',
  'All-Rounder': 'Универсал',
};

// One-line flavor per archetype — keeps the headline human, not just a label.
const ARCHETYPE_BLURB: Record<string, string> = {
  'Night Owl': 'Больше всего вы строите после заката.',
  'Quality Guardian': 'Гоняете тесты и читаете, прежде чем писать.',
  'Velocity Machine': 'Высокий темп — правки уходят быстро.',
  Architect: 'Планируете в режиме плана и работаете во многих репозиториях.',
  Scholar: 'Изучаете и читаете куда больше, чем правите.',
  Debugger: 'Много циклов git и тестов — ищете и чините.',
  Polyglot: 'Свободно переходите между языками.',
  Marathoner: 'Ваши сессии долгие и глубокие.',
  'All-Rounder': 'Ровно по всем направлениям.',
};

const SCORE_LABEL: Record<string, string> = {
  steering: 'Управление',
  execution: 'Исполнение',
  engineering: 'Инженерия',
  planning: 'Планирование',
  product: 'Продукт*',
};

const DOW = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

const pct = (v: number) => `${Math.round(v * 100)}%`;
const day = (ts: number) => (ts ? new Date(ts).toISOString().slice(0, 10) : '—');

/** Labeled horizontal bar. `value/max` drives the fill width. */
function Bar({ label, value, max, display }: { label: string; value: number; max: number; display: string }) {
  const w = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="barrow">
      <span className="barrow-label" title={label}>{label}</span>
      <span className="barrow-track">
        <span className="barrow-fill" style={{ width: `${w}%` }} />
      </span>
      <span className="barrow-val">{display}</span>
    </div>
  );
}

/** A 0–10 dimension score, rendered as a filled meter. */
function ScoreBar({ name, value }: { name: string; value: number }) {
  return (
    <div className="barrow score">
      <span className="barrow-label">{SCORE_LABEL[name] ?? name}</span>
      <span className="barrow-track">
        <span className="barrow-fill" style={{ width: `${Math.min(100, value * 10)}%` }} />
      </span>
      <span className="barrow-val">{value}</span>
    </div>
  );
}

function leaderboard(rows: NamedCount[]): NamedCount[] {
  return rows.slice(0, 8);
}

function countRows(rec: Record<string, number>): NamedCount[] {
  return Object.entries(rec)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
}

/**
 * Profile view: this machine's locally-computed "how you build with AI" report.
 * Everything shown is derived on the agent box from ~/.claude transcripts — no
 * excerpt or payload leaves the machine, only the reduced numbers rendered here.
 */
export function Profile({ central }: Props) {
  const withProfiles = useMemo(
    () => central.machines.filter((m) => central.profiles[m.machine.machineId]),
    [central.machines, central.profiles],
  );
  const [sel, setSel] = useState<string | null>(null);
  const machineId = sel && central.profiles[sel] ? sel : withProfiles[0]?.machine.machineId ?? null;
  const p: BuilderProfile | undefined = machineId ? central.profiles[machineId] : undefined;

  if (!p) {
    return (
      <div className="profile">
        <div className="board-head">
          <GaugeIcon size={20} />
          <h2>Профиль</h2>
        </div>
        <div className="placeholder">
          <div className="ph-sub">
            Профиля пока нет. Каждый агент считает его у себя по записям в ~/.claude через несколько секунд
            после подключения (и потом раз в несколько часов) — с машины ничего не уходит. Загляните чуть позже.
          </div>
        </div>
      </div>
    );
  }

  const topTools = countRows(p.tools.counts);
  const maxTool = topTools[0]?.count ?? 1;
  const langs = leaderboard(p.engineering.topLanguages);
  const maxLang = langs[0]?.count ?? 1;
  const models = countRows(p.models.histogram);
  const maxModel = models[0]?.count ?? 1;
  const maxHour = Math.max(1, ...p.cadence.hourHistogram);
  const maxDow = Math.max(1, ...p.cadence.weekdayHistogram);

  return (
    <div className="profile">
      <div className="board-head">
        <GaugeIcon size={20} />
        <h2>Профиль</h2>
        <span className="sub">посчитан на машине · наружу ничего не уходит</span>
      </div>

      {withProfiles.length > 1 && (
        <div className="board-toolbar">
          {withProfiles.map((m) => (
            <button
              key={m.machine.machineId}
              className={`board-filter ${m.machine.machineId === machineId ? 'active' : ''}`}
              onClick={() => setSel(m.machine.machineId)}
            >
              {m.machine.name}
            </button>
          ))}
        </div>
      )}

      {/* Archetype hero */}
      <div className="prof-hero">
        <div className="prof-hero-main">
          <div className="prof-arch">{ARCHETYPE_NAME[p.archetype.primary] ?? p.archetype.primary}</div>
          <div className="prof-arch-blurb">{ARCHETYPE_BLURB[p.archetype.primary] ?? ''}</div>
          {p.archetype.badges.length > 0 && (
            <div className="prof-badges">
              {p.archetype.badges.map((b) => (
                <span className="prof-badge" key={b}>{ARCHETYPE_NAME[b] ?? b}</span>
              ))}
            </div>
          )}
        </div>
        <div className="prof-hero-meta">
          <div>сессий: <b>{p.sessions}</b> · записей: <b>{p.transcriptsScanned}</b></div>
          <div>запросов: <b>{p.messages.user}</b> · ответов агента: <b>{p.messages.assistant}</b></div>
          <div>{day(p.span.firstTs)} → {day(p.span.lastTs)}</div>
          <div>активных дней: <b>{p.span.activeDays}</b> · самая длинная серия <b>{p.span.longestStreakDays} дн</b></div>
          <div className="prof-generated">обновлено {relTimeRu(p.generatedAt)}</div>
        </div>
      </div>

      <div className="prof-grid">
        {/* Scores */}
        <section className="prof-card">
          <h4>Оценки</h4>
          <div className="prof-bars">
            {(['steering', 'execution', 'engineering', 'planning', 'product'] as const).map((k) => (
              <ScoreBar key={k} name={k} value={p.scores[k]} />
            ))}
          </div>
          <div className="prof-note">*Продукт — грубая оценка (доля затронутых файлов интерфейса, документации и дизайна).</div>
        </section>

        {/* Cadence */}
        <section className="prof-card">
          <h4>Когда вы работаете</h4>
          <div className="prof-stat"><MoonIcon size={13} /> доля ночной работы <b>{pct(p.cadence.nightOwlShare)}</b></div>
          <div className="hist" title="Активность по часам (0–23); зелёным — 22:00–05:00">
            {p.cadence.hourHistogram.map((v, h) => (
              <span
                key={h}
                className={`hist-bar ${h >= 22 || h < 5 ? 'night' : ''}`}
                style={{ height: `${(v / maxHour) * 100}%` }}
                title={`${h}:00 — ${v}`}
              />
            ))}
          </div>
          <div className="hist-axis"><span>0 ч</span><span>12 ч</span><span>23 ч</span></div>
          <div className="hist wide" title="Активность по дням недели">
            {p.cadence.weekdayHistogram.map((v, i) => (
              <span key={i} className="hist-bar" style={{ height: `${(v / maxDow) * 100}%` }} title={`${DOW[i]} — ${v}`} />
            ))}
          </div>
          <div className="hist-axis dow">{DOW.map((d) => <span key={d}>{d}</span>)}</div>
          <div className="prof-stat">в среднем за сессию: <b>{p.cadence.avgSessionMessages}</b> сообщ. · <b>{Math.round(p.cadence.avgSessionMinutes)}</b> мин</div>
        </section>

        {/* Tools */}
        <section className="prof-card">
          <h4>Инструменты</h4>
          <Bar label="правки против чтения" value={p.tools.buildVsExplore} max={1} display={`${pct(p.tools.buildVsExplore)} правки`} />
          <Bar label="тесты / shell" value={p.tools.testRunShare} max={1} display={pct(p.tools.testRunShare)} />
          <Bar label="git / shell" value={p.tools.gitOpShare} max={1} display={pct(p.tools.gitOpShare)} />
          <div className="prof-stat">вызовов за сессию <b>{p.tools.toolCallsPerSession}</b></div>
          <div className="prof-bars">
            {topTools.map((t) => (
              <Bar key={t.name} label={t.name} value={t.count} max={maxTool} display={String(t.count)} />
            ))}
          </div>
        </section>

        {/* Engineering */}
        <section className="prof-card">
          <h4>Охват кода</h4>
          <div className="prof-stat">файлов: <b>{p.engineering.filesTouched}</b> · репозиториев: <b>{p.engineering.repos}</b> · веток: <b>{p.engineering.branches}</b></div>
          <div className="prof-bars">
            {langs.length === 0 && <div className="prof-note">Правленых файлов пока нет.</div>}
            {langs.map((l) => (
              <Bar key={l.name} label={l.name} value={l.count} max={maxLang} display={String(l.count)} />
            ))}
          </div>
        </section>

        {/* Planning */}
        <section className="prof-card">
          <h4>Планирование</h4>
          <Bar label="режим плана" value={p.planning.planModeShare} max={1} display={pct(p.planning.planModeShare)} />
          <Bar label="TodoWrite" value={p.planning.todoShare} max={1} display={pct(p.planning.todoShare)} />
          <div className="prof-subhead">Частые скиллы</div>
          {p.planning.topSkills.length === 0 && <div className="prof-note">Скиллы пока не вызывались.</div>}
          <div className="prof-chips">
            {p.planning.topSkills.map((s) => (
              <span className="chip" key={s.name}>{s.name} <b>{s.count}</b></span>
            ))}
          </div>
        </section>

        {/* Models */}
        <section className="prof-card">
          <h4>Модели</h4>
          <div className="prof-stat">моделей за сессию в среднем <b>{p.models.avgModelsPerSession}</b></div>
          <div className="prof-bars">
            {models.map((m) => (
              <Bar key={m.name} label={m.name} value={m.count} max={maxModel} display={String(m.count)} />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

import { useState } from 'react';
import { parseAskQuestions, type AskQuestion, type PermissionMode } from '@cc-remote/shared';
import { Check, X } from '../icons.js';
import { Md } from '../render/Blocks.js';
import type { ToolRequest } from '../useCentral.js';

/**
 * Renders interactive planning tools as real UI instead of a raw
 * JSON allow/deny dump:
 *  - AskUserQuestion → the question(s) with clickable option buttons (+ "Other").
 *  - EnterPlanMode   → enter planning / stay in the current mode.
 *  - ExitPlanMode    → keep planning / proceed with reviewed or auto-accepted edits.
 *
 * Both arrive through the normal tool-approval path (canUseTool → tool_request);
 * the chosen answer / approval travels back via decideTool's `updatedInput`
 * (PermissionResult.updatedInput).
 */

// Sentinel key for the auto-provided free-text choice. Internal-only (mapped to
// the typed text before we submit), so it just has to never equal a real option
// label — this fenced string is safe and, unlike a raw NUL byte, survives tools.
const OTHER = 'cc-other';

export function QuestionModal({
  req,
  onDecide,
}: {
  req: ToolRequest;
  onDecide: (allow: boolean, updatedInput?: Record<string, unknown>, permissionMode?: PermissionMode) => void;
}) {
  if (req.tool === 'ExitPlanMode') return <PlanModal req={req} onDecide={onDecide} />;
  if (req.tool === 'EnterPlanMode') return <EnterPlanModal req={req} onDecide={onDecide} />;
  return <AskModal req={req} onDecide={onDecide} />;
}

function AskModal({
  req,
  onDecide,
}: {
  req: ToolRequest;
  onDecide: (allow: boolean, updatedInput?: Record<string, unknown>) => void;
}) {
  const questions = parseAskQuestions(req.input?.['questions']);
  // Per question: a set of chosen option labels, plus optional "Other" text.
  const [picked, setPicked] = useState<Record<number, Set<string>>>({});
  const [other, setOther] = useState<Record<number, string>>({});

  const toggle = (qi: number, label: string, multi: boolean) => {
    setPicked((prev) => {
      const cur = new Set(prev[qi] ?? []);
      if (multi) {
        cur.has(label) ? cur.delete(label) : cur.add(label);
      } else {
        cur.clear();
        cur.add(label);
      }
      return { ...prev, [qi]: cur };
    });
  };

  const answerFor = (qi: number, q: AskQuestion): string | string[] | undefined => {
    const set = picked[qi] ?? new Set<string>();
    const labels = [...set].map((l) => (l === OTHER ? (other[qi] ?? '').trim() : l)).filter(Boolean);
    if (!labels.length) return undefined;
    return q.multiSelect ? labels : labels[0];
  };

  const answered = questions.every((q, qi) => answerFor(qi, q) !== undefined);

  const submit = () => {
    // Claude keys answers by question text; Codex supplies stable question ids.
    const answers: Record<string, string | string[]> = {};
    questions.forEach((q, qi) => {
      const a = answerFor(qi, q);
      if (a !== undefined) answers[q.id ?? q.question] = a;
    });
    onDecide(true, { ...req.input, answers });
  };

  // Malformed / empty payload — don't render a broken question form; fall back
  // to a plain allow/deny so the user can still act on the underlying tool.
  if (!questions.length) return <GenericApproval req={req} onDecide={onDecide} />;

  return (
    <div className="modal-backdrop">
      <div className="modal question-modal">
        {/* The questions scroll, the actions do not. A four-option quiz with
            descriptions is taller than a laptop viewport, and the modal had no
            height cap at all — it simply grew past the screen, taking Submit
            with it, with nothing anywhere to scroll. */}
        <div className="q-scroll">
        {questions.map((q, qi) => (
          <div key={qi} className="q-block">
            {q.header && <span className="q-header">{q.header}</span>}
            <div className="q-text">{q.question}</div>
            <div className="q-options">
              {q.options.map((o) => {
                const sel = (picked[qi] ?? new Set()).has(o.label);
                return (
                  <button
                    key={o.label}
                    className={`q-option ${sel ? 'sel' : ''}`}
                    onClick={() => toggle(qi, o.label, !!q.multiSelect)}
                    title={o.description}
                  >
                    <span className="q-option-label">{o.label}</span>
                    {o.description && <span className="q-option-desc">{o.description}</span>}
                  </button>
                );
              })}
              <button
                className={`q-option ${(picked[qi] ?? new Set()).has(OTHER) ? 'sel' : ''}`}
                onClick={() => toggle(qi, OTHER, !!q.multiSelect)}
              >
                <span className="q-option-label">Другое…</span>
              </button>
            </div>
            {(picked[qi] ?? new Set()).has(OTHER) && (
              <input
                className="q-other"
                type={q.isSecret ? 'password' : 'text'}
                autoFocus
                placeholder="Ваш ответ…"
                value={other[qi] ?? ''}
                onChange={(e) => setOther((p) => ({ ...p, [qi]: e.target.value }))}
              />
            )}
          </div>
        ))}
        </div>
        <div className="modal-actions">
          <button className="btn danger" onClick={() => onDecide(false)}>
            <X size={15} /> Отмена
          </button>
          <button className="btn primary" disabled={!answered} onClick={submit}>
            <Check size={15} /> Ответить
          </button>
        </div>
      </div>
    </div>
  );
}

/** Fallback when an approval tool's payload doesn't match a known shape: a plain
 *  allow/deny that echoes the original input so the agent still gets a decision. */
function GenericApproval({
  req,
  onDecide,
}: {
  req: ToolRequest;
  onDecide: (allow: boolean, updatedInput?: Record<string, unknown>) => void;
}) {
  return (
    <div className="modal-backdrop">
      <div className="modal question-modal">
        <div className="q-header">{req.tool}</div>
        <div className="q-text">{req.title ?? `Разрешить ${req.tool}?`}</div>
        <div className="modal-actions">
          <button className="btn danger" onClick={() => onDecide(false)}>
            <X size={15} /> Запретить
          </button>
          <button className="btn primary" onClick={() => onDecide(true, { ...req.input })}>
            <Check size={15} /> Разрешить
          </button>
        </div>
      </div>
    </div>
  );
}

function PlanModal({
  req,
  onDecide,
}: {
  req: ToolRequest;
  onDecide: (allow: boolean, updatedInput?: Record<string, unknown>, permissionMode?: PermissionMode) => void;
}) {
  const plan = typeof req.input?.plan === 'string' ? (req.input.plan as string) : '';
  return (
    <div className="modal-backdrop">
      <div className="modal question-modal">
        <div className="q-header">План</div>
        <div className="q-plan">{plan ? <Md text={plan} /> : <div className="q-text">Действовать по плану?</div>}</div>
        <div className="q-options q-plan-choices">
          <button className="q-option" onClick={() => onDecide(true, { ...req.input }, 'default')}>
            <span className="q-option-label">Принять, правки подтверждать</span>
            <span className="q-option-desc">Начать, но спрашивать перед изменениями, которым нужно подтверждение.</span>
          </button>
          <button className="q-option" onClick={() => onDecide(true, { ...req.input }, 'acceptEdits')}>
            <span className="q-option-label">Принять, правки без вопросов</span>
            <span className="q-option-desc">Начать и править файлы, не спрашивая.</span>
          </button>
          <button className="q-option q-option-danger" onClick={() => onDecide(false)}>
            <span className="q-option-label">Продолжить планирование</span>
            <span className="q-option-desc">Пока ничего не делать, доработать план.</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function EnterPlanModal({
  req,
  onDecide,
}: {
  req: ToolRequest;
  onDecide: (allow: boolean, updatedInput?: Record<string, unknown>) => void;
}) {
  return (
    <div className="modal-backdrop">
      <div className="modal question-modal">
        <div className="q-header">Режим плана</div>
        <div className="q-text">
          {req.title ?? 'Claude хочет изучить проект и составить план, прежде чем что-то менять.'}
        </div>
        <div className="q-options">
          <button className="q-option" onClick={() => onDecide(true, { ...req.input })}>
            <span className="q-option-label">Перейти в режим плана</span>
            <span className="q-option-desc">Только чтение и планирование.</span>
          </button>
          <button className="q-option q-option-danger" onClick={() => onDecide(false)}>
            <span className="q-option-label">Остаться в текущем режиме</span>
            <span className="q-option-desc">Продолжить без планирования.</span>
          </button>
        </div>
      </div>
    </div>
  );
}

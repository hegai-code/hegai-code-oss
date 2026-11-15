import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  availablePermissionModes,
  bypassAllowed,
  cliAcceptsBypass,
  defaultPermissionMode,
  deniedForProtectedPath,
} from '../src/claude-session.js';
import { codexDefaultPermissionMode } from '../src/codex-run.js';
import { machineDefaultPermissionMode } from '../src/permission-mode.js';
import { autoApproves } from '../src/run-manager.js';

const PROTECTED = ['/srv/acme'];

const denial = (tool: string, input: Record<string, unknown>) =>
  deniedForProtectedPath(tool, input, PROTECTED);

test('an agent with no protected paths is untouched', () => {
  // The whole fleet runs this way; only the sandbox sets the env var.
  for (const [tool, input] of [
    ['Write', { file_path: '/srv/acme/src/db.ts' }],
    ['Bash', { command: 'cd /srv/acme && git push' }],
    ['Bash', { command: 'deploy-prod api' }],
  ] as const) {
    assert.equal(deniedForProtectedPath(tool, input, []), undefined, `${tool} must stay allowed`);
  }
});

test('writes into a protected tree are refused, reads are not', () => {
  assert.match(
    denial('Write', { file_path: '/srv/acme/src/db.ts' }) ?? '',
    /read-only/,
    'writing the platform from the sandbox is the thing being prevented',
  );
  assert.match(denial('Edit', { file_path: '/srv/acme/api/route.ts' }) ?? '', /tz/,
    'the refusal names the route that does work');
  assert.equal(
    denial('Read', { file_path: '/srv/acme/src/db.ts' }),
    undefined,
    'you cannot write a good spec for code you are not allowed to read',
  );
  assert.equal(
    denial('Grep', { pattern: 'pool.connect', path: '/srv/acme' }),
    undefined,
    'searching the platform is how the spec gets written',
  );
});

test('a sibling directory that merely shares a prefix is not protected', () => {
  assert.equal(
    denial('Write', { file_path: '/srv/acme-notes/todo.md' }),
    undefined,
    '/srv/acme-notes is not inside /srv/acme',
  );
  assert.equal(
    denial('Write', { file_path: '/home/devbox/work/accounting/src/App.tsx' }),
    undefined,
    "the employee's own project is exactly what they are here to change",
  );
});

test('shipping commands are refused; looking around is not', () => {
  assert.match(
    denial('Bash', { command: 'git -C /srv/acme push origin main' }) ?? '',
    /read-only/,
    'a push out of the protected tree ships code that was never approved',
  );
  assert.match(
    denial('Bash', { command: 'cd /srv/acme && git commit -m wip' }) ?? '',
    /read-only/,
    'committing in the protected tree is the first half of shipping it',
  );
  assert.match(
    denial('Bash', { command: 'deploy-prod api' }) ?? '',
    /file a spec/,
    'deploying the platform is out of scope wherever it is run from',
  );
  assert.equal(
    denial('Bash', { command: 'git -C /srv/acme log --oneline -20' }),
    undefined,
    'reading history is research, not a change',
  );
  assert.equal(
    denial('Bash', { command: 'grep -rn "pool.connect" /srv/acme' }),
    undefined,
    'mentioning the path is not touching it',
  );
  assert.equal(
    denial('Bash', { command: 'cd ~/work/accounting && git push' }),
    undefined,
    "pushing the employee's own repo is the daily job, not an exception",
  );
});

/* --- кто вправе работать вообще без подтверждений -------------------------
 *
 * `bypassPermissions` — не «подтверждать быстрее», а «колбэк подтверждения не
 * зовут»: проверено против SDK, он и сам предупреждает
 * CLAUDE_SDK_CAN_USE_TOOL_SHADOWED. Значит вместе с режимом исчезает и
 * `sandboxNeedsReview` — выход наружу, `git push`, sudo.
 *
 * Раньше поэтому режим и не отдавался песочнице. С 24.09.2026 отдаётся всем:
 * тот вопрос задавали не нам, а тому же человеку, который сидит в песочнице,
 * то есть он стоил трения, а не безопасности. Настоящая граница — unix-юзер,
 * и запрет на запись в защищённые пути живёт в PreToolUse-хуке, который
 * переживает режим (тесты выше это и проверяют).
 */

test('песочная поза больше не закрывает режим', () => {
  // Явное «да» (`'1'`), а не ответ по умолчанию: настоящий ответ зависит от того,
  // примет ли CLI режим на ЭТОЙ машине (см. cliAcceptsBypass), и тест не должен
  // зависеть от того, от кого его запустили. Утверждение ровно одно — режим
  // отдаётся, и ни `CC_REMOTE_AUTOAPPROVE=sandbox`, ни защищённые пути его не
  // закрывают (у `bypassAllowed` больше нет аргументов про позу коробки).
  assert.deepEqual(availablePermissionModes('1'), [
    'default',
    'plan',
    'acceptEdits',
    'bypassPermissions',
  ]);
});

test('режим не просят там, где CLI его не примет', () => {
  // «--dangerously-skip-permissions cannot be used with root/sudo privileges»,
  // exit 1 — замерено на cloud 24.09.2026. Просить его там значит не убрать
  // подтверждения, а не поднять сессию вообще.
  assert.equal(cliAcceptsBypass({ uid: 1000 }), true, 'не root — правило CLI не про него');
  assert.equal(cliAcceptsBypass({}), true, 'Windows: getuid() нет вовсе');
  assert.equal(cliAcceptsBypass({ uid: 0 }), false, 'root без IS_SANDBOX');
  assert.equal(cliAcceptsBypass({ uid: 0, envFlag: '1' }), true, 'IS_SANDBOX из окружения');
  assert.equal(
    cliAcceptsBypass({ uid: 0, settingsFlag: true }),
    true,
    'IS_SANDBOX из ~/.claude/settings.json',
  );
  // Явное «да» сильнее проверки: оператор может знать то, чего мы не видим.
  assert.equal(bypassAllowed('1'), true);
});

test('выключить можно только явно, и мусор решением не считается', () => {
  assert.equal(bypassAllowed('0'), false, 'an explicit no wins');
  assert.equal(bypassAllowed('false'), false);
  assert.equal(bypassAllowed('1'), true);
  // Мусорное значение не решает ничего — ответ отдаётся проверке машины.
  assert.equal(bypassAllowed('maybe'), cliAcceptsBypass());
});

/* --- чем становится «никто ничего не выбрал» ------------------------------ */

/** Оболочка, из которой запустили тесты, может держать
 *  CC_REMOTE_DEFAULT_PERMISSION_MODE (на dev-box-1 так и есть) — а «undefined»
 *  в аргументе значит «возьми из окружения». Утверждения про пол без выбора
 *  машины делаем при снятой переменной и возвращаем её на место. */
function withoutMachineDefault(body: () => void): void {
  const saved = process.env['CC_REMOTE_DEFAULT_PERMISSION_MODE'];
  delete process.env['CC_REMOTE_DEFAULT_PERMISSION_MODE'];
  try {
    body();
  } finally {
    if (saved === undefined) delete process.env['CC_REMOTE_DEFAULT_PERMISSION_MODE'];
    else process.env['CC_REMOTE_DEFAULT_PERMISSION_MODE'] = saved;
  }
}

test('дефолт рана — режим без подтверждений, но выбор машины сильнее', () => {
  withoutMachineDefault(() => {
    assert.equal(defaultPermissionMode(undefined, true), 'bypassPermissions');
    assert.equal(defaultPermissionMode('plan', true), 'plan', 'CC_REMOTE_DEFAULT_PERMISSION_MODE выигрывает');
    assert.equal(defaultPermissionMode(undefined, false), 'default', 'машина с выключенным bypass не врёт про режим');
    // Сама переменная (не аргумент) читается на каждый вызов и проверяется.
    process.env['CC_REMOTE_DEFAULT_PERMISSION_MODE'] = 'acceptEdits';
    assert.equal(defaultPermissionMode(undefined, true), 'acceptEdits');
    process.env['CC_REMOTE_DEFAULT_PERMISSION_MODE'] = 'nonsense';
    assert.equal(
      defaultPermissionMode(undefined, true),
      'default',
      'опечатка в переменной — не режим, но и не пол bypass: кто-то писал ограничение',
    );
  });
  assert.equal(machineDefaultPermissionMode('nonsense'), 'default');
  assert.equal(machineDefaultPermissionMode('plan'), 'plan');
});

test('у Codex тот же пол, и он не тянет за собой SDK Claude', () => {
  withoutMachineDefault(() => {
    assert.equal(codexDefaultPermissionMode(undefined, undefined), 'bypassPermissions');
    assert.equal(codexDefaultPermissionMode(undefined, '0'), 'default');
    assert.equal(codexDefaultPermissionMode('acceptEdits', undefined), 'acceptEdits');
  });
});

/* --- автоодобрение, которое не отвечает за человека ----------------------- */

test('обычное разрешение одобряется само, вопрос — никогда', () => {
  assert.equal(autoApproves('Bash', true), true);
  assert.equal(autoApproves('Read', true), true);
  assert.equal(
    autoApproves('AskUserQuestion', true),
    false,
    'вопрос модели должен дойти до человека, а не ответить себе сам',
  );
  assert.equal(autoApproves('ExitPlanMode', true), false, 'план принимает человек');
  assert.equal(autoApproves('Bash', false), false, 'CC_REMOTE_AUTO_APPROVE=0 возвращает ожидание');
});

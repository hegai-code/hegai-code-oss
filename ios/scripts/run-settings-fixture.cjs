// Local runtime stand for RunSettingsUITests; never contacts a real agent.
const { WebSocketServer } = require('ws');
const now = Date.now();
const models = [
  { id: 'default', name: 'По умолчанию', resolved: 'gpt-6-astra' },
  { id: 'gpt-6-astra', name: '6 Astra', resolved: 'gpt-6-astra', efforts: ['low', 'medium', 'high', 'xhigh'], supportsEffort: true },
  { id: 'gpt-6-sol', name: '6 Sol', resolved: 'gpt-6-sol', efforts: ['low', 'medium', 'high'], supportsEffort: true },
];
const sessionIds = process.env.CC_DRAWER_CHROME_FIXTURE === '1'
  ? Array.from({ length: 40 }, (_, i) => `s${i}`)
  : process.env.CC_HISTORY_FIXTURE === '1' ? ['s0', 's1', 's2'] : ['s0', 's1'];
const sessions = sessionIds.map((id, i) => ({
  sessionId: id, title: process.env.CC_TITLE_FIXTURE === '1'
    ? (i ? 'Оптимизация производительности приложения' : 'Пересборка iPhone-приложения: фаза 0 подготовки')
    : process.env.CC_DRAWER_CHROME_FIXTURE === '1' ? `Сессия ${i + 1}: проверка меню` : 'Настройки мобильного чата', cwd: process.env.CC_DRAWER_CHROME_FIXTURE === '1' ? `/projects/group-${Math.floor(i / 4)}` : '/projects/demo',
  project: process.env.CC_DRAWER_CHROME_FIXTURE === '1' ? `Проект ${String(Math.floor(i / 4) + 1).padStart(2, '0')}` : 'Demo',
  lastModified: now - i, ...(i ? { source: 'codex' } : {}),
}));
if (process.env.CC_SEMANTIC_FIXTURE === '1') {
  sessions[0].title = 'А глянь айос моб приложение код. Как он тебе?';
  sessions[1].title = 'Модалка уходит вверх при открытии клавиатуры';
}
const snapshot = { type: 'snapshot', machines: [{
  machine: { machineId: 'm', name: 'Fixture Mac', os: 'mac', agentVersion: '1' },
  canControl: true, canStart: true, online: true, lastSeen: now, sessions,
}], activeRuns: sessions.map(s => ({ runId: `r-${s.sessionId}`, machineId: 'm',
  sessionId: s.sessionId, state: 'idle', since: now })) };
if (process.env.CC_PROJECT_CARDS_FIXTURE === '1') {
  sessions.splice(0, sessions.length, ...Array.from({ length: 1000 }, (_, i) => ({
    sessionId: `s${i}`, title: `Обсуждение задачи ${i}`, project: 'Demo', cwd: '/projects/demo',
    lastModified: now - i * 1000, source: i % 2 ? 'codex' : 'claude',
  })));
  sessions.push({ sessionId: 'copy', title: 'Другая копия проекта', project: 'Demo', cwd: '/other/demo', lastModified: now - 500 });
  for (let i = 0; i < 8; i++) sessions.push({ sessionId: `extra-${i}`, title: `Работа над проектом ${i}`,
    project: `Проект ${i}`, cwd: `/projects/extra-${i}`, lastModified: now - 2000000 - i });
  snapshot.machines.push({ machine: { machineId: 'server', name: 'Production', os: 'linux', agentVersion: '1' },
    canControl: true, canStart: true, online: true, lastSeen: now,
    sessions: [{ sessionId: 'remote', title: 'Проверка сервера', project: 'Demo', cwd: '/projects/demo', lastModified: now - 600 }] });
  snapshot.activeRuns = [{ runId: 'r-s0', machineId: 'm', sessionId: 's0', state: 'working', since: now }];
}
if (process.env.CC_PERMISSION_FIXTURE === '1') {
  snapshot.machines[0].machine.permissionModes = ['default', 'plan'];
  snapshot.machines[0].machine.codexPermissionModes = ['default', 'plan', 'acceptEdits', 'bypassPermissions'];
}
if (process.env.CC_OWNERSHIP_FIXTURE === '1') {
  snapshot.viewer = { userId: 'me', email: 'me@example.test', platformAdmin: false,
    workspace: { workspaceId: 'personal', name: 'Моя работа', kind: 'personal', role: 'owner' }, workspaces: [] };
  snapshot.machines[0].owner = { userId: 'me' };
  snapshot.machines[0].shared = true;
  sessions[0].owner = { userId: 'me' };
  sessions[1].owner = { userId: 'colleague' };
  sessions[1].project = 'circle';
  sessions[1].title = 'Разверни';
  snapshot.activeRuns[0].ownerUserId = 'me';
  snapshot.activeRuns[1].ownerUserId = 'colleague';
  snapshot.activeRuns.push(
    { runId: 'r-new-mine', machineId: 'm', sessionId: 'new-mine', ownerUserId: 'me',
      project: 'Моя новая работа', title: 'Моя новая сессия', state: 'working', since: now },
    { runId: 'r-new-team', machineId: 'm', sessionId: 'new-team', ownerUserId: 'colleague',
      project: 'Чужая новая работа', title: 'Чужая новая сессия', state: 'working', since: now });
}
if (process.env.CC_LIMITS_FIXTURE === '1') {
  snapshot.machines[0].usage = { account: 'claude@example.test', subscription: 'Max', updatedAt: now,
    fiveHour: { utilization: 32, resetsAt: now + 3600000 }, sevenDay: { utilization: 81, resetsAt: now + 86400000 } };
  snapshot.machines[0].codexUsage = { account: 'codex@example.test', subscription: 'Pro', updatedAt: now,
    limits: [{ key: 'session', label: 'Session (5hr)', percent: 45, resetsAt: now + 7200000 }] };
}
if (process.env.CC_HEADER_WIDTH_FIXTURE === '1') {
  snapshot.machines[0].machine.name = 'dev-mac-mini-001';
  for (const session of sessions) { session.project = 'claudehegai'; session.title = 'Оптимизация интерфейса мобильного приложения'; }
}
if (process.env.CC_SETTINGS_TABS_FIXTURE === '1') {
  snapshot.machines[0].profile = { ...require('./settings-profile-fixture.json'), generatedAt: now };
  snapshot.machines[0].stats = { ts: now, platform: 'macOS', cpuCount: 10, load1: 1.2,
    cpuPercent: 24, memTotal: 17179869184, memUsed: 8589934592, swapTotal: 0, swapUsed: 0,
    diskTotal: 1000000000000, diskUsed: 480000000000, uptimeSec: 270000,
    agentRss: 160000000, agentCpuPercent: 1.2 };
}
const inputs = [];
if (process.env.CC_MODEL_DORMANT_FIXTURE === '1') snapshot.activeRuns = [];
if (process.env.CC_ACTIVE_START_FIXTURE === '1') {
  snapshot.viewer = { userId: 'me', email: 'me@example.test', platformAdmin: false,
    workspace: { workspaceId: 'personal', name: 'Моя работа', kind: 'personal', role: 'owner' }, workspaces: [] };
  snapshot.machines[0].owner = { userId: 'me' };
  snapshot.machines[0].shared = true;
  sessions.splice(0, sessions.length, ...[
    ['s0', 'Настройка мобильного приложения', 'claude', 'working', 'me'],
    ['s1', 'Проверка новой версии сайта', 'codex', 'working', 'me'],
    ['idle', 'Завершённый разговор', 'claude', 'idle', 'me'],
    ['waiting', 'Ждёт подтверждения', 'codex', 'needs_attention', 'me'],
    ['team', 'Чужая работа', 'codex', 'working', 'colleague'],
  ].map(([sessionId, title, source, state, owner], i) => ({
    sessionId, title, source, cwd: '/projects/demo', project: 'Demo',
    owner: { userId: owner }, lastModified: now - i,
  })));
  snapshot.activeRuns = sessions.map((session, i) => ({
    runId: `r-${session.sessionId}`, machineId: 'm', sessionId: session.sessionId,
    state: ['working', 'working', 'idle', 'needs_attention', 'working'][i],
    ownerUserId: session.owner.userId, since: now - i,
  }));
}
if (process.env.CC_HOME_POLISH_FIXTURE === '1') {
  snapshot.activeRuns.forEach(run => {
    run.taskStartedAt = now - 83000;
    if (run.state === 'idle') run.preview = 'Обновлены экраны приложения, проверки пройдены.';
    if (run.state === 'needs_attention') { run.pendingKind = 'question'; run.pendingTool = 'ExitPlanMode'; }
  });
}
if (process.env.CC_HOME_TARGETS_FIXTURE === '1') {
  snapshot.machines[0].machine.name = 'stage';
  for (const [id, name] of [['other', 'Mac mini'], ['empty', 'Новый сервер'], ['offline', 'Offline']]) {
    snapshot.machines.push({ machine: { machineId: id, name, os: 'linux', agentVersion: '1' },
      canStart: true, canControl: true, online: id !== 'offline', lastSeen: now,
      sessions: id === 'other' ? [{ sessionId: 'other-demo', title: 'Работа на другом сервере',
        cwd: '/other/demo', project: 'Demo', lastModified: now - 10000 }] : [] });
  }
}
const imageMessages = [{ type: 'user', uuid: 'photo', blocks: [
  { kind: 'text', text: 'Проверь изображение в этой сессии.' },
  { kind: 'image', ref: 'photo#1' }, { kind: 'image' },
] }];
const galleryFixture = process.env.CC_IMAGE_LAYOUT_FIXTURE === '1';
const galleryImages = galleryFixture ? [1, 2].map(i => require('fs').readFileSync(
  require('path').join(__dirname, 'fixtures', `transcript-screen-${i}.png`)).toString('base64')) : [];
const galleryText = 'Сравни эти два экрана. Хочется компактнее показать проекты и оставить больше места для переписки.';
function imageHistory(sessionId) {
  if (!galleryFixture) return imageMessages;
  const count = sessionId === 's1' ? 1 : sessionId === 'mirror' ? 4 : 2;
  return [{ type: 'user', uuid: 'photo', ts: now, blocks: [
    ...(sessionId === 's1' ? [] : [{ kind: 'text', text: galleryText }]),
    ...Array.from({ length: count }, (_, i) => ({ kind: 'image', ref: `photo#${i + 1}` })),
  ] }];
}
if (process.env.CC_IMAGE_FIXTURE === '1') {
  sessions.push({ sessionId: 'mirror', title: 'Изображение в зеркале', cwd: '/projects/demo',
    project: 'Demo', livePid: 12345, lastModified: now - 10 });
}
const imageData = 'iVBORw0KGgoAAAANSUhEUgAAALQAAAB4CAIAAADUhU+qAAABlElEQVR4nO3SQRGDAADEQKTUBYawUJtVgBh+SOjlsTNxkD3u69Tb5/vT2zH/kWr+IxUccMABBxxwwAEHHHDA0Wn+IxUccMABBxxwwAEHHHDA0Wn+IxUccMABBxxwwAEHHHDA0Wn+IxUccMABBxxwwAEHHHDA0Wn+IxUccMABBxxwwAEHHHDA0Wn+IxUccMABBxxwwAEHHHDA0Wn+IxUccMABBxxwwAEHHHDA0Wn+IxUccMABBxxwwAEHHHDA0Wn+IxUccMABBxxwwAEHHHDA0Wn+IxUccMABBxxwwAEHHHDA0Wn+IxUccMABBxxwwAEHHHDA0Wn+IxUccMABBxxwwAEHHHDA0Wn+IxUccMABBxxwwAEHHHDA0Wn+IxUccMABBxxwwAEHHHDA0Wn+IxUccMABBxxwwAEHHHDA0Wn+IxUccMABBxxwwAEHHHDA0Wn+IxUccMABBxxwwAEHHHDA0Wn+IxUccMABBxxwwAEHHHDA0Wn+IxUccMABBxxwwAEHHHDA0Wn+IxUccMABBxxwwAEHHHDA0Wn+IxUccMABBxxwwAEHHHDA0Wn+IxUccMABBxxwwAEHHHDA0Wn+IxUccMABBxxwwAHHP3oACppT6TGjl9sAAAAASUVORK5CYII=';
const approvalClients = new Set();
let approvalSequence = 0;
const http = require('http').createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (process.env.CC_HOME_POLISH_FIXTURE === '1' && req.url === '/test/home/complete') {
    for (const socket of approvalClients) {
      if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'activity', runs: snapshot.activeRuns.map(run =>
        run.sessionId === 's0' ? { ...run, state: 'idle', since: Date.now(), preview: 'Новый интерфейс готов, проверки пройдены.' } : run) }));
    }
    res.end('{}'); return;
  }
  if (process.env.CC_HOME_POLISH_FIXTURE === '1' && req.url === '/test/home/empty') {
    for (const socket of approvalClients) {
      if (socket.readyState === 1) socket.send(JSON.stringify({ ...snapshot, activeRuns: [], machines: [] }));
    }
    res.end('{}'); return;
  }
  if (process.env.CC_ACTIVE_START_FIXTURE === '1' && req.url === '/test/active/many') {
    const many = Array.from({ length: 12 }, (_, i) => ({ ...sessions[i % 2], sessionId: `many-${i}`,
      title: `Работа над задачей ${i + 1}`, lastModified: now - i }));
    const activeRuns = many.map(session => ({ ...snapshot.activeRuns[0], runId: `r-${session.sessionId}`,
      sessionId: session.sessionId }));
    for (const socket of approvalClients) {
      if (socket.readyState === 1) socket.send(JSON.stringify({ ...snapshot, activeRuns,
        machines: [{ ...snapshot.machines[0], sessions: many }] }));
    }
    res.end('{}'); return;
  }
  if (process.env.CC_ACTIVE_START_FIXTURE === '1' && req.url === '/test/active/idle') {
    for (const socket of approvalClients) {
      if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'activity',
        runs: snapshot.activeRuns.map(run => ({ ...run, state: 'idle' })) }));
    }
    res.end('{}'); return;
  }
  if (process.env.CC_APPROVAL_FIXTURE === '1' && req.url.startsWith('/test/approval/')) {
    const action = req.url.slice('/test/approval/'.length);
    for (const socket of approvalClients) {
      if (socket.readyState !== 1) continue;
      const send = value => socket.send(JSON.stringify(value));
      if (action === 'clear') send({ type: 'activity', runs: [] });
      else {
        send({ type: 'activity', runs: snapshot.activeRuns });
        send({ type: 'tool_request', runId: 'r-s0', sessionId: 's0',
          requestId: `approval-${++approvalSequence}`, tool: action === 'question' ? 'AskUserQuestion' : 'Bash',
          input: action === 'question' ? { questions: [{ question: 'Продолжить проверку?', options: [{ label: 'Продолжить', description: 'Проверить закрытие окна' }] }] }
            : { command: 'git status' }, title: 'Проверка закрытия подтверждения' });
      }
    }
    res.end('{}'); return;
  }
  if (req.url === '/test/inputs') { res.end(JSON.stringify(inputs)); return; }
  if (process.env.CC_LIMITS_FIXTURE !== '1') { res.statusCode = 404; res.end('{}'); return; }
  res.end(JSON.stringify(req.url === '/api/budget'
    ? { plan: 'community', limits: { tokens: 1000000, tokensUsed: 250000, tokensWindow: '1d', resetAt: now + 86400000 } }
    : { gatewayQuota: { ok: true, plan: 'Team', primary_used_percent: 61, primary_window_minutes: 300,
      primary_reset_at: (now + 3600000) / 1000, updated_at: now / 1000 } }));
});
http.listen(Number(process.env.CC_FIXTURE_PORT || 18768), '127.0.0.1');
const server = new WebSocketServer({ server: http });
server.on('connection', socket => {
  approvalClients.add(socket);
  socket.on('close', () => approvalClients.delete(socket));
  const settings = new Map();
  const activity = snapshot.activeRuns.map(run => ({ ...run,
    state: process.env.CC_ACTIVITY_FIXTURE === '1' || process.env.CC_PROGRESS_FIXTURE === '1' ? 'working' : run.state,
    since: process.env.CC_PROGRESS_FIXTURE === '1' ? Date.now() - 83000 : run.since }));
  const send = value => socket.send(JSON.stringify(value));
  const publish = runId => {
    const value = settings.get(runId) ?? { model: 'gpt-6-astra', effort: 'medium', ultracode: false };
    settings.set(runId, value);
    send({ type: 'run_settings', runId, sessionId: runId.slice(2),
      activeModel: value.model || 'gpt-6-astra', ...value });
  };
  send({ ...snapshot, activeRuns: activity });
  socket.on('message', raw => {
    const message = JSON.parse(raw);
    if (process.env.CC_IMAGE_FIXTURE === '1' && message.type === 'mirror_open') {
      send({ type: 'mirror_opened', mirrorId: message.mirrorId, machineId: message.machineId });
      setTimeout(() => {
        if (socket.readyState === 1) send({ type: 'mirror_data', mirrorId: message.mirrorId, replace: true, messages: imageHistory(message.sessionId) });
      }, 100);
      return;
    }
    if (message.type === 'memory_list' && process.env.CC_SETTINGS_TABS_FIXTURE === '1') {
      send({ type: 'memory_list_result', requestId: message.requestId, ok: true,
        memories: ['MEMORY.md', 'ios-layout.md'].map((path, index) => ({ scope: 'project', scopeKey: '/projects/demo',
          path, sha256: 'fixture', revision: 2, updatedAt: now, bytes: index ? 1200 : 3600 })) });
    } else if (message.type === 'memory_read' && process.env.CC_SETTINGS_TABS_FIXTURE === '1') {
      send({ type: 'memory_read_result', requestId: message.requestId, ok: true, content: '# Память проекта\n\nПроверка настроек приложения.' });
    } else if (message.type === 'new_session' && process.env.CC_NEW_RUN_FIXTURE === '1') {
      inputs.push({ action: 'new_session', ...message });
      const runId = 'r-created';
      send({ type: 'opened', runId, machineId: message.machineId, sessionId: '' });
      publish(runId);
      setTimeout(() => {
        if (socket.readyState !== 1) return;
        const targetSessions = snapshot.machines.find(m => m.machine.machineId === message.machineId).sessions;
        const previous = targetSessions.findIndex(session => session.sessionId === 'created');
        if (previous !== -1) targetSessions.splice(previous, 1);
        targetSessions.push({ sessionId: 'created', title: message.message, source: message.source, project: 'Demo', cwd: message.cwd, lastModified: Date.now() });
        activity.push({ runId, machineId: message.machineId, sessionId: 'created', title: message.message, project: 'Demo', state: 'working', since: Date.now() });
        send({ type: 'session_started', runId, sessionId: 'created' });
        send({ ...snapshot, activeRuns: activity });
      }, 10000);
    } else if (message.type === 'open' && process.env.CC_MODEL_DORMANT_FIXTURE === '1') {
      inputs.push({ action: 'open', ...message });
      const runId = 'r-' + message.sessionId;
      activity.push({ runId, machineId: 'm', sessionId: message.sessionId, state: 'idle', since: Date.now() });
      send({ type: 'opened', runId, machineId: message.machineId, sessionId: message.sessionId });
      setTimeout(() => { if (socket.readyState === 1) publish(runId); }, 2500);
    } else if (message.type === 'subscribe') {
      publish(message.runId);
      if (process.env.CC_ACTIVITY_FIXTURE === '1') {
        send({ type: 'run_status', runId: message.runId, sessionId: message.runId.slice(2), state: 'started' });
      }
      if (process.env.CC_FORMAT_FIXTURE === '1') {
        const text = '## Проверка форматирования\n\nПервый абзац: **важная мысль**, обычный текст и `код`.\n\nВторой абзац отделён воздухом. Его удобно читать на телефоне.\n\n- Первый пункт списка\n- Второй пункт списка\n\nПоследний абзац ответа.';
        send({ type: 'stream', runId: message.runId, sessionId: message.runId.slice(2),
          event: { kind: message.runId === 'r-s0' ? 'partial' : 'assistant', text } });
      }
      if (process.env.CC_CHROME_FIXTURE === '1') {
        for (let i = 1; i <= 24; i++) {
          send({ type: 'stream', runId: message.runId, sessionId: message.runId.slice(2),
            event: { kind: i % 2 ? 'user' : 'assistant',
              text: `Сообщение ${i}. Проверяем прозрачную область за островами. Текст продолжается под верхней панелью и вокруг поля ввода при прокрутке.` } });
        }
      }
      if (process.env.CC_PROGRESS_FIXTURE === '1') {
        send({ type: 'stream', runId: message.runId, sessionId: message.runId.slice(2),
          event: { kind: 'status', code: 'turn_usage', data: { totalTokens: 48240 } } });
        const text = 'Проверяю текущую задачу и изменения в проекте.';
        for (const kind of ['partial', 'assistant']) {
          send({ type: 'stream', runId: message.runId, sessionId: message.runId.slice(2), event: { kind, text } });
        }
        // The last step of the turn names the working line («Читаю файл»).
        send({ type: 'stream', runId: message.runId, sessionId: message.runId.slice(2),
          event: { kind: 'tool_use', text: 'Read {"file_path":"README.md"}' } });
      }
      if (process.env.CC_CONTEXT_FIXTURE === '1') {
        send({ type: 'context_usage', runId: message.runId, sessionId: message.runId.slice(2),
          totalTokens: 100000, maxTokens: 200000, percentage: 50,
          autoCompactThreshold: 0.95, autoCompactEnabled: true });
      }
      if (process.env.CC_TOOL_FIXTURE === '1') {
        const event = (kind, text) => send({ type: 'stream', runId: message.runId,
          sessionId: message.runId.slice(2), event: { kind, text } });
        event('assistant', 'Проверяю проект.');
        const calls = process.env.CC_TOOL_SINGLE_CALLS === '1'
          ? ['Read', 'Bash', 'Edit', 'AskUserQuestion', 'PowerShell', 'Bash', 'Skill', 'Bash']
          : Array.from({ length: 12 }, (_, i) => i % 2 ? 'Bash' : 'Read');
        calls.forEach((name, i) => {
          event('tool_use', `${name} ${JSON.stringify({ file_path: 'd:\\Hegai_VScode\\higgsfield\\CLAUDE.md',
            command: 'git status', description: `Проверка проекта ${i + 1}` })}`);
          event('assistant', '   \n\n');
          event('status', '→ completed');
          event('status', '0    0\n→ completed');
          if (i === 2) event('assistant', 'Проверяю следующий файл.');
        });
        event('assistant', 'Проверка завершена.');
      }
      send({ type: 'run_mode' , runId: message.runId, sessionId: message.runId.slice(2), mode: 'default' });
    } else if (message.type === 'compact' && process.env.CC_CONTEXT_FIXTURE === '1') {
      send({ type: 'stream', runId: message.runId, sessionId: message.runId.slice(2),
        event: { kind: 'status', code: 'compact_started', text: 'compacting context…' } });
      setTimeout(() => {
        if (socket.readyState !== 1) return;
        send({ type: 'context_usage', runId: message.runId, sessionId: message.runId.slice(2),
          totalTokens: 20000, maxTokens: 200000, percentage: 10,
          autoCompactThreshold: 0.95, autoCompactEnabled: true });
        send({ type: 'stream', runId: message.runId, sessionId: message.runId.slice(2),
          event: { kind: 'status', code: 'compact_done', text: 'context compacted' } });
      }, 2500);
    } else if (message.type === 'tool_decision' && process.env.CC_APPROVAL_FIXTURE === '1') {
      inputs.push({ action: 'tool_decision', ...message });
    } else if (message.type === 'input') {
      inputs.push({ runId: message.runId, text: message.text,
        images: JSON.stringify(message.images ?? []) });
    } else if (message.type === 'close' && process.env.CC_MENU_FIXTURE === '1') {
      const index = activity.findIndex(run => run.runId === message.runId);
      if (index >= 0) activity.splice(index, 1);
      inputs.push({ action: 'close', runId: message.runId });
      send({ type: 'activity', runs: activity });
    } else if (message.type === 'interrupt') {
      const run = activity.find(run => run.runId === message.runId);
      if (run) run.state = 'idle';
      send({ type: 'activity', runs: activity });
    } else if (message.type === 'set_model' || message.type === 'set_effort') {
      inputs.push({ action: message.type, ...message });
      const current = settings.get(message.runId);
      if (!current) return;
      const before = JSON.stringify(current);
      if (message.type === 'set_model') current.model = message.model;
      else { current.effort = message.effort; current.ultracode = message.ultracode ?? false; }
      if (JSON.stringify(current) === before) return; // Runtime emits changes only.
      publish(message.runId);
    } else if (message.type === 'set_permission_mode') {
      send({ type: 'run_mode', runId: message.runId, sessionId: message.runId.slice(2), mode: message.mode });
    } else if (message.type === 'enrich_request') {
      if (process.env.CC_SEMANTIC_FIXTURE === '1' && message.purpose === 'session_title') {
        inputs.push({ action: 'title', sessionId: message.sessionId, text: message.text });
        send({ type: 'enrich_result', requestId: message.requestId, ok: true,
          enrichment: { sessionTitle: message.sessionId === 's0' ? 'Доработка iOS-приложения' : 'Модалка и клавиатура' } });
      } else send({ type: 'enrich_result', requestId: message.requestId, ok: true, enrichment: {} });
    } else if (message.type === 'rpc_request') {
      if (process.env.CC_IMAGE_FIXTURE === '1' && message.method === 'session.messages') {
        send({ type: 'rpc_response', requestId: message.requestId, ok: true, result: { messages: imageHistory(message.params.sessionId) } }); return;
      }
      if (process.env.CC_IMAGE_FIXTURE === '1' && message.method === 'session.image') {
        inputs.push({ action: 'image', machineId: message.machineId, ...message.params });
        send({ type: 'rpc_response', requestId: message.requestId, ok: true,
          result: { mediaType: 'image/png', dataB64: galleryFixture ? galleryImages[(Number(message.params.ref.split('#')[1]) - 1) % 2] : imageData } }); return;
      }
      if (process.env.CC_HOME_TARGETS_FIXTURE === '1' && message.method === 'projects.list' && message.machineId !== 'm') {
        send({ type: 'rpc_response', requestId: message.requestId, ok: true, result: { projects: [] } }); return;
      }
      if (process.env.CC_SEMANTIC_FIXTURE === '1' && message.method === 'session.messages') {
        const session = sessions.find(s => s.sessionId === message.params.sessionId);
        const messages = [
          { type: 'user', uuid: 'semantic-u', blocks: [{ kind: 'text', text: session.title }] },
          { type: 'assistant', uuid: 'semantic-a', blocks: [{ kind: 'text', text: 'Проверю интерфейс и скорость приложения.' }] }
        ];
        send({ type: 'rpc_response', requestId: message.requestId, ok: true, result: { messages } }); return;
      }
      if (process.env.CC_MENU_FIXTURE === '1' && message.method === 'session.rename') {
        const session = sessions.find(s => s.sessionId === message.params.sessionId);
        if (session) session.title = message.params.title;
        inputs.push({ action: 'rename', ...message.params });
        send({ type: 'rpc_response', requestId: message.requestId, ok: true, result: { ok: true } });
        send({ ...snapshot, activeRuns: activity });
        return;
      }
      if (process.env.CC_MENU_FIXTURE === '1' && message.method === 'session.messages') {
        const messages = [
          { type: 'user', uuid: 'menu-u', blocks: [{ kind: 'text', text: 'Найди уникальную строку про скругление' }] },
          { type: 'assistant', uuid: 'menu-a', blocks: [{ kind: 'text', text: '## Скругление экрана\n\nПроверили компактные строки и фон.' }] }
        ];
        send({ type: 'rpc_response', requestId: message.requestId, ok: true, result: { messages } });
        return;
      }
      if (process.env.CC_HISTORY_FIXTURE === '1' && message.method === 'session.messages') {
        const short = message.params.sessionId === 's2';
        const count = short ? 65 : 1000;
        const messages = Array.from({ length: count }, (_, i) => ({
          type: i % 2 ? 'assistant' : 'user', uuid: `history-${message.params.sessionId}-${i}`,
          blocks: [{ kind: 'text', text: i === count - 1 ? `КОНЕЦ ИСТОРИИ ${message.params.sessionId}`
            : short ? `Строка истории ${i}`
            : `Сообщение ${i}.\n\n` + (i % 2
              ? ('## Проверка\n\nТекст ответа с **разной высотой** и списком.\n\n- Первый пункт\n- Второй пункт\n\n').repeat(1 + i % 11)
              : 'Проверь историю сообщений. '.repeat(1 + i % 7)) }],
        }));
        setTimeout(() => {
          if (socket.readyState === 1) send({ type: 'rpc_response', requestId: message.requestId, ok: true, result: { messages } });
        }, 600);
        return;
      }
      const result = message.method === 'models.list' ? { models }
        : message.method === 'projects.list' ? { projects: process.env.CC_START_FIXTURE === '1'
          ? [{ cwd: '/projects/website', label: 'Website', count: 0, origin: 'root', lastModified: now - 1000 }] : [] } : { messages: [] };
      send({ type: 'rpc_response', requestId: message.requestId, ok: true, result });
    }
  });
});
console.log('Run settings fixture: ws://127.0.0.1:18768/ui');

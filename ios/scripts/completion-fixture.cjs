// Local synthetic hub for CompletionIndicatorUITests; no real sessions or credentials.
const http = require('http');
const { WebSocketServer } = require('ws');
const now = Date.now();
const viewer = { userId: 'completion-reader', email: 'reader@example.test', platformAdmin: false,
  workspace: { workspaceId: 'personal', name: 'Моя работа', kind: 'personal', role: 'owner' }, workspaces: [] };
const sessions = [
  ['s0', 'Проверка готового ответа', 'working'],
  ['s1', 'Исправление интерфейса', 'working'],
  ['s2', 'Настройка сервера', 'working'],
  ['waiting', 'План новой страницы', 'needs_attention'],
  ['s3', 'Проверка тестов', 'working'],
  ['old', 'Прочитанный разговор', 'idle'],
  ['team', 'Чужая работа', 'working'],
].map(([sessionId, title, state], i) => ({ sessionId, title, state,
  source: i % 2 ? 'codex' : 'claude', cwd: '/projects/mobile', project: 'Мобильное приложение',
  owner: { userId: sessionId === 'team' ? 'colleague' : viewer.userId }, lastModified: now - i }));
const runs = sessions.map(s => ({ runId: `r-${s.sessionId}`, machineId: 'm', machineName: 'Mac',
  sessionId: s.sessionId, title: s.title, project: s.project, state: s.state, since: now,
  ownerUserId: s.owner.userId, ...(s.state === 'needs_attention' ? { pendingKind: 'question', pendingRequestId: 'initial-question' } : {}) }));
const snapshot = () => ({ type: 'snapshot', viewer, machines: [{
  machine: { machineId: 'm', name: 'Mac', os: 'mac', agentVersion: '1' },
  canStart: true, canControl: true, online: true, shared: true, owner: { userId: viewer.userId },
  lastSeen: now, sessions: sessions.map(({ state, ...s }) => s),
}], activeRuns: runs });
const clients = new Set();
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url.startsWith('/test/')) {
    const action = req.url.slice('/test/'.length);
    if (!['work', 'finish', 'decision', 'resolve', 'replay'].includes(action)) { res.statusCode = 404; res.end('{}'); return; }
    for (const r of runs) {
      if (action === 'decision' || action === 'resolve' || action === 'replay') {
        if (r.sessionId !== 'waiting') continue;
        r.state = action === 'resolve' ? 'working' : 'needs_attention';
        if (action === 'decision') r.pendingRequestId = `request-${Date.now()}`;
      } else {
        if (r.sessionId !== 's0' && r.sessionId !== 'team') continue;
        r.state = action === 'work' ? 'working' : 'idle';
      }
      r.since = Date.now();
    }
    for (const ws of clients) if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'activity', runs }));
    res.end('{}'); return;
  }
  res.statusCode = 404; res.end('{}');
});
new WebSocketServer({ server }).on('connection', ws => {
  clients.add(ws); ws.on('close', () => clients.delete(ws));
  const send = value => ws.send(JSON.stringify(value));
  send(snapshot());
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.type === 'ping') send({ type: 'pong', ts: m.ts });
    else if (m.type === 'subscribe') {
      send({ type: 'run_settings', runId: m.runId, sessionId: m.runId.slice(2), model: 'default', effort: 'high' });
    } else if (m.type === 'enrich_request') send({ type: 'enrich_result', requestId: m.requestId, ok: true, enrichment: {} });
    else if (m.type === 'rpc_request') {
      const result = m.method === 'session.messages' ? { messages: [
        { type: 'user', uuid: 'u', blocks: [{ kind: 'text', text: 'Проверь изменения в приложении.' }] },
        { type: 'assistant', uuid: 'a', blocks: [{ kind: 'text', text: 'Готово. Проверил изменения и тесты.' }] },
      ] } : {};
      send({ type: 'rpc_response', requestId: m.requestId, ok: true, result });
    }
  });
});
server.listen(Number(process.env.CC_FIXTURE_PORT || 18784), '127.0.0.1', () => console.log('Completion fixture: ws://127.0.0.1:18784/ui'));

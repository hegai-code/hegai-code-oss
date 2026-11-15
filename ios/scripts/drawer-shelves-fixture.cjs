// Synthetic read-only inventory for DrawerShelvesUITests and shoot.sh.
const http = require('http');
const { WebSocketServer } = require('ws');
const port = Number(process.env.CC_FIXTURE_PORT || 18791);
const now = Date.now(), day = 86400000;
const viewer = { userId: 'drawer-reader', email: 'drawer@example.test', platformAdmin: false,
  workspace: { workspaceId: 'personal', name: 'Личное', kind: 'personal', role: 'owner' }, workspaces: [] };
const session = (sessionId, project, cwd, age, extra = {}) => ({ sessionId, title: `${project}: задача ${sessionId}`,
  project, cwd, lastModified: now - age * day, owner: { userId: viewer.userId }, ...extra });
const sessions = [
  session('waiting', 'Пульт', '/projects/remote', 10),
  session('work', 'Сайт', '/projects/site', 5),
  ...Array.from({ length: 1000 }, (_, i) => session(`s${i}`, 'Приложение', '/projects/mobile', 0.01 + i / 10000)),
  session('old', 'Архив', '/projects/archive', 30, { livePid: 42 }),
  session('root', 'root', '/root', 0), session('slash', '', '/', 0),
  session('cron', 'Служебный', '/projects/cron', 0, { entrypoint: 'sdk-cli' }),
  session('tmp', 'tmp', '/tmp', 0),
  session('tree', 'Worktree', '/projects/app/.claude/worktrees/test', 0),
];
const run = (id, state) => ({ runId: `r-${id}`, machineId: 'm', sessionId: id, state, since: now,
  title: sessions.find(s => s.sessionId === id)?.title, project: sessions.find(s => s.sessionId === id)?.project,
  ownerUserId: viewer.userId });
let runs;
const reset = () => { runs = [run('waiting', 'needs_attention'), run('work', 'working'), run('cron', 'working'), run('tmp', 'working')]; };
reset();
const machine = { machine: { machineId: 'm', name: 'Remote', os: 'linux', agentVersion: 'fixture' },
  online: true, canControl: true, canStart: true, lastSeen: now, owner: { userId: viewer.userId }, sessions };
const snapshot = () => ({ type: 'snapshot', viewer, machines: [machine], activeRuns: runs });
const send = (ws, message) => { if (ws.readyState === 1) ws.send(JSON.stringify(message)); };
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/test/reset') reset();
  else if (req.url === '/test/work-old' || req.url === '/test/complete') {
    runs = runs.filter(r => r.sessionId !== 'old');
    runs.push({ ...run('old', req.url === '/test/complete' ? 'idle' : 'working'), since: Date.now() });
  } else if (req.url === '/test/attention') runs.push({ ...run('s0', 'needs_attention'), since: Date.now() });
  else if (req.url !== '/test/state') res.statusCode = 404;
  if (res.statusCode !== 404) for (const ws of wss.clients) send(ws, { type: 'activity', runs });
  res.end(JSON.stringify({ runs: runs.length }));
});
const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
  send(ws, snapshot());
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.type === 'ping') send(ws, { type: 'pong', ts: m.ts });
    if (m.type === 'enrich_request') send(ws, { type: 'enrich_result', requestId: m.requestId, ok: true, enrichment: {} });
    if (m.type !== 'rpc_request') return;
    const result = m.method === 'projects.list' ? { projects: [] }
      : m.method === 'models.list' ? { models: [] }
      : m.method === 'session.messages' ? { messages: [
        { type: 'user', uuid: 'u', blocks: [{ kind: 'text', text: 'Проверь проект.' }] },
        { type: 'assistant', uuid: 'a', blocks: [{ kind: 'text', text: 'Проверка завершена.' }] },
      ] } : {};
    send(ws, { type: 'rpc_response', requestId: m.requestId, ok: true, result });
  });
});
server.listen(port, '127.0.0.1', () => console.log(`Drawer shelves fixture: ws://127.0.0.1:${port}/ui`));

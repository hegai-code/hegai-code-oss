// A long working session, shaped like a real one: many turns, tool runs, long
// prose. Proves «Показать более ранние» on a phone. Local and synthetic: no real
// agent, hub, account or transcript is touched.
const http = require('http');
const { WebSocketServer } = require('ws');
const port = Number(process.env.CC_FIXTURE_PORT || 18793);
const TURNS = Number(process.env.CC_FIXTURE_TURNS || 60);
const now = Date.now();
const prose = (t, n) => `Ход ${t}, абзац ${n}. ` + 'Обычный рабочий текст ответа, чтобы строка занимала несколько строк экрана телефона. '.repeat(3);
const messages = [];
for (let t = 0; t < TURNS; t++) {
  const ts = now - (TURNS - t) * 600_000;
  messages.push({ type: 'user', uuid: `u${t}`, ts, blocks: [{ kind: 'text', text: `Вопрос ${t}` }] });
  for (let n = 0; n < 2; n++) {
    messages.push({ type: 'assistant', uuid: `a${t}-${n}`, ts: ts + n * 1000 + 1, blocks: [
      { kind: 'text', text: prose(t, n) },
      { kind: 'tool_use', id: `c${t}-${n}`, name: 'Bash', input: { command: `echo ${t}` } },
    ] });
    messages.push({ type: 'user', uuid: `r${t}-${n}`, ts: ts + n * 1000 + 2, blocks: [
      { kind: 'tool_result', toolUseId: `c${t}-${n}`, content: 'ok' },
    ] });
  }
}
const session = { sessionId: 's0', title: 'Длинная сессия', project: 'Demo', cwd: '/projects/demo', source: 'claude', lastModified: now };
const wss = new WebSocketServer({ server: http.createServer().listen(port, '127.0.0.1', () => console.log(`Earlier fixture: ${port}`)) });
wss.on('connection', socket => {
  const send = frame => { if (socket.readyState === 1) socket.send(JSON.stringify(frame)); };
  send({ type: 'snapshot', machines: [{
    machine: { machineId: 'm', name: 'Fixture Mac', os: 'mac', agentVersion: '1' },
    online: true, canControl: true, canStart: true, lastSeen: now, sessions: [session],
  }], activeRuns: [{ runId: 'r-s0', machineId: 'm', sessionId: 's0', state: 'working', since: now }] });
  // CC_FIXTURE_STREAM=<ms>: a working turn keeps the screen redrawing from the stream.
  if (process.env.CC_FIXTURE_STREAM) {
    let n = 0;
    const tick = setInterval(() => send({ type: 'stream', runId: 'r-s0', sessionId: 's0', event: { kind: 'assistant', text: `Живая строка ${++n}` } }), Number(process.env.CC_FIXTURE_STREAM));
    socket.on('close', () => clearInterval(tick));
  }
  socket.on('message', raw => {
    const msg = JSON.parse(raw);
    if (msg.type === 'subscribe') {
      send({ type: 'opened', runId: msg.runId, machineId: 'm', sessionId: 's0' });
    } else if (msg.type === 'rpc_request') {
      const limit = msg.params && msg.params.limit;
      const result = msg.method === 'session.messages'
        ? { messages: msg.params.head ? [] : messages.slice(-(limit || 1000)) }
        : msg.method === 'models.list' ? { models: [] }
        : msg.method === 'projects.list' ? { projects: [] } : { messages: [] };
      send({ type: 'rpc_response', requestId: msg.requestId, ok: true, result });
    } else if (msg.type === 'enrich_request') {
      send({ type: 'enrich_result', requestId: msg.requestId, ok: true, enrichment: {} });
    } else if (msg.type === 'ping') send({ type: 'pong' });
  });
});

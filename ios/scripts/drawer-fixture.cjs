// Local read-only inventory for DrawerTimingUITests. Requires npm dependencies.
const { WebSocketServer } = require('ws');
const sessions = Array.from({ length: 1000 }, (_, i) => ({
  sessionId: `s${i}`,
  title: `Session ${i} — Project discussion`,
  cwd: i < 500 ? '/projects/demo' : i < 800 ? '/projects/website' : '/projects/mobile',
  project: i < 500 ? 'Demo' : i < 800 ? 'Website' : 'Mobile',
  lastModified: Date.now() - i * 1000,
  ...(i < 25 ? { stage: 'in_progress' } : {}),
}));
const snapshot = {
  type: 'snapshot',
  machines: [{
    machine: { machineId: 'm', name: 'Fixture Mac', os: 'mac', agentVersion: '1' },
    canControl: true, canStart: true, online: true, lastSeen: Date.now(), sessions,
  }],
  activeRuns: [],
};
const server = new WebSocketServer({ host: '127.0.0.1', port: 18767 });
server.on('connection', socket => {
  socket.send(JSON.stringify(snapshot));
  socket.on('message', raw => {
    const message = JSON.parse(raw);
    if (message.type !== 'rpc_request') return;
    const result = message.method === 'projects.list' ? { projects: [] }
      : message.method === 'models.list' ? { models: [] } : { messages: [] };
    socket.send(JSON.stringify({ type: 'rpc_response', requestId: message.requestId, ok: true, result }));
  });
});
console.log('1,000-session drawer fixture listening on ws://127.0.0.1:18767/ui');

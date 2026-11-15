// App-server protocol fixture. No model, credentials or real transcript.
import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync } from 'node:fs';
const mode = process.env.CCR_STEER_MODE;
let count = 0;
let active;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const complete = id => send({ method: 'turn/completed', params: { turn: { id, status: 'completed' } } });
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  appendFileSync(process.env.CCR_STEER_LOG, JSON.stringify(m) + '\n');
  const ok = result => send({ id: m.id, result });
  if (m.method === 'initialize') ok({});
  if (m.method === 'config/read') {
    if (mode === 'gateway-error') send({ id: m.id, error: { code: -32601, message: 'unsupported config/read' } });
    else ok({ config: { model_provider: mode === 'gateway-personal' ? 'openai' : 'hegai',
      model_providers: { hegai: { base_url: 'https://llm.acme.test/v1', wire_api: 'responses' } } } });
  }
  if (m.method === 'thread/start') {
    if (mode === 'gateway-reject-model' && m.params.model) {
      send({ id: m.id, error: { code: -32602, message: 'model not found' } });
      return;
    }
    if (mode === 'reject-thread') send({id:m.id,error:{code:-32602,message:'invalid working directory'}});
    else if (mode === 'crash-thread') process.exit(1);
    else if (mode === 'notify-thread-first') {
      send({method:'thread/started',params:{thread:{id:'fixture-thread'}}});
      setTimeout(() => ok({thread:{id:'fixture-thread'}}), 30);
    }
    else ok({ thread: { id: 'fixture-thread' }, model: 'fixture-model' });
  }
  if (m.method === 'turn/start') {
    const id = active = `turn-${++count}`;
    const started = () => {
      send({ method: 'turn/started', params: { turn: { id } } });
      if (mode === 'late-start' && count === 1) complete(id);
      ok({ turn: { id } });
      if (mode === 'late-item' && count === 1) {
        send({ method: 'item/started', params: { threadId: 'fixture-thread', turnId: id,
          item: { type: 'commandExecution', id: 'exec-1', command: 'nmap -p 445 192.168.112.0/24' } } });
      }
      if (mode === 'child-thread' && count === 1) {
        // A sub-agent's whole turn, narrated on our pipe under its own thread id.
        send({ method: 'turn/started', params: { threadId: 'child-thread', turn: { id: 'child-turn' } } });
        send({ method: 'item/completed', params: { threadId: 'child-thread', turnId: 'child-turn',
          item: { type: 'agentMessage', id: 'msg-child', text: 'from the child' } } });
        send({ method: 'turn/completed', params: { threadId: 'child-thread', turn: { id: 'child-turn', status: 'completed' } } });
        send({ method: 'turn/plan/updated', params: { plan: [{ step: 'marker', status: 'completed' }] } });
      }
      if (mode === 'usage') {
        for (const totalTokens of [10000 + count * 100, 10050 + count * 100]) {
          send({ method: 'thread/tokenUsage/updated', params: { turnId: id,
            tokenUsage: { total: { totalTokens }, last: { totalTokens: 50 }, modelContextWindow: 200000 } } });
        }
      }
    };
    if (mode === 'plan') {
      // Plan mode proposes a plan and ends the turn; default mode just ends it.
      send({ method: 'turn/started', params: { turn: { id } } });
      ok({ turn: { id } });
      if (m.params.collaborationMode?.mode === 'plan') {
        send({ method: 'item/completed', params: { threadId: 'fixture-thread', turnId: id,
          item: { type: 'agentMessage', id: `msg-${id}`, text: 'Вот план.\n<proposed_plan>\n# План\n- шаг\n</proposed_plan>' } } });
      }
      complete(id);
      return;
    }
    if (mode === 'rollout-image') {
      // 0.164: the picture is only a rollout line, written mid-turn; the turn
      // ends a while later (the tail polls every CC_REMOTE_IMAGE_TAIL_MS).
      started();
      setTimeout(() => {
        const line = { type: 'response_item', payload: { type: 'image_generation_call', id: 'ig_live', status: 'completed', revised_prompt: 'a red fox', result: 'AAAA' } };
        appendFileSync(process.env.CCR_ROLLOUT, JSON.stringify(line) + '\n');
      }, 40);
      setTimeout(() => complete(id), 400);
      return;
    }
    if (mode === 'delayed-start' && count === 1) setTimeout(started, 60);
    else started();
  }
  if (m.method === 'turn/steer') {
    const id = m.params.expectedTurnId;
    for (const input of m.params.input) {
      if (input.type === 'localImage') readFileSync(input.path); // must stay alive
    }
    if (mode === 'race' || mode === 'accepted-race') complete(id);
    if (mode === 'reject' || mode === 'race') {
      send({ id: m.id, error: { code: -32602, message: 'No active turn accepts steering' } });
    } else if (mode === 'timeout') {
      // Deliberately no response; the test advances only the RPC timeout.
    } else ok({ turnId: id });
  }
  if (m.method === 'turn/interrupt') {
    if (mode === 'late-item') {
      // Codex stops the turn but not the process it started: the command
      // reports AFTER turn/completed, under the dead turn's id.
      const id = active;
      send({ method: 'turn/completed', params: { turn: { id, status: 'interrupted' } } });
      ok({});
      setTimeout(() => {
        send({ method: 'item/completed', params: { threadId: 'fixture-thread', turnId: id,
          item: { type: 'commandExecution', id: 'exec-1', command: 'nmap', status: 'completed',
            aggregatedOutput: '445/tcp open' } } });
        send({ method: 'turn/completed', params: { turn: { id, status: 'completed' } } });
        send({ method: 'item/completed', params: { threadId: 'fixture-thread',
          item: { type: 'agentMessage', id: 'msg-late', text: 'from nowhere' } } });
        // The marker: no turn id, so it passes — once it lands, every straggler before it was seen.
        send({ method: 'turn/plan/updated', params: { plan: [{ step: 'marker', status: 'completed' }] } });
      }, 20);
      active = undefined;
      return;
    }
    complete(active); active = undefined; ok({});
  }
  if (m.method === 'thread/compact/start') {
    if (mode === 'reject-compact') {
      send({ id: m.id, error: { code: -32602, message: 'Compaction refused' } });
      return;
    }
    active = `turn-${++count}`;
    send({ method: 'turn/started', params: { turn: { id: active } } });
    ok({});
  }
});

// Synthetic sample data for App Store screenshots. No real account or agent.
const { WebSocketServer } = require('ws');
const port = Number(process.env.CC_FIXTURE_PORT || 18789);
const now = Date.now();
const sessions = [
  ['s0', 'Страница команды', 'Команда', 'team', 'codex'],
  ['s1', 'Проверка мобильного чата', 'Приложение', 'app', 'claude'],
  ['s2', 'Поиск по каталогу', 'Команда', 'team', 'claude'],
  ['s3', 'Новый раздел сайта', 'Сайт', 'site', 'codex'],
  ['s4', 'Адаптация для телефона', 'Сайт', 'site', 'claude'],
  ['s5', 'История разговоров', 'Приложение', 'app', 'codex'],
].map(([sessionId,title,project,path,source],i)=>({ sessionId,title,project,cwd:`/projects/${path}`,source,
  owner:{userId:'sample'},lastModified:now-i*60000 }));
const machine = {machineId:'sample-mac',name:'Рабочий Mac',os:'mac',agentVersion:'1'};
const runs = sessions.slice(0,2).map(s=>({runId:`r-${s.sessionId}`,machineId:machine.machineId,
  sessionId:s.sessionId,state:'working',since:now-40000,ownerUserId:'sample'}));
const snapshot = {type:'snapshot',viewer:{userId:'sample',email:'demo@example.test',platformAdmin:false,
  workspace:{workspaceId:'sample',name:'Мои проекты',kind:'personal',role:'owner'},workspaces:[]},
  machines:[{machine,online:true,canControl:true,canStart:true,lastSeen:now,owner:{userId:'sample'},sessions}],activeRuns:runs};
snapshot.machines[0].usage = {updatedAt:now, subscription:'Max',
  fiveHour:{utilization:18,resetsAt:now+3600000}, sevenDay:{utilization:32,resetsAt:now+86400000}};
const history = [
 {type:'user',uuid:'u',ts:now-60000,blocks:[{kind:'text',text:'Сделай страницу команды: участники, роли и поиск. На телефоне тоже должно быть удобно.'}]},
 {type:'assistant',uuid:'a',ts:now-50000,blocks:[{kind:'text',text:'## Страница команды\n\nСобрал основу интерфейса и проверяю поведение на маленьком экране.\n\n- **Участники** — имя, роль и статус в одной карточке.\n- **Поиск** — по имени и специализации.\n- **Телефон** — одна колонка и удобные области нажатия.'}]},
 {type:'assistant',uuid:'tools',blocks:[{kind:'tool_use',id:'t1',name:'Read',input:{file_path:'src/team/TeamPage.tsx'}}]},
 {type:'assistant',uuid:'b',ts:now-10000,blocks:[{kind:'text',text:'Сейчас проверяю поиск, пустые состояния и переключение светлой и тёмной темы.'}]},
];
const server = require('http').createServer((req,res)=>{
 res.setHeader('Content-Type','application/json');
 if(req.url==='/api/gateway-quota') {
  res.end(JSON.stringify({gatewayQuota:{ok:true,plan:'Team',primary_used_percent:24,
   primary_window_minutes:300,primary_reset_at:(now+3600000)/1000,updated_at:now/1000}}));
 } else { res.statusCode=404; res.end('{}'); }
});
const wss = new WebSocketServer({server});
server.listen(port,'127.0.0.1');
wss.on('connection',socket=>{
 const send=x=>{if(socket.readyState===1)socket.send(JSON.stringify(x));};
 send(snapshot);
 socket.on('message',raw=>{
  const m=JSON.parse(raw);
  if(m.type==='subscribe'){
   send({type:'opened',runId:m.runId,machineId:machine.machineId,sessionId:m.runId.slice(2)});
   send({type:'run_settings',runId:m.runId,sessionId:m.runId.slice(2),model:'gpt-6-astra',activeModel:'gpt-6-astra',effort:'medium'});
  } else if(m.type==='rpc_request'){
   let result={};
   if(m.method==='session.messages') result={messages:history};
   if(m.method==='models.list') {
    const codex=m.params?.source==='codex';
    const id=codex?'gpt-6-astra':'claude-opus-5-5';
    result={models:[{id:'default',name:'По умолчанию',resolved:id},
     {id,name:codex?'6 Astra':'Opus 5.5',resolved:id,supportsEffort:true,efforts:['low','medium','high']}]};
   }
   if(m.method==='projects.list') result={projects:[...new Map(sessions.map(s=>[s.cwd,{cwd:s.cwd,label:s.project,count:2,origin:'root',lastModified:now}])).values()]};
   send({type:'rpc_response',requestId:m.requestId,ok:true,result});
  } else if(m.type==='enrich_request')send({type:'enrich_result',requestId:m.requestId,ok:true,enrichment:{}});
  else if(m.type==='ping')send({type:'pong'});
 });
});
console.log(`App Store sample fixture: ${port}`);

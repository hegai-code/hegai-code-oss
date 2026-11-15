// A real throwaway hub owns auth/consent identity/deletion. Only the machine is
// synthetic; no provider or employee data is contacted by simulator UI tests.
import http from 'node:http';
import { api, ssoLogin, adminLogin, adminGrant, randomSmokeUser, enrollFakeAgent } from '../../server/src/cli/_harness.ts';
const target={http:'http://127.0.0.1:18841',ws:'ws://127.0.0.1:18841',token:'local-review-test-token',ssoSecret:process.env.CC_REMOTE_SSO_SECRET};
if(!target.ssoSecret)throw new Error('throwaway hub secret required');
const admin=await adminLogin(target.http,target.ssoSecret);
let calls=0; const agents=[];
http.createServer(async(req,res)=>{try{
 res.setHeader('Content-Type','application/json');
 if(req.url==='/state'){res.end(JSON.stringify({calls}));return;}
 if(req.url!=='/credentials'){res.writeHead(404);res.end('{}');return;}
 calls=0;
 const user=await ssoLogin(target.http,target.ssoSecret,randomSmokeUser('ui-review','Review test'));
 await adminGrant(target.http,admin,user.email);
 const agent=await enrollFakeAgent(target,user,{name:'Review sample',machineId:'ui-review-'+user.userId,sessions:[{sessionId:'sample-chat',title:'Проверка приложения',cwd:'/review/demo',project:'Demo',source:'codex',lastModified:Date.now()}]});
 agents.push(agent);
 agent.ws.on('message',raw=>{
  const m=JSON.parse(raw);
  const send=v=>agent.ws.readyState===1&&agent.ws.send(JSON.stringify(v));
  const hasInput=m.type==='input'||(['resume','new_session'].includes(m.type)&&Boolean(m.message));
  if(hasInput)calls++;
  if(m.type==='rpc_request'){
   let result={};
   if(m.method==='session.messages')result={messages:[{type:'assistant',uuid:'intro',blocks:[{kind:'text',text:'Это изолированный пример для проверки приложения.'}]}]};
   if(m.method==='models.list')result={models:[{id:'gpt-5.6-sol',name:'Sol'}]};
   if(m.method==='projects.list')result={projects:[{cwd:'/review/demo',label:'Demo',count:1,origin:'root'}]};
   send({type:'rpc_response',requestId:m.requestId,ok:true,result});
  }
  if(m.type==='resume'){
   send({type:'run_status',runId:m.runId,sessionId:m.sessionId,state:'started'});
  }
  if(hasInput){
   send({type:'stream',runId:m.runId,sessionId:m.sessionId,event:{kind:'assistant',text:'Тестовое сообщение получено.'}});
   send({type:'run_status',runId:m.runId,sessionId:m.sessionId,state:'idle'});
  }
 });
 res.end(JSON.stringify({token:user.session,userId:user.userId,machineId:agent.machineId,sessionId:'sample-chat'}));
}catch{res.writeHead(500);res.end('{"error":"fixture setup failed"}')}}).listen(18842,'127.0.0.1',()=>console.log('Release readiness UI fixture: 18842; real local hub: 18841'));

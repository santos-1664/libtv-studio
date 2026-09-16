// Explicit, manual acceptance command. Never run automatically during build or startup.
// Uses only a synthetic coffee scene; credentials remain inside the local application.
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
const base='http://127.0.0.1:3100';
const stateFile='data/live-acceptance.json';
async function api(route:string,body?:unknown){
  const response=await fetch(base+'/api'+route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const value=await response.json();if(!response.ok)throw new Error(value.error||`HTTP ${response.status}`);return value;
}
const mode=process.argv[2];
if(mode==='start'){
  if(existsSync(stateFile))throw new Error('An acceptance project already exists; inspect it before submitting again.');
  const {project}=await api('/projects',{name:'真实接口验收 · 晨光咖啡'});
  const {canvas}=await api('/projects/'+project.id);
  const descriptions=[
    {id:'acceptance-text',kind:'text',title:'晨光咖啡 · 文案',prompt:'为晨光中的一杯咖啡写一句20字以内的广告文案，只返回文案。'},
    {id:'acceptance-image',kind:'image',title:'晨光咖啡 · 生成图片',prompt:'一只简洁的白色陶瓷咖啡杯放在浅橡木桌面，柔和晨光从左侧窗户照入，少量蒸汽，写实产品摄影，画面干净，没有文字，没有人物。'},
    {id:'acceptance-video',kind:'video',title:'晨光咖啡 · 生成视频',prompt:'固定镜头拍摄木桌上的一只白色陶瓷咖啡杯，暖色晨光从左侧窗户照入，热气轻轻升起，真实摄影风格，画面稳定，无文字，无人物。'},
  ];
  const updated={...canvas,nodes:descriptions.map((n,i)=>({id:n.id,type:'creative',position:{x:120+i*410,y:120},data:{kind:n.kind,title:n.title,prompt:n.prompt,aspectRatio:'16:9',duration:2}}))};
  const saved=await fetch(base+'/api/projects/'+project.id+'/canvas',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(updated)});
  if(!saved.ok)throw new Error(await saved.text());
  mkdirSync('data',{recursive:true});writeFileSync(stateFile,JSON.stringify({projectId:project.id,createdAt:new Date().toISOString()},null,2),{mode:0o600});
  for(const n of descriptions){const {job}=await api(`/projects/${project.id}/nodes/${n.id}/generate`,{idempotencyKey:'manual-live-acceptance-'+n.id});console.log(JSON.stringify({kind:n.kind,jobId:job.id,status:job.status}))}
  console.log(JSON.stringify({projectId:project.id,url:base+'/canvas/'+project.id}));
}else if(mode==='status'){
  const state=JSON.parse(readFileSync(stateFile,'utf8'));const detail=await api('/projects/'+state.projectId);
  console.log(JSON.stringify({projectId:state.projectId,jobs:detail.jobs,nodes:detail.canvas.nodes.map((n:any)=>({id:n.id,kind:n.data.kind,status:n.data.status,text:n.data.text,url:n.data.url,error:n.data.error})),assets:detail.assets.map((a:any)=>({kind:a.kind,mimeType:a.mimeType,size:a.size,url:a.url}))},null,2));
}else if(mode==='agent'){
  const {project}=await api('/projects',{name:'Agent 实测 · 咖啡分镜'});
  const response=await fetch(base+`/api/projects/${project.id}/agent`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'请在画布创建一个简短的咖啡广告脚本文本节点和两个视频分镜草稿，镜头一为桌面全景，镜头二为杯沿特写，标注镜头序号。仅规划并保存草稿，不提交图片或视频生成。',skillId:'storyboard'})});
  if(!response.ok)throw new Error(await response.text());
  const raw=await response.text();const events=raw.split(/\r?\n\r?\n/).flatMap(frame=>frame.startsWith('data: ')?[JSON.parse(frame.slice(6))]:[]);
  const detail=await api('/projects/'+project.id);
  console.log(JSON.stringify({projectId:project.id,events:events.filter(e=>e.type!=='text'),nodeCount:detail.canvas.nodes.length,nodes:detail.canvas.nodes.map((n:any)=>({id:n.id,title:n.data.title,kind:n.data.kind,shotNumber:n.data.shotNumber,prompt:n.data.prompt}))},null,2));
  writeFileSync('data/live-agent-acceptance.json',JSON.stringify({projectId:project.id,nodes:detail.canvas.nodes},null,2),{mode:0o600});
}else throw new Error('Use an explicit start, status, or agent argument. start generates one text, one image, and a two-second video.');

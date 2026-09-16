import type { AgentEvent } from '../shared/types';
export class ApiError extends Error { constructor(message:string,public status:number){super(message)} }
export async function api<T>(path:string, options:RequestInit = {}):Promise<T>{
  const response = await fetch('/api'+path,{...options,headers:{...(options.body instanceof FormData ? {} : {'Content-Type':'application/json'}),...options.headers}});
  const body = await response.json().catch(()=>({error:'服务器返回了无效响应'}));
  if(!response.ok) throw new ApiError(body.error || '请求失败',response.status);
  return body;
}
export async function streamAgent(projectId:string,body:unknown,onEvent:(event:AgentEvent)=>void,signal?:AbortSignal){
  const response=await fetch(`/api/projects/${projectId}/agent`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal});
  if(!response.ok){const value=await response.json().catch(()=>({error:'Agent 请求失败'}));throw new ApiError(value.error,response.status)}
  if(!response.body)throw new Error('未收到 Agent 响应');
  const reader=response.body.getReader(),decoder=new TextDecoder();let pending='';let terminal=false;
  while(true){const {done,value}=await reader.read();if(done)break;pending+=decoder.decode(value,{stream:true});const frames=pending.split(/\r?\n\r?\n/);pending=frames.pop()||'';for(const frame of frames){const data=frame.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).join('\n');if(data){const event=JSON.parse(data) as AgentEvent;if(event.type==='done'||event.type==='error')terminal=true;onEvent(event)}}}
  if(!terminal)throw new Error('连接已中断，请检查项目中的任务状态后重试');
}

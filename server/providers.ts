import type { ProviderConfig } from './config';
import type { Model } from '../shared/types';
import { HttpError } from './errors';
import { generateBailianImage, submitBailianVideo, pollBailianVideo, listBailianModels } from './bailian';
export { listBailianModels } from './bailian';

export type ChatMessage = { role:string; content:string|unknown[]|null; tool_calls?:ToolCall[]; tool_call_id?:string };
export type ToolCall = { id:string; type:'function'; function:{name:string; arguments:string} };
export type ChatResult = { content:string; toolCalls:ToolCall[] };
export function endpoint(base:string, suffix:string) { return base.replace(/\/+$/, '') + suffix; }
function textEndpoint(base:string,suffix:string){
  const url=new URL(base);
  // A bare origin defaults to /v1. Explicit API prefixes, including /compatible-mode/v1, stay intact.
  url.pathname=(url.pathname.replace(/\/+$/,'')||'/v1')+suffix;
  return url.toString();
}
function requireTextProtocol(config:ProviderConfig){
  if(config.protocol!=='openai')throw new HttpError(400,'文本与 Agent 请使用 OpenAI 兼容服务地址和 API Key；旧配置任务请重新配置后提交');
}

function headers(config:ProviderConfig):Record<string,string> {
  return { Authorization:'Bearer '+config.key, 'Content-Type':'application/json',
    ...(config.kind==='text' ? {Accept:'text/event-stream'} : {}) };
}
function record(value:unknown):value is Record<string,unknown> {
  return typeof value==='object' && value!==null && !Array.isArray(value);
}
function safeDetail(config:ProviderConfig, value:unknown):string {
  if(typeof value!=='string' && typeof value!=='number') return '';
  let text=String(value);
  if(config.key) text=text.split(config.key).join('[凭据已隐藏]');
  return text.replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [凭据已隐藏]').replace(/[\u0000-\u001f]/g, ' ').slice(0,450);
}
function description(config:ProviderConfig, body:unknown) {
  if(!record(body)) return '';
  const error=body.error;
  return safeDetail(config, record(error) ? error.message : typeof error==='string' ? error : body.message);
}
function businessError(config:ProviderConfig, body:unknown):HttpError|undefined {
  if(!record(body)) return;
  const code=body.code;
  const hasFailureCode=code!==undefined && code!==null && ![0,200,'0','200'].includes(code as string|number);
  if(!body.error && !hasFailureCode) return;
  const detail=description(config,body);
  const codeText=safeDetail(config,code);
  return new HttpError(String(code)==='429' ? 429 : 502,
    `模型服务返回错误${codeText?'（code '+codeText+'）':''}${detail?'：'+detail:'，请检查 API Key 与模型权限'}`);
}
async function readJson(response:Response, maxBytes=2*1024*1024):Promise<unknown> {
  if(!response.body) throw new Error('Empty response');
  const reader=response.body.getReader(); const chunks:Uint8Array[]=[]; let size=0;
  try {
    while(true) {
      const {done,value}=await reader.read(); if(done) break;
      size+=value.byteLength; if(size>maxBytes) throw new Error('Response too large');
      chunks.push(value);
    }
    const bytes=new Uint8Array(size); let offset=0;
    for(const chunk of chunks) { bytes.set(chunk,offset); offset+=chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  } finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
}
export async function checkedFetch(config:ProviderConfig, url:string, options:RequestInit={}) {
  const requestHeaders=new Headers(headers(config));
  new Headers(options.headers).forEach((value,key)=>requestHeaders.set(key,value));
  const isPost=options.method?.toUpperCase()==='POST';
  try {
    const response=await fetch(url,{...options, headers:requestHeaders,
      signal:options.signal||AbortSignal.timeout(180000), redirect:'error'});
    if(!response.ok) {
      const body=await readJson(response,65536).catch(()=>undefined);
      const detail=description(config,body); const status=response.status;
      const label=status===401||status===403 ? '模型服务鉴权失败' : status===429 ? '模型服务请求过于频繁' : '模型服务请求失败';
      throw new HttpError(status===429?429:502,
        `${label}（HTTP ${status}）${detail?'：'+detail:status===401||status===403?'，请检查 API Key 和模型权限':''}`,
        !!isPost && status>=500);
    }
    return response;
  } catch(error) {
    if(error instanceof HttpError) throw error;
    throw new HttpError(502,'模型服务连接中断或超时，请核对服务地址与网络；不会自动重复提交生成请求',!!isPost);
  }
}
export async function listModels(config:ProviderConfig):Promise<Model[]> {
  if(config.kind==='text')requireTextProtocol(config);
  if(config.protocol==='bailian')return listBailianModels(config,config.kind);
  const url=config.kind==='text'?textEndpoint(config.baseUrl,'/models'):endpoint(config.baseUrl,'/v1/models');
  const response=await checkedFetch(config,url,{headers:{Accept:'application/json'}});
  let body:unknown;
  try { body=await readJson(response); }
  catch { throw new HttpError(502,'模型列表返回了无效的 JSON 数据，请检查服务基地址'); }
  const failure=businessError(config,body); if(failure) throw failure;
  if(!record(body)) throw new HttpError(502,'模型列表响应格式无效');
  const rows=record(body.data) ? body.data.models : body.data??body.models;
  if(!Array.isArray(rows)||rows.length>5000) throw new HttpError(502,'模型列表响应格式无效：缺少 data 或 data.models 数组');
  const models:Model[]=[]; const names=new Set<string>();
  for(const row of rows) {
    if(!record(row)) throw new HttpError(502,'模型列表包含无效条目');
    const name=row.model_name??row.id;
    if(typeof name!=='string'||!name.trim()||name.length>200) throw new HttpError(502,'模型列表包含无效的 id 或 model_name');
    if(names.has(name)) continue; names.add(name);
    const flag=(value:unknown)=>[0,1,'0','1'].includes(value as string|number)?Number(value):undefined;
    models.push({model_name:name,manufacturer:typeof row.manufacturer==='string'?row.manufacturer.slice(0,200):undefined,
      is_use_image:flag(row.is_use_image),is_use_video:flag(row.is_use_video)});
  }
  return models;
}
export async function chat(config:ProviderConfig, messages:ChatMessage[], options:{tools?:unknown[]; signal?:AbortSignal; onText?:(text:string)=>void}={}):Promise<ChatResult> {
  requireTextProtocol(config);
  const response=await checkedFetch(config,textEndpoint(config.baseUrl,'/chat/completions'),{
    method:'POST',headers:{Accept:'text/event-stream'},
    body:JSON.stringify({model:config.model,messages,stream:true,...(options.tools?{tools:options.tools,tool_choice:'auto'}:{})}),
    signal:options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(240000)]):AbortSignal.timeout(240000),
  });
  const contentType=(response.headers.get('content-type')||'').toLowerCase().split(';')[0].trim();
  if(contentType!=='text/event-stream') {
    const body=await readJson(response,65536).catch(()=>undefined);
    const failure=businessError(config,body); if(failure) throw failure;
    throw new HttpError(502,'聊天接口没有返回 text/event-stream；请检查服务地址或代理是否支持流式聊天',true);
  }
  if(!response.body) throw new HttpError(502,'模型没有返回数据流',true);
  let content='',pending='',frameLines:string[]=[],frameSize=0,sawDone=false,finishReason:string|undefined;
  const calls=new Map<number,ToolCall>();
  const decoder=new TextDecoder('utf-8',{fatal:true}),reader=response.body.getReader();
  function protocolError(message:string):never { throw new HttpError(502,message,true); }
  function dispatch() {
    const lines=frameLines; frameLines=[]; frameSize=0;
    if(sawDone) return;
    const event=lines.find(l=>l.startsWith('event:'))?.slice(6).trim();
    const data=lines.filter(l=>l==='data'||l.startsWith('data:')).map(l=>l==='data'?'':l.slice(5).replace(/^ /,'')).join('\n');
    if(!data.trim()) return;
    if(data.trim()==='[DONE]') { sawDone=true; return; }
    let chunk:unknown;
    try { chunk=JSON.parse(data); } catch { protocolError('模型返回了无效的 SSE JSON 数据'); }
    const failure=businessError(config,chunk); if(failure) throw failure;
    if(event==='error') throw new HttpError(502,'模型数据流返回错误'+(description(config,chunk)?'：'+description(config,chunk):''));
    if(!record(chunk)) protocolError('模型返回了无效的 SSE 事件');
    const choices=chunk.choices;
    // An empty choices array is permitted for the optional final usage event.
    if(!Array.isArray(choices)) protocolError('模型 SSE 事件缺少 choices 数组');
    if(!choices.length) return;
    const choice=choices.find(c=>record(c)&&c.index===0)??choices[0];
    if(!record(choice)) protocolError('模型 SSE choices 格式无效');
    if(choice.finish_reason!==undefined&&choice.finish_reason!==null) {
      if(typeof choice.finish_reason!=='string') protocolError('模型结束状态格式无效');
      finishReason=choice.finish_reason;
    }
    const delta=choice.delta;
    if(delta===undefined||delta===null) return;
    if(!record(delta)) protocolError('模型 SSE delta 格式无效');
    if(typeof delta.content==='string') {
      content+=delta.content;
      if(content.length>150000) protocolError('模型回复超出长度限制');
      options.onText?.(delta.content);
    } else if(delta.content!==undefined&&delta.content!==null) protocolError('模型返回了不支持的文本分片格式');
    if(delta.function_call!=null) protocolError('模型返回了旧版 function_call 格式，请选择支持 tools 的模型');
    if(delta.tool_calls===undefined||delta.tool_calls===null) return;
    if(!Array.isArray(delta.tool_calls)) protocolError('模型工具调用分片格式无效');
    for(const part of delta.tool_calls) {
      if(!record(part)||!Number.isInteger(part.index)||Number(part.index)<0||Number(part.index)>=30) protocolError('模型工具调用索引无效或数量超限');
      if(part.type!=null&&part.type!=='function') protocolError('模型返回了不支持的工具类型');
      const index=Number(part.index);
      const call=calls.get(index)||{id:'',type:'function',function:{name:'',arguments:''}};
      if(part.id!=null) {
        if(typeof part.id!=='string') protocolError('模型工具调用 ID 格式无效');
        if(call.id!==part.id) call.id+=part.id;
      }
      if(part.function!=null) {
        if(!record(part.function)) protocolError('模型工具定义格式无效');
        if(part.function.name!=null) {
          if(typeof part.function.name!=='string') protocolError('模型工具名称格式无效');
          if(call.function.name!==part.function.name) call.function.name+=part.function.name;
        }
        if(part.function.arguments!=null) {
          if(typeof part.function.arguments!=='string') protocolError('模型工具参数分片必须为字符串');
          call.function.arguments+=part.function.arguments;
        }
      }
      if(call.id.length>200||call.function.name.length>100||call.function.arguments.length>200000) protocolError('模型工具参数超出长度限制');
      calls.set(index,call);
    }
  }
  function consume(final=false) {
    while(!sawDone) {
      const index=pending.search(/[\r\n]/);
      if(index<0) break;
      // A CR at a network-chunk boundary may still be the first half of CRLF.
      if(pending[index]==='\r'&&index===pending.length-1&&!final) break;
      const line=pending.slice(0,index),separator=pending[index]==='\r'&&pending[index+1]==='\n'?2:1;
      pending=pending.slice(index+separator);
      if(!line) dispatch();
      else { frameLines.push(line); frameSize+=line.length; }
      if(frameSize+pending.length>250000) protocolError('模型单个 SSE 事件超出限制');
    }
    if(final&&!sawDone) {
      if(pending) { frameLines.push(pending); pending=''; }
      if(frameLines.length) dispatch();
    }
  }
  try {
    while(!sawDone) {
      const {done,value}=await reader.read();
      if(done) { pending+=decoder.decode(); consume(true); break; }
      pending+=decoder.decode(value,{stream:true}); consume();
      if(pending.length+frameSize>250000) protocolError('模型单个 SSE 事件超出限制');
    }
  } catch(error) {
    if(error instanceof HttpError) throw error;
    throw new HttpError(502,'模型数据流传输中断或编码无效；未执行不完整的工具调用',true);
  } finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
  // finish_reason is not a transport completion marker: require the documented [DONE].
  if(!sawDone) protocolError('模型连接提前中断（缺少 [DONE]）；未执行不完整的工具调用');
  if(finishReason==='length') protocolError('模型输出达到长度上限，回复或工具参数不完整；请缩小单次任务');
  if(finishReason==='content_filter') throw new HttpError(502,'模型服务拦截了本次内容，请调整创作请求');
  if(finishReason&&!['stop','tool_calls'].includes(finishReason)) protocolError('模型返回了未支持的结束状态：'+safeDetail(config,finishReason));
  const toolCalls=[...calls.entries()].sort(([a],[b])=>a-b).map(([,call])=>call);
  for(const call of toolCalls) {
    if(!call.id||!/^[-a-zA-Z0-9_]{1,100}$/.test(call.function.name)) protocolError('模型工具调用缺少有效的 ID 或名称');
    let args:unknown;
    try { args=JSON.parse(call.function.arguments); } catch { protocolError('模型工具参数 JSON 不完整，未执行该轮工具调用'); }
    if(!record(args)) protocolError('模型工具参数必须是 JSON 对象');
  }
  if(finishReason==='tool_calls'&&!toolCalls.length) protocolError('模型声明调用工具，但没有返回有效工具');
  if(!content.trim()&&!toolCalls.length) protocolError('模型没有返回文本或工具调用');
  return {content,toolCalls};
}
export async function generateImage(config:ProviderConfig,input:{prompt:string;aspectRatio?:string;references?:{dataUrl:string;name:string}[]}){
  if(config.protocol==='bailian')return generateBailianImage(config,input);
  const ratio=input.aspectRatio||'1:1';const size=ratio==='1:1'?'1024x1024':ratio==='9:16'||ratio==='3:4'||ratio==='2:3'?'1024x1536':'1536x1024';
  let response:Response;
  if(input.references?.length){const form=new FormData();form.append('model',config.model);form.append('prompt',input.prompt);form.append('size',size);for(const ref of input.references.slice(0,8)){const [meta,value]=ref.dataUrl.split(',');const mime=meta.match(/^data:(.*);base64$/)?.[1]||'image/png';form.append('image[]',new Blob([Buffer.from(value,'base64')],{type:mime}),ref.name)}const h=headers(config) as Record<string,string>;delete h['Content-Type'];try{response=await fetch(endpoint(config.baseUrl,'/images/edits'),{method:'POST',headers:h,body:form,signal:AbortSignal.timeout(240000),redirect:'error'});if(!response.ok)throw new HttpError(502,`图片编辑服务返回 ${response.status}`,response.status>=500)}catch(error){if(error instanceof HttpError)throw error;throw new HttpError(502,'图片编辑提交状态不确定，请核对供应商记录后重试',true)}}
  else response=await checkedFetch(config,endpoint(config.baseUrl,'/images/generations'),{method:'POST',body:JSON.stringify({model:config.model,prompt:input.prompt,size,n:1})});
  const result=await response.json() as any;const first=result.data?.[0];if(!first?.url&&!first?.b64_json)throw new HttpError(502,'图片服务未返回有效的图片数据',true);return first as {url?:string;b64_json?:string};
}
// Ark task protocol verified against the official volcengine Python SDK tasks resource.
export async function submitVideo(config:ProviderConfig,input:{prompt:string;aspectRatio?:string;duration?:number;references?:{dataUrl:string}[]}){if(config.protocol==='bailian')return submitBailianVideo(config,input);const content:unknown[]=[{type:'text',text:input.prompt}];if(input.references?.[0])content.push({type:'image_url',image_url:{url:input.references[0].dataUrl},role:'first_frame'});const response=await checkedFetch(config,endpoint(config.baseUrl,'/contents/generations/tasks'),{method:'POST',body:JSON.stringify({model:config.model,content,ratio:input.aspectRatio||'16:9',duration:input.duration||5})});const result=await response.json() as any;if(typeof result.id!=='string')throw new HttpError(502,'视频服务未返回任务 ID，提交状态不确定',true);return result.id as string}
export async function pollVideo(config:ProviderConfig,id:string):Promise<{status:string;content?:{video_url?:string};error?:{message?:string}}>{if(config.protocol==='bailian')return pollBailianVideo(config,id);const response=await checkedFetch(config,endpoint(config.baseUrl,'/contents/generations/tasks/'+encodeURIComponent(id)));return await response.json() as any}

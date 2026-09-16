import { createHash } from 'node:crypto';
import type { ProviderConfig } from './config';
import type { Model, NodeKind } from '../shared/types';
import { HttpError } from './errors';

// Official contracts, verified 2026-09-15:
// https://help.aliyun.com/zh/model-studio/list-models
// https://help.aliyun.com/zh/model-studio/qwen-image-generation-and-editing-api-reference
// https://help.aliyun.com/zh/model-studio/text-to-video-api-reference
// https://help.aliyun.com/zh/model-studio/image-to-video-general-api-reference
const imageModels=new Set(['qwen-image-3.0','qwen-image-3.0-pro']);
const textVideoModels=new Set(['wan2.7-t2v','wan2.7-t2v-2026-06-12']);
const imageVideoModels=new Set(['wan2.7-i2v-2026-04-25']);
const capabilityFor:Record<NodeKind,string>={image:'IG',video:'VG',text:'TG'};
const outputFor:Record<NodeKind,string>={image:'Image',video:'Video',text:'Text'};
type ImageInput={prompt:string;aspectRatio?:string;references?:{dataUrl:string;name?:string}[]};
type VideoInput={prompt:string;aspectRatio?:string;duration?:number;references?:{dataUrl:string}[]};
export interface BailianModel extends Model {capabilities:string[];features:string[];requestModalities:string[];responseModalities:string[];adapterSupported:boolean}
export interface BailianVideoState {status:'queued'|'running'|'succeeded'|'failed'|'cancelled';content?:{video_url:string};error?:{message:string}}
function record(value:unknown):value is Record<string,unknown>{return typeof value==='object'&&value!==null&&!Array.isArray(value)}
function clean(config:ProviderConfig,value:unknown){let text=typeof value==='string'||typeof value==='number'?String(value):'';if(config.key)text=text.split(config.key).join('[凭据已隐藏]');return text.replace(/Bearer\s+[^\s"',;]+/gi,'Bearer [凭据已隐藏]').replace(/[\u0000-\u001f]/g,' ').slice(0,500)}
function bailianEndpoint(config:ProviderConfig,pathname:string){
  let base:URL;try{base=new URL(config.baseUrl)}catch{throw new HttpError(400,'百炼 API Host 必须是带 https:// 的完整域名')}
  const local=['127.0.0.1','localhost','[::1]'].includes(base.hostname);
  if(base.username||base.password||base.search||base.hash||!['','/'].includes(base.pathname)||base.protocol!=='https:'&&!(local&&base.protocol==='http:'))throw new HttpError(400,'百炼 API Host 只填写 HTTPS 域名，不附加 /api/v1 或 /compatible-mode 路径');
  if(!config.key)throw new HttpError(503,'尚未配置百炼 API Key');
  return base.origin+pathname;
}
async function bodyJson(response:Response){
  if(!response.body)throw new Error('Empty response');const reader=response.body.getReader();let size=0;const parts:Uint8Array[]=[];
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>2*1024*1024)throw new Error('Response too large');parts.push(value)}const data=new Uint8Array(size);let offset=0;for(const part of parts){data.set(part,offset);offset+=part.byteLength}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data)) as unknown}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock()}
}
async function request(config:ProviderConfig,pathname:string,options:{method?:'GET'|'POST';body?:unknown;async?:boolean;timeout?:number}={}):Promise<Record<string,unknown>>{
  const url=bailianEndpoint(config,pathname),isPost=options.method==='POST';let response:Response;
  try{response=await fetch(url,{method:options.method||'GET',headers:{Authorization:'Bearer '+config.key,'Content-Type':'application/json',Accept:'application/json',...(options.async?{'X-DashScope-Async':'enable'}:{})},body:options.body===undefined?undefined:JSON.stringify(options.body),signal:AbortSignal.timeout(options.timeout||60000),redirect:'error'})}
  catch{throw new HttpError(502,'百炼服务连接中断或超时；不会自动重复提交生成请求',isPost)}
  let body:unknown;try{body=await bodyJson(response)}catch{throw new HttpError(502,`百炼服务返回无效 JSON（HTTP ${response.status}），请核对 API Host 和请求记录`,isPost)}
  const value=record(body)?body:{};const error=record(value.error)?value.error:undefined;
  const code=error?.code??value.code;
  const failureCode=code!==undefined&&code!==null&&code!==''&&![0,200,'0','200'].includes(code as string|number);
  if(!response.ok||value.success===false||value.error||failureCode){
    const detail=clean(config,error?.message??value.message),requestId=clean(config,value.request_id??response.headers.get('x-request-id'));
    const codeText=clean(config,code);const auth=response.status===401||response.status===403||code==='InvalidApiKey';
    throw new HttpError(response.status===429?429:502,`百炼${auth?'鉴权失败':'请求失败'}（HTTP ${response.status}${codeText?'，'+codeText:''}）${detail?'：'+detail:''}${requestId?'；request_id='+requestId:''}`,isPost&&response.status>=500);
  }
  if(!record(body))throw new HttpError(502,'百炼服务响应格式无效',isPost);
  return body;
}
const strings=(value:unknown)=>Array.isArray(value)?value.filter((item):item is string=>typeof item==='string'):[];
export function supportsBailianModel(kind:NodeKind,model:string){return kind==='image'?imageModels.has(model):kind==='video'?textVideoModels.has(model)||imageVideoModels.has(model):false}
export async function listBailianModels(config:ProviderConfig,kind:NodeKind):Promise<BailianModel[]>{
  const models:BailianModel[]=[],seen=new Set<string>();let received=0;
  for(let page=1;page<=100;page++){
    const params=new URLSearchParams({capabilities:capabilityFor[kind],page_no:String(page),page_size:'100'});
    const body=await request(config,'/api/v1/models?'+params.toString());
    const output=body.output;if(!record(output)||!Array.isArray(output.models)||!Number.isInteger(output.total)||Number(output.total)<0||Number(output.total)>10000)throw new HttpError(502,'百炼模型目录缺少有效的 output.models 或 output.total');
    if(output.page_no!==undefined&&output.page_no!==page)throw new HttpError(502,'百炼模型目录分页页码不匹配');
    const total=Number(output.total);let newCount=0;
    for(const item of output.models){
      if(!record(item)||typeof item.model!=='string'||!item.model.trim()||item.model.length>200)throw new HttpError(502,'百炼模型目录包含无效的 model 字段');
      if(seen.has(item.model))continue;seen.add(item.model);newCount++;
      const capabilities=strings(item.capabilities),features=strings(item.features),metadata=record(item.inference_metadata)?item.inference_metadata:{};
      const requestModalities=strings(metadata.request_modality),responseModalities=strings(metadata.response_modality);
      // Image/video input capability alone is never interpreted as media generation.
      if(!capabilities.includes(capabilityFor[kind])&&!responseModalities.includes(outputFor[kind]))continue;
      models.push({model_name:item.model,manufacturer:typeof item.provider==='string'?item.provider:undefined,is_use_image:requestModalities.includes('Image')?1:0,is_use_video:requestModalities.includes('Video')?1:0,capabilities,features,requestModalities,responseModalities,adapterSupported:supportsBailianModel(kind,item.model)});
    }
    received+=output.models.length;
    if(received>=total)return models;
    if(!output.models.length||!newCount)throw new HttpError(502,'百炼模型目录分页没有进展，请稍后重试');
  }
  throw new HttpError(502,'百炼模型目录超出分页上限');
}
function dataReference(value:string,maxBytes:number,allowedMime:Set<string>,purpose:string){
  if(typeof value!=='string'||!value)throw new HttpError(400,`${purpose}素材为空`);
  if(value.startsWith('data:')){
    if(value.length>Math.ceil(maxBytes*4/3)+1024)throw new HttpError(413,`${purpose}单张图像不能超过 ${maxBytes/(1024*1024)} MB`);
    const match=/^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
    if(!match||!allowedMime.has(match[1].toLowerCase()))throw new HttpError(415,`${purpose}图像格式或 Data URL 无效`);
    const bytes=Buffer.from(match[2],'base64');if(!bytes.length||bytes.toString('base64').replace(/=+$/,'')!==match[2].replace(/=+$/,''))throw new HttpError(400,`${purpose}Base64 数据无效`);
    if(bytes.length>maxBytes)throw new HttpError(413,`${purpose}单张图像不能超过 ${maxBytes/(1024*1024)} MB`);
    return {url:value,mime:match[1].toLowerCase(),bytes};
  }
  let url:URL;try{url=new URL(value)}catch{throw new HttpError(400,`${purpose}只支持公开 HTTP(S) URL 或图像 Data URL`)}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new HttpError(400,`${purpose}需要供应商可访问的公开 HTTP(S) URL 或图像 Data URL`);
  return {url:value,mime:undefined,bytes:undefined};
}
function resultUrl(value:unknown):string|undefined{if(typeof value!=='string'||!value)return;try{const url=new URL(value);if(url.protocol==='https:'&&!url.username&&!url.password)return value}catch{/* Invalid output is rejected by the caller. */}}
function imageSize(ratio='1:1'){
  const sizes:Record<string,string>={'1:1':'1024x1024','16:9':'1536x864','9:16':'864x1536','4:3':'1152x864','3:4':'864x1152','3:2':'1536x1024','2:3':'1024x1536','21:9':'1792x768',adaptive:'auto'};
  if(!sizes[ratio])throw new HttpError(400,'千问图片 3.0 不支持所选画面比例');return sizes[ratio];
}
export async function generateBailianImage(config:ProviderConfig,input:ImageInput):Promise<{url:string}>{
  if(!imageModels.has(config.model))throw new HttpError(400,'当前百炼图片适配器仅支持 qwen-image-3.0 和 qwen-image-3.0-pro；其他版本需要对应协议，不会调用旧版接口');
  if(!input.prompt.trim())throw new HttpError(400,'请输入图片生成或编辑提示词');
  const references=input.references||[];if(references.length>3)throw new HttpError(400,'千问图片 3.0 最多支持 3 张参考图，请减少连接的图片节点');
  const mime=new Set(['image/jpeg','image/jpg','image/png','image/bmp','image/tiff','image/webp','image/gif']);
  const images=references.map(ref=>dataReference(ref.dataUrl,10*1024*1024,mime,'千问图片 3.0').url);
  const body=await request(config,'/compatible-mode/v1/images/generations',{method:'POST',timeout:600000,body:{model:config.model,prompt:input.prompt,n:1,size:imageSize(input.aspectRatio),...(images.length?{image:images.length===1?images[0]:images}:{})}});
  const first=Array.isArray(body.data)?body.data[0]:undefined;const url=record(first)?resultUrl(first.url):undefined;
  if(!url)throw new HttpError(502,'千问图片 3.0 未返回有效的 data[0].url，生成状态不确定，请核对供应商记录',true);
  return {url};
}
function hasPngTransparency(bytes:Buffer){
  if(bytes.length<33||bytes.subarray(1,4).toString()!=='PNG')return false;
  if(bytes[25]===4||bytes[25]===6)return true;
  for(let offset=8;offset+12<=bytes.length;){const length=bytes.readUInt32BE(offset),type=bytes.subarray(offset+4,offset+8).toString();if(type==='tRNS')return true;if(type==='IEND')break;if(length>bytes.length-offset-12)break;offset+=length+12}
  return false;
}
export async function submitBailianVideo(config:ProviderConfig,input:VideoInput):Promise<string>{
  const textMode=textVideoModels.has(config.model),imageMode=imageVideoModels.has(config.model);
  if(!textMode&&!imageMode)throw new HttpError(400,'当前百炼视频适配器仅支持 wan2.7-t2v、wan2.7-t2v-2026-06-12 和 wan2.7-i2v-2026-04-25；其他版本需要对应协议');
  const references=input.references||[],duration=input.duration??5;
  if(!Number.isInteger(duration)||duration<2||duration>15)throw new HttpError(400,'万相 2.7 视频时长必须是 2–15 秒的整数');
  if(!input.prompt.trim()||[...input.prompt].length>5000)throw new HttpError(400,'万相 2.7 提示词需要 1–5000 个字符');
  const parameters:Record<string,unknown>={resolution:'720P',duration};const videoInput:Record<string,unknown>={prompt:input.prompt};
  if(textMode){
    if(references.length)throw new HttpError(400,'所选 wan2.7-t2v 是文生视频模型；使用参考图时请选择已适配的 wan2.7-i2v-2026-04-25');
    const ratio=input.aspectRatio||'16:9';if(!['16:9','9:16','1:1','4:3','3:4'].includes(ratio))throw new HttpError(400,'万相 2.7 文生视频仅支持 16:9、9:16、1:1、4:3、3:4');parameters.ratio=ratio;
  }else{
    if(references.length!==1)throw new HttpError(400,'万相 2.7 图生视频当前需要且仅接受 1 张首帧图；请只连接一个图片节点');
    const ref=dataReference(references[0].dataUrl,20*1024*1024,new Set(['image/jpeg','image/jpg','image/png','image/bmp','image/webp']),'万相 2.7 首帧');
    if(ref.mime==='image/png'&&ref.bytes&&hasPngTransparency(ref.bytes))throw new HttpError(415,'万相 2.7 首帧不支持带透明通道的 PNG，请先转换为无透明通道的 PNG 或 JPEG');
    videoInput.media=[{type:'first_frame',url:ref.url}];
    // The i2v contract derives aspect ratio from the first frame and has no ratio parameter.
  }
  const body=await request(config,'/api/v1/services/aigc/video-generation/video-synthesis',{method:'POST',async:true,body:{model:config.model,input:videoInput,parameters}});
  const output=body.output;if(!record(output)||typeof output.task_id!=='string'||!output.task_id||output.task_id.length>200)throw new HttpError(502,'百炼视频未返回有效的 output.task_id，提交状态不确定，请核对请求记录',true);
  return output.task_id;
}
const pollCache=new Map<string,{at:number;state:BailianVideoState}>();
const pollInFlight=new Map<string,Promise<BailianVideoState>>();
export async function pollBailianVideo(config:ProviderConfig,id:string):Promise<BailianVideoState>{
  if(!/^[a-zA-Z0-9_-]{1,200}$/.test(id))throw new HttpError(400,'百炼视频任务 ID 格式无效');
  const cacheKey=createHash('sha256').update(config.baseUrl+'\0'+config.key+'\0'+id).digest('hex');
  const cached=pollCache.get(cacheKey);if(cached&&Date.now()-cached.at<15000)return cached.state;
  const active=pollInFlight.get(cacheKey);if(active)return active;
  const lookup=(async()=>{
    const body=await request(config,'/api/v1/tasks/'+encodeURIComponent(id));
    const output=body.output;if(!record(output)||typeof output.task_status!=='string')throw new HttpError(502,'百炼视频查询缺少 output.task_status；任务 ID 已保留，请继续查询');
    if(output.task_id!==undefined&&output.task_id!==id)throw new HttpError(502,'百炼视频查询返回的任务 ID 不匹配');
    let state:BailianVideoState;
    switch(output.task_status){
      case 'PENDING':state={status:'queued'};break;
      case 'RUNNING':state={status:'running'};break;
      case 'SUCCEEDED':{const url=resultUrl(output.video_url);if(!url)throw new HttpError(502,'百炼视频已生成，但查询中缺少有效视频 URL；保留任务 ID，继续查询而不重新生成');state={status:'succeeded',content:{video_url:url}};break}
      case 'FAILED':state={status:'failed',error:{message:[clean(config,output.code),clean(config,output.message)].filter(Boolean).join('：')||'百炼视频任务生成失败'}};break;
      case 'CANCELED':state={status:'cancelled',error:{message:'百炼视频任务已取消'}};break;
      case 'UNKNOWN':throw new HttpError(502,'百炼任务不存在或已超过 24 小时查询有效期；原任务 ID 已保留，请先核对供应商记录，勿重复提交');
      default:throw new HttpError(502,'百炼返回未知任务状态；原任务 ID 已保留，请继续查询');
    }
    if(pollCache.size>=1000)pollCache.delete(pollCache.keys().next().value!);pollCache.set(cacheKey,{at:Date.now(),state});return state;
  })();
  pollInFlight.set(cacheKey,lookup);try{return await lookup}finally{pollInFlight.delete(cacheKey)}
}

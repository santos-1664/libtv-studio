import { randomUUID } from 'node:crypto';
import type { CreativeNodeData } from '../shared/types';
import { Configuration } from './config';
import type { ProviderConfig } from './config';
import { Store } from './store';
import type { JobRecord } from './store';
import { HttpError, messageOf } from './errors';
import { assetDataUrl, downloadMedia, persistMedia } from './media';
import { chat, generateImage, submitVideo, pollVideo } from './providers';

type Input={prompt:string;aspectRatio?:string;duration?:number;references:{dataUrl:string;name:string}[]};
export class JobEngine {
  private running=new Set<string>();private stopped=false;private timer:ReturnType<typeof setInterval>|undefined;
  constructor(private store:Store,private config:Configuration){}
  start(){this.recover();this.timer=setInterval(()=>{for(const job of this.store.activeJobs())void this.run(job.id)},5000);this.timer.unref()}
  stop(){this.stopped=true;if(this.timer)clearInterval(this.timer)}
  recover(){for(const job of this.store.activeJobs()){if(job.phase==='submitting'&&!job.externalId&&!job.resultJson){this.fail(job,'服务在提交期间重启，供应商可能已收到请求。请核对供应商记录；系统不会自动重复提交。',true)}else void this.run(job.id)}}
  create(projectId:string,nodeId:string,key:string=randomUUID()):JobRecord{
    const existing=this.store.existingJob(projectId,nodeId,key);if(existing)return existing;
    const active=this.store.activeJobs(projectId).find(j=>j.nodeId===nodeId);if(active)return active;
    if(this.store.ambiguousJob(projectId,nodeId))throw new HttpError(409,'该节点有提交状态不确定的任务。请先在供应商核对请求记录，再通过任务确认接口解除重试保护。');
    const canvas=this.store.canvas(projectId),node=canvas.nodes.find(n=>n.id===nodeId);if(!node)throw new HttpError(404,'节点不存在');
    let provider=this.config.provider(node.data.kind,node.data.model);const inputs=canvas.edges.filter(e=>e.target===nodeId).map(e=>canvas.nodes.find(n=>n.id===e.source)).filter(Boolean);
    const referenceText=inputs.filter(n=>n!.data.kind==='text').map(n=>n!.data.text||n!.data.prompt).filter(Boolean).join('\n\n');const prompt=[node.data.prompt,referenceText?`参考内容：\n${referenceText}`:''].filter(Boolean).join('\n\n').trim();if(!prompt)throw new HttpError(400,'请先输入生成提示词，或连接一个文本节点');
    const imageNodes=inputs.filter(n=>n!.data.kind==='image'&&n!.data.assetId);const references=imageNodes.slice(0,8).map(n=>({dataUrl:assetDataUrl(this.store,n!.data.assetId!,projectId),name:n!.data.title+'.png'}));
    // The default Wan family has separate text and first-frame endpoints/models.
    // Only resolve an automatic model choice; an explicit node choice stays authoritative.
    if(node.data.kind==='video'&&!node.data.model&&references.length&&provider.protocol==='bailian'&&['wan2.7-t2v','wan2.7-t2v-2026-06-12'].includes(provider.model)){
      provider={...provider,model:'wan2.7-i2v-2026-04-25'};
    }
    const input:Input={prompt,aspectRatio:node.data.aspectRatio,duration:node.data.duration,references};
    const job=this.store.insertJob(projectId,nodeId,node.data.kind,input,this.config.encrypt(provider),key);queueMicrotask(()=>void this.run(job.id));return job;
  }
  private fail(job:JobRecord,error:string,ambiguous=false){this.store.updateJob(job.id,{status:'failed',error:error.slice(0,1900),ambiguous:ambiguous?1:0});this.store.setNodeJob(job,{status:'failed',error:error.slice(0,1900)})}
  async run(id:string){if(this.stopped||this.running.has(id)||this.running.size>=4)return;const initial=this.store.job(id);if(!['queued','running'].includes(initial.status))return;this.running.add(id);
    try{
      let job=this.store.job(id);const config=this.config.decrypt<ProviderConfig>(job.providerJson),input=JSON.parse(job.inputJson) as Input;
      this.store.updateJob(id,{status:'running'});this.store.setNodeJob(job,{status:'running',error:undefined});
      let result:any=job.resultJson?JSON.parse(job.resultJson):undefined;
      if(!result&&job.kind==='text'){
        this.store.updateJob(id,{phase:'submitting'});const content:unknown[]=[{type:'text',text:input.prompt},...input.references.map(r=>({type:'image_url',image_url:{url:r.dataUrl}}))];
        const response=await chat(config,[{role:'system',content:'你是专业影视创作助手。按用户要求给出可直接用于创作的内容，使用中文。'},{role:'user',content:input.references.length?content:input.prompt}]);if(this.stopped)return;result={text:response.content};if(!result.text)throw new HttpError(502,'模型未返回文本内容');this.store.updateJob(id,{resultJson:JSON.stringify(result),phase:'result'});
      }
      if(!result&&job.kind==='image'){this.store.updateJob(id,{phase:'submitting'});result=await generateImage(config,input);if(this.stopped)return;this.store.updateJob(id,{resultJson:JSON.stringify(result),phase:'result'})}
      if(!result&&job.kind==='video'){
        if(!job.externalId){this.store.updateJob(id,{phase:'submitting'});const externalId=await submitVideo(config,input);if(this.stopped)return;this.store.updateJob(id,{externalId,phase:'submitted'});job=this.store.job(id)}
        let state;try{state=await pollVideo(config,job.externalId!);if(this.stopped)return}catch(error){if(this.stopped)return;this.store.updateJob(id,{error:messageOf(error)});return}
        if(['failed','cancelled','expired'].includes(state.status))throw new HttpError(502,state.error?.message||'视频生成失败');if(state.status!=='succeeded')return;
        if(!state.content?.video_url)throw new HttpError(502,'视频生成完成，但没有返回视频地址');result={url:state.content.video_url};this.store.updateJob(id,{resultJson:JSON.stringify(result),phase:'result'});
      }
      const patch:Partial<CreativeNodeData>={status:'succeeded',error:undefined};
      if(job.kind==='text')patch.text=result.text;
      else{let bytes:Buffer;try{bytes=result.b64_json?Buffer.from(result.b64_json,'base64'):await downloadMedia(result.url);if(this.stopped)return}catch(error){if(this.stopped)return;this.store.updateJob(id,{error:messageOf(error),phase:'result'});return}const asset=persistMedia(this.store,job.projectId,`${job.kind==='image'?'生成图片':'生成视频'}-${job.nodeId}`,bytes,job.kind);patch.url=asset.url;patch.assetId=asset.id}
      this.store.updateJob(id,{status:'succeeded',error:null,phase:'complete'});this.store.setNodeJob(job,patch);
    }catch(error){if(!this.stopped){const job=this.store.job(id);const ambiguous=error instanceof HttpError?error.ambiguous:job.phase==='submitting';this.fail(job,messageOf(error),ambiguous)}}finally{this.running.delete(id)}
  }
  resolve(projectId:string,id:string){const job=this.store.job(id);if(job.projectId!==projectId)throw new HttpError(404,'任务不存在');if(!job.ambiguous)throw new HttpError(409,'该任务不需要解除提交保护');this.store.updateJob(id,{ambiguous:0});}
}

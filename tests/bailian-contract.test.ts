// Loopback-only contract fixtures. No real API Key, real provider request, or paid media generation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ProviderConfig } from '../server/config';
import { HttpError } from '../server/errors';
import { listBailianModels, generateBailianImage, submitBailianVideo, pollBailianVideo } from '../server/bailian';
import { generateImage, submitVideo, pollVideo, listModels, chat } from '../server/providers';
const fakeKey='bailian-local-contract-not-a-real-key';
const jpeg='data:image/jpeg;base64,/9j/2Q==';
const resultImage='https://example.com/local-contract-image.png';
const resultVideo='https://example.com/local-contract-video.mp4';
async function gateway(handler:(req:IncomingMessage,res:ServerResponse)=>void,run:(config:ProviderConfig)=>Promise<void>){
  const server=createServer(handler);server.listen(0,'127.0.0.1');await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject)});
  const config:ProviderConfig={protocol:'bailian',kind:'image',baseUrl:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,key:fakeKey,model:'qwen-image-3.0'};
  try{await run(config)}finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()))}
}
async function json(req:IncomingMessage){let text='';for await(const chunk of req)text+=chunk;return JSON.parse(text)}
function send(res:ServerResponse,body:unknown,status=200){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body))}
const fail=(pattern:RegExp,ambiguous?:boolean)=>(error:unknown)=>{assert.ok(error instanceof HttpError);assert.match(error.message,pattern);assert.ok(!error.message.includes(fakeKey));if(ambiguous!==undefined)assert.equal(error.ambiguous,ambiguous);return true};

test('Bailian catalog uses origin /api/v1/models, capability filter and all pages; input Video never means generated Video',async()=>{
  const pages:number[]=[];
  await gateway((req,res)=>{
    const url=new URL(req.url!,'http://localhost');assert.equal(url.pathname,'/api/v1/models');assert.equal(req.method,'GET');assert.equal(req.headers.authorization,'Bearer '+fakeKey);assert.equal(req.headers.sys_name,undefined);assert.equal(url.searchParams.get('capabilities'),'IG');assert.equal(url.searchParams.get('page_size'),'100');const page=Number(url.searchParams.get('page_no'));pages.push(page);
    send(res,{success:true,code:null,output:{total:3,page_no:page,page_size:100,models:page===1?[{model:'qwen-image-3.0',provider:'qwen',capabilities:['IG'],features:[],inference_metadata:{request_modality:['Text','Image'],response_modality:['Image']}},{model:'vision-only',provider:'qwen',capabilities:['VU'],inference_metadata:{request_modality:['Video','Image'],response_modality:['Text']}}]:[{model:'qwen-image-2.0',provider:'qwen',capabilities:['IG'],inference_metadata:{request_modality:['Text'],response_modality:['Image']}}]}});
  },async config=>{const models=await listBailianModels(config,'image');assert.deepEqual(pages,[1,2]);assert.deepEqual(models.map(m=>m.model_name),['qwen-image-3.0','qwen-image-2.0']);assert.equal(models[0].is_use_image,1);assert.equal(models[0].adapterSupported,true);assert.equal(models[1].adapterSupported,false)});
});

test('Bailian catalog errors and stalled pagination are explicit and credential-safe',async()=>{
  await gateway((_req,res)=>send(res,{success:false,code:'InvalidApiKey',message:`Invalid key ${fakeKey}`}),async config=>{await assert.rejects(listBailianModels(config,'video'),fail(/鉴权失败.*InvalidApiKey/))});
  await gateway((req,res)=>{const page=Number(new URL(req.url!,'http://localhost').searchParams.get('page_no'));send(res,{output:{total:9,page_no:page,models:[{model:'same-model',capabilities:['VG']}]}})},async config=>{await assert.rejects(listBailianModels(config,'video'),fail(/分页没有进展/))});
  await gateway((_req,res)=>send(res,{output:{models:[]}}),async config=>{await assert.rejects(listModels(config),fail(/output.total/))});
});

test('Qwen Image 3 uses JSON generations for text-to-image and exact image extension for editing',async()=>{
  const bodies:any[]=[];
  await gateway((req,res)=>{assert.equal(req.url,'/compatible-mode/v1/images/generations');assert.equal(req.method,'POST');assert.equal(req.headers['content-type'],'application/json');assert.equal(req.headers.sys_name,undefined);assert.equal(req.headers['x-dashscope-async'],undefined);void json(req).then(body=>{bodies.push(body);send(res,{data:[{url:resultImage}]})})},async config=>{
    assert.deepEqual(await generateImage(config,{prompt:'一杯咖啡',aspectRatio:'16:9'}),{url:resultImage});
    assert.deepEqual(await generateImage({...config,model:'qwen-image-3.0-pro'},{prompt:'改成近景',references:[{dataUrl:jpeg,name:'reference.jpg'}]}),{url:resultImage});
    await generateBailianImage(config,{prompt:'两张图融合',references:[{dataUrl:jpeg},{dataUrl:jpeg}]});
    assert.deepEqual(bodies[0],{model:'qwen-image-3.0',prompt:'一杯咖啡',n:1,size:'1536x864'});assert.equal(bodies[1].image,jpeg);assert.deepEqual(bodies[2].image,[jpeg,jpeg]);assert.equal(bodies[1].response_format,undefined);assert.equal(bodies[1].mask,undefined);
  });
});

test('Qwen Image 3 validates version, reference count, 10 MB limit and ratio before a paid request',async()=>{
  let requests=0;await gateway((_req,res)=>{requests++;send(res,{})},async config=>{
    await assert.rejects(generateBailianImage({...config,model:'qwen-image-2.0'},{prompt:'test'}),fail(/仅支持 qwen-image-3.0/));
    await assert.rejects(generateBailianImage(config,{prompt:'test',references:Array.from({length:4},()=>({dataUrl:jpeg}))}),fail(/最多支持 3 张/));
    await assert.rejects(generateBailianImage(config,{prompt:'test',references:[{dataUrl:'data:image/jpeg;base64,'+'A'.repeat(Math.ceil(10*1024*1024*4/3)+2048)}]}),fail(/10 MB/));
    await assert.rejects(generateBailianImage(config,{prompt:'test',aspectRatio:'8:7'}),fail(/不支持所选画面比例/));
    await assert.rejects(generateBailianImage(config,{prompt:'test',references:[{dataUrl:'data:image/svg+xml;base64,PHN2Zz4='}]}),fail(/图像格式/));assert.equal(requests,0);
  });
});

test('Bailian image missing URL and HTTP failure preserve ambiguity without a duplicate submit',async()=>{
  let count=0;await gateway((_req,res)=>{count++;send(res,{data:[{b64_json:'not-the-documented-result'}]})},async config=>{await assert.rejects(generateImage(config,{prompt:'test'}),fail(/data\[0\].url/,true));assert.equal(count,1)});
  await gateway((_req,res)=>send(res,{code:'InternalError',message:`temporary ${fakeKey}`},503),async config=>{await assert.rejects(generateImage(config,{prompt:'test'}),fail(/HTTP 503.*InternalError/,true))});
});

test('Wan 2.7 text-to-video uses native async request, 720P, explicit duration and ratio',async()=>{
  await gateway((req,res)=>{assert.equal(req.url,'/api/v1/services/aigc/video-generation/video-synthesis');assert.equal(req.headers['x-dashscope-async'],'enable');assert.equal(req.headers.authorization,'Bearer '+fakeKey);assert.equal(req.headers.sys_name,undefined);void json(req).then(body=>{assert.deepEqual(body,{model:'wan2.7-t2v',input:{prompt:'咖啡杯缓缓转动'},parameters:{resolution:'720P',duration:2,ratio:'9:16'}});send(res,{output:{task_id:'test-t2v',task_status:'PENDING'}})})},async config=>{assert.equal(await submitVideo({...config,kind:'video',model:'wan2.7-t2v'},{prompt:'咖啡杯缓缓转动',duration:2,aspectRatio:'9:16'}),'test-t2v')});
});

test('Wan 2.7 image-to-video sends first_frame media, not old img_url or Ark content; ratio follows source image',async()=>{
  await gateway((req,res)=>{assert.equal(req.url,'/api/v1/services/aigc/video-generation/video-synthesis');void json(req).then(body=>{assert.deepEqual(body,{model:'wan2.7-i2v-2026-04-25',input:{prompt:'镜头向前推进',media:[{type:'first_frame',url:jpeg}]},parameters:{resolution:'720P',duration:5}});send(res,{output:{task_id:'test-i2v',task_status:'PENDING'}})})},async config=>{assert.equal(await submitBailianVideo({...config,kind:'video',model:'wan2.7-i2v-2026-04-25'},{prompt:'镜头向前推进',aspectRatio:'16:9',references:[{dataUrl:jpeg}]}),'test-i2v')});
});

test('Wan adapters reject unsupported versions, wrong workflow, multiple first frames and invalid timing without sending requests',async()=>{
  let count=0;await gateway((_req,res)=>{count++;send(res,{})},async config=>{
    const textConfig={...config,kind:'video' as const,model:'wan2.7-t2v'},imageConfig={...textConfig,model:'wan2.7-i2v-2026-04-25'};
    await assert.rejects(submitBailianVideo({...textConfig,model:'wan2.6-t2v'},{prompt:'test'}),fail(/仅支持 wan2.7/));
    await assert.rejects(submitBailianVideo(textConfig,{prompt:'test',references:[{dataUrl:jpeg}]}),fail(/是文生视频模型/));
    await assert.rejects(submitBailianVideo(imageConfig,{prompt:'test'}),fail(/仅接受 1 张首帧/));
    await assert.rejects(submitBailianVideo(imageConfig,{prompt:'test',references:[{dataUrl:jpeg},{dataUrl:jpeg}]}),fail(/仅接受 1 张首帧/));
    await assert.rejects(submitBailianVideo(textConfig,{prompt:'test',duration:20}),fail(/2–15 秒/));
    await assert.rejects(submitBailianVideo(textConfig,{prompt:'test',aspectRatio:'21:9'}),fail(/仅支持 16:9/));
    await assert.rejects(submitBailianVideo(imageConfig,{prompt:'test',references:[{dataUrl:'data:image/gif;base64,R0lGODlh'}]}),fail(/图像格式/));
    const transparent=Buffer.alloc(33);transparent.write('PNG',1);transparent[25]=6;
    await assert.rejects(submitBailianVideo(imageConfig,{prompt:'test',references:[{dataUrl:'data:image/png;base64,'+transparent.toString('base64')}]}),fail(/透明通道/));assert.equal(count,0);
  });
});

test('Wan task poll maps native statuses and caches successful queries for the recommended 15 seconds',async()=>{
  let requests=0;await gateway((req,res)=>{requests++;assert.equal(req.method,'GET');assert.equal(req.headers['x-dashscope-async'],undefined);const id=req.url!.split('/').pop()!;assert.match(req.url!,/^\/api\/v1\/tasks\//);send(res,{output:{task_id:id,task_status:id,...(id==='SUCCEEDED'?{video_url:resultVideo}:{}),...(id==='FAILED'?{code:'InvalidParameter',message:'The size does not match'}:{})}})},async config=>{
    const videoConfig={...config,kind:'video' as const,model:'wan2.7-t2v'};
    assert.deepEqual(await pollVideo(videoConfig,'PENDING'),{status:'queued'});assert.deepEqual(await pollVideo(videoConfig,'RUNNING'),{status:'running'});
    assert.deepEqual(await pollVideo(videoConfig,'SUCCEEDED'),{status:'succeeded',content:{video_url:resultVideo}});
    assert.deepEqual(await pollVideo(videoConfig,'FAILED'),{status:'failed',error:{message:'InvalidParameter：The size does not match'}});
    assert.deepEqual(await pollVideo(videoConfig,'CANCELED'),{status:'cancelled',error:{message:'百炼视频任务已取消'}});
    assert.deepEqual(await pollVideo(videoConfig,'RUNNING'),{status:'running'});assert.equal(requests,5);
  });
});

test('UNKNOWN or malformed successful results preserve the external task instead of synthesizing success or resubmitting',async()=>{
  let posts=0;await gateway((req,res)=>{if(req.method==='POST')posts++;const id=req.url!.split('/').pop()!;send(res,{output:{task_id:id,task_status:id==='unknown'?'UNKNOWN':'SUCCEEDED'}})},async config=>{
    await assert.rejects(pollBailianVideo(config,'unknown'),fail(/24 小时.*任务 ID 已保留/));
    await assert.rejects(pollBailianVideo(config,'missing-url'),fail(/缺少有效视频 URL/));assert.equal(posts,0);
  });
});

test('Bailian origin validation prevents silently appending paths and text requires the explicit OpenAI-compatible protocol',async()=>{
  let count=0;await gateway((_req,res)=>{count++;send(res,{})},async config=>{
    await assert.rejects(listBailianModels({...config,baseUrl:config.baseUrl+'/api/v1'},'image'),fail(/不附加/));
    await assert.rejects(submitBailianVideo({...config,kind:'video',model:'wan2.7-t2v',baseUrl:config.baseUrl+'/compatible-mode/v1'},{prompt:'test'}),fail(/不附加/));
    await assert.rejects(chat({...config,kind:'text'},[{role:'user',content:'test'}]),fail(/OpenAI 兼容服务地址和 API Key/));assert.equal(count,0);
  });
});

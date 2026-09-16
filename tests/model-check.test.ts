import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app';

async function listen(server:Server){
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve())});
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server:Server){await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}

test('model checks use draft credentials without persisting them, and allow selecting the first model',async()=>{
  let received:{authorization?:string;sysName?:string|string[];url?:string}={};
  const gateway=createServer((req,res)=>{
    received={authorization:req.headers.authorization,sysName:req.headers.sys_name,url:req.url};
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({code:0,message:'success',data:{models:[{model_name:'contract-test-model',manufacturer:'local-test'}]}}));
  });
  const gatewayUrl=await listen(gateway);
  const dir=mkdtempSync(path.join(tmpdir(),'libtv-catalog-'));
  const runtime=createApp({dataDir:dir,env:{},startJobs:false});
  const server=createServer(runtime.app);
  try{
    const base=await listen(server);
    const response=await fetch(base+'/api/models/check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({textBaseUrl:gatewayUrl,textKey:'draft-credential-for-local-test'})});
    assert.equal(response.status,200);
    const body=await response.json();
    assert.equal(body.models[0].model_name,'contract-test-model');
    assert.ok(Number.isFinite(Date.parse(body.checkedAt)));
    assert.deepEqual(received,{authorization:'Bearer draft-credential-for-local-test',sysName:undefined,url:'/v1/models'});
    assert.equal(runtime.config.settings().textKey,'');
    assert.equal(runtime.config.settings().textModel,'');
    assert.ok(!runtime.store.setting('providers'));
    assert.ok(!JSON.stringify(body).includes('draft-credential'));
    assert.equal(runtime.config.status(true,false).services.text.configured,false);
  }finally{await close(server);runtime.close();await close(gateway);rmSync(dir,{recursive:true,force:true})}
});

test('catalog configuration reuses saved credentials, needs no model, and rejects unsafe or unsupported input',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'libtv-catalog-config-'));
  const runtime=createApp({dataDir:dir,env:{},startJobs:false});
  try{
    assert.throws(()=>runtime.config.modelCatalog(),/API Key/);
    runtime.config.update({textKey:'saved-local-test',textBaseUrl:'https://gateway.example/v1'});
    const config=runtime.config.modelCatalog({textKey:'',textBaseUrl:'https://gateway.example/compatible-mode/v1'});
    assert.equal(config.key,'saved-local-test');
    assert.equal(config.model,'');
    assert.equal(config.protocol,'openai');
    assert.equal(config.baseUrl,'https://gateway.example/compatible-mode/v1');
    assert.equal(runtime.config.settings().textBaseUrl,'https://gateway.example/v1');
    assert.throws(()=>runtime.config.modelCatalog({textBaseUrl:'http://remote.example'}),/HTTPS/);
    assert.throws(()=>runtime.config.modelCatalog({textBaseUrl:'https://user:password@example.com'}),/格式无效/);
    assert.throws(()=>runtime.config.modelCatalog({textModel:'not-part-of-this-endpoint'}));
    assert.throws(()=>runtime.config.modelCatalog({sysName:'含空格 invalid'}));
  }finally{runtime.close();rmSync(dir,{recursive:true,force:true})}
});

test('model check API rejects missing credentials and unsupported fields without creating settings',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'libtv-catalog-errors-'));
  const runtime=createApp({dataDir:dir,env:{},startJobs:false});
  const server=createServer(runtime.app);
  try{
    const base=await listen(server);
    const check=(body:unknown)=>fetch(base+'/api/models/check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const missing=await check({});
    assert.equal(missing.status,503);
    assert.match((await missing.json()).error,/API Key/);
    assert.equal((await check({imageKey:'not-allowed'})).status,400);
    assert.equal((await fetch(base+'/api/models')).status,503);
    assert.ok(!runtime.store.setting('providers'));
  }finally{await close(server);runtime.close();rmSync(dir,{recursive:true,force:true})}
});

test('blank or omitted text keys only preserve credentials on the same origin, for both save and catalog checks',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'libtv-origin-config-'));
  const runtime=createApp({dataDir:dir,env:{},startJobs:false});
  try{
    runtime.config.update({textKey:'saved-origin-key',textBaseUrl:'https://models.example/v1',textModel:'model-one'});
    runtime.config.update({textBaseUrl:'https://MODELS.example:443/compatible-mode/v1/',textKey:'   ',textModel:'model-two'});
    assert.equal(runtime.config.settings().textKey,'saved-origin-key');
    assert.equal(runtime.config.modelCatalog({textBaseUrl:'https://models.example/v1',textKey:''}).key,'saved-origin-key');
    const before=runtime.store.setting('providers');
    for(const textBaseUrl of ['https://elsewhere.example/v1','https://models.example:8443/v1','']){
      for(const keyPatch of [{},{textKey:''},{textKey:'  '}]){
        assert.throws(()=>runtime.config.update({textBaseUrl,...keyPatch}),/新 API Key/);
        assert.throws(()=>runtime.config.modelCatalog({textBaseUrl,...keyPatch}),/新 API Key/);
        assert.equal(runtime.store.setting('providers'),before);
      }
    }
    const draft=runtime.config.modelCatalog({textBaseUrl:'https://elsewhere.example/v1',textKey:'new-origin-key'});
    assert.equal(draft.key,'new-origin-key');
    assert.equal(runtime.store.setting('providers'),before);
    runtime.config.update({textBaseUrl:'https://elsewhere.example/v1',textKey:'new-origin-key'});
    assert.equal(runtime.config.provider('text').key,'new-origin-key');
  }finally{runtime.close();rmSync(dir,{recursive:true,force:true})}
});

test('changing the connection origin never sends the previous API key to a local HTTP server',async()=>{
  const received:string[]=[];
  const gateway=createServer((req,res)=>{received.push(req.headers.authorization||'');res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:[{id:'new-origin-model'}]}))});
  const gatewayUrl=await listen(gateway);
  const dir=mkdtempSync(path.join(tmpdir(),'libtv-origin-http-'));
  const runtime=createApp({dataDir:dir,env:{},startJobs:false});
  const server=createServer(runtime.app);
  try{
    runtime.config.update({textBaseUrl:'https://previous.example/v1',textKey:'previous-origin-key',textModel:'previous-model'});
    const base=await listen(server);
    for(const route of ['/api/models/check','/api/settings']){
      for(const keyPatch of [{},{textKey:''}]){
        const response=await fetch(base+route,{method:route.endsWith('check')?'POST':'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({textBaseUrl:gatewayUrl,...keyPatch})});
        assert.equal(response.status,400);assert.match((await response.json()).error,/新 API Key/);
      }
    }
    assert.deepEqual(received,[]);
    const response=await fetch(base+'/api/models/check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({textBaseUrl:gatewayUrl+'/compatible-mode/v1',textKey:'new-origin-key'})});
    assert.equal(response.status,200);
    assert.equal((await response.json()).models[0].model_name,'new-origin-model');
    assert.deepEqual(received,['Bearer new-origin-key']);
    assert.equal(runtime.config.settings().textKey,'previous-origin-key');
  }finally{await close(server);runtime.close();await close(gateway);rmSync(dir,{recursive:true,force:true})}
});

test('same-origin catalog checks send the saved API key when the key is blank or omitted',async()=>{
  const received:{authorization?:string;url?:string}[]=[];
  const gateway=createServer((req,res)=>{received.push({authorization:req.headers.authorization,url:req.url});res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:[{id:'saved-key-model'}]}))});
  const gatewayUrl=await listen(gateway);
  const dir=mkdtempSync(path.join(tmpdir(),'libtv-same-origin-http-'));
  const runtime=createApp({dataDir:dir,env:{},startJobs:false});
  const server=createServer(runtime.app);
  try{
    runtime.config.update({textBaseUrl:gatewayUrl+'/v1',textKey:'same-origin-api-key'});
    const before=runtime.store.setting('providers');
    const base=await listen(server);
    for(const keyPatch of [{textKey:''},{}]){
      const response=await fetch(base+'/api/models/check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({textBaseUrl:gatewayUrl+'/compatible-mode/v1/',...keyPatch})});
      assert.equal(response.status,200);assert.equal((await response.json()).models[0].model_name,'saved-key-model');
    }
    assert.deepEqual(received,[
      {authorization:'Bearer same-origin-api-key',url:'/compatible-mode/v1/models'},
      {authorization:'Bearer same-origin-api-key',url:'/compatible-mode/v1/models'}
    ]);
    assert.equal(runtime.store.setting('providers'),before);
  }finally{await close(server);runtime.close();await close(gateway);rmSync(dir,{recursive:true,force:true})}
});

test('legacy saved tokens and environment tokens are discarded rather than reused as API keys',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'libtv-legacy-config-'));
  const runtime=createApp({dataDir:dir,env:{TEXT_TOKEN:'legacy-environment-token',SYS_NAME:'legacy-system'},startJobs:false});
  try{
    runtime.store.setSetting('providers',runtime.config.encrypt({sysName:'legacy-system',textToken:'legacy-saved-token',textBaseUrl:'https://previous.example/legacy',textModel:'saved-model',imageKey:'preserved-image-key',imageProvider:'bailian'}));
    const settings=runtime.config.settings();
    assert.equal(settings.textKey,'');assert.equal(settings.imageKey,'preserved-image-key');
    assert.equal(settings.imageProvider,'bailian');
    assert.ok(!('sysName' in settings));assert.ok(!('textToken' in settings));
    assert.equal(runtime.config.status(true,false).services.text.configured,false);
    assert.throws(()=>runtime.config.provider('text'),/尚未配置/);
    assert.throws(()=>runtime.config.modelCatalog(),/API Key/);
    runtime.config.update({imageModel:'image-model'});
    const cleaned=runtime.config.decrypt<Record<string,unknown>>(runtime.store.setting('providers')!);
    assert.equal(cleaned.textKey,'');assert.ok(!('textToken' in cleaned));assert.ok(!('sysName' in cleaned));
    runtime.config.update({textBaseUrl:'https://new.example/v1',textKey:'new-explicit-key'});
    const persisted=runtime.config.decrypt<Record<string,unknown>>(runtime.store.setting('providers')!);
    assert.equal(persisted.textKey,'new-explicit-key');
    assert.ok(!('sysName' in persisted));assert.ok(!('textToken' in persisted));
    assert.ok(!JSON.stringify(persisted).includes('legacy'));
    assert.throws(()=>runtime.config.update({textToken:'obsolete-field'}));
    assert.throws(()=>runtime.config.modelCatalog({sysName:'obsolete-field'}));
  }finally{runtime.close();rmSync(dir,{recursive:true,force:true})}
});

test('TEXT_API_KEY is supported and an environment key is not attached to an unrelated saved URL',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'libtv-env-origin-'));
  const runtime=createApp({dataDir:dir,env:{TEXT_API_KEY:'environment-api-key',TEXT_BASE_URL:'https://environment.example/v1',TEXT_MODEL:'env-model'},startJobs:false});
  try{
    assert.equal(runtime.config.provider('text').key,'environment-api-key');
    assert.equal(runtime.config.provider('text').protocol,'openai');
    runtime.store.setSetting('providers',runtime.config.encrypt({textBaseUrl:'https://saved.example/v1',textToken:'legacy-token'}));
    assert.equal(runtime.config.settings().textKey,'');
    assert.throws(()=>runtime.config.modelCatalog(),/API Key/);
    runtime.store.setSetting('providers',runtime.config.encrypt({textBaseUrl:'https://environment.example/compatible-mode/v1'}));
    assert.equal(runtime.config.modelCatalog().key,'environment-api-key');
  }finally{runtime.close();rmSync(dir,{recursive:true,force:true})}
});

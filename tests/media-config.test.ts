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

for(const kind of ['image','video'] as const){
  const key=`${kind}Key` as const,baseUrl=`${kind}BaseUrl` as const,model=`${kind}Model` as const;

  test(`${kind} keys are trimmed and retained only for the same origin unless replaced`,()=>{
    const dir=mkdtempSync(path.join(tmpdir(),`libtv-${kind}-origin-`));
    const runtime=createApp({dataDir:dir,env:{},startJobs:false});
    try{
      runtime.config.update({[baseUrl]:'  https://media.example/v1  ',[key]:'  saved-media-test-key  ',[model]:'test-model'});
      assert.equal(runtime.config.settings()[baseUrl],'https://media.example/v1');
      for(const keyPatch of [{},{[key]:''},{[key]:' \t\n '}]){
        runtime.config.update({[baseUrl]:'  https://MEDIA.example:443/another/path  ',...keyPatch});
        assert.equal(runtime.config.provider(kind).key,'saved-media-test-key');
        assert.equal(runtime.config.provider(kind).baseUrl,'https://MEDIA.example:443/another/path');
      }
      const before=runtime.store.setting('providers');
      for(const nextUrl of ['https://other.example/v1','https://media.example:8443/v1','http://localhost:3100/v1','']){
        for(const keyPatch of [{},{[key]:''},{[key]:' \t\n '}]){
          assert.throws(()=>runtime.config.update({[baseUrl]:` ${nextUrl} `,...keyPatch}),/新 API Key/);
          assert.equal(runtime.store.setting('providers'),before);
        }
      }
      runtime.config.update({[baseUrl]:' https://other.example/v1 ',[key]:' replacement-media-test-key '});
      assert.equal(runtime.config.provider(kind).key,'replacement-media-test-key');
      assert.equal(runtime.config.provider(kind).baseUrl,'https://other.example/v1');
    }finally{runtime.close();rmSync(dir,{recursive:true,force:true})}
  });

  test(`${kind} environment credentials cannot attach to a different saved origin`,()=>{
    const dir=mkdtempSync(path.join(tmpdir(),`libtv-${kind}-env-`));
    const prefix=kind.toUpperCase();
    const env:NodeJS.ProcessEnv={[`${prefix}_BASE_URL`]:' https://environment.example/v1 ',[`${prefix}_API_KEY`]:' env-media-test-key ',[`${prefix}_MODEL`]:'test-model'};
    const runtime=createApp({dataDir:dir,env,startJobs:false});
    try{
      assert.equal(runtime.config.provider(kind).key,'env-media-test-key');
      assert.equal(runtime.config.provider(kind).baseUrl,'https://environment.example/v1');
      runtime.store.setSetting('providers',runtime.config.encrypt({[baseUrl]:' https://ENVIRONMENT.example:443/another/path '}));
      assert.equal(runtime.config.provider(kind).key,'env-media-test-key');
      for(const nextUrl of ['https://saved.example/v1','https://environment.example:8443/v1','']){
        runtime.store.setSetting('providers',runtime.config.encrypt({[baseUrl]:nextUrl}));
        assert.equal(runtime.config.settings()[key],'');
        assert.equal(runtime.config.status(true,false).services[kind].configured,false);
        assert.throws(()=>runtime.config.provider(kind),/尚未配置/);
        // Saving another field must not resurrect the environment key.
        runtime.config.update({[model]:'updated-model'});
        assert.equal(runtime.config.settings()[key],'');
      }
      runtime.store.setSetting('providers',runtime.config.encrypt({[baseUrl]:'https://saved.example/v1',[key]:' saved-explicit-test-key '}));
      assert.equal(runtime.config.provider(kind).key,'saved-explicit-test-key');
      runtime.store.setSetting('providers',runtime.config.encrypt({[baseUrl]:'https://environment.example/v1',[key]:' \t '}));
      assert.equal(runtime.config.settings()[key],'');
      delete env[`${prefix}_BASE_URL`];
      runtime.store.setSetting('providers',runtime.config.encrypt({[baseUrl]:'https://saved.example/v1'}));
      assert.equal(runtime.config.settings()[key],'');
    }finally{runtime.close();rmSync(dir,{recursive:true,force:true})}
  });
}

test('a failed provider validation leaves the entire settings patch unsaved',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'libtv-settings-atomic-'));
  const runtime=createApp({dataDir:dir,env:{},startJobs:false});
  try{
    runtime.config.update({textBaseUrl:'https://text.example/v1',textKey:'text-test-key',textModel:'original-text',imageBaseUrl:'https://image.example/v1',imageKey:'image-test-key',videoBaseUrl:'https://video.example/v1',videoKey:'video-test-key'});
    const before=runtime.store.setting('providers'),settings=runtime.config.settings();
    assert.throws(()=>runtime.config.update({textModel:'must-not-save',imageBaseUrl:'https://new-image.example',imageKey:'new-image-test-key',videoBaseUrl:'https://new-video.example',videoKey:' '}),/新 API Key/);
    assert.equal(runtime.store.setting('providers'),before);
    assert.deepEqual(runtime.config.settings(),settings);
    assert.throws(()=>runtime.config.update({textModel:'must-not-save',imageKey:'new-image-test-key',videoBaseUrl:'https://video.example?invalid=1'}),/格式无效/);
    assert.equal(runtime.store.setting('providers'),before);
  }finally{runtime.close();rmSync(dir,{recursive:true,force:true})}
});

test('media settings API rejects cross-origin key reuse and sends only explicit new keys to the new server',async()=>{
  const oldRequests:string[]=[],newRequests:string[]=[];
  const catalog=(received:string[])=>createServer((req,res)=>{
    received.push(req.headers.authorization||'');
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({output:{models:[],total:0}}));
  });
  const original=catalog(oldRequests),replacement=catalog(newRequests);
  const originalUrl=await listen(original),replacementUrl=await listen(replacement);
  const dir=mkdtempSync(path.join(tmpdir(),'libtv-media-origin-http-'));
  const runtime=createApp({dataDir:dir,env:{},startJobs:false});
  const server=createServer(runtime.app);
  try{
    const appUrl=await listen(server);
    for(const kind of ['image','video'] as const){
      const baseUrl=`${kind}BaseUrl` as const,key=`${kind}Key` as const;
      runtime.config.update({[`${kind}Provider`]:'bailian',[baseUrl]:originalUrl,[key]:`original-${kind}-test-key`,[`${kind}Model`]:'test-model'});
      const before=runtime.store.setting('providers');
      const hitsBefore=newRequests.length;
      for(const keyPatch of [{},{[key]:''},{[key]:' \t\n '}]){
        const response=await fetch(appUrl+'/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({textModel:'must-not-save',[baseUrl]:` ${replacementUrl} `,...keyPatch})});
        assert.equal(response.status,400);
        assert.match((await response.json()).error,/新 API Key/);
        assert.equal(runtime.store.setting('providers'),before);
      }
      const unchangedCatalog=await fetch(appUrl+`/api/models?kind=${kind}`);
      assert.equal(unchangedCatalog.status,200);
      await unchangedCatalog.json();
      assert.equal(oldRequests.at(-1),`Bearer original-${kind}-test-key`);
      assert.equal(newRequests.length,hitsBefore);
      const save=await fetch(appUrl+'/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({[baseUrl]:` ${replacementUrl} `,[key]:` new-${kind}-test-key `})});
      assert.equal(save.status,200);
      const updatedCatalog=await fetch(appUrl+`/api/models?kind=${kind}`);
      assert.equal(updatedCatalog.status,200);
      await updatedCatalog.json();
      assert.equal(newRequests.at(-1),`Bearer new-${kind}-test-key`);
      assert.equal(newRequests.length,hitsBefore+1);
    }
  }finally{await close(server);runtime.close();await close(original);await close(replacement);rmSync(dir,{recursive:true,force:true})}
});

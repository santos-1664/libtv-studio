// OpenAI-compatible contract tests use loopback-only mock servers with synthetic API keys.
// They never contact a real model service or consume paid quota.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chat, checkedFetch, listModels } from '../server/providers';
import type { ProviderConfig } from '../server/config';
import { HttpError } from '../server/errors';

const fakeCredential='contract-test-not-a-real-api-key';
type Handler=(request:IncomingMessage,response:ServerResponse)=>void;
async function withGateway(handler:Handler,run:(config:ProviderConfig)=>Promise<void>) {
  const server=createServer(handler); server.listen(0,'127.0.0.1');
  await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject)});
  const config:ProviderConfig={protocol:'openai',kind:'text',baseUrl:`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,key:fakeCredential,model:'contract-only-model'};
  try { await run(config); }
  finally { server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve())); }
}
const event=(body:unknown,newline='\n')=>`data: ${JSON.stringify(body)}${newline}${newline}`;
const choice=(delta:unknown,finish_reason?:string)=>({choices:[{index:0,delta,...(finish_reason?{finish_reason}:{})}]});
const contentEvent=(text:string)=>event(choice({content:text}));
const toolDelta={tool_calls:[{index:0,id:'call_1',type:'function',function:{name:'update_node',arguments:'{"nodeId":"shot2","prompt":"近景"}'}}]};
const invoke=(config:ProviderConfig)=>chat(config,[{role:'user',content:'测试协议，无真实模型请求'}]);

function matchesError(pattern:RegExp,ambiguous?:boolean) {
  return (error:unknown)=>{assert.ok(error instanceof HttpError);assert.match(error.message,pattern);if(ambiguous!==undefined)assert.equal(error.ambiguous,ambiguous);assert.ok(!error.message.includes(fakeCredential));return true};
}

test('GET model contract sends Bearer API key without sys_name and reads wrapped models',async()=>{
  await withGateway((req,res)=>{
    assert.equal(req.method,'GET');assert.equal(req.url,'/v1/models');
    assert.equal(req.headers.authorization,'Bearer '+fakeCredential);assert.equal(req.headers.sys_name,undefined);assert.equal(req.headers['content-type'],'application/json');
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({code:0,message:'success',data:{models:[{model_name:'allowed-model',manufacturer:'test-vendor',is_use_image:1,is_use_video:0},{model_name:'allowed-model'}]}}));
  },async config=>{const models=await listModels({...config,model:''});assert.deepEqual(models,[{model_name:'allowed-model',manufacturer:'test-vendor',is_use_image:1,is_use_video:0}])});
});

test('standard model lists and chat endpoints preserve explicit API prefixes and default a bare origin to v1',async()=>{
  const requests:string[]=[];
  await withGateway((req,res)=>{
    assert.equal(req.headers.authorization,'Bearer '+fakeCredential);
    assert.equal(req.headers.sys_name,undefined);
    requests.push(req.url!);
    if(req.method==='GET'){
      assert.equal(req.headers.accept,'application/json');
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({object:'list',data:[{id:'standard-model',object:'model'},{id:'standard-model',object:'model'}]}));
    }else{
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      res.end(event(choice({content:'完成'},'stop'))+'data: [DONE]\n\n');
    }
  },async config=>{
    const origin=new URL(config.baseUrl).origin;
    for(const prefix of ['', '/', '/v1', '/v1/', '/compatible-mode/v1', '/compatible-mode/v1/', '/proxy/openai/v1/']){
      const settings={...config,baseUrl:origin+prefix};
      const models=await listModels(settings);
      assert.equal(models.length,1);assert.equal(models[0].model_name,'standard-model');
      assert.equal((await invoke(settings)).content,'完成');
      const apiPrefix=prefix.replace(/\/+$/,'')||'/v1';
      assert.deepEqual(requests.splice(0),[apiPrefix+'/models',apiPrefix+'/chat/completions']);
    }
  });
});

test('legacy text provider snapshots are rejected before making an authenticated request',async()=>{
  let requests=0;
  await withGateway((_req,res)=>{requests++;res.end()},async config=>{
    for(const protocol of ['company',undefined,'bailian']){
      const legacy={...config,protocol,sysName:'legacy-system'} as unknown as ProviderConfig;
      await assert.rejects(invoke(legacy),matchesError(/OpenAI 兼容服务地址和 API Key/));
      await assert.rejects(listModels(legacy),matchesError(/OpenAI 兼容服务地址和 API Key/));
    }
    assert.equal(requests,0);
  });
});

test('HTTP 200 business errors take precedence over a nested model list and redact credentials',async()=>{
  await withGateway((_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code:401,message:`API Key 已失效: ${fakeCredential}; Bearer another-secret`,data:{models:[{model_name:'must-not-be-returned'}]}}))},async config=>{
    await assert.rejects(listModels(config),error=>{assert.ok(matchesError(/code 401.*API Key 已失效/)(error));assert.ok(!(error as Error).message.includes('another-secret'));return true});
  });
});

test('model-list malformed JSON or malformed model records return actionable provider errors',async()=>{
  for(const payload of ['not-json',JSON.stringify({code:0,data:{models:[null]}}),JSON.stringify({code:0,data:{models:[{model_name:{bad:true}}]}}),JSON.stringify({code:0,data:{}})]){
    await withGateway((_req,res)=>{res.setHeader('Content-Type','application/json');res.end(payload)},async config=>{await assert.rejects(listModels(config),matchesError(/无效|缺少/))});
  }
});

test('chat sends Accept SSE and supported tools, parses CRLF and fragmented UTF-8 bytes',async()=>{
  let requestBody='';
  await withGateway((req,res)=>{
    assert.equal(req.method,'POST');assert.equal(req.url,'/v1/chat/completions');
    assert.equal(req.headers.accept,'text/event-stream');assert.equal(req.headers['content-type'],'application/json');assert.equal(req.headers.authorization,'Bearer '+fakeCredential);assert.equal(req.headers.sys_name,undefined);
    req.setEncoding('utf8');req.on('data',chunk=>requestBody+=chunk);req.on('end',()=>{
      const body=JSON.parse(requestBody);assert.equal(body.model,'contract-only-model');assert.equal(body.stream,true);assert.equal(body.tool_choice,'auto');assert.equal(body.tools[0].function.name,'update_node');
      res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8'});
      const wire=Buffer.from(': heartbeat\r\n\r\n'+event(choice({content:'第二镜头：'}),'\r\n')+event(choice({tool_calls:[{index:0,id:'call_1',type:'function',function:{name:'update_node',arguments:'{"nodeId":"shot2",'}}]}),'\r\n')+event(choice({tool_calls:[{index:0,function:{arguments:'"prompt":"近景"}'}}]},'tool_calls'),'\r\n')+'data: [DONE]\r\n\r\n');
      let offset=0;const writePiece=()=>{if(res.destroyed)return;if(offset>=wire.length){res.end();return}res.write(wire.subarray(offset,offset+3));offset+=3;setImmediate(writePiece)};writePiece();
    });
  },async config=>{const observed:string[]=[];const result=await chat(config,[{role:'user',content:'test'}],{tools:[{type:'function',function:{name:'update_node',parameters:{type:'object'}}}],onText:text=>observed.push(text)});assert.equal(result.content,'第二镜头：');assert.equal(observed.join(''),'第二镜头：');assert.equal(result.toolCalls[0].id,'call_1');assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments),{nodeId:'shot2',prompt:'近景'})});
});

test('finish_reason without DONE is an incomplete stream and never returns executable tools',async()=>{
  await withGateway((_req,res)=>{res.setHeader('Content-Type','text/event-stream');res.end(event(choice(toolDelta,'tool_calls')))},async config=>{await assert.rejects(invoke(config),matchesError(/缺少 \[DONE\]/,true))});
});

test('streaming tool continuation accepts null placeholders without losing accumulated ID or function name',async()=>{
  await withGateway((_req,res)=>{
    res.setHeader('Content-Type','text/event-stream');
    res.end(event(choice({tool_calls:[{index:0,id:'call_1',type:'function',function:{name:'update_node',arguments:'{"nodeId":"shot2",'}}]}))+
      event(choice({function_call:null,tool_calls:[{index:0,id:null,type:null,function:{name:null,arguments:'"prompt":"近景"}'}}]},'tool_calls'))+'data: [DONE]\n\n');
  },async config=>{const result=await invoke(config);assert.equal(result.toolCalls[0].id,'call_1');assert.equal(result.toolCalls[0].function.name,'update_node');assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments),{nodeId:'shot2',prompt:'近景'})});
});

test('interleaved parallel tool calls retain separate fragmented arguments and return index order',async()=>{
  await withGateway((_req,res)=>{
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    res.end(event(choice({content:'更新两镜头',tool_calls:[
      {index:1,id:'call_second',type:'function',function:{name:'update_node',arguments:'{"nodeId":"shot2",'}},
      {index:0,id:'call_first',type:'function',function:{name:'update_',arguments:'{"nodeId":"shot1",'}}
    ]}))+event(choice({tool_calls:[
      {index:0,id:null,type:null,function:{name:'node',arguments:'"prompt":"远景"}'}},
      {index:1,id:'call_second',function:{name:'update_node',arguments:'"prompt":"近景"}'}}
    ]},'tool_calls'))+event({choices:[],usage:{total_tokens:42}})+'data: [DONE]\n\n');
  },async config=>{
    const result=await invoke(config);
    assert.equal(result.content,'更新两镜头');
    assert.deepEqual(result.toolCalls.map(call=>({id:call.id,name:call.function.name,args:JSON.parse(call.function.arguments)})),[
      {id:'call_first',name:'update_node',args:{nodeId:'shot1',prompt:'远景'}},
      {id:'call_second',name:'update_node',args:{nodeId:'shot2',prompt:'近景'}}
    ]);
  });
});

test('DONE ends the stream without waiting for the server to close its connection',async()=>{
  await withGateway((_req,res)=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(contentEvent('已完成')+'data: [DONE]\n\n');/* Keep the transport open until the client cancels. */},async config=>{
    const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),1000);
    try{assert.equal((await chat(config,[{role:'user',content:'test'}],{signal:controller.signal})).content,'已完成')}finally{clearTimeout(timeout)}
  });
});

test('HTTP 200 JSON error is surfaced; JSON success does not bypass the required SSE contract',async()=>{
  await withGateway((_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code:403,message:`API Key 不允许使用这个模型 ${fakeCredential}`}))},async config=>{await assert.rejects(invoke(config),matchesError(/code 403.*API Key/))});
  await withGateway((_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:'not SSE'}}]}))},async config=>{await assert.rejects(invoke(config),matchesError(/没有返回 text\/event-stream/,true))});
});

test('SSE business failures, error events, malformed JSON and truncated tools reject the complete tool batch',async()=>{
  const cases:[string,RegExp][]=[
    [event({code:403,message:`模型不可用 ${fakeCredential}`})+'data: [DONE]\n\n',/code 403.*模型不可用/],
    ['event: error\ndata: {"message":"key expired"}\n\n',/数据流返回错误.*key expired/],
    ['data: {bad json}\n\ndata: [DONE]\n\n',/无效的 SSE JSON/],
    [event(choice({tool_calls:[{index:0,id:'call_bad',function:{name:'update_node',arguments:'{"nodeId":'}}]},'tool_calls'))+'data: [DONE]\n\n',/工具参数 JSON 不完整/],
    [event(choice({tool_calls:[{index:-1,id:'bad',function:{name:'x',arguments:'{}'}}]}))+'data: [DONE]\n\n',/调用索引无效/],
    [event(choice({tool_calls:[{index:0,id:'array',function:{name:'x',arguments:'[]'}}]},'tool_calls'))+'data: [DONE]\n\n',/必须是 JSON 对象/],
  ];
  for(const [payload,pattern] of cases)await withGateway((_req,res)=>{res.setHeader('Content-Type','text/event-stream');res.end(payload)},async config=>{await assert.rejects(invoke(config),matchesError(pattern))});
});

test('truncated output and content-filter endings are not reported as successful generations',async()=>{
  for(const [reason,pattern] of [['length',/长度上限/],['content_filter',/拦截/]] as const)await withGateway((_req,res)=>{res.setHeader('Content-Type','text/event-stream');res.end(event(choice({content:'partial'},reason))+'data: [DONE]\n\n')},async config=>{await assert.rejects(invoke(config),matchesError(pattern))});
});

test('HTTP provider errors keep upstream status context and redact secrets; Headers overrides work',async()=>{
  for(const status of [401,429,503])await withGateway((req,res)=>{assert.equal(req.headers['x-contract'],'present');res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify({message:`provider failure ${fakeCredential}`}))},async config=>{
    await assert.rejects(checkedFetch(config,config.baseUrl,{method:'POST',headers:new Headers({'X-Contract':'present'})}),error=>{assert.ok(error instanceof HttpError);assert.equal(error.status,status===429?429:502);assert.equal(error.ambiguous,status>=500);return matchesError(new RegExp(`HTTP ${status}`))(error)});
  });
});

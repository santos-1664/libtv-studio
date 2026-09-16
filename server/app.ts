import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Store } from './store';
import { Configuration } from './config';
import { JobEngine } from './jobs';
import { AgentEngine, skills } from './agent';
import { HttpError } from './errors';
import { canvasSchema, agentBodySchema, idSchema } from './schema';
import { persistMedia } from './media';
import { listModels } from './providers';
import { listBailianModels } from './bailian';

const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
const id=(req:Request,key='id')=>idSchema.parse(req.params[key]);
export interface AppOptions {dataDir?:string;env?:NodeJS.ProcessEnv;startJobs?:boolean}
export function createApp(options:AppOptions={}) {
  const env=options.env||process.env;const store=new Store(options.dataDir||env.DATA_DIR||path.resolve('data'));
  const config=new Configuration(store,env),jobs=new JobEngine(store,config),agent=new AgentEngine(store,config,jobs);
  const app=express();app.disable('x-powered-by');app.set('trust proxy',false);app.use(express.json({limit:'8mb'}));
  const password=env.ACCESS_PASSWORD||'';const authRequired=!!password;
  const sessionId=(req:Request)=>(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('studio_session='))?.slice('studio_session='.length)||'';
  const authenticated=(req:Request)=>!authRequired||!!store.db.prepare('SELECT id_hash FROM sessions WHERE id_hash=? AND expires_at>?').get(digest(sessionId(req)),Date.now());
  app.use((req,res,next)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','DENY');if(req.path.startsWith('/api'))res.setHeader('Cache-Control','no-store');next()});
  app.use('/api',(req,res,next)=>{
    if(['GET','HEAD','OPTIONS'].includes(req.method))return next();
    if(req.headers['sec-fetch-site']==='cross-site')return next(new HttpError(403,'禁止跨站请求'));
    const origin=req.headers.origin;if(origin){const own=env.APP_ORIGIN||`${req.protocol}://${req.headers.host}`;if(origin!==own)return next(new HttpError(403,'请求来源不匹配'))}
    next();
  });
  app.get('/api/health',(_req,res)=>res.json({ok:true}));
  app.get('/api/status',(req,res)=>res.json(config.status(authenticated(req),authRequired)));
  const loginAttempts=new Map<string,{count:number;since:number}>();
  app.post('/api/auth/login',(req,res)=>{
    const value=z.object({password:z.string().max(1000)}).parse(req.body);const ip=req.socket.remoteAddress||'local';let attempts=loginAttempts.get(ip);if(!attempts||Date.now()-attempts.since>60000){attempts={count:0,since:Date.now()};loginAttempts.set(ip,attempts)}if(++attempts.count>8)throw new HttpError(429,'尝试次数过多，请一分钟后重试');
    if(authRequired&&!timingSafeEqual(Buffer.from(digest(value.password),'hex'),Buffer.from(digest(password),'hex')))throw new HttpError(401,'工作区密码不正确');
    const token=randomBytes(32).toString('base64url');store.db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());store.db.prepare('INSERT INTO sessions VALUES(?,?)').run(digest(token),Date.now()+7*24*60*60*1000);
    res.cookie('studio_session',token,{httpOnly:true,sameSite:'strict',secure:env.COOKIE_SECURE==='true'||req.secure,maxAge:7*24*60*60*1000,path:'/'});loginAttempts.delete(ip);res.json(config.status(true,authRequired));
  });
  app.post('/api/auth/logout',(req,res)=>{store.db.prepare('DELETE FROM sessions WHERE id_hash=?').run(digest(sessionId(req)));res.clearCookie('studio_session',{path:'/'});res.json({ok:true})});
  app.use(['/api','/media'],(req,_res,next)=>authenticated(req)?next():next(new HttpError(401,'请先输入工作区密码')));
  app.get('/api/projects',(_req,res)=>res.json({projects:store.projects()}));
  app.post('/api/projects',(req,res)=>{const input=z.object({name:z.string().trim().min(1).max(100).optional()}).parse(req.body||{});res.status(201).json({project:store.createProject(input.name)})});
  app.get('/api/projects/:id',(req,res)=>res.json(store.detail(id(req))));
  app.patch('/api/projects/:id',(req,res)=>{const input=z.object({name:z.string().trim().min(1).max(100).optional(),coverUrl:z.string().max(3000).nullable().optional()}).strict().parse(req.body);res.json({project:store.patchProject(id(req),input)})});
  app.delete('/api/projects/:id',(req,res)=>{const projectId=id(req);if(agent.active.has(projectId))throw new HttpError(409,'Agent 正在处理，暂时不能删除项目');const filenames=store.deleteProject(projectId);for(const filename of filenames)try{unlinkSync(path.join(store.mediaDir,filename))}catch{ /* Database deletion remains authoritative if a file was already removed. */ }res.json({ok:true})});
  app.put('/api/projects/:id/canvas',(req,res)=>{const projectId=id(req);if(agent.active.has(projectId))throw new HttpError(409,'Agent 正在更新画布，请等待完成后再保存');const canvas=canvasSchema.parse(req.body);res.json({canvas:store.saveCanvas(projectId,canvas,true)})});
  const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:100*1024*1024,files:1,fields:4}});
  app.post('/api/projects/:id/assets',(req,_res,next)=>{store.project(id(req));next()},upload.single('file'),(req,res)=>{if(!req.file)throw new HttpError(400,'请选择要上传的素材文件');const asset=persistMedia(store,id(req),Buffer.from(req.file.originalname,'latin1').toString('utf8'),req.file.buffer);res.status(201).json({asset})});
  app.get('/api/projects/:id/messages',(req,res)=>res.json({messages:store.messages(id(req))}));
  app.get('/api/projects/:id/jobs',(req,res)=>{store.project(id(req));res.json({jobs:store.jobs(id(req))})});
  app.get('/api/skills',(_req,res)=>res.json({skills}));
  app.get('/api/models',async(req,res)=>{
    const kind=z.enum(['text','image','video']).parse(req.query.kind||'text');
    if(kind==='text'){res.json({models:await listModels(config.modelCatalog())});return}
    const provider=config.provider(kind);
    if(provider.protocol!=='bailian')throw new HttpError(400,'当前媒体服务暂不支持读取模型列表，请填写供应商提供的模型名称');
    const models=await listBailianModels(provider,kind);
    res.json({models:models.filter(model=>model.adapterSupported)});
  });
  app.post('/api/models/check',async(req,res)=>{const models=await listModels(config.modelCatalog(req.body));res.json({models,checkedAt:new Date().toISOString()})});
  app.put('/api/settings',(req,res)=>{config.update(req.body);res.json(config.status(true,authRequired))});
  app.post('/api/projects/:id/nodes/:nodeId/generate',(req,res)=>{const body=z.object({idempotencyKey:z.string().min(1).max(200).optional()}).parse(req.body||{});const created=jobs.create(id(req),id(req,'nodeId'),body.idempotencyKey);const {id:jobId,projectId,nodeId,kind,status,error,createdAt,updatedAt}=created;res.status(202).json({job:{id:jobId,projectId,nodeId,kind,status,error,createdAt,updatedAt}})});
  app.post('/api/projects/:id/jobs/:jobId/resolve',(req,res)=>{z.object({confirmedNotSubmitted:z.literal(true)}).strict().parse(req.body);jobs.resolve(id(req),id(req,'jobId'));res.json({ok:true})});
  app.post('/api/projects/:id/agent',async(req,res)=>{
    const projectId=id(req),body=agentBodySchema.parse(req.body);agent.validateStart(projectId,body.model,body.attachmentIds);
    res.status(200).set({'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();
    const controller=new AbortController();res.on('close',()=>controller.abort());const heartbeat=setInterval(()=>{if(!res.destroyed)res.write(': heartbeat\n\n')},15000);
    try{await agent.run(projectId,body,event=>{if(!res.destroyed)res.write(`data: ${JSON.stringify(event)}\n\n`)},controller.signal)}finally{clearInterval(heartbeat);res.end()}
  });
  app.get('/media/:filename',(req,res)=>{const filename=String(req.params.filename);const asset=store.assetByFilename(filename);if(!asset)throw new HttpError(404,'素材不存在');res.setHeader('Content-Type',asset.mimeType);res.setHeader('Cache-Control','private, max-age=3600');res.sendFile(path.join(store.mediaDir,filename))});
  app.use('/api',(_req,_res,next)=>next(new HttpError(404,'接口不存在')));
  app.use((error:unknown,_req:Request,res:Response,_next:NextFunction)=>{if(res.headersSent){res.end();return}if(error instanceof HttpError){res.status(error.status===499?400:error.status).json({error:error.message});return}if(error instanceof z.ZodError){res.status(400).json({error:'参数无效：'+error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).slice(0,4).join('；')});return}if(error instanceof multer.MulterError){res.status(error.code==='LIMIT_FILE_SIZE'?413:400).json({error:error.code==='LIMIT_FILE_SIZE'?'素材超过 100 MB 限制':'上传参数无效'});return}if(typeof error==='object'&&error!==null&&'type' in error&&(error as {type:string}).type==='entity.too.large'){res.status(413).json({error:'请求内容超过 8 MB 限制'});return}if(error instanceof SyntaxError){res.status(400).json({error:'请求 JSON 格式无效'});return}console.error('Request failed:',error instanceof Error?error.name:'UnknownError');res.status(500).json({error:'服务处理失败，请检查服务器日志'})});
  if(options.startJobs!==false)jobs.start();
  return {app,store,config,jobs,agent,close:()=>{jobs.stop();store.close()}};
}
export async function attachFrontend(app:express.Express,env:NodeJS.ProcessEnv=process.env){
  const dist=path.resolve('dist');
  if(env.NODE_ENV==='production'||existsSync(path.join(dist,'index.html'))){app.use(express.static(dist));app.get('/{*path}',(_req,res)=>res.sendFile(path.join(dist,'index.html')))}
  else{const {createServer}=await import('vite');const vite=await createServer({server:{middlewareMode:true},appType:'spa'});app.use(vite.middlewares)}
}

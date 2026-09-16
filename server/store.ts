import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Asset, CanvasDocument, CanvasNode, Project, ProjectDetail, GenerationJob, AgentMessage, NodeKind } from '../shared/types';
import { HttpError } from './errors';
import { canvasSchema } from './schema';

export const now = () => new Date().toISOString();
export type JobRecord = GenerationJob & {inputJson:string;providerJson:string;externalId:string|null;resultJson:string|null;phase:string;ambiguous:number;idempotencyKey:string};
type Row = Record<string, any>;
export class Store {
  readonly db: DatabaseSync;
  readonly mediaDir: string;
  constructor(readonly dataDir:string) {
    mkdirSync(dataDir,{recursive:true,mode:0o700}); this.mediaDir=path.join(dataDir,'media'); mkdirSync(this.mediaDir,{recursive:true,mode:0o700});
    this.db = new DatabaseSync(path.join(dataDir,'studio.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,cover_url TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS canvases(project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,document TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,name TEXT NOT NULL,kind TEXT NOT NULL,mime_type TEXT NOT NULL,size INTEGER NOT NULL,filename TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,node_id TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,input_json TEXT NOT NULL,provider_json TEXT NOT NULL,external_id TEXT,result_json TEXT,phase TEXT NOT NULL DEFAULT 'queued',ambiguous INTEGER NOT NULL DEFAULT 0,idempotency_key TEXT NOT NULL,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(project_id,node_id,idempotency_key));
      CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_active ON jobs(project_id,node_id) WHERE status IN ('queued','running');
      CREATE INDEX IF NOT EXISTS jobs_project ON jobs(project_id,created_at);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,role TEXT NOT NULL,content TEXT NOT NULL,actions_json TEXT,status TEXT NOT NULL DEFAULT 'complete',created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_project ON messages(project_id,created_at);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id_hash TEXT PRIMARY KEY,expires_at INTEGER NOT NULL);
      INSERT OR IGNORE INTO migrations(version,applied_at) VALUES(1,datetime('now'));
    `);
  }
  close(){this.db.close()}
  transaction<T>(fn:()=>T):T {this.db.exec('BEGIN IMMEDIATE');try{const value=fn();this.db.exec('COMMIT');return value}catch(e){this.db.exec('ROLLBACK');throw e}}
  project(id:string):Project {
    const row=this.db.prepare('SELECT p.*,c.document FROM projects p JOIN canvases c ON c.project_id=p.id WHERE p.id=?').get(id) as Row|undefined;
    if(!row)throw new HttpError(404,'项目不存在');
    return {id:row.id,name:row.name,coverUrl:row.cover_url,createdAt:row.created_at,updatedAt:row.updated_at,nodeCount:JSON.parse(row.document).nodes.length};
  }
  projects():Project[]{return (this.db.prepare('SELECT id FROM projects ORDER BY updated_at DESC').all() as Row[]).map(r=>this.project(r.id))}
  createProject(name='未命名项目'):Project{return this.transaction(()=>{const id=randomUUID(),time=now();this.db.prepare('INSERT INTO projects VALUES(?,?,NULL,?,?)').run(id,name,time,time);this.db.prepare('INSERT INTO canvases VALUES(?,?,0)').run(id,JSON.stringify({nodes:[],edges:[],viewport:{x:0,y:0,zoom:1}}));return this.project(id)})}
  patchProject(id:string,patch:{name?:string;coverUrl?:string|null}):Project{this.project(id);if(patch.coverUrl && !this.assets(id).some(a=>a.url===patch.coverUrl))throw new HttpError(400,'封面必须属于当前项目素材');this.db.prepare('UPDATE projects SET name=COALESCE(?,name),cover_url=CASE WHEN ? THEN ? ELSE cover_url END,updated_at=? WHERE id=?').run(patch.name??null,patch.coverUrl!==undefined?1:0,patch.coverUrl??null,now(),id);return this.project(id)}
  deleteProject(id:string):string[]{this.project(id);if(this.activeJobs(id).length)throw new HttpError(409,'项目有生成任务进行中，请等待任务完成后删除');const filenames=(this.db.prepare('SELECT filename FROM assets WHERE project_id=?').all(id) as Row[]).map(a=>a.filename);this.db.prepare('DELETE FROM projects WHERE id=?').run(id);return filenames}
  canvas(id:string):CanvasDocument{const row=this.db.prepare('SELECT document,version FROM canvases WHERE project_id=?').get(id) as Row|undefined;if(!row)throw new HttpError(404,'项目不存在');return {...JSON.parse(row.document),version:row.version}}
  validateCanvas(id:string,document:CanvasDocument){
    canvasSchema.parse(document);const ids=new Set(document.nodes.map(n=>n.id));if(ids.size!==document.nodes.length)throw new HttpError(400,'节点 ID 重复');
    if(new Set(document.edges.map(e=>e.id)).size!==document.edges.length)throw new HttpError(400,'连线 ID 重复');
    if(document.edges.some(e=>!ids.has(e.source)||!ids.has(e.target)||e.source===e.target))throw new HttpError(400,'连线引用了不存在的节点或自身');
    const assets=this.assets(id);for(const node of document.nodes){if(node.data.assetId && !assets.some(a=>a.id===node.data.assetId))throw new HttpError(400,'不能引用其他项目的素材');if(node.data.url && !assets.some(a=>a.url===node.data.url))throw new HttpError(400,'节点只能引用当前项目已上传或已生成的素材');}
  }
  saveCanvas(id:string,input:CanvasDocument,fromClient=false):CanvasDocument{return this.transaction(()=>{
    const current=this.canvas(id);if(current.version!==input.version)throw new HttpError(409,'画布已更新，请重新加载后再保存');
    this.validateCanvas(id,input);
    if(fromClient){for(const job of this.activeJobs(id)){const old=current.nodes.find(n=>n.id===job.nodeId),next=input.nodes.find(n=>n.id===job.nodeId);if(!next)throw new HttpError(409,'生成中的节点不能删除');if(old){next.data={...next.data,status:old.data.status,jobId:old.data.jobId,error:old.data.error,url:old.data.url,assetId:old.data.assetId,text:old.data.text};}}}
    return this.writeCanvas(id,input);
  })}
  writeCanvas(id:string,document:CanvasDocument):CanvasDocument{const next={...document,version:document.version+1};this.db.prepare('UPDATE canvases SET document=?,version=? WHERE project_id=?').run(JSON.stringify({nodes:next.nodes,edges:next.edges,viewport:next.viewport}),next.version,id);this.db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(now(),id);return next}
  mutateCanvas(id:string,fn:(canvas:CanvasDocument)=>void):CanvasDocument{return this.transaction(()=>{const canvas=this.canvas(id);fn(canvas);this.validateCanvas(id,canvas);return this.writeCanvas(id,canvas)})}
  assets(id:string):Asset[]{return (this.db.prepare('SELECT * FROM assets WHERE project_id=? ORDER BY created_at DESC').all(id) as Row[]).map(r=>this.toAsset(r))}
  toAsset(r:Row):Asset{return {id:r.id,projectId:r.project_id,name:r.name,kind:r.kind,url:'/media/'+r.filename,mimeType:r.mime_type,size:r.size,createdAt:r.created_at}}
  asset(id:string,projectId?:string):Asset & {filename:string}{const row=this.db.prepare('SELECT * FROM assets WHERE id=?').get(id) as Row|undefined;if(!row || projectId&&row.project_id!==projectId)throw new HttpError(404,'素材不存在于当前项目');return {...this.toAsset(row),filename:row.filename}}
  assetByFilename(filename:string){const row=this.db.prepare('SELECT * FROM assets WHERE filename=?').get(filename) as Row|undefined;return row ? {...this.toAsset(row),filename:row.filename}:undefined}
  addAsset(projectId:string,name:string,kind:'image'|'video',mime:string,size:number,filename:string):Asset{this.project(projectId);const id=randomUUID();this.db.prepare('INSERT INTO assets VALUES(?,?,?,?,?,?,?,?)').run(id,projectId,name,kind,mime,size,filename,now());const asset=this.asset(id);if(kind==='image')this.db.prepare('UPDATE projects SET cover_url=COALESCE(cover_url,?) WHERE id=?').run(asset.url,projectId);return asset}
  jobs(id:string):GenerationJob[]{return (this.db.prepare('SELECT * FROM jobs WHERE project_id=? ORDER BY created_at DESC LIMIT 200').all(id) as Row[]).map(r=>this.toJob(r))}
  toJob(r:Row):GenerationJob{return {id:r.id,projectId:r.project_id,nodeId:r.node_id,kind:r.kind,status:r.status,error:r.error,createdAt:r.created_at,updatedAt:r.updated_at}}
  job(id:string):JobRecord{const r=this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as Row|undefined;if(!r)throw new HttpError(404,'任务不存在');return {...this.toJob(r),inputJson:r.input_json,providerJson:r.provider_json,externalId:r.external_id,resultJson:r.result_json,phase:r.phase,ambiguous:r.ambiguous,idempotencyKey:r.idempotency_key}}
  activeJobs(projectId?:string):JobRecord[]{return (this.db.prepare(`SELECT id FROM jobs WHERE status IN ('queued','running') ${projectId?'AND project_id=?':''}`).all(...(projectId?[projectId]:[])) as Row[]).map(r=>this.job(r.id))}
  existingJob(projectId:string,nodeId:string,key:string){const r=this.db.prepare('SELECT id FROM jobs WHERE project_id=? AND node_id=? AND idempotency_key=?').get(projectId,nodeId,key) as Row|undefined;return r?this.job(r.id):undefined}
  ambiguousJob(projectId:string,nodeId:string){return this.db.prepare('SELECT id FROM jobs WHERE project_id=? AND node_id=? AND ambiguous=1 LIMIT 1').get(projectId,nodeId)}
  insertJob(projectId:string,nodeId:string,kind:NodeKind,input:unknown,providerJson:string,key:string):JobRecord{return this.transaction(()=>{const id=randomUUID(),time=now();this.db.prepare(`INSERT INTO jobs(id,project_id,node_id,kind,status,input_json,provider_json,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,'queued',?,?,?,?,?)`).run(id,projectId,nodeId,kind,JSON.stringify(input),providerJson,key,time,time);const canvas=this.canvas(projectId),node=canvas.nodes.find(n=>n.id===nodeId);if(!node)throw new HttpError(404,'节点不存在');node.data={...node.data,jobId:id,status:'queued',error:undefined};this.writeCanvas(projectId,canvas);return this.job(id)})}
  updateJob(id:string,patch:{status?:GenerationJob['status'];error?:string|null;phase?:string;externalId?:string;resultJson?:string;ambiguous?:number}){
    const columns:Record<string,string>={status:'status',error:'error',phase:'phase',externalId:'external_id',resultJson:'result_json',ambiguous:'ambiguous'};
    const entries=Object.entries(patch);if(!entries.length)return;this.db.prepare(`UPDATE jobs SET ${entries.map(([key])=>columns[key]+'=?').join(',')},updated_at=? WHERE id=?`).run(...entries.map(([,v])=>v??null),now(),id);
  }
  setNodeJob(job:JobRecord,patch:Partial<CanvasNode['data']>){this.mutateCanvas(job.projectId,canvas=>{const node=canvas.nodes.find(n=>n.id===job.nodeId);if(node&&node.data.jobId===job.id)node.data={...node.data,...patch}})}
  messages(id:string):AgentMessage[]{this.project(id);return (this.db.prepare('SELECT * FROM messages WHERE project_id=? ORDER BY rowid').all(id) as Row[]).map(r=>({id:r.id,role:r.role,content:r.content,createdAt:r.created_at,status:r.status,actions:r.actions_json?JSON.parse(r.actions_json):undefined}))}
  addMessage(projectId:string,role:AgentMessage['role'],content:string,actions?:AgentMessage['actions'],status:AgentMessage['status']='complete'){const id=randomUUID();this.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)').run(id,projectId,role,content,actions?JSON.stringify(actions):null,status,now());return id}
  detail(id:string):ProjectDetail{return {project:this.project(id),canvas:this.canvas(id),assets:this.assets(id),jobs:this.jobs(id)}}
  setting(key:string):string|undefined{return (this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as Row|undefined)?.value}
  setSetting(key:string,value:string){this.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value)}
}

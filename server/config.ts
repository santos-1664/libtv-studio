import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AppStatus, NodeKind } from '../shared/types';
import type { Store } from './store';
import { HttpError } from './errors';
import { settingsSchema } from './schema';
export interface ProviderConfig {protocol?:'openai'|'ark'|'bailian';kind:NodeKind;baseUrl:string;key:string;model:string}
export interface Settings {imageProvider:'openai'|'bailian';videoProvider:'ark'|'bailian';textBaseUrl:string;textKey:string;textModel:string;imageBaseUrl:string;imageKey:string;imageModel:string;videoBaseUrl:string;videoKey:string;videoModel:string}
function sameOrigin(first:string,second:string){try{return new URL(first).origin===new URL(second).origin}catch{return false}}
export class Configuration {
  readonly key:Buffer;
  constructor(private store:Store,private env:NodeJS.ProcessEnv=process.env){
    const keyFile=path.join(store.dataDir,'.master-key');
    if(env.SETTINGS_ENCRYPTION_KEY)this.key=createHash('sha256').update(env.SETTINGS_ENCRYPTION_KEY).digest();
    else{if(!existsSync(keyFile))writeFileSync(keyFile,randomBytes(32),{mode:0o600,flag:'wx'});this.key=readFileSync(keyFile);if(this.key.length!==32)throw new Error('配置加密主密钥格式无效');}
  }
  encrypt(value:unknown){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);const body=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);return [iv,cipher.getAuthTag(),body].map(b=>b.toString('base64')).join('.')}
  decrypt<T>(value:string):T{try{const [iv,tag,body]=value.split('.').map(v=>Buffer.from(v,'base64'));const decipher=createDecipheriv('aes-256-gcm',this.key,iv);decipher.setAuthTag(tag);return JSON.parse(Buffer.concat([decipher.update(body),decipher.final()]).toString('utf8')) as T}catch{throw new HttpError(500,'服务配置无法解密，请检查 SETTINGS_ENCRYPTION_KEY 或数据目录主密钥')}}
  settings():Settings{
    const persisted=this.store.setting('providers');
    // Allow-list persisted fields: legacy credentials never become API keys or survive a new save.
    const saved=persisted?settingsSchema.strip().parse(this.decrypt<unknown>(persisted)):{};
    const textBaseUrl=this.env.TEXT_BASE_URL?.trim()||'';
    const textKey=this.env.TEXT_API_KEY?.trim()||'';
    return {imageProvider:this.env.IMAGE_PROVIDER==='bailian'?'bailian':'openai',videoProvider:this.env.VIDEO_PROVIDER==='bailian'?'bailian':'ark',textBaseUrl,textKey,textModel:this.env.TEXT_MODEL||'',imageBaseUrl:this.env.IMAGE_BASE_URL||'',imageKey:this.env.IMAGE_API_KEY||'',imageModel:this.env.IMAGE_MODEL||'',videoBaseUrl:this.env.VIDEO_BASE_URL||'',videoKey:this.env.VIDEO_API_KEY||'',videoModel:this.env.VIDEO_MODEL||'',...saved,
      // An environment key also belongs to its configured origin, not an unrelated saved URL.
      ...(saved.textKey===undefined&&saved.textBaseUrl!==undefined&&!sameOrigin(saved.textBaseUrl,textBaseUrl)?{textKey:''}:{})};
  }
  update(value:unknown){const patch=settingsSchema.parse(value);const current=this.settings();
    for(const field of ['textBaseUrl','imageBaseUrl','videoBaseUrl'] as const){if(patch[field])this.validateBaseUrl(patch[field]!);}
    this.textCredential(current,patch);
    // Empty credentials preserve saved values; text keys are first checked against the URL origin.
    for(const key of ['textKey','imageKey','videoKey'] as const)if(patch[key]==='')delete patch[key];
    this.store.setSetting('providers',this.encrypt({...current,...patch}));
  }
  validateBaseUrl(value:string){let url:URL;try{url=new URL(value)}catch{throw new HttpError(400,'服务地址必须是完整的 HTTP(S) URL')};if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new HttpError(400,'服务地址格式无效');if(url.protocol!=='https:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new HttpError(400,'远程模型服务必须使用 HTTPS');}
  private textCredential(saved:Settings,patch:{textBaseUrl?:string;textKey?:string}){
    if(patch.textKey)return patch.textKey;
    if(saved.textKey&&patch.textBaseUrl!==undefined&&!sameOrigin(patch.textBaseUrl,saved.textBaseUrl))throw new HttpError(400,'文本服务地址已更换来源，请填写该服务的新 API Key；不会复用原服务密钥');
    return saved.textKey;
  }
  modelCatalog(overrides:unknown={}):ProviderConfig{
    const patch=settingsSchema.pick({textBaseUrl:true,textKey:true}).parse(overrides);
    const saved=this.settings();
    const baseUrl=(patch.textBaseUrl??saved.textBaseUrl).trim();
    if(baseUrl)this.validateBaseUrl(baseUrl);
    const key=this.textCredential(saved,patch);
    if(!key)throw new HttpError(503,'尚未配置文本服务 API Key，请在设置中填写服务地址与 API Key');
    this.validateBaseUrl(baseUrl);
    // Catalog checks validate the current form without persisting credentials or requiring a model.
    return {kind:'text',protocol:'openai',baseUrl,key,model:saved.textModel};
  }
  provider(kind:NodeKind,model?:string):ProviderConfig{const s=this.settings();const p:ProviderConfig={kind,protocol:kind==='text'?'openai':kind==='image'?s.imageProvider:s.videoProvider,baseUrl:kind==='text'?s.textBaseUrl:kind==='image'?s.imageBaseUrl:s.videoBaseUrl,key:kind==='text'?s.textKey:kind==='image'?s.imageKey:s.videoKey,model:model||(kind==='text'?s.textModel:kind==='image'?s.imageModel:s.videoModel)};if(!p.baseUrl||!p.key||!p.model)throw new HttpError(503,`尚未配置${kind==='text'?'文本 / Agent':kind==='image'?'图片':'视频'}模型服务。请在设置中补充服务地址、API Key 和模型。`);this.validateBaseUrl(p.baseUrl);return p}
  status(authenticated:boolean,authRequired:boolean):AppStatus{const s=this.settings();return {authenticated,authRequired,version:'1.0.0',services:{text:{configured:!!(s.textBaseUrl&&s.textKey&&s.textModel),model:s.textModel},image:{configured:!!(s.imageBaseUrl&&s.imageKey&&s.imageModel),model:s.imageModel},video:{configured:!!(s.videoBaseUrl&&s.videoKey&&s.videoModel),model:s.videoModel}},...(authenticated?{settings:{textBaseUrl:s.textBaseUrl,imageBaseUrl:s.imageBaseUrl,videoBaseUrl:s.videoBaseUrl,imageProvider:s.imageProvider,videoProvider:s.videoProvider}}:{})}}
}

import { randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Store } from './store';
import { HttpError } from './errors';

const MAX_MEDIA_BYTES=100*1024*1024;
export function sniffMedia(buffer:Buffer):{kind:'image'|'video';mime:string;extension:string}|undefined{
  if(buffer.length<12)return;
  if(buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return {kind:'image',mime:'image/png',extension:'png'};
  if(buffer[0]===255&&buffer[1]===216&&buffer[2]===255)return {kind:'image',mime:'image/jpeg',extension:'jpg'};
  if(buffer.subarray(0,4).toString()==='RIFF'&&buffer.subarray(8,12).toString()==='WEBP')return {kind:'image',mime:'image/webp',extension:'webp'};
  if(['GIF87a','GIF89a'].includes(buffer.subarray(0,6).toString()))return {kind:'image',mime:'image/gif',extension:'gif'};
  if(buffer.subarray(4,8).toString()==='ftyp')return {kind:'video',mime:'video/mp4',extension:'mp4'};
  if(buffer.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])))return {kind:'video',mime:'video/webm',extension:'webm'};
}
export function persistMedia(store:Store,projectId:string,name:string,bytes:Buffer,expectedKind?:'image'|'video'){
  if(bytes.length>MAX_MEDIA_BYTES)throw new HttpError(413,'素材超过 100 MB 限制');const type=sniffMedia(bytes);
  if(!type||expectedKind&&type.kind!==expectedKind)throw new HttpError(415,'不支持该文件内容，请上传 PNG、JPEG、WebP、GIF、MP4 或 WebM');
  store.project(projectId);const filename=randomUUID()+'.'+type.extension,location=path.join(store.mediaDir,filename);writeFileSync(location,bytes,{mode:0o600});
  try{return store.addAsset(projectId,name.slice(0,200),type.kind,type.mime,bytes.length,filename)}catch(error){unlinkSync(location);throw error}
}
export function assetDataUrl(store:Store,id:string,projectId:string){const asset=store.asset(id,projectId);if(asset.size>20*1024*1024)throw new HttpError(413,'参考图请小于 20 MB');return `data:${asset.mimeType};base64,${readFileSync(path.join(store.mediaDir,asset.filename)).toString('base64')}`}
function isPrivate(address:string){const lower=address.toLowerCase();return /^(127\.|10\.|192\.168\.|169\.254\.|0\.|224\.|240\.)/.test(lower)||/^172\.(1[6-9]|2\d|3[01])\./.test(lower)||lower==='::1'||lower==='::'||lower.startsWith('fc')||lower.startsWith('fd')||lower.startsWith('fe80:')||lower.startsWith('::ffff:')}
export async function downloadMedia(rawUrl:string):Promise<Buffer>{
  let current=new URL(rawUrl);
  for(let redirect=0;redirect<4;redirect++){
    if(current.protocol!=='https:'||current.username||current.password)throw new HttpError(502,'模型返回的素材地址不安全');
    const host=current.hostname.replace(/^\[|\]$/g,'');const addresses=isIP(host)?[{address:host}]:await lookup(host,{all:true});if(!addresses.length||addresses.some(a=>isPrivate(a.address)))throw new HttpError(502,'模型返回的素材地址不可访问');
    const response=await fetch(current,{redirect:'manual',signal:AbortSignal.timeout(120000)});
    if(response.status>=300&&response.status<400&&response.headers.get('location')){current=new URL(response.headers.get('location')!,current);continue}
    if(!response.ok||!response.body)throw new HttpError(502,'生成成功但下载素材失败，请通过任务恢复下载');
    if(Number(response.headers.get('content-length')||0)>MAX_MEDIA_BYTES)throw new HttpError(413,'生成素材超过 100 MB');
    const reader=response.body.getReader(),chunks:Buffer[]=[];let size=0;
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_MEDIA_BYTES){await reader.cancel();throw new HttpError(413,'生成素材超过 100 MB')}chunks.push(Buffer.from(value))}return Buffer.concat(chunks);
  }
  throw new HttpError(502,'素材下载重定向过多');
}

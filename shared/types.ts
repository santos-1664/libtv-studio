export type NodeKind = 'text' | 'image' | 'video';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export interface CreativeNodeData extends Record<string, unknown> {
  kind: NodeKind; title: string; prompt: string; text?: string; url?: string; assetId?: string;
  model?: string; aspectRatio?: string; duration?: number; status?: JobStatus; error?: string;
  jobId?: string; shotNumber?: number;
}
export interface CanvasNode { id: string; type: 'creative'; position: {x:number;y:number}; data: CreativeNodeData; }
export interface CanvasEdge { id: string; source: string; target: string; sourceHandle?: string|null; targetHandle?: string|null; }
export interface CanvasDocument { nodes: CanvasNode[]; edges: CanvasEdge[]; viewport: {x:number;y:number;zoom:number}; version: number; }
export interface Project { id: string; name: string; coverUrl: string|null; createdAt: string; updatedAt: string; nodeCount: number; }
export interface Asset { id: string; projectId: string; name: string; kind: 'image'|'video'; url: string; mimeType: string; size: number; createdAt: string; }
export interface GenerationJob { id: string; projectId: string; nodeId: string; kind: NodeKind; status: JobStatus; error?: string|null; createdAt: string; updatedAt: string; }
export interface ProjectDetail { project: Project; canvas: CanvasDocument; assets: Asset[]; jobs: GenerationJob[]; }
export interface AgentMessage { id: string; role: 'user'|'assistant'|'tool'; content: string; createdAt: string; actions?: {label:string;nodeId?:string}[]; status?: 'complete'|'failed'; }
export interface Skill { id:string; name:string; description:string; category:string; icon:string; prompt:string; color:string; }
export interface Model { model_name:string; manufacturer?:string; is_use_image?:number; is_use_video?:number; }
export interface ServiceStatus { configured:boolean; model:string; }
export interface AppStatus { authenticated:boolean; authRequired:boolean; version:string; services:{text:ServiceStatus;image:ServiceStatus;video:ServiceStatus}; settings?:{textBaseUrl:string;imageBaseUrl:string;videoBaseUrl:string;imageProvider?:'openai'|'bailian';videoProvider?:'ark'|'bailian'}; }
export interface AgentEvent { type:'text'|'action'|'done'|'error'; text?:string; label?:string; nodeId?:string; error?:string; }

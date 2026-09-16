import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Handle, Position, applyNodeChanges, applyEdgeChanges } from '@xyflow/react';
import type { Connection, Edge, EdgeChange, Node, NodeChange, NodeProps, ReactFlowInstance, Viewport } from '@xyflow/react';
import { ArrowLeft, ArrowUpRight, Check, CheckCheck, ChevronDown, ChevronRight, CircleAlert, Copy, Download, Expand, Film, FolderOpen, Image as ImageIcon, Link2, LoaderCircle, Maximize2, MoreHorizontal, Play, Plus, Redo2, RefreshCw, Settings2, Sparkles, Trash2, Type, Undo2, Upload, WandSparkles, X, ZoomIn, ZoomOut } from 'lucide-react';
import type { AppStatus, Asset, CanvasDocument, CanvasEdge, CanvasNode, CreativeNodeData, GenerationJob, Model, NodeKind, Project, ProjectDetail } from '../../shared/types';
import { api, ApiError } from '../api';
import '@xyflow/react/dist/style.css';
import './canvas.css';

type FlowNode = Node<CreativeNodeData, 'creative'>;
type SaveState = 'loading' | 'saved' | 'pending' | 'saving' | 'error' | 'conflict';
interface Props {
  projectId: string;
  refreshKey: number;
  onProjectChange: () => void;
  onOpenAgent: () => void;
  onSettings: () => void;
  onBack: () => void;
  notify: (text: string) => void;
}
interface NodeActions {
  generate: (id: string) => void;
  preview: (id: string) => void;
  duplicate: (id: string) => void;
  remove: (id: string) => void;
  submitting: string[];
}
const NodeActionsContext = createContext<NodeActions>({ generate: () => {}, preview: () => {}, duplicate: () => {}, remove: () => {}, submitting: [] });
const kindNames: Record<NodeKind, string> = { text: '文本', image: '图片', video: '视频' };
const kindIcons = { text: Type, image: ImageIcon, video: Film };
const statusNames = { queued: '等待生成', running: '生成中', succeeded: '已完成', failed: '生成失败' };
const emptyDocument = (): CanvasDocument => ({ nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, version: 0 });
const clone = <T,>(value: T): T => structuredClone(value);
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => same(item, b[index]));
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left).filter(key => left[key] !== undefined), rightKeys = Object.keys(right).filter(key => right[key] !== undefined);
  return leftKeys.length === rightKeys.length && leftKeys.every(key => same(left[key], right[key]));
}
const contentSame = (a: CanvasDocument, b: CanvasDocument) => same(a.nodes, b.nodes) && same(a.edges, b.edges) && same(a.viewport, b.viewport);
const cleanNode = (node: FlowNode): CanvasNode => ({ id: node.id, type: 'creative', position: { ...node.position }, data: { ...node.data } });
const cleanEdge = (edge: Edge): CanvasEdge => ({ id: edge.id, source: edge.source, target: edge.target, ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}), ...(edge.targetHandle ? { targetHandle: edge.targetHandle } : {}) });
const isActive = (status?: string) => status === 'queued' || status === 'running';
const messageOf = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试';
type ModelCatalog = { models: Model[]; loaded: boolean; error: string };
const emptyCatalogs = (): Record<NodeKind, ModelCatalog> => ({ text: { models: [], loaded: false, error: '' }, image: { models: [], loaded: false, error: '' }, video: { models: [], loaded: false, error: '' } });
const bailianImageVideoModel = 'wan2.7-i2v-2026-04-25';
const isBailianTextVideo = (model: string) => model === 'wan2.7-t2v' || model === 'wan2.7-t2v-2026-06-12';
function videoInputIssue(node: CanvasNode, canvas: CanvasDocument, defaultModel: string, provider?: 'ark' | 'bailian'): string {
  if (node.data.kind !== 'video' || provider !== 'bailian') return '';
  let model = node.data.model?.trim() || defaultModel;
  const references = canvas.edges.filter(edge => edge.target === node.id).map(edge => canvas.nodes.find(item => item.id === edge.source)).filter(item => item?.data.kind === 'image');
  if (!node.data.model?.trim() && references.length && isBailianTextVideo(defaultModel)) model = bailianImageVideoModel;
  if (references.length && isBailianTextVideo(model)) return `当前模型只支持文字生成视频。要使用参考图，请选择 ${bailianImageVideoModel}。`;
  if (model === bailianImageVideoModel) {
    if (references.length !== 1) return '图生视频需要且只接受 1 张首帧图，请连接一个图片节点。';
    if (!references[0]?.data.assetId || !references[0].data.url) return '首帧图片还没有内容，请先上传或生成图片，再生成视频。';
  }
  const duration = node.data.duration ?? 5;
  if (!Number.isInteger(duration) || duration < 2 || duration > 15) return '百炼视频时长应为 2–15 秒的整数，请调整时长。';
  return '';
}
type PendingUpload = { assetId: string; position: { x: number; y: number } };
const assetTitle = (asset: Asset) => (asset.name.replace(/\.[^.]+$/, '') || asset.name || kindNames[asset.kind]).slice(0, 200);
function pendingUploads(projectId: string): PendingUpload[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(`libtv.canvas.uploads.${projectId}`) || '[]');
    return Array.isArray(stored) ? stored.filter(item => typeof item?.assetId === 'string' && Number.isFinite(item?.position?.x) && Number.isFinite(item?.position?.y)) : [];
  } catch { return []; }
}
function rememberUpload(projectId: string, asset: Asset, position: { x: number; y: number }) {
  try { localStorage.setItem(`libtv.canvas.uploads.${projectId}`, JSON.stringify([...pendingUploads(projectId).filter(item => item.assetId !== asset.id), { assetId: asset.id, position }])); }
  catch { /* The uploaded file is also recoverable from the server asset library. */ }
}
function forgetSavedUploads(projectId: string, canvas: CanvasDocument) {
  try {
    const savedIds = new Set(canvas.nodes.map(node => node.data.assetId));
    const remaining = pendingUploads(projectId).filter(item => !savedIds.has(item.assetId));
    if (remaining.length) localStorage.setItem(`libtv.canvas.uploads.${projectId}`, JSON.stringify(remaining));
    else localStorage.removeItem(`libtv.canvas.uploads.${projectId}`);
  } catch { /* Storage is best effort; server assets remain available. */ }
}

/** Merge remote task results and new Agent nodes without replacing local edits. */
function mergeDocuments(base: CanvasDocument, local: CanvasDocument, remote: CanvasDocument): CanvasDocument {
  const oldNodes = new Map(base.nodes.map(node => [node.id, node]));
  const localNodes = new Map(local.nodes.map(node => [node.id, node]));
  const remoteNodes = new Map(remote.nodes.map(node => [node.id, node]));
  const nodes: CanvasNode[] = [];
  for (const id of new Set([...remoteNodes.keys(), ...localNodes.keys()])) {
    const old = oldNodes.get(id), mine = localNodes.get(id), theirs = remoteNodes.get(id);
    if (!mine) { if (!old && theirs) nodes.push(clone(theirs)); continue; }
    if (!theirs) { if (!old || !same(mine, old)) nodes.push(clone(mine)); continue; }
    if (!old) { nodes.push(clone(mine)); continue; }
    const data: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(old.data), ...Object.keys(mine.data), ...Object.keys(theirs.data)])) {
      const value = same(mine.data[key], old.data[key]) ? theirs.data[key] : mine.data[key];
      if (value !== undefined) data[key] = value;
    }
    nodes.push({ ...theirs, position: same(mine.position, old.position) ? { ...theirs.position } : { ...mine.position }, data: data as CreativeNodeData });
  }
  const oldEdges = new Map(base.edges.map(edge => [edge.id, edge]));
  const mineEdges = new Map(local.edges.map(edge => [edge.id, edge]));
  const theirsEdges = new Map(remote.edges.map(edge => [edge.id, edge]));
  const ids = new Set(nodes.map(node => node.id));
  const edges: CanvasEdge[] = [];
  for (const id of new Set([...theirsEdges.keys(), ...mineEdges.keys()])) {
    const old = oldEdges.get(id), mine = mineEdges.get(id), theirs = theirsEdges.get(id);
    let edge: CanvasEdge | undefined;
    if (!mine) edge = old ? undefined : theirs;
    else if (!theirs) edge = !old || !same(mine, old) ? mine : undefined;
    else edge = same(mine, old) ? theirs : mine;
    if (edge && ids.has(edge.source) && ids.has(edge.target) && validConnection(edge, edges)) edges.push({ ...edge });
  }
  return { nodes, edges, viewport: same(base.viewport, local.viewport) ? { ...remote.viewport } : { ...local.viewport }, version: remote.version };
}

function validConnection(connection: { source: string; target: string }, edges: CanvasEdge[]): boolean {
  if (connection.source === connection.target || edges.some(edge => edge.source === connection.source && edge.target === connection.target)) return false;
  const visited = new Set<string>();
  const hasPath = (id: string): boolean => {
    if (id === connection.source) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    return edges.filter(edge => edge.source === id).some(edge => hasPath(edge.target));
  };
  return !hasPath(connection.target);
}

function restoreHistory(snapshot: CanvasDocument, current: CanvasDocument): CanvasDocument {
  const nodes = snapshot.nodes.map(node => {
    const latest = current.nodes.find(item => item.id === node.id);
    if (latest?.data.jobId && (latest.data.jobId !== node.data.jobId || latest.data.status !== node.data.status)) {
      return { ...node, data: { ...node.data, url: latest.data.url, assetId: latest.data.assetId, text: latest.data.text, jobId: latest.data.jobId, status: latest.data.status, error: latest.data.error } };
    }
    return node;
  });
  for (const node of current.nodes) if (isActive(node.data.status) && !nodes.some(item => item.id === node.id)) nodes.push(clone(node));
  return { ...snapshot, nodes, version: current.version };
}

function CreativeNode({ id, data, selected }: NodeProps<FlowNode>) {
  const actions = useContext(NodeActionsContext);
  const Icon = kindIcons[data.kind];
  const busy = isActive(data.status) || actions.submitting.includes(id);
  const [menu, setMenu] = useState(false);
  return <div className={`creative-card creative-card--${data.kind} ${selected ? 'is-selected' : ''} ${busy ? 'is-generating' : ''}`}>
    <Handle type="target" position={Position.Left} id="in" className="creative-handle" aria-label="输入引用" />
    <div className="creative-card-head">
      <span className={`creative-kind creative-kind--${data.kind}`}><Icon size={14} /></span>
      <span className="creative-card-title">{data.title || `${kindNames[data.kind]}节点`}</span>
      {data.shotNumber && <span className="creative-shot">镜头 {String(data.shotNumber).padStart(2, '0')}</span>}
      <div className="creative-more-wrap nodrag">
        <button className="cw-icon-button creative-more" aria-label={`${data.title}更多操作`} aria-expanded={menu} onClick={() => setMenu(!menu)}><MoreHorizontal size={17} /></button>
        {menu && <div className="creative-node-menu" onMouseLeave={() => setMenu(false)}>
          <button onClick={() => { actions.duplicate(id); setMenu(false); }}><Copy size={14} />复制节点</button>
          <button onClick={() => { actions.remove(id); setMenu(false); }}><Trash2 size={14} />删除节点</button>
        </div>}
      </div>
    </div>
    {data.kind === 'text' ? <div className="creative-text-body" onDoubleClick={() => actions.preview(id)}>
      {data.text ? <p>{data.text}</p> : data.prompt ? <p className="creative-prompt-text">{data.prompt}</p> : <div className="creative-text-placeholder"><span>每一帧，始于一个想法。</span><small>选择节点，在右侧写下你的创作需求</small></div>}
    </div> : <div className={`creative-media-body ${data.url ? 'has-media' : ''}`} onDoubleClick={() => data.url && actions.preview(id)}>
      {data.url ? data.kind === 'image' ? <img src={data.url} alt={data.title} loading="lazy" draggable={false} /> : <video src={data.url} preload="metadata" muted playsInline /> : <div className="creative-media-placeholder"><Icon size={32} strokeWidth={1.2} /><span>{busy ? '正在把想法变成画面' : `等待你的${data.kind === 'image' ? '第一张画面' : '精彩片段'}`}</span><small>{data.prompt ? data.prompt : `输入描述，或连接一个${data.kind === 'image' ? '文本' : '图片'}节点`}</small></div>}
      {data.url && <button className="creative-preview-button nodrag" aria-label={`预览${data.title}`} onClick={() => actions.preview(id)}>{data.kind === 'video' ? <Play size={19} fill="currentColor" /> : <Expand size={18} />}</button>}
      {data.kind === 'video' && data.url && <span className="creative-duration">{data.duration || 5}s</span>}
    </div>}
    {data.status === 'failed' && <div className="creative-error"><CircleAlert size={13} /><span>{data.error || '生成失败，请重试'}</span></div>}
    <div className="creative-card-foot">
      <span className={`creative-status ${busy ? 'is-active' : ''}`}>
        {busy ? <><LoaderCircle size={12} className="cw-spin" />{data.status === 'queued' ? '排队中' : '生成中'}</> : data.status === 'succeeded' ? <><Check size={12} />已完成</> : <>{data.aspectRatio || (data.kind === 'text' ? '灵感与脚本' : '16:9')}{data.kind === 'video' ? ` · ${data.duration || 5}s` : ''}</>}
      </span>
      <button className="creative-run nodrag" disabled={busy} onClick={() => actions.generate(id)} aria-label={`生成${data.title}`}><Sparkles size={12} />{data.url || data.text ? '重新生成' : '生成'}</button>
    </div>
    <Handle type="source" position={Position.Right} id="out" className="creative-handle" aria-label="输出引用" />
  </div>;
}
const nodeTypes = { creative: CreativeNode };

function Workspace({ projectId, refreshKey, onProjectChange, onOpenAgent, onSettings, onBack, notify }: Props) {
  const [project, setProject] = useState<Project | null>(null);
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('loading');
  const [loadError, setLoadError] = useState('');
  const [changeTick, setChangeTick] = useState(0);
  const [historyTick, setHistoryTick] = useState(0);
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const [services, setServices] = useState<AppStatus['services'] | null>(null);
  const [videoProvider, setVideoProvider] = useState<'ark' | 'bailian'>('ark');
  const [modelCatalogs, setModelCatalogs] = useState(emptyCatalogs);
  const [modelListOpen, setModelListOpen] = useState(false);
  const [loadingModelKind, setLoadingModelKind] = useState<NodeKind | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetLibraryOpen, setAssetLibraryOpen] = useState(false);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [draggingFile, setDraggingFile] = useState(false);
  const [submitting, setSubmitting] = useState<string[]>([]);
  const [conflict, setConflict] = useState<CanvasDocument | null>(null);
  const [rename, setRename] = useState(false);
  const [name, setName] = useState('');
  const [loadTick, setLoadTick] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const instanceRef = useRef<ReactFlowInstance<FlowNode, Edge> | null>(null);
  const documentRef = useRef<CanvasDocument>(emptyDocument());
  const baseRef = useRef<CanvasDocument>(emptyDocument());
  const nodesRef = useRef<FlowNode[]>([]);
  const edgesRef = useRef<Edge[]>([]);
  const selectedIdRef = useRef<string | null>(null);
  const readyRef = useRef(false);
  const aliveRef = useRef(true);
  const conflictRef = useRef<CanvasDocument | null>(null);
  const savingRef = useRef<Promise<boolean> | null>(null);
  const uploadPromiseRef = useRef<Promise<boolean> | null>(null);
  const refreshInFlightRef = useRef(false);
  const generationEpochRef = useRef(0);
  const historyRef = useRef<CanvasDocument[]>([]);
  const futureRef = useRef<CanvasDocument[]>([]);
  const submittingRef = useRef(new Set<string>());
  const modelRequestRef = useRef<{ controller: AbortController | null; sequence: number }>({ controller: null, sequence: 0 });
  const catalogConfigRef = useRef('');
  const callbacksRef = useRef({ onProjectChange, onOpenAgent, onSettings, onBack, notify });
  callbacksRef.current = { onProjectChange, onOpenAgent, onSettings, onBack, notify };

  const applyServiceStatus = useCallback((result: AppStatus) => {
    setServices(result.services);
    setVideoProvider(result.settings?.videoProvider || 'ark');
    const fingerprint = JSON.stringify({ services: result.services, settings: result.settings });
    if (catalogConfigRef.current && catalogConfigRef.current !== fingerprint) {
      modelRequestRef.current.controller?.abort();
      modelRequestRef.current.sequence++;
      setModelCatalogs(emptyCatalogs());
      setLoadingModelKind(null);
    }
    catalogConfigRef.current = fingerprint;
  }, []);

  const loadModels = useCallback(async (kind: NodeKind) => {
    modelRequestRef.current.controller?.abort();
    const controller = new AbortController();
    const sequence = ++modelRequestRef.current.sequence;
    modelRequestRef.current.controller = controller;
    setLoadingModelKind(kind);
    setModelListOpen(true);
    setModelCatalogs(current => ({ ...current, [kind]: { ...current[kind], error: '' } }));
    const currentRequest = () => aliveRef.current && !controller.signal.aborted && modelRequestRef.current.sequence === sequence;
    try {
      const { models } = await api<{ models: Model[] }>(`/models?kind=${kind}`, { signal: controller.signal });
      if (!currentRequest()) return;
      const received = [...new Map(models.filter(model => typeof model.model_name === 'string' && model.model_name.trim()).map(model => [model.model_name, model])).values()];
      setModelCatalogs(current => ({ ...current, [kind]: { models: received, loaded: true, error: received.length ? '' : '当前服务没有返回可用模型，请检查服务设置。' } }));
    } catch (error) {
      if (currentRequest()) setModelCatalogs(current => ({ ...current, [kind]: { models: [], loaded: false, error: messageOf(error) } }));
    } finally {
      if (currentRequest()) { setLoadingModelKind(null); modelRequestRef.current.controller = null; }
    }
  }, []);

  useEffect(() => {
    setModelListOpen(false);
    modelRequestRef.current.controller?.abort();
    modelRequestRef.current.sequence++;
    setLoadingModelKind(null);
    return () => { modelRequestRef.current.controller?.abort(); modelRequestRef.current.sequence++; };
  }, [selectedId]);

  const persistDraft = useCallback(() => {
    if (!readyRef.current) return;
    try {
      const key = `libtv.canvas.draft.${projectId}`;
      if (contentSame(documentRef.current, baseRef.current)) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify({ base: baseRef.current, local: documentRef.current }));
    } catch { /* A full browser cache must not interrupt the server save. */ }
  }, [projectId]);

  const chooseNode = useCallback((id: string | null) => {
    selectedIdRef.current = id;
    setSelectedId(id);
    nodesRef.current = nodesRef.current.map(node => ({ ...node, selected: node.id === id }));
    setNodes(nodesRef.current);
  }, []);

  const setDocument = useCallback((doc: CanvasDocument, edited = false) => {
    documentRef.current = clone(doc);
    const old = new Map(nodesRef.current.map(node => [node.id, node]));
    nodesRef.current = doc.nodes.map(node => ({ ...old.get(node.id), ...node, selected: selectedIdRef.current === node.id }));
    setNodes(nodesRef.current);
    edgesRef.current = doc.edges;
    setEdges(doc.edges);
    setViewport(doc.viewport);
    if (selectedIdRef.current && !doc.nodes.some(node => node.id === selectedIdRef.current)) {
      selectedIdRef.current = null;
      setSelectedId(null);
    }
    if (edited) {
      setChangeTick(tick => tick + 1);
      if (!conflictRef.current) setSaveState('pending');
    }
  }, []);

  const pushHistory = useCallback(() => {
    const current = clone(documentRef.current);
    const previous = historyRef.current.at(-1);
    if (!previous || !contentSame(previous, current)) {
      historyRef.current = [...historyRef.current.slice(-39), current];
      futureRef.current = [];
      setHistoryTick(tick => tick + 1);
    }
  }, []);

  const saveNow = useCallback(async (): Promise<boolean> => {
    if (!readyRef.current) return false;
    if (conflictRef.current) return false;
    if (savingRef.current) {
      if (!await savingRef.current) return false;
      return saveNow();
    }
    if (contentSame(documentRef.current, baseRef.current)) { setSaveState('saved'); return true; }
    const payload = clone(documentRef.current);
    payload.version = baseRef.current.version;
    const save = (async () => {
      setSaveState('saving');
      try {
        const result = await api<{ canvas: CanvasDocument }>(`/projects/${projectId}/canvas`, { method: 'PUT', body: JSON.stringify(payload) });
        forgetSavedUploads(projectId, result.canvas);
        if (!aliveRef.current) return true;
        const merged = mergeDocuments(payload, documentRef.current, result.canvas);
        baseRef.current = clone(result.canvas);
        setDocument(merged);
        const changedAgain = !contentSame(merged, result.canvas);
        setSaveState(changedAgain ? 'pending' : 'saved');
        persistDraft();
        if (changedAgain) setChangeTick(tick => tick + 1);
        callbacksRef.current.onProjectChange();
        return true;
      } catch (error) {
        if (!aliveRef.current) return false;
        if (error instanceof ApiError && error.status === 409) {
          try {
            const latest = await api<ProjectDetail>(`/projects/${projectId}`);
            conflictRef.current = latest.canvas;
            setConflict(latest.canvas);
            setSaveState('conflict');
          } catch (reloadError) {
            setSaveState('error');
            callbacksRef.current.notify(messageOf(reloadError));
          }
        } else {
          setSaveState('error');
          callbacksRef.current.notify(messageOf(error));
        }
        return false;
      }
    })();
    savingRef.current = save;
    try { return await save; } finally { savingRef.current = null; }
  }, [persistDraft, projectId, setDocument]);

  const flushSave = useCallback(async (): Promise<boolean> => {
    if (!await saveNow()) return false;
    while (aliveRef.current && !contentSame(documentRef.current, baseRef.current)) if (!await saveNow()) return false;
    return true;
  }, [saveNow]);

  const settleBeforeLeaving = useCallback(async (): Promise<boolean> => {
    while (uploadPromiseRef.current) {
      if (!await uploadPromiseRef.current || !aliveRef.current) return false;
    }
    return flushSave();
  }, [flushSave]);

  const refreshProject = useCallback(async () => {
    if (!readyRef.current || refreshInFlightRef.current || savingRef.current || conflictRef.current) return;
    refreshInFlightRef.current = true;
    const generationEpoch = generationEpochRef.current;
    try {
      const result = await api<ProjectDetail>(`/projects/${projectId}`);
      if (!aliveRef.current || savingRef.current || conflictRef.current || generationEpoch !== generationEpochRef.current || result.canvas.version < baseRef.current.version) return;
      const merged = mergeDocuments(baseRef.current, documentRef.current, result.canvas);
      baseRef.current = clone(result.canvas);
      setDocument(merged);
      setJobs(result.jobs);
      setAssets(result.assets);
      setProject(result.project);
      if (!contentSame(merged, result.canvas)) { setSaveState('pending'); setChangeTick(tick => tick + 1); }
      else setSaveState('saved');
    } catch { /* Poll retries on the next tick; editing remains available. */ }
    finally { refreshInFlightRef.current = false; }
  }, [projectId, setDocument]);

  useEffect(() => {
    aliveRef.current = true;
    readyRef.current = false;
    let cancelled = false;
    setSaveState('loading');
    setLoadError('');
    void api<ProjectDetail>(`/projects/${projectId}`).then(result => {
      if (cancelled) return;
      baseRef.current = clone(result.canvas);
      let restored = result.canvas;
      try {
        const draft = JSON.parse(localStorage.getItem(`libtv.canvas.draft.${projectId}`) || 'null') as { base: CanvasDocument; local: CanvasDocument } | null;
        if (draft && Array.isArray(draft.base?.nodes) && Array.isArray(draft.local?.nodes) && Array.isArray(draft.base?.edges) && Array.isArray(draft.local?.edges) && draft.base?.viewport && draft.local?.viewport) restored = mergeDocuments(draft.base, draft.local, result.canvas);
      } catch { /* Ignore invalid or unavailable browser storage. */ }
      for (const pending of pendingUploads(projectId)) {
        const asset = result.assets.find(item => item.id === pending.assetId);
        if (asset && !restored.nodes.some(node => node.data.assetId === asset.id)) {
          restored = { ...restored, nodes: [...restored.nodes, { id: `upload-${asset.id}`, type: 'creative', position: pending.position, data: { kind: asset.kind, title: assetTitle(asset), prompt: '', aspectRatio: '16:9', assetId: asset.id, url: asset.url, status: 'succeeded' } }] };
        }
      }
      forgetSavedUploads(projectId, result.canvas);
      readyRef.current = true;
      const hasDraft = !contentSame(restored, result.canvas);
      setDocument(restored, hasDraft);
      setProject(result.project);
      setName(result.project.name);
      setJobs(result.jobs);
      setAssets(result.assets);
      setSaveState(hasDraft ? 'pending' : 'saved');
      if (hasDraft) callbacksRef.current.notify('已恢复上次未保存的画布修改');
      historyRef.current = [];
      futureRef.current = [];
    }).catch(error => { if (!cancelled) setLoadError(messageOf(error)); });
    void api<AppStatus>('/status').then(result => { if (!cancelled) applyServiceStatus(result); }).catch(() => {});
    return () => { persistDraft(); cancelled = true; aliveRef.current = false; readyRef.current = false; };
  }, [applyServiceStatus, projectId, loadTick, persistDraft, setDocument]);

  useEffect(() => {
    if (!readyRef.current) return;
    persistDraft();
    if (conflictRef.current) return;
    const timer = window.setTimeout(() => { void saveNow(); }, 700);
    return () => window.clearTimeout(timer);
  }, [changeTick, persistDraft, saveNow]);

  useEffect(() => {
    if (readyRef.current) void refreshProject();
    void api<AppStatus>('/status').then(result => { if (aliveRef.current) applyServiceStatus(result); }).catch(() => {});
  }, [applyServiceStatus, refreshKey, refreshProject]);
  const hasActiveJobs = jobs.some(job => isActive(job.status)) || nodes.some(node => isActive(node.data.status));
  useEffect(() => {
    if (!hasActiveJobs) return;
    const timer = window.setInterval(() => { void refreshProject(); }, 2300);
    return () => window.clearInterval(timer);
  }, [hasActiveJobs, refreshProject]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (uploadPromiseRef.current || readyRef.current && !contentSame(documentRef.current, baseRef.current)) { persistDraft(); event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [persistDraft]);

  const updateNode = useCallback((id: string, patch: Partial<CreativeNodeData>) => {
    const current = documentRef.current;
    setDocument({ ...current, nodes: current.nodes.map(node => node.id === id ? { ...node, data: { ...node.data, ...patch } } : node) }, true);
  }, [setDocument]);

  const centerPosition = useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect && instanceRef.current) return instanceRef.current.screenToFlowPosition({ x: rect.left + (rect.width - (selectedIdRef.current ? 340 : 0)) / 2 - 145, y: rect.top + rect.height / 2 - 125 });
    return { x: 220, y: 150 };
  }, []);

  const addNode = useCallback((kind: NodeKind, partial: Partial<CreativeNodeData> = {}, position?: { x: number; y: number }) => {
    pushHistory();
    const current = documentRef.current;
    const number = current.nodes.filter(node => node.data.kind === kind).length + 1;
    const node: CanvasNode = { id: crypto.randomUUID(), type: 'creative', position: position || centerPosition(), data: { kind, title: `${kindNames[kind]} ${String(number).padStart(2, '0')}`, prompt: '', aspectRatio: '16:9', ...(kind === 'video' ? { duration: 5 } : {}), ...partial } };
    node.data.title = node.data.title.slice(0, 200);
    selectedIdRef.current = node.id;
    setSelectedId(node.id);
    setDocument({ ...current, nodes: [...current.nodes, node] }, true);
    return node.id;
  }, [centerPosition, pushHistory, setDocument]);

  const removeNode = useCallback((id: string) => {
    const node = documentRef.current.nodes.find(item => item.id === id);
    if (isActive(node?.data.status) || submittingRef.current.has(id)) { callbacksRef.current.notify('该节点正在生成，完成后可以删除'); return; }
    pushHistory();
    const current = documentRef.current;
    setDocument({ ...current, nodes: current.nodes.filter(item => item.id !== id), edges: current.edges.filter(edge => edge.source !== id && edge.target !== id) }, true);
  }, [pushHistory, setDocument]);

  const duplicateNode = useCallback((id: string) => {
    const node = documentRef.current.nodes.find(item => item.id === id);
    if (!node) return;
    const { jobId: _jobId, status: _status, error: _error, ...data } = node.data;
    addNode(node.data.kind, { ...data, title: `${node.data.title.slice(0, 197)} 副本`, ...(node.data.url || node.data.text ? { status: 'succeeded' } : {}) }, { x: node.position.x + 335, y: node.position.y + 32 });
  }, [addNode]);

  const undo = useCallback(() => {
    const prior = historyRef.current.pop();
    if (!prior) return;
    futureRef.current.push(clone(documentRef.current));
    // Preserve newly returned results while restoring the user's earlier layout/content.
    const current = documentRef.current;
    const restored = restoreHistory(prior, current);
    setDocument(restored, true);
    setHistoryTick(tick => tick + 1);
  }, [setDocument]);

  const redo = useCallback(() => {
    const next = futureRef.current.pop();
    if (!next) return;
    historyRef.current.push(clone(documentRef.current));
    setDocument(restoreHistory(next, documentRef.current), true);
    setHistoryTick(tick => tick + 1);
  }, [setDocument]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (window.document.querySelector('.modal-backdrop')) return;
      if (previewId) { if (event.key === 'Escape') setPreviewId(null); return; }
      const target = event.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
      const command = event.ctrlKey || event.metaKey;
      if (command && event.key.toLowerCase() === 's') { event.preventDefault(); void flushSave(); }
      else if (command && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); }
      else if (command && event.key.toLowerCase() === 'd' && selectedIdRef.current) { event.preventDefault(); duplicateNode(selectedIdRef.current); }
      else if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selectedIdRef.current) { event.preventDefault(); removeNode(selectedIdRef.current); }
        else {
          const edgeIds = new Set(edgesRef.current.filter(edge => edge.selected).map(edge => edge.id));
          if (edgeIds.size) { event.preventDefault(); pushHistory(); setDocument({ ...documentRef.current, edges: documentRef.current.edges.filter(edge => !edgeIds.has(edge.id)) }, true); }
        }
      }
      else if (event.key === 'Escape') { setPreviewId(null); chooseNode(null); }
      else if (!command && event.key.toLowerCase() === 't') addNode('text');
      else if (!command && event.key.toLowerCase() === 'f') void instanceRef.current?.fitView({ padding: 0.2, duration: 300 });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [addNode, chooseNode, duplicateNode, flushSave, previewId, pushHistory, redo, removeNode, setDocument, undo]);

  const generate = useCallback(async (id: string) => {
    const node = documentRef.current.nodes.find(item => item.id === id);
    if (!node || isActive(node.data.status) || submittingRef.current.has(id)) return;
    const videoIssue = videoInputIssue(node, documentRef.current, services?.video.model || '', videoProvider);
    if (videoIssue) { chooseNode(id); callbacksRef.current.notify(videoIssue); return; }
    const hasReferences = documentRef.current.edges.some(edge => edge.target === id);
    if (!node.data.prompt.trim() && !hasReferences) { chooseNode(id); callbacksRef.current.notify('先写下创作描述，或连接一个参考节点'); return; }
    submittingRef.current.add(id);
    setSubmitting([...submittingRef.current]);
    try {
      if (!await flushSave()) { callbacksRef.current.notify('请先保存画布，解决保存问题后再生成'); return; }
      const { job } = await api<{ job: GenerationJob }>(`/projects/${projectId}/nodes/${id}/generate`, { method: 'POST', body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }) });
      generationEpochRef.current++;
      setJobs(current => [...current.filter(item => item.id !== job.id), job]);
      await refreshProject();
      callbacksRef.current.notify(`${kindNames[node.data.kind]}生成已提交`);
    } catch (error) {
      callbacksRef.current.notify(messageOf(error));
      if (error instanceof ApiError && error.status === 503) callbacksRef.current.onSettings();
    }
    finally { submittingRef.current.delete(id); setSubmitting([...submittingRef.current]); }
  }, [chooseNode, flushSave, projectId, refreshProject, services?.video.model, videoProvider]);

  const uploadFiles = useCallback(async (files: File[], position?: { x: number; y: number }): Promise<boolean> => {
    if (uploadPromiseRef.current) { callbacksRef.current.notify('请等待当前素材上传完成'); return false; }
    const accepted = files.filter(file => file.type.startsWith('image/') || file.type.startsWith('video/'));
    if (!accepted.length) { callbacksRef.current.notify('请选择图片或视频文件'); return false; }
    setUploading(true);
    const startPosition = position || centerPosition();
    const task = (async (): Promise<boolean> => {
      let completed = 0;
      try {
        for (const file of accepted) {
          if (!aliveRef.current) return false;
          const form = new FormData();
          form.append('file', file);
          const { asset } = await api<{ asset: Asset }>(`/projects/${projectId}/assets`, { method: 'POST', body: form });
          const nodePosition = { x: startPosition.x + completed * 40, y: startPosition.y + completed * 40 };
          // Record a durable recovery pointer before touching the mounted canvas.
          rememberUpload(projectId, asset, nodePosition);
          if (!aliveRef.current) return false;
          setAssets(current => [asset, ...current.filter(item => item.id !== asset.id)]);
          addNode(asset.kind, { title: assetTitle(asset), url: asset.url, assetId: asset.id, status: 'succeeded' }, nodePosition);
          persistDraft();
          completed++;
        }
        const saved = await flushSave();
        if (!aliveRef.current) return saved;
        if (saved) callbacksRef.current.notify(`已将 ${completed} 个素材添加到画布并保存`);
        else callbacksRef.current.notify('素材已上传，画布尚未保存。请重试保存；素材也保留在素材库中。');
        return saved;
      } catch (error) {
        if (aliveRef.current) callbacksRef.current.notify(messageOf(error));
        return false;
      } finally {
        if (aliveRef.current) { setUploading(false); if (fileInputRef.current) fileInputRef.current.value = ''; }
      }
    })();
    uploadPromiseRef.current = task;
    try { return await task; } finally { if (uploadPromiseRef.current === task) uploadPromiseRef.current = null; }
  }, [addNode, centerPosition, flushSave, persistDraft, projectId]);

  const refreshAssets = useCallback(async () => {
    setAssetsLoading(true);
    try {
      const result = await api<ProjectDetail>(`/projects/${projectId}`);
      if (aliveRef.current) setAssets(result.assets);
    } catch (error) { if (aliveRef.current) callbacksRef.current.notify(messageOf(error)); }
    finally { if (aliveRef.current) setAssetsLoading(false); }
  }, [projectId]);

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    const updated = applyNodeChanges(changes, nodesRef.current);
    nodesRef.current = updated;
    setNodes(updated);
    if (changes.some(change => ['position', 'remove', 'add', 'replace'].includes(change.type))) {
      documentRef.current = { ...documentRef.current, nodes: updated.map(cleanNode) };
      setChangeTick(tick => tick + 1);
      if (!conflictRef.current) setSaveState('pending');
    }
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange<Edge>[]) => {
    const updated = applyEdgeChanges(changes, edgesRef.current);
    edgesRef.current = updated;
    setEdges(updated);
    if (changes.some(change => ['remove', 'add', 'replace'].includes(change.type))) {
      documentRef.current = { ...documentRef.current, edges: updated.map(cleanEdge) };
      setChangeTick(tick => tick + 1);
      if (!conflictRef.current) setSaveState('pending');
    }
  }, []);

  const onConnect = useCallback((connection: Connection) => {
    if (!validConnection(connection, documentRef.current.edges)) { callbacksRef.current.notify('不能重复连接，也不能形成循环引用'); return; }
    pushHistory();
    setDocument({ ...documentRef.current, edges: [...documentRef.current.edges, { ...connection, id: crypto.randomUUID() }] }, true);
  }, [pushHistory, setDocument]);

  const saveProjectName = async () => {
    const value = name.trim();
    if (!project || !value) { setName(project?.name || ''); setRename(false); return; }
    if (value === project.name) { setRename(false); return; }
    try {
      const { project: updated } = await api<{ project: Project }>(`/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify({ name: value }) });
      setProject(updated);
      setName(updated.name);
      setRename(false);
      callbacksRef.current.onProjectChange();
    } catch (error) { callbacksRef.current.notify(messageOf(error)); }
  };

  const resolveConflict = async () => {
    const remote = conflictRef.current;
    if (!remote) return;
    const merged = mergeDocuments(baseRef.current, documentRef.current, remote);
    baseRef.current = clone(remote);
    conflictRef.current = null;
    setConflict(null);
    setDocument(merged, true);
    await flushSave();
  };

  const selected = nodes.find(node => node.id === selectedId);
  const preview = nodes.find(node => node.id === previewId);
  const selectedBusy = !!selected && (isActive(selected.data.status) || submitting.includes(selected.id));
  const references = selected ? edges.filter(edge => edge.target === selected.id).map(edge => ({ edge, node: nodes.find(node => node.id === edge.source) })).filter(item => item.node) : [];
  const isBailianVideo = selected?.data.kind === 'video' && videoProvider === 'bailian';
  const autoFirstFrame = isBailianVideo && !selected?.data.model?.trim() && isBailianTextVideo(services?.video.model || '') && references.some(item => item.node?.data.kind === 'image');
  const effectiveModel = autoFirstFrame ? bailianImageVideoModel : selected ? selected.data.model?.trim() || services?.[selected.data.kind]?.model || '' : '';
  const followsFirstFrame = isBailianVideo && effectiveModel === bailianImageVideoModel;
  const videoIssue = selected ? videoInputIssue(cleanNode(selected), documentRef.current, services?.video.model || '', videoProvider) : '';
  const suggestImageVideo = isBailianVideo && isBailianTextVideo(effectiveModel) && references.some(item => item.node?.data.kind === 'image');
  const saveLabel = { loading: '载入中', saved: '已保存', pending: '等待保存', saving: '保存中', error: '保存失败 · 点击重试', conflict: '有待合并的修改' }[saveState];
  void historyTick;

  if (loadError) return <div className="canvas-workspace cw-loading"><CircleAlert size={36} /><h2>暂时无法打开画布</h2><p>{loadError}</p><div><button className="cw-secondary" onClick={onBack}>返回项目</button><button className="cw-primary" onClick={() => setLoadTick(tick => tick + 1)}>重新加载</button></div></div>;
  if (!project) return <div className="canvas-workspace cw-loading"><LoaderCircle size={30} className="cw-spin" /><p>正在打开创作画布…</p></div>;

  return <NodeActionsContext.Provider value={{ generate: id => void generate(id), preview: setPreviewId, duplicate: duplicateNode, remove: removeNode, submitting }}>
    <div className={`canvas-workspace ${selected ? 'has-inspector' : ''}`} ref={containerRef}
      onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDraggingFile(true); } }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as globalThis.Node)) setDraggingFile(false); }}
      onDrop={event => { if (!event.dataTransfer.files.length) return; event.preventDefault(); setDraggingFile(false); const position = instanceRef.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY }); void uploadFiles(Array.from(event.dataTransfer.files), position); }}>
      <ReactFlow<FlowNode, Edge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
        onInit={instance => { instanceRef.current = instance; void instance.setViewport(documentRef.current.viewport); }}
        onNodeClick={(_, node) => chooseNode(node.id)} onEdgeClick={() => chooseNode(null)} onPaneClick={() => chooseNode(null)} onNodeDragStart={pushHistory}
        onMoveEnd={(_, nextViewport) => { setViewport(nextViewport); if (readyRef.current && !same(documentRef.current.viewport, nextViewport)) { documentRef.current = { ...documentRef.current, viewport: nextViewport }; setChangeTick(tick => tick + 1); if (!conflictRef.current) setSaveState('pending'); } }}
        isValidConnection={connection => validConnection(connection, documentRef.current.edges)}
        defaultViewport={documentRef.current.viewport} minZoom={0.2} maxZoom={2} panOnScroll panOnDrag={[1, 2]} selectionOnDrag panActivationKeyCode="Space" deleteKeyCode={null}
        defaultEdgeOptions={{ type: 'smoothstep', style: { stroke: '#65c7df', strokeWidth: 1.5 }, animated: false }} connectionLineStyle={{ stroke: '#77d7ec', strokeWidth: 1.5 }} proOptions={{ hideAttribution: true }}>
        <Background variant={BackgroundVariant.Dots} color="#36393d" gap={24} size={1.2} />
      </ReactFlow>

      <header className="cw-topbar">
        <div className="cw-topbar-left">
          <button className="cw-back" title="返回项目" aria-label="返回项目" onClick={async () => { if (await settleBeforeLeaving()) onBack(); }}><ArrowLeft size={18} /></button>
          <span className="cw-wordmark">Lib<span>TV</span><i>STUDIO</i></span>
          <span className="cw-topbar-divider" />
          {rename ? <input className="cw-name-input" value={name} maxLength={100} autoFocus onChange={event => setName(event.target.value)} onBlur={() => void saveProjectName()} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { setName(project.name); setRename(false); } }} aria-label="项目名称" /> : <button className="cw-project-name" title="重命名项目" onClick={() => { setName(project.name); setRename(true); }}><span>{project.name}</span><ChevronDown size={13} /></button>}
          <button className={`cw-save-indicator is-${saveState}`} onClick={() => void flushSave()} aria-label={saveLabel} title="立即保存 ⌘S">{saveState === 'saving' ? <LoaderCircle size={13} className="cw-spin" /> : saveState === 'saved' ? <CheckCheck size={13} /> : saveState === 'error' || saveState === 'conflict' ? <CircleAlert size={13} /> : <span className="cw-pending-dot" />}{saveLabel}</button>
        </div>
        <div className="cw-topbar-right">
          <button className="cw-icon-button cw-settings" aria-label="AI 服务设置" title="AI 服务设置" onClick={onSettings}><Settings2 size={18} /></button>
          <button className="cw-agent-button" onClick={async () => { if (await settleBeforeLeaving()) onOpenAgent(); }}><Sparkles size={15} /><span>LibTV Agent</span><ArrowUpRight size={14} /></button>
        </div>
      </header>

      {conflict && <div className="cw-conflict"><CircleAlert size={17} /><span>项目有新修改。你的编辑已保留，合并时以本地修改为准。</span><button onClick={() => void resolveConflict()}>合并并保存</button></div>}

      <nav className="cw-tools" aria-label="画布工具">
        <button className="cw-tool cw-tool-add" aria-label="添加文本节点" title="添加文本 T" onClick={() => addNode('text')}><Type size={20} /><span>文本</span></button>
        <button className="cw-tool" aria-label="添加图片节点" title="添加图片" onClick={() => addNode('image')}><ImageIcon size={20} /><span>图片</span></button>
        <button className="cw-tool" aria-label="添加视频节点" title="添加视频" onClick={() => addNode('video')}><Film size={20} /><span>视频</span></button>
        <span className="cw-tool-divider" />
        <button className="cw-tool" aria-label="上传图片或视频" title="上传素材" disabled={uploading} onClick={() => fileInputRef.current?.click()}>{uploading ? <LoaderCircle size={20} className="cw-spin" /> : <Upload size={20} />}<span>上传</span></button>
        <button className={`cw-tool ${assetLibraryOpen ? 'is-active' : ''}`} aria-label="打开项目素材库" aria-expanded={assetLibraryOpen} title="项目素材库" onClick={() => { setAssetLibraryOpen(open => !open); if (!assetLibraryOpen) void refreshAssets(); }}><FolderOpen size={20} /><span>素材</span></button>
        <span className="cw-tool-divider" />
        <button className="cw-tool cw-tool-compact" aria-label="撤销" title="撤销 ⌘Z" disabled={!historyRef.current.length} onClick={undo}><Undo2 size={18} /></button>
        <button className="cw-tool cw-tool-compact" aria-label="重做" title="重做 ⇧⌘Z" disabled={!futureRef.current.length} onClick={redo}><Redo2 size={18} /></button>
      </nav>

      {assetLibraryOpen && <aside className="cw-assets-panel" aria-label="项目素材库">
        <div className="cw-assets-head"><span>项目素材 <small>{assets.length}</small></span><div><button className="cw-icon-button" aria-label="刷新素材库" disabled={assetsLoading} onClick={() => void refreshAssets()}><RefreshCw size={14} className={assetsLoading ? 'cw-spin' : ''} /></button><button className="cw-icon-button" aria-label="关闭素材库" onClick={() => setAssetLibraryOpen(false)}><X size={16} /></button></div></div>
        <p>上传的素材保留在这里，随时添加到画布。</p>
        {assets.length ? <div className="cw-assets-grid">{assets.map(asset => <button className="cw-asset-item" key={asset.id} title={`添加 ${asset.name} 到画布`} onClick={() => { addNode(asset.kind, { title: assetTitle(asset), url: asset.url, assetId: asset.id, status: 'succeeded' }); setAssetLibraryOpen(false); }}><span className="cw-asset-thumb">{asset.kind === 'image' ? <img src={asset.url} alt={asset.name} loading="lazy" /> : <><video src={asset.url} preload="metadata" muted playsInline /><Film size={21} /></>}<i><Plus size={17} /></i></span><strong>{assetTitle(asset)}</strong><small>{asset.kind === 'image' ? '图片' : '视频'} · {(asset.size / 1024 / 1024).toFixed(1)} MB</small></button>)}</div> : <div className="cw-assets-empty"><FolderOpen size={29} strokeWidth={1.3} /><span>{assetsLoading ? '正在读取素材…' : '还没有素材，先上传图片或视频'}</span><button onClick={() => fileInputRef.current?.click()}>上传素材</button></div>}
      </aside>}

      {!nodes.length && <section className="cw-empty">
        <div className="cw-empty-mark"><div><Type size={22} /><small>灵感</small></div><span>····</span><div><ImageIcon size={25} /><small>画面</small></div><span>····</span><div><Film size={22} /><small>故事</small></div></div>
        <span className="cw-eyebrow">YOUR NEXT STORY STARTS HERE</span>
        <h1>让灵感，自由生长。</h1>
        <p>从一段文字、一张图片开始，连接你的创作。</p>
        <div className="cw-empty-actions"><button className="cw-primary" onClick={() => addNode('text')}><Plus size={16} />添加第一个节点</button><button className="cw-secondary" onClick={() => fileInputRef.current?.click()}><Upload size={15} />上传素材</button></div>
        <button className="cw-empty-agent" onClick={async () => { if (await settleBeforeLeaving()) onOpenAgent(); }}><Sparkles size={13} />也可以让 Agent 帮你开启创作<ChevronRight size={14} /></button>
      </section>}

      <div className="cw-zoom-tools" aria-label="画布视图控制"><button className="cw-icon-button" aria-label="缩小" onClick={() => void instanceRef.current?.zoomOut({ duration: 160 })}><ZoomOut size={16} /></button><button className="cw-zoom-value" title="重置为 100%" onClick={() => void instanceRef.current?.zoomTo(1, { duration: 200 })}>{Math.round(viewport.zoom * 100)}%</button><button className="cw-icon-button" aria-label="放大" onClick={() => void instanceRef.current?.zoomIn({ duration: 160 })}><ZoomIn size={16} /></button><span /><button className="cw-icon-button" aria-label="适应全部节点" title="适应画布 F" onClick={() => void instanceRef.current?.fitView({ padding: 0.22, duration: 300 })}><Maximize2 size={16} /></button></div>
        <div className="cw-canvas-hint"><kbd>Space</kbd><span>拖动画布</span><i /><kbd>Ctrl</kbd><span>＋滚轮缩放</span><i /><Link2 size={12} /><span>连接节点作为参考</span></div>
      <div className="cw-node-count"><span />{nodes.length} 个节点</div>

      {selected && <aside className="cw-inspector" aria-label="节点设置">
        <div className="cw-inspector-head"><span>节点设置</span><div><button className="cw-icon-button" title="复制节点 ⌘D" aria-label="复制选中节点" onClick={() => duplicateNode(selected.id)}><Copy size={15} /></button><button className="cw-icon-button" aria-label="关闭节点设置" onClick={() => chooseNode(null)}><X size={17} /></button></div></div>
        <div className="cw-inspector-scroll">
          <div className="cw-inspector-type"><span className={`creative-kind creative-kind--${selected.data.kind}`}>{selected.data.kind === 'text' ? <Type size={18} /> : selected.data.kind === 'image' ? <ImageIcon size={18} /> : <Film size={18} />}</span><div><strong>{kindNames[selected.data.kind]}创作</strong><small>{selected.data.kind === 'text' ? '构思、脚本与分镜' : selected.data.kind === 'image' ? '将想法转化为画面' : '让画面成为故事'}</small></div></div>
          <label className="cw-field"><span>节点名称</span><input value={selected.data.title} onFocus={pushHistory} onChange={event => updateNode(selected.id, { title: event.target.value })} maxLength={200} placeholder="给这个节点起个名字" /></label>
          <label className="cw-field cw-prompt-field"><span><span>创作描述</span><small>{selected.data.prompt.length} 字</small></span><textarea maxLength={30000} value={selected.data.prompt} onFocus={pushHistory} onChange={event => updateNode(selected.id, { prompt: event.target.value })} placeholder={selected.data.kind === 'text' ? '描述你的想法，例如：为一款白色运动鞋设计 15 秒短片，拆解成 3 个镜头…' : selected.data.kind === 'image' ? '描述画面主体、构图、光线和风格…' : '描述镜头运动、人物动作与画面氛围…'} rows={6} /></label>
          {selected.data.kind === 'text' && selected.data.text !== undefined && <label className="cw-field cw-prompt-field"><span><span>生成文本</span><small>可直接编辑</small></span><textarea maxLength={100000} value={selected.data.text} onFocus={pushHistory} onChange={event => updateNode(selected.id, { text: event.target.value })} rows={5} /></label>}
          {references.length > 0 && <div className="cw-reference-section"><div className="cw-field-heading"><Link2 size={13} />参考内容 <span>{references.length}</span></div><div className="cw-reference-list">{references.map(({ edge, node }) => node && <div className="cw-reference" key={edge.id}><button onClick={() => chooseNode(node.id)}>{node.data.kind === 'image' ? <ImageIcon size={13} /> : node.data.kind === 'video' ? <Film size={13} /> : <Type size={13} />}<span>{node.data.title}</span></button><button aria-label={`移除对${node.data.title}的引用`} onClick={() => { pushHistory(); setDocument({ ...documentRef.current, edges: documentRef.current.edges.filter(item => item.id !== edge.id) }, true); }}><X size={12} /></button></div>)}</div></div>}
          <div className="cw-section-divider" />
          <div className="cw-field"><span><label htmlFor="cw-generation-model">生成模型</label><button className="cw-inline-link" type="button" onClick={onSettings}>管理服务<ArrowUpRight size={10} /></button></span><div className="cw-model-input"><Sparkles size={14} /><input id="cw-generation-model" maxLength={200} value={selected.data.model || ''} onFocus={pushHistory} onChange={event => updateNode(selected.id, { model: event.target.value })} onBlur={event => { if (event.target.value !== event.target.value.trim()) updateNode(selected.id, { model: event.target.value.trim() }); }} placeholder={services?.[selected.data.kind]?.model || '使用服务默认模型'} aria-label="生成模型" /></div><div className="cw-model-controls"><small>{selected.data.model?.trim() ? '当前节点使用指定模型' : `默认：${services?.[selected.data.kind]?.model || '尚未配置'}`}</small><button type="button" aria-expanded={modelListOpen} onClick={() => { if (modelListOpen) setModelListOpen(false); else if (modelCatalogs[selected.data.kind].loaded) setModelListOpen(true); else void loadModels(selected.data.kind); }}>选择模型<ChevronDown size={11} /></button></div>
            {modelListOpen && <div className="cw-model-catalog"><div className="cw-model-catalog-head"><span>{kindNames[selected.data.kind]}模型</span><button type="button" aria-label="刷新可用模型" disabled={loadingModelKind === selected.data.kind} onClick={() => void loadModels(selected.data.kind)}><RefreshCw size={12} className={loadingModelKind === selected.data.kind ? 'cw-spin' : ''} /></button></div><div className="cw-model-options" role="listbox" aria-label={`选择${kindNames[selected.data.kind]}模型`}><button role="option" aria-selected={!selected.data.model?.trim()} onClick={() => { pushHistory(); updateNode(selected.id, { model: '' }); setModelListOpen(false); }}><span>使用服务默认模型<small>{services?.[selected.data.kind]?.model || '尚未配置'}</small></span>{!selected.data.model?.trim() && <Check size={13} />}</button>{modelCatalogs[selected.data.kind].models.map(model => <button key={model.model_name} role="option" aria-selected={selected.data.model === model.model_name} onClick={() => { pushHistory(); updateNode(selected.id, { model: model.model_name }); setModelListOpen(false); }}><span>{model.model_name}{model.manufacturer && <small>{model.manufacturer}</small>}</span>{selected.data.model === model.model_name && <Check size={13} />}</button>)}</div>{loadingModelKind === selected.data.kind && <p className="cw-model-loading"><LoaderCircle size={12} className="cw-spin" />正在读取服务模型列表…</p>}{modelCatalogs[selected.data.kind].error && <p className="cw-model-list-error" role="status">{modelCatalogs[selected.data.kind].error}</p>}</div>}
          </div>
          {services && !services[selected.data.kind].configured && <button className="cw-connect-service" onClick={onSettings}><span><Settings2 size={13} />连接{kindNames[selected.data.kind]}生成服务</span><ChevronRight size={13} /></button>}
          {selected.data.kind !== 'text' && <div className="cw-parameter-row"><label className="cw-field"><span>画面比例</span>{followsFirstFrame ? <input value="跟随首帧图片" readOnly aria-label="画面比例跟随首帧图片" /> : <select value={selected.data.aspectRatio || '16:9'} onFocus={pushHistory} onChange={event => updateNode(selected.id, { aspectRatio: event.target.value })}><option value="16:9">16:9 横屏</option><option value="9:16">9:16 竖屏</option><option value="1:1">1:1 方形</option><option value="4:3">4:3 标准</option><option value="3:4">3:4 竖版</option></select>}</label>{selected.data.kind === 'video' && <label className="cw-field"><span>视频时长{isBailianVideo && <small>2–15 秒</small>}</span><select value={selected.data.duration || 5} onFocus={pushHistory} onChange={event => updateNode(selected.id, { duration: Number(event.target.value) })}>{isBailianVideo ? <>{selected.data.duration !== undefined && (selected.data.duration < 2 || selected.data.duration > 15) && <option value={selected.data.duration} disabled>{selected.data.duration} 秒 · 请调整</option>}{Array.from({ length: 14 }, (_, index) => index + 2).map(duration => <option key={duration} value={duration}>{duration} 秒</option>)}</> : <><option value={5}>5 秒</option><option value={10}>10 秒</option><option value={15}>15 秒</option></>}</select></label>}</div>}
          {followsFirstFrame && <p className="cw-video-parameter-hint">{autoFirstFrame ? `已连接首帧，生成时将自动使用 ${bailianImageVideoModel}。` : '图生视频使用 1 张图片作为首帧。'}输出比例跟随首帧，不使用单独的比例设置。</p>}
          {videoIssue && <div className="cw-video-input-notice" role="status"><div><CircleAlert size={14} /><p>{videoIssue}</p></div>{suggestImageVideo && <button type="button" onClick={() => { pushHistory(); updateNode(selected.id, { model: bailianImageVideoModel }); }}>选择图生视频模型<ArrowUpRight size={12} /></button>}</div>}
          {selected.data.status && <div className={`cw-generation-state state-${selected.data.status}`}>{isActive(selected.data.status) ? <LoaderCircle size={14} className="cw-spin" /> : selected.data.status === 'failed' ? <CircleAlert size={14} /> : <Check size={14} />}<div><strong>{statusNames[selected.data.status]}</strong>{selected.data.status === 'failed' ? <p>{selected.data.error || '请调整描述后重试'}</p> : isActive(selected.data.status) ? <p>可以继续编辑其他节点，结果会自动更新。</p> : null}</div></div>}
          {(selected.data.url || selected.data.text) && <div className="cw-result-actions"><button onClick={() => setPreviewId(selected.id)}><Expand size={14} />预览结果</button>{selected.data.url && <a href={selected.data.url} download><Download size={14} />下载</a>}</div>}
        </div>
        <div className="cw-inspector-foot"><button className="cw-generate-button" disabled={selectedBusy} onClick={() => void generate(selected.id)}>{selectedBusy ? <LoaderCircle size={16} className="cw-spin" /> : <WandSparkles size={16} />}{selectedBusy ? '正在生成…' : selected.data.url || selected.data.text ? '重新生成' : `生成${kindNames[selected.data.kind]}`}<span>{selectedBusy ? '' : <ArrowUpRight size={16} />}</span></button><button className="cw-delete-button" disabled={selectedBusy} onClick={() => removeNode(selected.id)}><Trash2 size={13} />删除节点</button></div>
      </aside>}

      {draggingFile && <div className="cw-drop-overlay"><Upload size={42} /><h2>松开，添加到画布</h2><p>支持图片和视频素材</p></div>}
      {uploading && <div className="cw-upload-progress"><LoaderCircle size={17} className="cw-spin" />正在上传素材…</div>}
      <input type="file" ref={fileInputRef} accept="image/*,video/*" multiple hidden aria-label="选择素材文件" onChange={event => { if (event.target.files) void uploadFiles(Array.from(event.target.files)); }} />
      {preview && <div className="cw-preview-overlay" onClick={() => setPreviewId(null)} role="dialog" aria-modal="true" aria-label={`预览${preview.data.title}`}><div className="cw-preview-modal" onClick={event => event.stopPropagation()}><div className="cw-preview-head"><span>{preview.data.title}</span><div>{preview.data.url && <a className="cw-preview-download" href={preview.data.url} download><Download size={15} />下载原文件</a>}<button className="cw-icon-button" aria-label="关闭预览" onClick={() => setPreviewId(null)} autoFocus><X size={21} /></button></div></div><div className="cw-preview-content">{preview.data.kind === 'image' && preview.data.url ? <img src={preview.data.url} alt={preview.data.title} /> : preview.data.kind === 'video' && preview.data.url ? <video src={preview.data.url} controls autoPlay playsInline /> : <pre>{preview.data.text || preview.data.prompt || '暂无生成内容'}</pre>}</div></div></div>}
    </div>
  </NodeActionsContext.Provider>;
}

export default function CanvasWorkspace(props: Props) {
  return <ReactFlowProvider><Workspace key={props.projectId} {...props} /></ReactFlowProvider>;
}

import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { ArrowRight, ArrowUp, Check, ChevronDown, ChevronRight, CircleAlert, Clapperboard, ExternalLink, Film, ImagePlus, LayoutGrid, LoaderCircle, MessageSquarePlus, Paperclip, Search, Sparkles, Star, WandSparkles, X } from 'lucide-react';
import { api, streamAgent } from '../api';
import type { AgentEvent, AgentMessage, AppStatus, Asset, Model, Project, Skill } from '../../shared/types';
import './agent.css';

interface AgentWorkspaceProps {
  projectId: string | null;
  onSelectProject: (id: string) => void;
  onOpenCanvas: (id: string) => void;
  onSettings: () => void;
  notify: (text: string) => void;
  refreshKey: number;
  onProjectChange: () => void;
}
interface AgentRequest { message: string; skillId?: string; model?: string; attachmentIds?: string[] }
interface AgentAction { label: string; nodeId?: string }
interface ComposerDraft { message: string; skillId: string | null; model: string; attachments: Asset[] }
const favoriteKey = 'libtv.agent.favorite-skills';
const draftKey = (id: string | null) => `libtv.agent.draft.${id || 'new'}`;
const readDraft = (id: string | null): ComposerDraft => {
  const empty = { message: '', skillId: null, model: '', attachments: [] };
  try {
    const value = JSON.parse(localStorage.getItem(draftKey(id)) || 'null') as Partial<ComposerDraft> | null;
    if (!value || typeof value.message !== 'string') return empty;
    return { message: value.message, skillId: typeof value.skillId === 'string' ? value.skillId : null, model: typeof value.model === 'string' ? value.model : '', attachments: Array.isArray(value.attachments) ? value.attachments.filter(asset => asset && typeof asset.id === 'string' && typeof asset.url === 'string' && asset.projectId === id) : [] };
  } catch { return empty; }
};
const readFavorites = (): string[] => {
  try { const value: unknown = JSON.parse(localStorage.getItem(favoriteKey) || '[]'); return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []; } catch { return []; }
};
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请重试';
const shortName = (name: string) => name.replace(/^models\//, '');

function RichText({ text }: { text: string }) {
  return <div className="agent-rich-text">{text.split('\n').map((line, index) => {
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    const content = (heading?.[2] ?? line).split(/(\*\*[^*]+\*\*)/g).map((part, i) => part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : part);
    return heading ? <h4 key={index}>{content}</h4> : <p key={index}>{content.length && line ? content : <br />}</p>;
  })}</div>;
}

function SkillArtwork({ index }: { index: number }) {
  const scene = index % 6;
  return <div className={`agent-skill-art scene-${scene}`} aria-hidden="true">
    <span className="art-grain" />
    {scene === 0 && <><span className="art-horizon" /><span className="art-sun" /><span className="art-mountain mountain-back" /><span className="art-mountain mountain-front" /><span className="art-film-mark">STORY INTO MOTION</span></>}
    {scene === 1 && <><span className="art-orbit orbit-one" /><span className="art-orbit orbit-two" /><span className="art-bottle"><i /><b>ÉCHO</b><small>EAU DE PARFUM</small></span><span className="art-pedestal" /></>}
    {scene === 2 && <><span className="art-sheet sheet-back" /><span className="art-sheet sheet-front"><i /><i /><i /><i /></span><span className="art-note">THE NEXT SCENE</span></>}
    {scene === 3 && <><span className="art-planet" /><span className="art-planet-ring" /><span className="art-asteroid" /><span className="art-stars">✦<i>✧</i><b>✦</b></span></>}
    {scene === 4 && <><span className="art-frame frame-one" /><span className="art-frame frame-two" /><span className="art-frame frame-three" /><span className="art-play">▶</span></>}
    {scene === 5 && <><span className="art-wave wave-one" /><span className="art-wave wave-two" /><span className="art-wave wave-three" /><span className="art-type">MAKE<br /><i>IT MOVE.</i></span></>}
  </div>;
}

export default function AgentWorkspace({ projectId, onSelectProject, onOpenCanvas, onSettings, notify, refreshKey, onProjectChange }: AgentWorkspaceProps) {
  const [initialDraft] = useState(() => readDraft(projectId));
  const [skills, setSkills] = useState<Skill[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [draft, setDraft] = useState(initialDraft.message);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(initialDraft.skillId);
  const [model, setModel] = useState(initialDraft.model);
  const [attachments, setAttachments] = useState<Asset[]>(initialDraft.attachments);
  const [favorites, setFavorites] = useState<string[]>(readFavorites);
  const [category, setCategory] = useState('全部');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(Boolean(projectId));
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [streamText, setStreamText] = useState('');
  const [actions, setActions] = useState<AgentAction[]>([]);
  const [requestError, setRequestError] = useState('');
  const [libraryError, setLibraryError] = useState('');
  const [showSkills, setShowSkills] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const conversationEnd = useRef<HTMLDivElement>(null);
  const currentId = useRef<string | null>(projectId);
  const creatingProject = useRef<Promise<string> | null>(null);
  const busyRef = useRef(false);
  const alive = useRef(true);
  const lastRequest = useRef<AgentRequest | null>(null);
  const scrollOnUpdate = useRef(true);
  const skipDraftWrite = useRef(false);

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  useEffect(() => {
    let disposed = false;
    async function loadLibrary() {
      await Promise.allSettled([
        api<{ skills: Skill[] }>('/skills').then(result => { if (!disposed) { setSkills(result.skills); setLibraryError(''); } }).catch(error => { if (!disposed) setLibraryError(errorText(error)); }).finally(() => { if (!disposed) setLibraryLoading(false); }),
        api<{ projects: Project[] }>('/projects').then(result => { if (!disposed) setProjects(result.projects); }),
        api<{ models: Model[] }>('/models').then(result => { if (!disposed) setModels(result.models); }),
        api<AppStatus>('/status').then(result => { if (!disposed) setStatus(result); }),
      ]);
    }
    void loadLibrary();
    return () => { disposed = true; };
  }, [refreshKey]);

  useEffect(() => {
    let disposed = false;
    const changed = currentId.current !== projectId;
    currentId.current = projectId;
    if (changed) {
      const savedDraft = readDraft(projectId);
      skipDraftWrite.current = true;
      setMessages([]); setStreamText(''); setActions([]); setRequestError(''); setAttachments(savedDraft.attachments);
      setDraft(savedDraft.message); setSelectedSkillId(savedDraft.skillId); setModel(savedDraft.model); lastRequest.current = null;
    }
    if (!projectId) { setMessages([]); setLoading(false); return; }
    if (busyRef.current) return;
    setLoading(true);
    api<{ messages: AgentMessage[] }>(`/projects/${projectId}/messages`)
      .then(result => { if (!disposed) setMessages(result.messages); })
      .catch(error => { if (!disposed) setRequestError(errorText(error)); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [projectId, refreshKey]);

  useEffect(() => {
    if (skipDraftWrite.current) { skipDraftWrite.current = false; return; }
    try { localStorage.setItem(draftKey(projectId), JSON.stringify({ message: draft, skillId: selectedSkillId, model, attachments })); } catch { /* The composer remains usable when browser storage is unavailable. */ }
  }, [projectId, draft, selectedSkillId, model, attachments]);

  useEffect(() => {
    if (textarea.current) { textarea.current.style.height = 'auto'; textarea.current.style.height = `${Math.min(textarea.current.scrollHeight, 190)}px`; }
  }, [draft]);

  useEffect(() => {
    if (scrollOnUpdate.current && (busy || messages.length)) conversationEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [streamText, actions.length, messages.length, busy]);

  const ensureProject = async (): Promise<string> => {
    if (currentId.current) return currentId.current;
    if (creatingProject.current) return creatingProject.current;
    creatingProject.current = api<{ project: Project }>('/projects', {
      method: 'POST', body: JSON.stringify({ name: draft.trim().slice(0, 24) || 'Agent 创作项目' }),
    }).then(({ project }) => {
      currentId.current = project.id; setProjects(value => [project, ...value]);
      try {
        localStorage.setItem(draftKey(project.id), JSON.stringify({ message: draft, skillId: selectedSkillId, model, attachments }));
        localStorage.removeItem(draftKey(null));
      } catch { /* Server-side project creation remains successful without local draft storage. */ }
      onSelectProject(project.id); onProjectChange(); return project.id;
    }).finally(() => { creatingProject.current = null; });
    return creatingProject.current;
  };

  const newConversation = async () => {
    if (busyRef.current || uploading || loading) return;
    setLoading(true);
    try {
      const { project } = await api<{ project: Project }>('/projects', { method: 'POST', body: JSON.stringify({ name: '新的 Agent 创作' }) });
      setMessages([]); setStreamText(''); setActions([]); setAttachments([]); setDraft('');
      setSelectedSkillId(null); setRequestError(''); lastRequest.current = null;
      currentId.current = project.id;
      setProjects(previous => [project, ...previous]); onSelectProject(project.id); onProjectChange();
      textarea.current?.focus();
    } catch (error) { setRequestError(errorText(error)); }
    finally { if (alive.current) setLoading(false); }
  };

  const runAgent = async (request: AgentRequest) => {
    if (busyRef.current || uploading || !request.message.trim()) return;
    busyRef.current = true; setBusy(true); setRequestError(''); setStreamText(''); setActions([]);
    setShowSkills(false); scrollOnUpdate.current = true; lastRequest.current = request;
    let targetId: string | null = null;
    let terminalError = '';
    try {
      targetId = await ensureProject();
      if (!alive.current || targetId !== currentId.current) return;
      setLoading(false);
      setMessages(previous => [...previous, { id: `pending-${Date.now()}`, role: 'user', content: request.message, createdAt: new Date().toISOString() }]);
      await streamAgent(targetId, request, (event: AgentEvent) => {
        if (!alive.current || targetId !== currentId.current) return;
        if (event.type === 'text') setStreamText(previous => previous + (event.text || ''));
        if (event.type === 'action' && event.label) setActions(previous => [...previous, { label: event.label!, nodeId: event.nodeId }]);
        if (event.type === 'error') { terminalError = event.error || '创作未完成，请重试'; setRequestError(terminalError); }
      });
      if (!alive.current || targetId !== currentId.current) return;
      if (!terminalError) {
        setDraft(''); setAttachments([]); lastRequest.current = null;
        try { localStorage.removeItem(draftKey(targetId)); } catch { /* React state still clears the successful request. */ }
      }
      const result = await api<{ messages: AgentMessage[] }>(`/projects/${targetId}/messages`);
      setMessages(result.messages); setStreamText(''); setActions([]);
    } catch (error) {
      if (alive.current && (!targetId || targetId === currentId.current)) setRequestError(errorText(error));
    } finally {
      busyRef.current = false;
      if (alive.current) { setBusy(false); onProjectChange(); }
    }
  };

  const send = () => void runAgent({ message: draft.trim(), ...(selectedSkillId ? { skillId: selectedSkillId } : {}), ...(model ? { model } : {}), ...(attachments.length ? { attachmentIds: attachments.map(asset => asset.id) } : {}) });
  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); }
  };

  const uploadFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []); event.target.value = '';
    if (!files.length || busyRef.current || uploading) return;
    setUploading(true); setRequestError('');
    try {
      const targetId = await ensureProject();
      for (const file of files) {
        const body = new FormData(); body.append('file', file);
        const { asset } = await api<{ asset: Asset }>(`/projects/${targetId}/assets`, { method: 'POST', body });
        if (alive.current && targetId === currentId.current) setAttachments(previous => [...previous, asset]);
      }
      onProjectChange();
    } catch (error) { setRequestError(errorText(error)); }
    finally { if (alive.current) setUploading(false); }
  };

  const selectSkill = (skill: Skill) => {
    setSelectedSkillId(skill.id); setDraft(skill.prompt); setShowSkills(false);
    textarea.current?.focus(); textarea.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  const toggleFavorite = (id: string) => {
    setFavorites(previous => {
      const next = previous.includes(id) ? previous.filter(value => value !== id) : [...previous, id];
      try { localStorage.setItem(favoriteKey, JSON.stringify(next)); } catch { notify('浏览器暂时无法保存收藏'); }
      return next;
    });
  };
  const selectedSkill = skills.find(skill => skill.id === selectedSkillId);
  const selectedProject = projects.find(project => project.id === projectId);
  const categories = ['全部', ...new Set(skills.map(skill => skill.category)), '我的收藏'];
  const filteredSkills = skills.filter(skill => (category === '全部' || (category === '我的收藏' ? favorites.includes(skill.id) : skill.category === category)) && `${skill.name} ${skill.description}`.toLowerCase().includes(search.toLowerCase()));
  const hasConversation = messages.length > 0 || busy || streamText.length > 0;
  const missingText = status?.services.text.configured === false;
  const availableModels = models;
  const defaultModel = status?.services.text.model;

  const composer = <div className={`agent-composer-zone ${hasConversation ? 'is-conversation' : ''}`}>
    <div className={`agent-composer ${busy ? 'is-working' : ''}`}>
      {selectedSkill && <div className="agent-selected-skill"><WandSparkles size={13} /><span>{selectedSkill.name}</span><button type="button" aria-label="移除当前 Skill" onClick={() => setSelectedSkillId(null)} disabled={busy}><X size={12} /></button></div>}
      {attachments.length > 0 && <div className="agent-attachments">{attachments.map(asset => <div className="agent-attachment" key={asset.id}>
        {asset.kind === 'image' ? <img src={asset.url} alt={asset.name} /> : <Film size={22} />}
        <span title={asset.name}>{asset.name}</span>
        <button type="button" aria-label={`移除附件 ${asset.name}`} onClick={() => setAttachments(previous => previous.filter(item => item.id !== asset.id))} disabled={busy}><X size={12} /></button>
      </div>)}</div>}
      <label className="agent-sr-only" htmlFor="agent-message">描述你想创作的视频</label>
      <textarea ref={textarea} id="agent-message" value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={onComposerKeyDown} rows={hasConversation ? 2 : 3} disabled={busy} placeholder={hasConversation ? '继续描述你的想法，例如：把第二个镜头改成近景…' : '描述你的灵感，让 Agent 帮你写脚本、做分镜、生成视频…'} />
      <div className="agent-composer-tools">
        <div className="agent-composer-tools-left">
          <button type="button" className="agent-composer-tool attachment-tool" onClick={() => fileInput.current?.click()} disabled={busy || uploading} aria-label="上传图片或视频" title="上传参考图片或视频">{uploading ? <LoaderCircle size={18} className="agent-spin" /> : <Paperclip size={18} />}<span className="agent-upload-label">添加素材</span></button>
          <span className="agent-tool-divider" />
          <label className="agent-model-select"><Sparkles size={14} /><select value={model} onChange={event => setModel(event.target.value)} disabled={busy} aria-label="选择创作模型"><option value="">{defaultModel ? shortName(defaultModel) : '默认模型'}</option>{availableModels.filter(item => item.model_name !== defaultModel).map(item => <option key={item.model_name} value={item.model_name}>{shortName(item.model_name)}</option>)}</select><ChevronDown size={12} /></label>
          <button type="button" className={`agent-composer-tool skill-tool ${showSkills ? 'active' : ''}`} onClick={() => { setShowSkills(value => !value); if (!hasConversation) document.getElementById('agent-skill-library')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }} disabled={busy} aria-expanded={showSkills}><WandSparkles size={15} /><span>Skill</span><ChevronDown size={12} /></button>
        </div>
        <button type="button" className="agent-send" onClick={send} disabled={busy || uploading || !draft.trim()} aria-label={busy ? 'Agent 正在创作' : '发送创作需求'}>{busy ? <LoaderCircle size={19} className="agent-spin" /> : <ArrowUp size={20} strokeWidth={2.4} />}</button>
      </div>
    </div>
    <input ref={fileInput} type="file" accept="image/*,video/*" multiple onChange={uploadFiles} hidden aria-label="选择参考素材" />
    {showSkills && hasConversation && <div className="agent-inline-skills">{skills.map(skill => <button key={skill.id} onClick={() => selectSkill(skill)}><WandSparkles size={14} /><span>{skill.name}</span><ChevronRight size={13} /></button>)}</div>}
    <div className="agent-composer-caption"><span>{busy ? 'Agent 正在创作，结果将自动保存到当前项目' : '你的每个想法，都可以在画布中继续创作'}</span><span className="agent-enter-hint">Enter 发送 · Shift + Enter 换行</span></div>
    {missingText && <button className="agent-config-hint" onClick={onSettings}><CircleAlert size={13} /><span>连接 AI 服务，开始你的第一次创作</span><ArrowRight size={13} /></button>}
  </div>;

  return <section className={`agent-workspace ${hasConversation ? 'has-conversation' : ''}`}>
    <header className="agent-topbar">
      <div className="agent-page-label"><span className="agent-page-icon"><Sparkles size={17} /></span><span>LibTV Agent</span><span className="agent-beta">BETA</span></div>
      <div className="agent-header-actions">
        {projectId && <button className="agent-header-button agent-new-conversation" onClick={() => void newConversation()} disabled={busy || uploading || loading} title="新建创作会话"><MessageSquarePlus size={14} /><span>新建会话</span></button>}
        <label className="agent-project-select"><Clapperboard size={14} /><select value={projectId || ''} onChange={event => event.target.value && onSelectProject(event.target.value)} disabled={busy || uploading} aria-label="选择项目与会话"><option value="">选择项目</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select><ChevronDown size={13} /></label>
        {projectId && <button className="agent-header-button agent-canvas-shortcut" onClick={() => onOpenCanvas(projectId)} title="在画布中继续创作"><LayoutGrid size={15} /><span>打开画布</span><ExternalLink size={12} /></button>}
      </div>
    </header>

    {!hasConversation && !loading && <div className="agent-landing">
      <div className="agent-hero">
        <div className="agent-hero-symbol"><span /><Sparkles size={28} strokeWidth={1.4} /></div>
        <div className="agent-hero-eyebrow">YOUR VISION. IN MOTION.</div>
        <h1>让灵感，成为下一帧<span>。</span></h1>
        <p>从一个想法，到一部作品。和你的 AI 创作伙伴一起开始。</p>
      </div>
      {composer}
      <div className="agent-prompt-starters"><span>试着说</span>{['为新款香水创作一支电影感广告', '把我的故事拆解成视频分镜', '让这张图片动起来'].map((prompt, index) => <button key={prompt} onClick={() => { setDraft(prompt); textarea.current?.focus(); }}>{index === 0 ? <Clapperboard size={13} /> : index === 1 ? <Film size={13} /> : <ImagePlus size={13} />}<span>{prompt}</span><ArrowRight size={12} /></button>)}</div>
      {requestError && <div className="agent-error" role="alert"><CircleAlert size={16} /><span>{requestError}</span>{lastRequest.current && <button onClick={() => void runAgent(lastRequest.current!)}>重试</button>}</div>}

      <section className="agent-skill-library" id="agent-skill-library" aria-label="创作 Skill">
        <div className="agent-library-heading"><div><h2>把专业创作，变成一个 Skill<span className="agent-library-spark">✦</span></h2><p>选择一个创作方向，让 Agent 为你完成接下来的步骤。</p></div><div className="agent-library-count"><WandSparkles size={14} /><span>{skills.length} 个创作 Skill</span></div></div>
        <div className="agent-library-toolbar"><div className="agent-category-tabs" role="tablist" aria-label="Skill 分类">{categories.map(value => <button role="tab" aria-selected={category === value} className={category === value ? 'active' : ''} key={value} onClick={() => setCategory(value)}>{value === '我的收藏' && <Star size={12} />}{value}</button>)}</div><label className="agent-skill-search"><Search size={14} /><input placeholder="搜索 Skill" value={search} onChange={event => setSearch(event.target.value)} aria-label="搜索 Skill" />{search && <button onClick={() => setSearch('')} aria-label="清空搜索"><X size={12} /></button>}</label></div>
        {libraryLoading ? <div className="agent-library-loading"><LoaderCircle size={19} className="agent-spin" /><span>正在加载创作 Skill</span></div> : libraryError ? <div className="agent-library-empty"><CircleAlert size={24} /><p>{libraryError}</p><button onClick={onProjectChange}>重新加载</button></div> : filteredSkills.length ? <div className="agent-skill-grid">{filteredSkills.map(skill => <article className="agent-skill-card" key={skill.id}>
          <button className="agent-card-open" onClick={() => selectSkill(skill)} aria-label={`使用 ${skill.name}`}><SkillArtwork index={({ storyboard: 2, 'product-ad': 1, 'image-prompt': 3, script: 0, 'shot-edit': 4, 'prompt-polish': 5 } as Record<string, number>)[skill.id] ?? skills.indexOf(skill)} /><div className="agent-card-body"><div className="agent-card-title"><h3>{skill.name}</h3><span className="agent-card-arrow"><ArrowUp size={15} /></span></div><p>{skill.description}</p><div className="agent-card-meta"><span><WandSparkles size={11} />{skill.category}</span><span>使用 Skill <ChevronRight size={11} /></span></div></div></button>
          <button className={`agent-favorite ${favorites.includes(skill.id) ? 'is-favorite' : ''}`} aria-label={`${favorites.includes(skill.id) ? '取消收藏' : '收藏'} ${skill.name}`} aria-pressed={favorites.includes(skill.id)} onClick={() => toggleFavorite(skill.id)}><Star size={14} fill={favorites.includes(skill.id) ? 'currentColor' : 'none'} /></button>
        </article>)}</div> : <div className="agent-library-empty"><Search size={24} /><p>{category === '我的收藏' && !search ? '收藏常用 Skill，下次更快找到创作方向。' : '没有找到符合条件的 Skill'}</p><button onClick={() => { setSearch(''); setCategory('全部'); }}>查看全部 Skill</button></div>}
      </section>
      <footer className="agent-page-footer"><span className="agent-footer-brand">LibTV</span><span>让每个人，都拥有创作的力量。</span></footer>
    </div>}

    {loading && !hasConversation && <div className="agent-conversation-loading"><LoaderCircle className="agent-spin" size={22} /><span>正在恢复你的创作</span></div>}

    {hasConversation && <div className="agent-chat-layout">
      <div className="agent-conversation-heading"><div><span className="agent-session-label">创作会话</span><h2>{selectedProject?.name || '新的灵感'}</h2></div><span className="agent-autosave"><span />自动保存</span></div>
      <div className="agent-messages" aria-live="polite" aria-relevant="additions text">
        {messages.map(message => <div className={`agent-message role-${message.role}`} key={message.id}>
          {message.role !== 'user' && <div className="agent-message-avatar"><Sparkles size={17} /></div>}
          <div className="agent-message-main">{message.role !== 'user' && <div className="agent-message-author">{message.role === 'tool' ? '创作工具' : 'LibTV Agent'}</div>}<div className="agent-message-content"><RichText text={message.content} /></div>{message.actions && message.actions.length > 0 && <div className="agent-actions">{message.actions.map((action, index) => <button key={`${action.nodeId}-${index}`} onClick={() => projectId && onOpenCanvas(projectId)} className="agent-action-card"><span className="agent-action-check"><Check size={13} /></span><span>{action.label}</span><ArrowRight size={14} /></button>)}<button className="agent-result-link" onClick={() => projectId && onOpenCanvas(projectId)}><LayoutGrid size={14} />在画布中查看创作<ArrowRight size={14} /></button></div>}{message.status === 'failed' && <span className="agent-message-failed"><CircleAlert size={12} />这次创作未完成，可以继续描述需求重试。</span>}</div>
        </div>)}
        {(busy || streamText || actions.length > 0) && <div className="agent-message role-assistant agent-live-message"><div className="agent-message-avatar"><Sparkles size={17} /></div><div className="agent-message-main"><div className="agent-message-author">LibTV Agent {busy && <span className="agent-thinking"><span /><span /><span /></span>}</div>{streamText ? <div className="agent-message-content"><RichText text={streamText} /></div> : busy && <p className="agent-thinking-label">正在理解你的想法，准备创作…</p>}{actions.length > 0 && <div className="agent-actions">{actions.map((action, index) => <div className="agent-action-card" key={`${action.nodeId}-${index}`}><span className="agent-action-check">{action.label.startsWith('操作未完成') ? <CircleAlert size={13} /> : <Check size={13} />}</span><span>{action.label}</span>{action.nodeId && <button className="agent-action-open" onClick={() => currentId.current && onOpenCanvas(currentId.current)} aria-label="在画布查看此节点"><ArrowRight size={14} /></button>}</div>)}</div>}</div></div>}
        {requestError && <div className="agent-error" role="alert"><CircleAlert size={16} /><span>{requestError}</span>{!busy && lastRequest.current && <button onClick={() => void runAgent(lastRequest.current!)}>再次发送</button>}</div>}
        <div ref={conversationEnd} className="agent-conversation-end" />
      </div>
      {composer}
    </div>}
  </section>;
}

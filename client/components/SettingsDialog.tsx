import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, ChevronRight, Image, KeyRound, Loader2, LockKeyhole, Settings2, Sparkles, Video, X } from 'lucide-react';
import { api } from '../api';
import type { AppStatus, Model } from '../../shared/types';

interface ModelCheckResult { models: Model[]; checkedAt: string | number }
type MediaKind = 'image' | 'video';

export default function SettingsDialog({ status, onClose, onSaved, notify }: {
  status: AppStatus;
  onClose: () => void;
  onSaved: (status: AppStatus) => void;
  notify: (text: string) => void;
}) {
  const [tab, setTab] = useState<'text' | 'image' | 'video'>('text');
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<Model[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [checkedAt, setCheckedAt] = useState<string | number | null>(null);
  const [modelError, setModelError] = useState('');
  const [mediaModels, setMediaModels] = useState<Record<MediaKind, Model[]>>({ image: [], video: [] });
  const [mediaModelMessages, setMediaModelMessages] = useState<Record<MediaKind, { error: string; loaded: boolean }>>({ image: { error: '', loaded: false }, video: { error: '', loaded: false } });
  const [loadingMedia, setLoadingMedia] = useState<MediaKind | null>(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    textBaseUrl: status.settings?.textBaseUrl || '',
    textKey: '', textModel: status.services.text.model || '',
    imageProvider: status.settings?.imageProvider || 'openai',
    imageBaseUrl: status.settings?.imageBaseUrl || '', imageKey: '', imageModel: status.services.image.model || '',
    videoProvider: status.settings?.videoProvider || 'ark',
    videoBaseUrl: status.settings?.videoBaseUrl || '', videoKey: '', videoModel: status.services.video.model || '',
  });
  const mounted = useRef(true);
  const modelRequest = useRef<{ sequence: number; controller: AbortController | null }>({ sequence: 0, controller: null });
  const saveRequest = useRef<AbortController | null>(null);
  const loadingModelsRef = useRef(false);
  const savingRef = useRef(false);
  const mediaRequest = useRef<{ sequence: number; controller: AbortController | null; kind: MediaKind | null }>({ sequence: 0, controller: null, kind: null });

  const close = useCallback(() => {
    mounted.current = false;
    modelRequest.current.sequence += 1;
    modelRequest.current.controller?.abort();
    mediaRequest.current.sequence += 1;
    mediaRequest.current.controller?.abort();
    saveRequest.current?.abort();
    onClose();
  }, [onClose]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      modelRequest.current.sequence += 1;
      modelRequest.current.controller?.abort();
      mediaRequest.current.sequence += 1;
      mediaRequest.current.controller?.abort();
      saveRequest.current?.abort();
    };
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [close]);

  const change = (key: keyof typeof form, value: string) => {
    if (form[key] === value || savingRef.current) return;
    if (key === 'textBaseUrl' || key === 'textKey') {
      modelRequest.current.sequence += 1;
      modelRequest.current.controller?.abort();
      modelRequest.current.controller = null;
      loadingModelsRef.current = false;
      setLoadingModels(false); setModels([]); setCheckedAt(null); setModelError('');
    }
    for (const kind of ['image', 'video'] as const) {
      if (key === `${kind}Provider` || key === `${kind}BaseUrl` || key === `${kind}Key`) {
        if (mediaRequest.current.kind === kind) {
          mediaRequest.current.sequence += 1; mediaRequest.current.controller?.abort();
          mediaRequest.current.controller = null; mediaRequest.current.kind = null; setLoadingMedia(null);
        }
        setMediaModels(previous => ({ ...previous, [kind]: [] }));
        setMediaModelMessages(previous => ({ ...previous, [kind]: { error: '', loaded: false } }));
      }
    }
    setError('');
    setForm(previous => ({ ...previous, [key]: value }));
  };

  const save = async () => {
    if (savingRef.current || loadingModelsRef.current || mediaRequest.current.kind || !mounted.current) return;
    const controller = new AbortController();
    saveRequest.current = controller;
    savingRef.current = true; setBusy(true); setError('');
    try {
      const body = Object.fromEntries(Object.entries(form).filter(([key, value]) => !key.endsWith('Key') || value.trim()));
      const response = await api<AppStatus>('/settings', { method: 'PUT', body: JSON.stringify(body), signal: controller.signal });
      if (!mounted.current || controller.signal.aborted) return;
      onSaved(response);
      if (mounted.current) setForm(previous => ({ ...previous, textKey: '', imageKey: '', videoKey: '' }));
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : '设置保存失败，请重试');
    } finally {
      if (saveRequest.current === controller) {
        saveRequest.current = null; savingRef.current = false;
        if (mounted.current) setBusy(false);
      }
    }
  };

  const getModels = async () => {
    if (loadingModelsRef.current || mediaRequest.current.kind || savingRef.current || !mounted.current) return;
    const body = { textBaseUrl: form.textBaseUrl.trim(), textKey: form.textKey.trim() };
    if (!body.textBaseUrl) { setModelError('请先填写服务 URL，再验证模型列表。'); return; }
    const controller = new AbortController();
    const sequence = ++modelRequest.current.sequence;
    modelRequest.current.controller = controller;
    loadingModelsRef.current = true;
    setLoadingModels(true); setModels([]); setCheckedAt(null); setModelError(''); setError('');
    const isCurrent = () => mounted.current && !controller.signal.aborted && sequence === modelRequest.current.sequence;
    try {
      const response = await api<ModelCheckResult>('/models/check', { method: 'POST', body: JSON.stringify(body), signal: controller.signal });
      if (!isCurrent()) return;
      const received = [...new Map(response.models.filter(model => typeof model.model_name === 'string' && model.model_name.trim()).map(model => [model.model_name, model])).values()];
      setModels(received);
      if (!received.length) {
        setModelError('服务返回了空模型列表，尚未确认可用模型。请检查账户权限或服务配置。');
        return;
      }
      setCheckedAt(response.checkedAt);
      notify('模型列表读取成功；选择模型并保存后可用于创作');
    } catch (failure) {
      if (isCurrent()) setModelError(failure instanceof Error ? failure.message : '模型列表验证失败，请重试');
    } finally {
      if (sequence === modelRequest.current.sequence) {
        modelRequest.current.controller = null; loadingModelsRef.current = false;
        if (mounted.current) setLoadingModels(false);
      }
    }
  };

  const cancelModelCheck = () => {
    modelRequest.current.sequence += 1;
    modelRequest.current.controller?.abort();
    modelRequest.current.controller = null;
    loadingModelsRef.current = false; setLoadingModels(false);
  };
  const hasUnsavedMediaService = (kind: MediaKind) => form[`${kind}Provider`] !== (status.settings?.[`${kind}Provider`] || (kind === 'image' ? 'openai' : 'ark')) || form[`${kind}BaseUrl`].trim() !== (status.settings?.[`${kind}BaseUrl`] || '').trim() || Boolean(form[`${kind}Key`].trim());
  const getMediaModels = async (kind: MediaKind) => {
    if (loadingModelsRef.current || mediaRequest.current.kind || savingRef.current || !mounted.current || form[`${kind}Provider`] !== 'bailian') return;
    if (hasUnsavedMediaService(kind)) {
      setMediaModelMessages(previous => ({ ...previous, [kind]: { error: '服务配置尚未保存，请保存后再读取该配置的模型列表。', loaded: false } }));
      return;
    }
    const controller = new AbortController();
    const sequence = ++mediaRequest.current.sequence;
    mediaRequest.current.controller = controller; mediaRequest.current.kind = kind;
    setLoadingMedia(kind);
    setMediaModels(previous => ({ ...previous, [kind]: [] }));
    setMediaModelMessages(previous => ({ ...previous, [kind]: { error: '', loaded: false } }));
    const isCurrent = () => mounted.current && !controller.signal.aborted && sequence === mediaRequest.current.sequence;
    try {
      const response = await api<{ models: Model[] }>(`/models?kind=${kind}`, { signal: controller.signal });
      if (!isCurrent()) return;
      const received = [...new Map(response.models.filter(model => typeof model.model_name === 'string' && model.model_name.trim()).map(model => [model.model_name, model])).values()];
      setMediaModels(previous => ({ ...previous, [kind]: received }));
      setMediaModelMessages(previous => ({ ...previous, [kind]: { error: received.length ? '' : '服务返回了空模型列表，请检查业务空间模型权限。', loaded: received.length > 0 } }));
    } catch (failure) {
      if (isCurrent()) setMediaModelMessages(previous => ({ ...previous, [kind]: { error: failure instanceof Error ? failure.message : '模型列表读取失败，请重试', loaded: false } }));
    } finally {
      if (sequence === mediaRequest.current.sequence) {
        mediaRequest.current.controller = null; mediaRequest.current.kind = null;
        if (mounted.current) setLoadingMedia(null);
      }
    }
  };
  const cancelMediaModels = () => {
    mediaRequest.current.sequence += 1; mediaRequest.current.controller?.abort();
    mediaRequest.current.controller = null; mediaRequest.current.kind = null; setLoadingMedia(null);
  };
  const mediaKind: MediaKind = tab === 'video' ? 'video' : 'image';
  const mediaProvider = form[`${mediaKind}Provider`];
  const isBailian = mediaProvider === 'bailian';
  const checkedDate = checkedAt === null ? null : new Date(checkedAt);
  const checkedTime = checkedDate && Number.isFinite(checkedDate.getTime()) ? checkedDate.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';

  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <section className="dialog settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header className="settings-header"><span className="settings-heading-icon"><Settings2 size={21} /></span><div><h2 id="settings-title">连接你的创作能力</h2><p>配置模型服务，让画布与 Agent 开始工作。</p></div><button className="icon-btn" onClick={close} aria-label="关闭设置"><X size={20} /></button></header>
      <div className="settings-tabs" role="tablist" aria-label="模型服务类型">{[
        { id: 'text' as const, label: '创作与对话', Icon: Sparkles },
        { id: 'image' as const, label: '图片生成', Icon: Image },
        { id: 'video' as const, label: '视频生成', Icon: Video },
      ].map(({ id, label, Icon }) => <button role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)} disabled={busy} key={id}><Icon size={16} />{label}{status.services[id].configured && <i />}</button>)}</div>
      <div className="settings-body">
        <div className="service-state"><span className={status.services[tab].configured ? 'configured' : ''}>{status.services[tab].configured ? <CheckCircle2 size={16} /> : <span className="status-ring" />}{status.services[tab].configured ? '配置已保存' : '等待接入'}</span><small>{tab === 'text' ? 'OpenAI 兼容对话接口' : isBailian ? '阿里云百炼' : tab === 'image' ? 'OpenAI 兼容图像接口' : '火山方舟视频任务接口'}</small></div>
        {tab === 'text' ? <>
          <label className="field-label" htmlFor="text-base">服务 URL</label><input id="text-base" className="form-input code-input" value={form.textBaseUrl} onChange={event => change('textBaseUrl', event.target.value)} placeholder="https://服务域名/compatible-mode/v1" spellCheck={false} disabled={busy} />
          <p className="field-hint">填写 OpenAI 兼容服务的基础 URL，包含 /v1 或 /compatible-mode/v1 等服务要求的路径，无需附加 /chat/completions。</p>
          <label className="field-label" htmlFor="text-key">API Key <span>留空保留原服务密钥</span></label><div className="secret-input"><KeyRound size={15} /><input id="text-key" type="password" autoComplete="off" value={form.textKey} onChange={event => change('textKey', event.target.value)} placeholder="填写该服务的 API Key" disabled={busy} /></div>
          <p className="field-hint">更换服务域名时，需填写新服务的 API Key。密钥仅保存在服务端，保存后不会回显。</p>
          <div className="field-label model-label"><label htmlFor="text-model">对话模型</label><button className="text-link" onClick={() => void getModels()} disabled={loadingModels || Boolean(loadingMedia) || busy}>{loadingModels && <Loader2 size={12} className="spin" />}{loadingModels ? '正在验证…' : '验证并获取模型'}<ChevronRight size={12} /></button></div>
          <input id="text-model" className="form-input" value={form.textModel} onChange={event => change('textModel', event.target.value)} placeholder="从列表选择，或手动填写服务支持的模型 ID" list="available-models" disabled={busy} />
          <datalist id="available-models">{models.map(model => <option key={model.model_name} value={model.model_name}>{model.manufacturer || model.model_name}</option>)}</datalist>
          {loadingModels ? <p className="field-hint" role="status">正在使用当前表单读取模型列表。<button className="text-link" onClick={cancelModelCheck}>取消验证</button></p> : checkedAt !== null && models.length > 0 ? <div className="setup-notice settings-model-check-result" role="status"><p>模型列表读取成功；选择模型并保存后可用于创作</p><p className="field-hint">共 {models.length} 个模型{checkedTime ? ` · ${checkedTime} 验证` : ''}。当前仅确认模型列表可读取，真实生成是否成功需实际调用验证。</p></div> : <p className="field-hint">无需先保存，验证将使用上面填写的 URL 和 API Key。服务不支持模型列表时，可手动填写模型并保存；也可先保存部分配置。</p>}
          {modelError && <div className="form-error" role="alert">{modelError}<p>仍可手动填写服务支持的模型 ID 并保存设置，生成结果以实际调用为准。</p></div>}
        </> : <>
          <label className="field-label" htmlFor="media-provider">服务类型</label><select id="media-provider" className="form-input" value={form[`${tab}Provider`]} onChange={event => change(`${tab}Provider`, event.target.value)} disabled={busy}><option value="bailian">阿里云百炼</option>{tab === 'image' ? <option value="openai">OpenAI 兼容</option> : <option value="ark">火山方舟</option>}</select>
          <div className="setup-notice settings-media-protocol">{isBailian ? tab === 'image' ? '使用阿里云百炼图片生成服务。图片生成后自动保存到当前项目，可在画布继续编辑与引用。' : '使用阿里云百炼异步视频任务。系统会查询生成进度，并将完成的视频保存到当前项目。' : tab === 'image' ? '使用 OpenAI 兼容图片接口，支持文生图与参考图编辑。服务地址应包含接口版本路径。' : '使用火山方舟异步视频任务接口。提交任务后自动查询进度，完成后可在画布预览和下载。'}</div>
          <label className="field-label" htmlFor="media-base">{isBailian ? '业务空间地址' : '服务地址'}</label><input id="media-base" className="form-input code-input" value={form[`${tab}BaseUrl`]} onChange={event => change(`${tab}BaseUrl`, event.target.value)} placeholder={isBailian ? 'https://工作空间.cn-beijing.maas.aliyuncs.com' : tab === 'image' ? 'https://服务域名/v1' : 'https://服务域名/api/v3'} spellCheck={false} disabled={busy} />
          <p className="field-hint">{isBailian ? '填写业务空间根地址，不要附加 /compatible-mode/v1。系统会按图片或视频服务自动补全接口路径。' : tab === 'image' ? '填写提供 OpenAI 兼容图片服务的基础地址，例如以 /v1 结尾。' : '填写火山方舟服务基础地址，通常以 /api/v3 结尾。'}</p>
          <label className="field-label" htmlFor="media-key">服务密钥 <span>{status.services[tab].configured ? '留空保留已有密钥' : ''}</span></label><div className="secret-input"><KeyRound size={15} /><input id="media-key" type="password" autoComplete="off" value={form[`${tab}Key`]} onChange={event => change(`${tab}Key`, event.target.value)} placeholder="填写接口提供的密钥" disabled={busy} /></div>
          <div className="field-label model-label"><label htmlFor="media-model">默认模型</label>{isBailian && <button className="text-link" onClick={() => void getMediaModels(tab)} disabled={busy || loadingModels || Boolean(loadingMedia) || hasUnsavedMediaService(tab)}>{loadingMedia === tab && <Loader2 size={12} className="spin" />}{loadingMedia === tab ? '正在读取…' : '读取模型列表'}<ChevronRight size={12} /></button>}</div><input id="media-model" className="form-input" value={form[`${tab}Model`]} onChange={event => change(`${tab}Model`, event.target.value)} placeholder="填写接口支持的模型 ID" list={isBailian ? `${tab}-available-models` : undefined} disabled={busy} />
          {isBailian && <datalist id={`${tab}-available-models`}>{mediaModels[tab].map(model => <option key={model.model_name} value={model.model_name}>{model.manufacturer || model.model_name}</option>)}</datalist>}
          <p className="field-hint">{status.services[tab].model ? '已保存的默认模型用于画布生成，可按需调整。' : '保存默认模型后，即可在画布提交生成任务。'}{isBailian && (hasUnsavedMediaService(tab) ? ' 地址、密钥或服务类型有未保存修改，先保存后再读取模型列表。' : ' 模型列表使用已保存的业务空间配置读取。')}</p>
          {loadingMedia === tab && <p className="field-hint" role="status">正在读取已保存配置的模型列表。<button className="text-link" onClick={cancelMediaModels}>取消读取</button></p>}
          {isBailian && mediaModelMessages[tab].loaded && <div className="setup-notice settings-model-check-result" role="status">已读取 {mediaModels[tab].length} 个模型。选择模型并保存后可用于后续创作。</div>}
          {isBailian && mediaModelMessages[tab].error && <div className="form-error" role="alert">{mediaModelMessages[tab].error}</div>}
        </>}
        {error && <div className="form-error" role="alert">{error}</div>}
      </div>
      <footer className="settings-footer"><span><LockKeyhole size={13} />凭据保存在服务端</span><button className="primary-btn" disabled={busy || loadingModels || Boolean(loadingMedia)} onClick={() => void save()}>{busy && <Loader2 className="spin" size={16} />}{busy ? '正在保存…' : '保存设置'}</button></footer>
    </section>
  </div>;
}

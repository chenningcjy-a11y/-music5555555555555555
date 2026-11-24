import {
  AiProviderConfig,
  AiProviderKind,
  DiscoveredModel,
  ModelCapabilities,
  StemServiceConfig,
  StemServiceKind,
} from '../../types/ai';

export const BUILTIN_GEMINI_PROVIDER_ID = '__builtin_gemini__';

export function inferClientModelCapabilities(
  kind: AiProviderKind,
  modelId: string
): ModelCapabilities {
  const m = (modelId || '').toLowerCase();
  if (kind === 'gemini') {
    const isEnsemble = m === '__builtin_auto_ensemble__';
    const isTextOrMultimodal =
      !m.includes('embedding') && !m.includes('tts') && !m.includes('image');
    return {
      textReasoning: isTextOrMultimodal || isEnsemble,
      lyricsProcessing: isTextOrMultimodal || isEnsemble,
      dspPlanning: isTextOrMultimodal || isEnsemble,
      audioInputAnalysis:
        isEnsemble ||
        m.includes('gemini-4') ||
        m.includes('gemini-3') ||
        m.includes('gemini-2.5') ||
        m.includes('transcribe'),
      stemSeparation: false,
      note: '支持文本推理与音频理解，音轨分离需使用独立音源分离服务',
    };
  }
  if (kind === 'deepseek') {
    return {
      textReasoning: true,
      lyricsProcessing: true,
      dspPlanning: true,
      audioInputAnalysis: false,
      stemSeparation: false,
      note: '纯文本模型（支持歌词、调音建议与任务规划；不支持音频信号识别与音轨分离）',
    };
  }
  if (kind === 'openai' || kind === 'openai-compatible') {
    const supportsAudio = m.includes('audio-preview') || m.includes('gpt-4o-audio');
    return {
      textReasoning: true,
      lyricsProcessing: true,
      dspPlanning: true,
      audioInputAnalysis: supportsAudio,
      stemSeparation: false,
      note: supportsAudio
        ? '支持文本与音频输入分析；不支持音轨分离'
        : '纯文本模型（不支持原始音频信号听辨与音轨分离）',
    };
  }
  return {
    textReasoning: true,
    lyricsProcessing: true,
    dspPlanning: true,
    audioInputAnalysis: false,
    stemSeparation: false,
    note: '自定义接口（默认文本推理；音轨分离请配置独立分离服务）',
  };
}

async function parseApiJson<T>(res: Response, fallbackError: string): Promise<T> {
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  const text = await res.text();
  const trimmed = text.trim();
  if (
    contentType.includes('text/html') ||
    trimmed.startsWith('<!doctype') ||
    trimmed.startsWith('<!DOCTYPE') ||
    trimmed.startsWith('<html') ||
    trimmed.startsWith('<')
  ) {
    throw new Error('当前为纯静态托管环境，后端 AI 代理接口不可用');
  }
  let parsed: unknown = null;
  try {
    parsed = trimmed ? JSON.parse(trimmed) : null;
  } catch {
    throw new Error(`${fallbackError} (${res.status})`);
  }
  if (!res.ok) {
    const errMsg =
      parsed && typeof parsed === 'object' && 'error' in parsed && typeof (parsed as { error?: unknown }).error === 'string'
        ? (parsed as { error: string }).error
        : '';
    throw new Error(errMsg || `${fallbackError} (${res.status})`);
  }
  return parsed as T;
}

export async function fetchProviders(): Promise<{
  defaultProviderId: string | null;
  providers: AiProviderConfig[];
  builtinGeminiAvailable?: boolean;
  builtinGeminiModels?: string[];
  securityMode: string;
}> {
  const res = await fetch('/api/ai/providers', { headers: { Accept: 'application/json' } });
  return parseApiJson(res, '加载 AI 服务配置失败');
}

export async function saveProvider(payload: {
  id?: string;
  name: string;
  kind: AiProviderKind;
  baseUrl: string;
  model: string;
  availableModels?: string[];
  apiKey?: string;
  enabled?: boolean;
  timeoutMs?: number;
  maxRequestsPerDay?: number;
  customHeadersJson?: string;
  setAsDefault?: boolean;
}): Promise<{ defaultProviderId: string | null; provider: AiProviderConfig }> {
  const res = await fetch('/api/ai/providers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  });
  return parseApiJson(res, '保存服务商失败');
}

export async function deleteProviderById(id: string): Promise<void> {
  const res = await fetch(`/api/ai/providers/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    await parseApiJson(res, '删除服务商失败');
  }
}

export async function deleteProviderKey(id: string): Promise<AiProviderConfig> {
  const res = await fetch(`/api/ai/providers/${encodeURIComponent(id)}/key`, {
    method: 'DELETE',
    headers: { Accept: 'application/json' },
  });
  const json = await parseApiJson<{ provider: AiProviderConfig }>(res, '删除 API Key 失败');
  return json.provider;
}

export async function setDefaultProviderById(id: string): Promise<void> {
  const res = await fetch(`/api/ai/providers/${encodeURIComponent(id)}/default`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    await parseApiJson(res, '切换默认服务商失败');
  }
}

export async function testProviderApi(id: string): Promise<{
  ok: boolean;
  latencyMs: number;
  error?: string;
  modelsFound?: number;
  provider?: AiProviderConfig;
}> {
  const res = await fetch(`/api/ai/providers/${encodeURIComponent(id)}/test`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
  });
  return parseApiJson(res, '测试服务连通性失败');
}

export async function fetchProviderModels(id: string): Promise<{
  models: DiscoveredModel[];
  supportsModelListing: boolean;
  message?: string;
}> {
  const res = await fetch(`/api/ai/providers/${encodeURIComponent(id)}/models`, {
    headers: { Accept: 'application/json' },
  });
  return parseApiJson(res, '获取模型列表失败');
}

export async function fetchStemServices(): Promise<{
  activeStemServiceId: string | null;
  services: StemServiceConfig[];
}> {
  const res = await fetch('/api/ai/stem-services', {
    headers: { Accept: 'application/json' },
  });
  return parseApiJson(res, '加载音源分离服务配置失败');
}

export async function saveStemService(payload: {
  id?: string;
  name: string;
  kind: StemServiceKind;
  baseUrl: string;
  endpointPath: string;
  apiKey?: string;
  clearKey?: boolean;
  enabled?: boolean;
  timeoutMs?: number;
  setActive?: boolean;
}): Promise<{ activeStemServiceId: string | null; service: StemServiceConfig }> {
  const res = await fetch('/api/ai/stem-services', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  });
  return parseApiJson(res, '保存音源分离服务失败');
}

export async function setActiveStemServiceId(serviceId: string | null): Promise<void> {
  const res = await fetch('/api/ai/stem-services/active', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ serviceId }),
  });
  if (!res.ok) {
    await parseApiJson(res, '切换音源分离服务失败');
  }
}

export async function deleteStemServiceById(id: string): Promise<void> {
  const res = await fetch(`/api/ai/stem-services/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    await parseApiJson(res, '删除分离服务失败');
  }
}

export async function testStemServiceById(id: string): Promise<{
  ok: boolean;
  message?: string;
  error?: string;
  service?: StemServiceConfig;
}> {
  const res = await fetch(`/api/ai/stem-services/${encodeURIComponent(id)}/test`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
  });
  return parseApiJson(res, '测试分离服务失败');
}

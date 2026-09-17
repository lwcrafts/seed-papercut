// 火山方舟 API 浏览器直连客户端（票 16）。
//
// 红线：
// - Key 只经参数传入，只存在于调用方内存变量中；本模块不写 localStorage/
//   sessionStorage/cookie，不 console 打印 Key，错误信息里不包含 Key。
// - evolving 必须 SSE 流式（非流式 300s 被网络层切断），600s 超时。
//
// CORS（研究 09-cors-preflight 已验证）：ark.cn-beijing.volces.com 对浏览器
// Origin 反射 ACAO，authorization/content-type 头都在白名单内，直连成立。

export const ARK_BASE = 'https://ark.cn-beijing.volces.com/api/v3';
export const DECOMPOSE_MODEL = 'doubao-seedream-5-0-pro-260628';
export const EVOLVE_MODEL = 'doubao-seed-evolving';

export const DECOMPOSE_TIMEOUT_MS = 300_000; // 拆层实测 93–120s
export const EVOLVE_TIMEOUT_MS = 600_000; // evolving 实测 4–9 分钟

export interface DecomposeItem {
  url?: string;
  b64_json?: string;
  size: string;
  output_format: string;
  z_index: number;
  bounding_box?: { absolute: [number, number, number, number]; normalized?: number[] };
  name?: string;
  description?: string;
}

export interface DecomposeResult {
  items: DecomposeItem[];
  ms: number;
  usedB64: boolean;
}

export interface EvolveResult {
  content: string;
  usage: { total_tokens?: number; completion_tokens?: number } | null;
  ms: number;
}

export type ErrorCategory = 'key' | 'rate-limit' | 'timeout' | 'network' | 'moderation' | 'api' | 'parse' | 'cancelled';

export class ArkError extends Error {
  category: ErrorCategory;
  status: number | null;
  constructor(category: ErrorCategory, message: string, status: number | null = null) {
    super(message);
    this.name = 'ArkError';
    this.category = category;
    this.status = status;
  }
}

/** 把任意异常归类为面向观众的错误类别（不透出 Key 与堆栈）。 */
export function classifyError(err: unknown): { category: ErrorCategory; message: string } {
  if (err instanceof ArkError) return { category: err.category, message: err.message };
  if (err instanceof DOMException && err.name === 'AbortError') {
    return { category: 'timeout', message: '请求超时，网络或模型响应过慢' };
  }
  if (err instanceof TypeError) {
    return { category: 'network', message: '网络请求被浏览器拦截或连接失败（可能是网络不通或 CORS 限制）' };
  }
  return { category: 'api', message: err instanceof Error ? err.message : String(err) };
}

function categoryForStatus(status: number, bodyText: string): ErrorCategory {
  if (status === 401 || status === 403) return 'key';
  if (status === 429) return 'rate-limit';
  if (/sensitive|DataInspection|ContentFilter|审核/i.test(bodyText)) return 'moderation';
  return 'api';
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 400);
  } catch {
    return '';
  }
}

/**
 * 拆层：Seed-2.1-pro（doubao-seedream-5-0-pro-260628）layer_decomposition。
 * 优先请求 b64_json（浏览器内直接解码，绕开 TOS 图片下载的 CORS 不确定性）；
 * 若服务端不认该参数（400）则不带参数重试一次，改走 url 下载。
 */
export async function decompose(opts: {
  apiKey: string;
  imageDataUrl: string;
  signal: AbortSignal;
}): Promise<DecomposeResult> {
  const { apiKey, imageDataUrl, signal } = opts;
  const body = {
    model: DECOMPOSE_MODEL,
    image: imageDataUrl,
    layer_decomposition: true,
    size: '2K',
    watermark: false,
    response_format: 'b64_json',
  };
  const t0 = Date.now();
  let res = await fetch(`${ARK_BASE}/images/generations`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  let status = res.status;
  if (status === 400) {
    // response_format 参数不被接受 → 去掉重试一次
    const { response_format: _omit, ...rest } = body;
    void _omit;
    res = await fetch(`${ARK_BASE}/images/generations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(rest),
      signal,
    });
    status = res.status;
  }
  if (status !== 200) {
    throw new ArkError(categoryForStatus(status, await readErrorBody(res)), `拆层请求失败（HTTP ${status}）`, status);
  }
  const j = (await res.json().catch(() => null)) as { data?: DecomposeItem[] } | null;
  const items = j?.data ?? [];
  if (items.length === 0) throw new ArkError('parse', '拆层响应中没有图层（data 为空）');
  return { items, ms: Date.now() - t0, usedB64: items.some((it) => typeof it.b64_json === 'string' && it.b64_json.length > 0) };
}

/** 拆层返回的图层图 → ImageData（bbox 裁剪的上采样位图）。 */
export async function itemToImageData(item: DecomposeItem, signal: AbortSignal): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
  let blob: Blob;
  if (typeof item.b64_json === 'string' && item.b64_json.length > 0) {
    const bin = atob(item.b64_json);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    blob = new Blob([bytes], { type: `image/${item.output_format || 'png'}` });
  } else if (item.url) {
    let res: Response;
    try {
      res = await fetch(item.url, { signal });
    } catch (err) {
      if (signal.aborted) throw err;
      throw new ArkError('network', '图层图片下载被浏览器 CORS 拦截（拆层服务未授权跨域读取）');
    }
    if (!res.ok) throw new ArkError('api', `图层图片下载失败（HTTP ${res.status}）`);
    blob = await res.blob();
  } else {
    throw new ArkError('parse', '拆层结果项既无 b64_json 也无 url');
  }
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext('2d', { willreadfrequently: true }) as CanvasRenderingContext2D | null;
  if (!ctx) throw new ArkError('api', '无法创建 2D 画布上下文');
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: imgData.width, height: imgData.height, data: imgData.data };
}

/**
 * evolving 语义映射：SSE 流式，onDelta 每收到增量文本回调一次（驱动进度文案）。
 * 返回拼接后的完整 content（原始 JSON 字符串）与 usage。
 */
export async function evolveStream(opts: {
  apiKey: string;
  system: string;
  userText: string;
  baseImageB64: string;
  schema: unknown;
  maxTokens?: number;
  signal: AbortSignal;
  onDelta?: (fullText: string) => void;
}): Promise<EvolveResult> {
  const { apiKey, system, userText, baseImageB64, schema, signal, onDelta } = opts;
  const body = {
    model: EVOLVE_MODEL,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${baseImageB64}`, detail: 'high' } },
          { type: 'text', text: userText },
        ],
      },
    ],
    response_format: { type: 'json_schema', json_schema: schema },
    max_tokens: opts.maxTokens ?? 4096,
    stream: true, // 必须 SSE：非流式 300s 被网络层切断
    stream_options: { include_usage: true },
  };
  const timeoutCtl = new AbortController();
  const onAbort = () => timeoutCtl.abort();
  signal.addEventListener('abort', onAbort);
  const timer = setTimeout(() => timeoutCtl.abort(), EVOLVE_TIMEOUT_MS);
  const t0 = Date.now();
  try {
    let res: Response;
    try {
      res = await fetch(`${ARK_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal: timeoutCtl.signal,
      });
    } catch (err) {
      if (signal.aborted) throw new ArkError('cancelled', '已取消');
      if (err instanceof DOMException && err.name === 'AbortError') throw new ArkError('timeout', '语义映射请求超时（>10 分钟）');
      throw err;
    }
    if (res.status !== 200) {
      throw new ArkError(categoryForStatus(res.status, await readErrorBody(res)), `语义映射请求失败（HTTP ${res.status}）`, res.status);
    }
    if (!res.body) throw new ArkError('network', '响应不是流式（无 body）');
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let content = '';
    let buf = '';
    let usage: EvolveResult['usage'] = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          const delta = j.choices?.[0]?.delta;
          if (delta?.content) {
            content += delta.content;
            onDelta?.(content);
          }
          if (j.usage) usage = j.usage;
        } catch {
          /* 忽略非 JSON 行 */
        }
      }
    }
    return { content, usage, ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

/** 解析 evolving 输出（剥掉可能的 ```json 围栏）。 */
export function parseEvolveJson(content: string): unknown {
  const txt = content
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  try {
    return JSON.parse(txt);
  } catch {
    throw new ArkError('parse', '模型输出不是合法 JSON（映射解析失败）');
  }
}

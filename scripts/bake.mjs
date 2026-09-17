// 烘焙管线（issue 12 前半 + issue 13 后半）：
//   场景图 → Seedream 5.0-pro 拆层 → Seed-Evolving 语义映射
//   → 按映射把各 z 层缩放回原画布合成 → alpha 二值化（闭运算 r=1 + 去 <64px 噪点）
//   → 6 层二值蒙版 PNG（白=纸）
//   → 拓扑修复（4 邻接孤岛检测 + Dijkstra 最短桥 + DSU 链式，桥宽 3mm 圆头胶囊，
//      缝隙红线 1mm：像素粗判 + 矢量化后精算两段式；开运算去毛刺；每层 3mm 外框纸环）
//   → imagetracerjs 矢量化 → LayerSet v2 JSON → public/data/baked/<sceneId>.json
//
// 用法：
//   npm run bake -- xiake            # 全链路；已有中间产物则复用（不重复花钱）
//   npm run bake -- xiake --fresh    # 忽略缓存，重新调 API（拆层约 0.2 元 + evolving 约 4-9 分钟）
//
// 事实约定（来自 spike，勿再踩）：
// - 图层 PNG 是「bbox 区域的上采样裁剪」，必须按 bounding_box 缩放回原画布合成。
// - evolving 必须 SSE 流式（非流式 300s 被网络层切断），600s 超时 + 1 次重试。
// - 拆层必须 watermark:false；响应存档一律脱敏（去 TOS 签名 query）。
// - L1 不并入 z0 满版底图：底图会吞掉天光元素形状，且整层白纸挡光；
//   L1 只取映射到该层的天光图层（云/月光=白纸，天空=镂空透光）。
// - API key 只从仓库外 v2/.env 读，只进内存，不打印不落盘。
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, fetch as undiciFetch } from 'undici';
import { PNG } from 'pngjs';
import { runMaskChecks } from './check-masks.mjs';
import { openMask, closeMaskDisc, addFrameRing, repairTopology, minGapPxRidge, healNarrowGaps, median3, connectedComponents } from './topology.mjs';
import { vectorizeMask } from './vectorize.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT_MS = 600_000;
const BASE = 'https://ark.cn-beijing.volces.com/api/v3';
const DECOMPOSE_MODEL = 'doubao-seedream-5-0-pro-260628';
const EVOLVE_MODEL = 'doubao-seed-evolving';
// 预置场景登记表（spec §5：先只烘焙 1 张）
const SCENES = {
  xiake: {
    image: 'public/scenes/xiake.jpg',
    hint: '暖金色纸雕风古风山水插画：侠客策马、古亭、层叠山峦、松树、祥云、水岸草丛。',
  },
};

const sceneId = process.argv[2];
if (!SCENES[sceneId]) {
  console.error(`usage: npm run bake -- <sceneId> [--fresh]  (known: ${Object.keys(SCENES).join(', ')})`);
  process.exit(1);
}
const fresh = process.argv.includes('--fresh');
const scene = SCENES[sceneId];
const BAKE = join(REPO, '.bake', sceneId);
const ARCHIVE = join(REPO, '..', '.scratch', 'seed-papercut', 'research', 'bake-run');
const key = readKey();
const dispatcher = new Agent({ headersTimeout: TIMEOUT_MS, bodyTimeout: TIMEOUT_MS, connectTimeout: 30_000 });

function readKey() {
  if (process.env.ARK_API_KEY) return process.env.ARK_API_KEY.trim();
  const envPath = join(REPO, '..', '.env'); // v2/.env，仓库外
  const m = readFileSync(envPath, 'utf8').match(/^ARK_API_KEY=(.+)$/m);
  if (!m) { console.error('NO KEY: 未找到 ARK_API_KEY'); process.exit(1); }
  return m[1].trim();
}

// 存档脱敏：TOS 签名 query 一律替换，不泄露可重放的 URL 签名
const sanitize = (obj) =>
  JSON.parse(JSON.stringify(obj).replace(/(X-Tos-[A-Za-z-]+)=[^&"\\]+/g, '$1=<redacted>'));

const log = (s) => console.log(`[bake ${sceneId}] ${s}`);

// ---------- step 1: 拆层 ----------
async function decompose() {
  const outFile = join(BAKE, 'decompose.json');
  if (!fresh && existsSync(outFile)) {
    log('decompose.json 已存在，复用（--fresh 可重跑）');
    return JSON.parse(readFileSync(outFile, 'utf8'));
  }
  const imgPath = join(REPO, scene.image);
  const dataUrl = `data:image/jpeg;base64,${readFileSync(imgPath).toString('base64')}`;
  const body = {
    model: DECOMPOSE_MODEL,
    image: dataUrl,
    layer_decomposition: true,
    size: '2K',
    watermark: false,
  };
  const t0 = Date.now();
  const res = await undiciFetch(`${BASE}/images/generations`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    dispatcher,
  });
  const ms = Date.now() - t0;
  const j = await res.json().catch(() => null);
  const rec = { model: DECOMPOSE_MODEL, at: new Date().toISOString(), status: res.status, ms, sanitized: sanitize(j) };
  writeFileSync(outFile, JSON.stringify(rec, null, 2));
  log(`拆层 status=${res.status} ms=${ms} items=${j?.data?.length ?? 0}`);
  if (res.status !== 200) throw new Error(`拆层失败: ${JSON.stringify(j)?.slice(0, 400)}`);

  // 全量图层本地化（URL 24h 过期）：item 无 name = z0 满版底图 jpeg
  mkdirSync(join(BAKE, 'layers'), { recursive: true });
  for (const [i, it] of (j?.data ?? []).entries()) {
    const url = it.url || it.image_url;
    if (!url) { log(`item${i} 无 url，跳过`); continue; }
    const z = it.z_index ?? i;
    const isBase = it.name == null;
    const fn = isBase ? `base-z${z}.jpeg` : `layer-z${z}.png`;
    const r = await undiciFetch(url, { signal: AbortSignal.timeout(120_000), dispatcher });
    if (!r.ok) throw new Error(`图层下载失败 i=${i} HTTP ${r.status}`);
    writeFileSync(join(BAKE, 'layers', fn), Buffer.from(await r.arrayBuffer()));
    log(`saved ${fn} ${it.size} bbox=${JSON.stringify(it.bounding_box?.absolute ?? null)} name=${it.name ?? '-'}`);
  }
  return rec;
}

// ---------- step 2: evolving 语义映射（SSE，600s 超时 + 1 次重试） ----------
async function evolve(decomposeRec) {
  const outFile = join(BAKE, 'evolve-map.json');
  if (!fresh && existsSync(outFile)) {
    log('evolve-map.json 已存在，复用（--fresh 可重跑）');
    return JSON.parse(readFileSync(outFile, 'utf8'));
  }
  const items = decomposeRec.sanitized.data;
  const base = items.find((it) => it.name == null);
  const layers = items.filter((it) => it.name != null);
  const table = layers.map((it) => {
    const b = it.bounding_box;
    return `- z_index=${it.z_index} 「${it.name}」 normalized_bbox=[${b.normalized.join(',')}] output=${it.size} ${it.output_format}｜${it.description}`;
  }).join('\n');

  // 模板 v2 定稿 system + 本次拆层归并任务附则
  const system = readFileSync(join(REPO, 'scripts', 'evolving-prompt-v2.md'), 'utf8') + `

【本次特殊任务：拆层归并映射】
一台拆层引擎已把输入图拆成 ${layers.length} 个原始图层（另有 1 张 z_index=0 的不透明底图）。清单如下（z_index 越大越靠前/越近观者）：

${table}

请把上面每个原始图层（连同底图）归并映射到六层模板 L1-L6：
1. 每个 element 对应恰好一个原始图层：element.name 必须逐字使用原始图层名（含书名号前的文字即可，不加 z 前缀），bbox 填该图层的 normalized bbox，anchor 按其接地点判定，notes 写归并理由（独占本层/与谁合并/为何归此层）。
2. ${layers.length} 个原始图层每个都必须被分配到恰好一层，总数守恒，不得丢弃或复制；每层至少 1 个 element（底图不算 element，L1 的 mergeNotes 注明"含底图"）。
3. 归并时考虑：同语义同深度的合并（如多丛草、多棵松树）、z 顺序与六层语义的错位（如最靠前的主体剪影应归 L5 而不是 L6，前景草丛才归 L6）。
4. 其余粒度自检、空层禁令等规则照常执行。`;

  const userText = `画面说明：${scene.hint}

请把拆层引擎给出的 ${layers.length} 个原始图层按归并映射规则分配到 L1-L6（本次调用标记：bake-${sceneId}）。先通读图层清单的 z 顺序与语义，再落映射，最后自检：${layers.length} 个图层是否每层分配恰好一次、主体剪影是否落在 L5、前景草丛是否落在 L6。`;

  const b64 = readFileSync(join(BAKE, 'layers', `base-z${base?.z_index ?? 0}.jpeg`)).toString('base64');
  const body = {
    model: EVOLVE_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}`, detail: 'high' } },
        { type: 'text', text: userText },
      ] },
    ],
    response_format: { type: 'json_schema', json_schema: JSON.parse(readFileSync(join(REPO, 'scripts', 'evolving-schema-v2.json'), 'utf8')) },
    max_tokens: 4096,
    stream: true, // 必须 SSE：非流式 300s 被网络层切断
    stream_options: { include_usage: true },
  };

  let rec = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    rec = await evolveOnce(body, attempt);
    if (!rec.error) break;
    log(`evolving 第 ${attempt} 次失败：${rec.error.slice(0, 160)}${attempt === 1 ? '，重试 1 次' : ''}`);
  }
  writeFileSync(outFile, JSON.stringify(rec, null, 2));
  if (rec.error) throw new Error(`evolving 两次尝试均失败: ${rec.error.slice(0, 200)}`);
  log(`evolving status=${rec.status} ms=${rec.ms} tokens=${rec.usage?.total_tokens ?? '?'} unmapped=${rec.mapping.unmapped.length}`);
  return rec;
}

async function evolveOnce(body, attempt) {
  const rec = { attempt, model: body.model, at: new Date().toISOString(), ms: null, status: null, usage: null, parsed: null, mapping: null, error: null };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error('timeout 600s')), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await undiciFetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: ctl.signal,
      dispatcher,
    });
    rec.status = res.status;
    if (res.status !== 200) { rec.error = `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`; return rec; }
    let content = '';
    let buf = '';
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          const delta = j.choices?.[0]?.delta;
          if (delta?.content) content += delta.content;
          if (j.usage) rec.usage = j.usage;
        } catch { /* 忽略非 JSON 行 */ }
      }
    }
    rec.ms = Date.now() - t0;
    const txt = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    rec.parsed = JSON.parse(txt);
    // elements 名字反查 z_index → L1-L6 映射
    const items = JSON.parse(readFileSync(join(BAKE, 'decompose.json'), 'utf8')).sanitized.data;
    const byName = new Map(items.filter((it) => it.name != null).map((it) => [it.name, it.z_index]));
    const mapping = { base: 1, zToL: {}, unmapped: [] };
    for (const L of rec.parsed.layers) {
      for (const el of L.elements) {
        const z = byName.get(el.name);
        if (z === undefined) mapping.unmapped.push(el.name);
        else mapping.zToL[z] = L.index;
      }
    }
    rec.mapping = mapping;
  } catch (e) {
    rec.error = String(e?.message || e).slice(0, 500);
  } finally {
    clearTimeout(timer);
  }
  return rec;
}

// ---------- step 3: 合成 + 二值化 ----------
const THRESHOLD = 128;
const CLOSE_R = 1;          // 闭运算半径（工作分辨率，重连细链断裂）
const DESPECKLE_AREA = 64;  // 小于该面积的独立白区视为噪点（工作分辨率）
const SCALE = 0.5;          // 形态学/拓扑/矢量化在半分辨率上跑（spike 验证参数），蒙版导出全分辨率

// ---------- 冻结规格（spec §3 + 票 09 作者拍板参数） ----------
const SIZE_MM = { width: 200, height: 150 }; // 成品物理尺寸
const BRIDGE_WIDTH_MM = 3;   // 桥宽（真实卡纸）
const GAP_REDLINE_MM = 1;    // 最小镂空缝隙红线：低于判 fail（像素粗判+矢量精算两段式）
const RING_MM = 3;           // 每层外框纸环宽度（孤岛锚定目标，藏在灯箱框边后面）
const OPEN_R_PX = 1;         // 开运算半径（工作分辨率，轻量去毛刺）

function loadAlpha(pngPath, bbox, CW, CH) {
  const png = PNG.sync.read(readFileSync(pngPath));
  const [bx0, by0, bx1, by1] = bbox;
  const bw = bx1 - bx0, bh = by1 - by0;
  const out = new Uint8Array(CW * CH);
  for (let y = 0; y < bh; y++) {
    const cy = by0 + y;
    if (cy < 0 || cy >= CH) continue;
    const sy = Math.min(png.height - 1, Math.floor((y * png.height) / bh));
    for (let x = 0; x < bw; x++) {
      const cx = bx0 + x;
      if (cx < 0 || cx >= CW) continue;
      const sx = Math.min(png.width - 1, Math.floor((x * png.width) / bw));
      out[cy * CW + cx] = png.data[(sy * png.width + sx) * 4 + 3];
    }
  }
  return out;
}

// 4 邻接 BFS 连通分量（触摸边界的分量不视为噪点）
function components(w, h, px) {
  const seen = new Uint8Array(w * h);
  const comps = [];
  for (let i = 0; i < px.length; i++) {
    if (!px[i] || seen[i]) continue;
    const queue = [i];
    seen[i] = 1;
    let touchesBorder = false;
    const pixels = [];
    while (queue.length) {
      const p = queue.pop();
      pixels.push(p);
      const x = p % w, y = (p / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touchesBorder = true;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (px[q] && !seen[q]) { seen[q] = 1; queue.push(q); }
      }
    }
    comps.push({ areaPx: pixels.length, touchesBorder, pixels });
  }
  return comps;
}

function closeMask(w, h, px, r) {
  const out = px.slice();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (px[y * w + x]) continue;
    let any = false;
    for (let dy = -r; dy <= r && !any; dy++) for (let dx = -r; dx <= r; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h && px[ny * w + nx]) { any = true; break; }
    }
    if (any) out[y * w + x] = 1;
  }
  return out;
}

function despeckle(w, h, px, minArea) {
  const out = px.slice();
  for (const c of components(w, h, out)) {
    if (c.areaPx < minArea && !c.touchesBorder) for (const p of c.pixels) out[p] = 0;
  }
  return out;
}

function binarizeLayers(decomposeRec, evolveRec) {
  const cleanedMasks = new Map(); // L -> 工作分辨率清理后蒙版（issue 13 后半的输入）
  const items = decomposeRec.sanitized.data;
  const base = items.find((it) => it.name == null);
  const layers = items.filter((it) => it.name != null);
  const CW = Number(base.size.split('x')[0]);
  const CH = Number(base.size.split('x')[1]);
  const TW = Math.round(CW * SCALE), TH = Math.round(CH * SCALE);
  const metas = layers.map((it) => ({
    z: it.z_index,
    name: it.name,
    file: join(BAKE, 'layers', `layer-z${it.z_index}.png`),
    bbox: it.bounding_box.absolute,
  }));

  log(`解码 ${metas.length} 个图层并缩放回 bbox 合成（canvas=${CW}x${CH}）...`);
  const alphas = new Map();
  for (const m of metas) alphas.set(m.z, loadAlpha(m.file, m.bbox, CW, CH));

  // z → L 映射（z0 底图不进任何蒙版，见文件头说明）
  const zToL = evolveRec.mapping.zToL;
  const byL = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  for (const m of metas) {
    const L = zToL[m.z];
    if (!L) throw new Error(`z${m.z}「${m.name}」未被映射到任何层`);
    byL[L].push(m);
  }

  mkdirSync(join(BAKE, 'masks'), { recursive: true });
  const meta = {
    sceneId, bakedAt: new Date().toISOString(),
    canvas: { w: CW, h: CH },
    params: { threshold: THRESHOLD, closeRadiusPx: CLOSE_R, despeckleAreaPx: DESPECKLE_AREA, workScale: SCALE },
    baseImagePolicy: 'z0 满版底图不并入蒙版：L1 只取天光图层（天空镂空透光）',
    decompose: { model: decomposeRec.model, at: decomposeRec.at, ms: decomposeRec.ms, zItems: layers.length },
    evolve: { model: evolveRec.model, at: evolveRec.at, ms: evolveRec.ms, attempts: evolveRec.attempt, usage: evolveRec.usage },
    layers: [],
  };
  for (let L = 1; L <= 6; L++) {
    const zsL = byL[L];
    if (zsL.length === 0) throw new Error(`L${L} 没有被映射任何图层（空层）`);
    const alpha = new Uint8Array(CW * CH);
    for (const m of zsL) {
      const a = alphas.get(m.z);
      for (let i = 0; i < alpha.length; i++) {
        const s = alpha[i] + a[i];
        alpha[i] = s > 255 ? 255 : s; // 同层 alpha 相加，饱和截断
      }
    }
    // 半分辨率形态学清理
    const small = new Uint8Array(TW * TH);
    for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
      small[y * TW + x] = alpha[Math.min(CH - 1, Math.round(y / SCALE)) * CW + Math.min(CW - 1, Math.round(x / SCALE))] >= THRESHOLD ? 1 : 0;
    }
    const cleaned = despeckle(TW, TH, closeMask(TW, TH, small, CLOSE_R), DESPECKLE_AREA);
    cleanedMasks.set(L, cleaned);
    // 全分辨率导出（白=纸）
    const png = new PNG({ width: CW, height: CH });
    for (let y = 0; y < CH; y++) {
      const sy = Math.min(TH - 1, Math.round(y * SCALE));
      for (let x = 0; x < CW; x++) {
        const sx = Math.min(TW - 1, Math.round(x * SCALE));
        const v = cleaned[sy * TW + sx] ? 255 : 0;
        const p = (y * CW + x) * 4;
        png.data[p] = png.data[p + 1] = png.data[p + 2] = v;
        png.data[p + 3] = 255;
      }
    }
    const maskPath = join(BAKE, 'masks', `L${L}.png`);
    writeFileSync(maskPath, PNG.sync.write(png));
    log(`L${L} [${zsL.map((m) => `z${m.z} ${m.name}`).join(' + ')}] -> masks/L${L}.png`);
    meta.layers.push({ index: L, sources: zsL.map((m) => ({ z: m.z, name: m.name })), mask: `masks/L${L}.png` });
  }
  writeFileSync(join(BAKE, 'bake-meta.json'), JSON.stringify(meta, null, 2));
  return { meta, cleanedMasks };
}

// ---------- step 4（issue 13 后半）：拓扑修复 + 矢量化 + LayerSet v2 ----------

function bakeLayerSet(decomposeRec, evolveRec, bakeMeta, cleanedMasks) {
  const CW = bakeMeta.canvas.w;
  const CH = bakeMeta.canvas.h;
  const TW = Math.round(CW * SCALE);
  const TH = Math.round(CH * SCALE);
  const pxPerMmWork = TW / SIZE_MM.width; // trace/拓扑工作分辨率下的像素每毫米
  const scale = CW / TW;                  // trace 坐标 → viewBox（全分辨率）坐标
  const pxPerMmView = CW / SIZE_MM.width; // viewBox 分辨率下的像素每毫米（记录进 pipeline）
  const ringPx = Math.max(1, Math.round(RING_MM * pxPerMmWork));
  const bridgeRadiusPx = Math.max(1, Math.round((BRIDGE_WIDTH_MM * pxPerMmWork - 1) / 2)); // capsule 宽 = 2r+1 ≈ 3mm
  // 蒙版域缝隙目标 = 红线 + 2px：盖住矢量化轮廓相对像素边界的内缩（~1.5px）与量化误差，
  // 否则蒙版上恰好 1mm 的缝，矢量化后精算会低于红线
  const gapTargetPx = GAP_REDLINE_MM * pxPerMmWork + 2;
  const gapCloseR = Math.max(1, Math.ceil(gapTargetPx / 2));
  const round2 = (v) => Math.round(v * 100) / 100;

  // evolving 给的每层名称/归并说明
  const evolvedLayers = new Map((evolveRec.parsed?.layers ?? []).map((l) => [l.index, l]));

  const layers = [];
  const vectorStage = [];
  for (let L = 1; L <= 6; L++) {
    let m = { w: TW, h: TH, px: cleanedMasks.get(L).slice() };

    // 中值滤波去锯齿/发丝缝 + 轻量形态学开运算去毛刺（票 09 拍板 6）
    m = median3(m, 2);
    m = openMask(m, OPEN_R_PX);
    // 缝隙预闭合：把整段都窄于目标的黑缝物理填掉（激光烧穿不可切）
    m = closeMaskDisc(m, gapCloseR);
    // 闭运算填不掉的瓶颈窄槽按槽中心线判据逐个填掉
    const heal1 = healNarrowGaps(m, gapTargetPx);
    const islandsBeforeRing = connectedComponents(m).comps.filter((c) => !c.touchesBorder).length;

    // 外框纸环：孤岛锚定目标（每张雕刻纸物理上都有保留边框）
    addFrameRing(m, ringPx);

    // 拓扑修复：4 邻接孤岛检测 + Dijkstra 最短桥 + DSU 链式；桥以 3mm 圆头胶囊落进蒙版，
    // 矢量化后自然成为矩形/圆头桥几何（票 09 拍板 4）
    const rep = repairTopology(m, bridgeRadiusPx);
    if (!rep.pass) throw new Error(`L${L} 加桥后仍有 ${rep.islandsAfter} 个孤岛`);

    // 加桥后再闭合+焊接一次：愈合胶囊两侧可能残留的窄黑缝
    m = closeMaskDisc(m, gapCloseR);
    const heal2 = healNarrowGaps(m, gapTargetPx);

    // 缝隙两段式（票 09 拍板 3）：镂空内切宽度（距离场局部极大，即槽中心线）
    // 1) 像素粗判：工作分辨率蒙版；2) 矢量化后精算：同一几何上采样到全分辨率
    //    （矢量化所表示的精确几何）再算内切宽度（格点精度翻倍，0.084mm/px）。
    //    粗格点对斜缝宽度有 ~1.5x 高估，精算若仍低于红线，则回到全分辨率蒙版上
    //    精修一轮窄槽（涂白+OR 回写工作蒙版），直到精算达标。
    const countIslands = (mm) => connectedComponents(mm).comps.filter((c) => !c.touchesBorder).length;
    const gapTargetFullPx = GAP_REDLINE_MM * pxPerMmView + 2;
    const upsampleFull = () => {
      const fullPx = new Uint8Array(CW * CH);
      for (let y = 0; y < CH; y++) {
        const row = (y >> 1) * TW;
        const dst = y * CW;
        for (let x = 0; x < CW; x++) fullPx[dst + x] = m.px[row + (x >> 1)];
      }
      return { w: CW, h: CH, px: fullPx };
    };
    let fullGapPx = 0;
    for (let pass = 0; pass < 3; pass++) {
      fullGapPx = minGapPxRidge(upsampleFull());
      if (fullGapPx >= gapTargetFullPx) break;
      const full = upsampleFull();
      healNarrowGaps(full, gapTargetFullPx);
      for (let y = 0; y < CH; y++) {
        const src = y * CW;
        const dst = (y >> 1) * TW;
        for (let x = 0; x < CW; x++) {
          if (full.px[src + x] === 1) m.px[dst + (x >> 1)] = 1; // OR 回写（只会填纸，不生孤岛）
        }
      }
      const isl = countIslands(m);
      if (isl > 0) throw new Error(`L${L} 全分辨率缝隙精修后出现孤岛 ${isl}`);
    }
    const pixelGapPx = minGapPxRidge(m);
    const pixelGapMm = round2(pixelGapPx / pxPerMmWork);
    const fullGapMm = round2(fullGapPx / pxPerMmView);
    const vec = vectorizeMask(m, { scale, pxPerMm: pxPerMmWork });
    const minGapMm = Math.min(pixelGapMm, fullGapMm);
    const islandsFinal = countIslands(m);
    const pass = islandsFinal === 0 && minGapMm >= GAP_REDLINE_MM && vec.pathD.length > 0;

    const ev = evolvedLayers.get(L);
    const sources = bakeMeta.layers[L - 1].sources.map((s) => s.name).join(' + ');
    layers.push({
      index: L,
      name: ev?.name ?? `第 ${L} 层`,
      depth: round2(L * 0.05), // 相对 LED 面的层深（0.05 = 5mm 层距）
      description: ev?.mergeNotes ?? sources,
      pathD: vec.pathD,
      fabCheck: {
        islands: rep.islands,
        bridgesAdded: rep.bridges.map((b) => ({
          fromId: b.fromId,
          toTarget: b.toTarget,
          lengthMm: round2(b.lengthPx / pxPerMmWork),
          startPx: [Math.round(b.startPx[0] * scale), Math.round(b.startPx[1] * scale)],
          endPx: [Math.round(b.endPx[0] * scale), Math.round(b.endPx[1] * scale)],
        })),
        cutLengthMm: vec.cutLengthMm,
        minGapMm,
        pass,
      },
    });
    vectorStage.push({
      layer: L,
      islandsBeforeRepair: islandsBeforeRing,
      islandsAfterRepair: rep.islandsAfter,
      bridgeWidthMm: round2((2 * bridgeRadiusPx + 1) / pxPerMmWork),
      bridgesAdded: rep.bridges.length,
      healIters: [heal1, heal2],
      contours: vec.contourCount,
      subpaths: vec.pathD.length,
      minGapPixelMm: pixelGapMm,
      minGapFullResMm: fullGapMm,
      minGapMethod: 'inscribed width of hollow regions (distance-transform local maxima); coarse @workRes, refined @viewBox res',
    });
    log(`L${L} 「${layers[L - 1].name}」 孤岛=${rep.islands.length}→${rep.islandsAfter} 桥=${rep.bridges.length} 切割=${vec.cutLengthMm}mm 缝隙=${minGapMm}mm(粗判 ${pixelGapMm}/精算 ${fullGapMm}) pass=${pass}`);

    // 调试 SVG（.bake 内，不进 public；正式 mm 制 SVG 导出是票 15）
    const svgDir = join(BAKE, 'svg');
    mkdirSync(svgDir, { recursive: true });
    writeFileSync(
      join(svgDir, `L${L}.svg`),
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CW} ${CH}"><path fill="#111" fill-rule="evenodd" d="${layers[L - 1].pathD.join(' ')}"/></svg>\n`,
    );
  }

  const layerSet = {
    schemaVersion: 2,
    sceneId,
    sourceImage: scene.image,
    viewBox: `0 0 ${CW} ${CH}`,
    sizeMm: SIZE_MM,
    layers,
    pipeline: {
      decomposeModel: decomposeRec.model,
      mapModel: evolveRec.model,
      zItems: bakeMeta.decompose.zItems,
      mapSource: 'evolving',
      bakedAt: new Date().toISOString(),
      // 物理尺寸换算：viewBox 像素 ↔ mm（200×150mm 成品）
      pxPerMm: round2(pxPerMmView),
      workRes: { w: TW, h: TH, scale: SCALE },
      pxPerMmWork: round2(pxPerMmWork),
      topology: {
        bridgeWidthMm: BRIDGE_WIDTH_MM,
        bridgeRadiusPx,
        gapRedLineMm: GAP_REDLINE_MM,
        gapTargetPx: round2(gapTargetPx),
        gapCloseRadiusPx: gapCloseR,
        medianPasses: 2,
        openRadiusPx: OPEN_R_PX,
        frameRingMm: RING_MM,
        frameRingPx: ringPx,
        connectivity: '4-neighbor BFS',
        bridgeSearch: '8-neighbor weighted Dijkstra + DSU chain',
      },
      tracer: { name: 'imagetracerjs', version: '1.2.6', license: 'Unlicense', ltres: 1, qtres: 1, pathomit: 8, roundcoords: 1 },
      maskStage: {
        threshold: THRESHOLD,
        closeRadiusPx: CLOSE_R,
        despeckleAreaPx: DESPECKLE_AREA,
        decompose: bakeMeta.decompose,
        evolve: { model: bakeMeta.evolve.model, at: bakeMeta.evolve.at, ms: bakeMeta.evolve.ms },
        layers: bakeMeta.layers.map((l) => ({ index: l.index, sources: l.sources })),
      },
      vectorStage,
    },
  };

  const outDir = join(REPO, 'public', 'data', 'baked');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${sceneId}.json`);
  writeFileSync(outPath, JSON.stringify(layerSet));
  log(`LayerSet v2 -> ${outPath} (${(JSON.stringify(layerSet).length / 1024).toFixed(0)}KB)`);
  return layerSet;
}

// ---------- main ----------
mkdirSync(BAKE, { recursive: true });
mkdirSync(ARCHIVE, { recursive: true });
const t0 = Date.now();
const decomposeRec = await decompose();
const evolveRec = await evolve(decomposeRec);
const { meta, cleanedMasks } = binarizeLayers(decomposeRec, evolveRec);
const layerSet = bakeLayerSet(decomposeRec, evolveRec, meta, cleanedMasks);

// 存档（脱敏）到 .scratch/seed-papercut/research/bake-run/，文章留证用
copyFileSync(join(BAKE, 'decompose.json'), join(ARCHIVE, 'decompose-response.json'));
copyFileSync(join(BAKE, 'evolve-map.json'), join(ARCHIVE, 'evolve-map.json'));
copyFileSync(join(BAKE, 'bake-meta.json'), join(ARCHIVE, 'bake-meta.json'));
copyFileSync(join(REPO, 'public', 'data', 'baked', `${sceneId}.json`), join(ARCHIVE, `${sceneId}.layerset.json`));

const checks = runMaskChecks(meta);
writeFileSync(join(BAKE, 'checks.json'), JSON.stringify(checks, null, 2));
copyFileSync(join(BAKE, 'checks.json'), join(ARCHIVE, 'checks.json'));

const allPass = checks.pass && layerSet.layers.every((l) => l.fabCheck.pass);
log(`完成，总耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s，产物在 ${BAKE}`);
if (!allPass) {
  if (!checks.pass) log('蒙版语义自查未通过（见 .bake/xiake/checks.json）');
  if (!layerSet.layers.every((l) => l.fabCheck.pass)) log('存在 fabCheck.pass=false 的图层');
  process.exit(2);
}

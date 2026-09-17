// 现场重跑全链路编排（票 16）：浏览器内的异步任务状态机。
//
// 流水线（与 scripts/bake.mjs 同源，Node 逻辑浏览器化）：
//   拆层（Seedream 5.0-pro layer_decomposition）
//   → evolving 语义映射（SSE 流式，strict json_schema，模板 v2）
//   → 合成 + 二值化（bbox 回位 + alpha 阈值 + 闭运算 + 去噪点）
//   → 拓扑修复（中值滤波/开运算/缝隙闭合/窄缝修复 + 外框纸环 + 孤岛加桥）
//   → 矢量化（imagetracerjs）+ fabCheck → LayerSet v2
//
// 阶段划分对齐 UI 五段：拆层中 / 语义映射中 / 矢量化中 / 拓扑修复中 / 完成。
// 实际计算顺序保持「先拓扑修复后矢量化」（蒙版加桥后才能 trace），
// 因此「矢量化中」段负责蒙版制备（合成+二值化，是矢量化的输入），
// 「拓扑修复中」段完成修复+矢量化+fabCheck，段内详情文案会如实说明。
//
// Key 只经调用方传入本模块的闭包变量，不落盘、不打日志。
import {
  ArkError,
  classifyError,
  decompose,
  evolveStream,
  itemToImageData,
  parseEvolveJson,
} from './ark-client';
import {
  binarizeSixLayers,
  type LayerSource,
} from './raster';
import {
  addFrameRing,
  closeMaskDisc,
  healNarrowGaps,
  median3,
  minGapPxRidge,
  openMask,
  repairTopology,
  connectedComponents,
} from './topology';
import { vectorizeMask } from './vectorize';
import type { FabCheck, Layer, LayerSet } from '../types';

// ---------- 冻结规格（spec §3 + 票 09 作者拍板参数，与 bake.mjs 一致） ----------
const SIZE_MM = { width: 200, height: 150 }; // 成品物理尺寸
const BRIDGE_WIDTH_MM = 3; // 桥宽（真实卡纸）
const GAP_REDLINE_MM = 1; // 最小镂空缝隙红线：低于判 fail（像素粗判+矢量精算两段式）
const RING_MM = 3; // 每层外框纸环宽度（孤岛锚定目标，藏在灯箱框边后面）
const OPEN_R_PX = 1; // 开运算半径（工作分辨率，轻量去毛刺）
const WORK_SCALE = 0.5; // 形态学/拓扑/矢量化在半分辨率上跑

const round2 = (v: number): number => Math.round(v * 100) / 100;

export type RerunStage = 'decompose' | 'map' | 'vectorize' | 'topology';

export interface RerunCallbacks {
  /** 进入某阶段 */
  onStage: (stage: RerunStage) => void;
  /** 阶段内详情（如「模型返回 12 项」） */
  onDetail: (stage: RerunStage, text: string) => void;
  /** 阶段完成（耗时 ms + 汇总一句话） */
  onStageDone: (stage: RerunStage, ms: number, summary: string) => void;
  /** 失败：分类 + 面向观众的消息 */
  onError: (category: string, message: string) => void;
  /** 成功：产出 LayerSet v2 + 总耗时 */
  onSuccess: (layerSet: LayerSet, totalMs: number, timings: Record<RerunStage, number>) => void;
}

export interface RerunOptions {
  apiKey: string;
  /** 预置场景图 URL（同源，如 scenes/xiake.jpg） */
  sceneImageUrl: string;
  sceneId: string;
  sceneHint: string;
  callbacks: RerunCallbacks;
  signal: AbortSignal;
  /** evolving prompt 模板（v2 定稿），由调用方注入（?raw 导入保证离线可用） */
  promptTemplate: string;
  /** evolving strict json_schema */
  schema: unknown;
}

/** 拆层结果项 → base64（数据 URL 或 TOS url 下载），供 evolving 带图调用。 */
async function fetchAsBase64(urlOrB64: string, isB64: boolean, signal: AbortSignal): Promise<string> {
  if (isB64) return urlOrB64;
  const res = await fetch(urlOrB64, { signal });
  if (!res.ok) throw new ArkError('api', `底图下载失败（HTTP ${res.status}）`);
  const blob = await res.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result);
      const comma = s.indexOf(',');
      resolve(comma >= 0 ? s.slice(comma + 1) : s);
    };
    reader.onerror = () => reject(new ArkError('network', '底图读取失败'));
    reader.readAsDataURL(blob);
  });
}

/**
 * 全链路重跑。任何阶段失败都会抛出（调用方先收到 onError），
 * 成功时回调 onSuccess 并返回 LayerSet（与烘焙数据同 schema）。
 */
export async function runLiveRerun(opts: RerunOptions): Promise<void> {
  const { apiKey, sceneImageUrl, sceneId, sceneHint, callbacks, signal } = opts;
  const timings: Record<RerunStage, number> = { decompose: 0, map: 0, vectorize: 0, topology: 0 };
  const t0 = Date.now();
  const checkAbort = (): void => {
    if (signal.aborted) throw new ArkError('cancelled', '已取消');
  };

  try {
    /* ---------------- 阶段 1：拆层 ---------------- */
    callbacks.onStage('decompose');
    checkAbort();
    callbacks.onDetail('decompose', '载入预置场景图…');
    const imgRes = await fetch(sceneImageUrl, { signal });
    if (!imgRes.ok) throw new ArkError('api', `预置场景图载入失败（HTTP ${imgRes.status}）`);
    const imgBlob = await imgRes.blob();
    const imageDataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new ArkError('network', '场景图读取失败'));
      reader.readAsDataURL(imgBlob);
    });
    callbacks.onDetail('decompose', '拆层请求已提交（Seedream 分层引擎，通常约 2 分钟）…');
    const dec = await decompose({ apiKey, imageDataUrl, signal });
    timings.decompose = dec.ms;
    const items = dec.items;
    const base = items.find((it) => it.name == null);
    const layerItems = items.filter((it) => it.name != null);
    if (!base) throw new ArkError('parse', '拆层结果缺少底图（无 name 的满版项）');
    if (layerItems.length === 0) throw new ArkError('parse', '拆层结果没有任何命名图层');
    const [CW, CH] = base.size.split('x').map(Number);
    if (!CW || !CH) throw new ArkError('parse', `底图 size 无法解析：${base.size}`);
    callbacks.onDetail('decompose', `模型返回 ${items.length} 项（底图 1 + 图层 ${layerItems.length}），耗时 ${(dec.ms / 1000).toFixed(0)} 秒`);

    // 解码全部命名图层（ImageData）
    const sources: LayerSource[] = [];
    for (let i = 0; i < layerItems.length; i++) {
      checkAbort();
      const it = layerItems[i];
      callbacks.onDetail('decompose', `解码图层 ${i + 1}/${layerItems.length}：${it.name ?? ''}`);
      const image = await itemToImageData(it, signal);
      if (!it.bounding_box) throw new ArkError('parse', `图层「${it.name}」缺少 bounding_box`);
      sources.push({ z: it.z_index, name: it.name as string, image, bbox: it.bounding_box.absolute });
    }
    callbacks.onStageDone('decompose', dec.ms, `${layerItems.length} 个图层 + 底图（画布 ${CW}×${CH}）`);

    /* ---------------- 阶段 2：evolving 语义映射（SSE） ---------------- */
    callbacks.onStage('map');
    checkAbort();
    const table = layerItems
      .map((it) => {
        const b = it.bounding_box as { normalized?: number[] };
        return `- z_index=${it.z_index} 「${it.name}」 normalized_bbox=[${(b.normalized ?? []).join(',')}] output=${it.size} ${it.output_format}｜${it.description ?? ''}`;
      })
      .join('\n');
    // 模板 v2 定稿 system + 本次拆层归并任务附则（与 bake.mjs 一致）
    const system =
      opts.promptTemplate +
      `

【本次特殊任务：拆层归并映射】
一台拆层引擎已把输入图拆成 ${layerItems.length} 个原始图层（另有 1 张 z_index=0 的不透明底图）。清单如下（z_index 越大越靠前/越近观者）：

${table}

请把上面每个原始图层（连同底图）归并映射到六层模板 L1-L6：
1. 每个 element 对应恰好一个原始图层：element.name 必须逐字使用原始图层名（含书名号前的文字即可，不加 z 前缀），bbox 填该图层的 normalized bbox，anchor 按其接地点判定，notes 写归并理由（独占本层/与谁合并/为何归此层）。
2. ${layerItems.length} 个原始图层每个都必须被分配到恰好一层，总数守恒，不得丢弃或复制；每层至少 1 个 element（底图不算 element，L1 的 mergeNotes 注明"含底图"）。
3. 归并时考虑：同语义同深度的合并（如多丛草、多棵松树）、z 顺序与六层语义的错位（如最靠前的主体剪影应归 L5 而不是 L6，前景草丛才归 L6）。
4. 其余粒度自检、空层禁令等规则照常执行。`;
    const userText = `画面说明：${sceneHint}

请把拆层引擎给出的 ${layerItems.length} 个原始图层按归并映射规则分配到 L1-L6（本次调用标记：live-${sceneId}）。先通读图层清单的 z 顺序与语义，再落映射，最后自检：${layerItems.length} 个图层是否每层分配恰好一次、主体剪影是否落在 L5、前景草丛是否落在 L6。`;

    const baseB64 = await fetchAsBase64(
      (base.b64_json as string) ?? (base.url as string),
      typeof base.b64_json === 'string' && base.b64_json.length > 0,
      signal,
    );
    callbacks.onDetail('map', '语义映射请求已提交（模型推理通常 4–9 分钟，输出会实时显示）…');
    let lastDeltaDetail = 0;
    const ev = await evolveStream({
      apiKey,
      system,
      userText,
      baseImageB64: baseB64,
      schema: opts.schema,
      signal,
      onDelta: (full) => {
        const now = Date.now();
        if (now - lastDeltaDetail > 1200) {
          lastDeltaDetail = now;
          callbacks.onDetail('map', `模型推理输出中… 已接收 ${full.length.toLocaleString('zh-CN')} 字`);
        }
      },
    });
    timings.map = ev.ms;
    const parsed = parseEvolveJson(ev.content) as {
      layers?: Array<{ index: number; name?: string; mergeNotes?: string; elements?: Array<{ name: string }> }>;
    };
    const evolvedLayers = parsed.layers ?? [];
    if (evolvedLayers.length !== 6) throw new ArkError('parse', `映射结果应为 6 层，实际 ${evolvedLayers.length} 层`);
    // elements 名字反查 z_index → L1-L6 映射（与 bake.mjs 相同）
    const byName = new Map(layerItems.map((it) => [it.name as string, it.z_index]));
    const zToL: Record<string, number> = {};
    const unmapped: string[] = [];
    for (const L of evolvedLayers) {
      for (const el of L.elements ?? []) {
        const z = byName.get(el.name);
        if (z === undefined) unmapped.push(el.name);
        else zToL[String(z)] = L.index;
      }
    }
    const tokenInfo = ev.usage?.total_tokens != null ? `，tokens ${ev.usage.total_tokens}` : '';
    callbacks.onStageDone(
      'map',
      ev.ms,
      `L1–L6 映射完成${tokenInfo}${unmapped.length > 0 ? `（${unmapped.length} 项未匹配将被忽略）` : ''}`,
    );

    /* ---------------- 阶段 3：蒙版制备（矢量化的输入） ---------------- */
    callbacks.onStage('vectorize');
    checkAbort();
    callbacks.onDetail('vectorize', '按 bbox 把图层缩放回原画布合成…');
    const bin = binarizeSixLayers(sources, zToL, CW, CH);
    for (let L = 1; L <= 6; L++) {
      const names = (bin.byL[L] ?? []).map((s) => s.name).join(' + ');
      callbacks.onDetail('vectorize', `L${L} 蒙版合成：${names || '（空）'}`);
    }
    const vectorizeMs = Date.now() - t0 - timings.decompose - timings.map;
    timings.vectorize = vectorizeMs;
    callbacks.onStageDone('vectorize', vectorizeMs, '6 层二值蒙版就绪（阈值化 + 闭运算 + 去噪点）');

    /* ---------------- 阶段 4：拓扑修复 + 矢量化 + fabCheck ---------------- */
    callbacks.onStage('topology');
    checkAbort();
    const TW = bin.workRes.w;
    const TH = bin.workRes.h;
    const pxPerMmWork = TW / SIZE_MM.width; // trace/拓扑工作分辨率下的像素每毫米
    const scale = CW / TW; // trace 坐标 → viewBox（全分辨率）坐标
    const pxPerMmView = CW / SIZE_MM.width; // viewBox 分辨率下的像素每毫米
    const ringPx = Math.max(1, Math.round(RING_MM * pxPerMmWork));
    const bridgeRadiusPx = Math.max(1, Math.round((BRIDGE_WIDTH_MM * pxPerMmWork - 1) / 2)); // capsule 宽 = 2r+1 ≈ 3mm
    // 蒙版域缝隙目标 = 红线 + 2px：盖住矢量化轮廓相对像素边界的内缩（~1.5px）与量化误差
    const gapTargetPx = GAP_REDLINE_MM * pxPerMmWork + 2;
    const gapCloseR = Math.max(1, Math.ceil(gapTargetPx / 2));

    const layers: Layer[] = [];
    const vectorStage: Array<Record<string, unknown>> = [];
    for (let L = 1; L <= 6; L++) {
      checkAbort();
      const cleaned = bin.cleanedMasks.get(L);
      if (!cleaned) throw new ArkError('api', `L${L} 蒙版缺失`);
      let m = { w: TW, h: TH, px: cleaned.px.slice() };

      // 中值滤波去锯齿/发丝缝 + 轻量形态学开运算去毛刺（票 09 拍板 6）
      m = median3(m, 2);
      m = openMask(m, OPEN_R_PX);
      // 缝隙预闭合：把整段都窄于目标的黑缝物理填掉（激光烧穿不可切）
      m = closeMaskDisc(m, gapCloseR);
      healNarrowGaps(m, gapTargetPx);
      const islandsBeforeRing = connectedComponents(m).comps.filter((c) => !c.touchesBorder).length;

      // 外框纸环：孤岛锚定目标（每张雕刻纸物理上都有保留边框）
      addFrameRing(m, ringPx);

      // 拓扑修复：4 邻接孤岛检测 + Dijkstra 最短桥 + DSU 链式；桥以 3mm 圆头胶囊落进蒙版
      const rep = repairTopology(m, bridgeRadiusPx);
      if (!rep.pass) throw new ArkError('api', `L${L} 加桥后仍有 ${rep.islandsAfter} 个孤岛（拓扑修复未收敛）`);

      // 加桥后再闭合+焊接一次：愈合胶囊两侧可能残留的窄黑缝
      m = closeMaskDisc(m, gapCloseR);
      const heal2 = healNarrowGaps(m, gapTargetPx);

      // 缝隙两段式（票 09 拍板 3）：像素粗判 + 矢量化几何上的全分辨率精算
      const countIslands = (mm: { w: number; h: number; px: Uint8Array }): number =>
        connectedComponents(mm).comps.filter((c) => !c.touchesBorder).length;
      const gapTargetFullPx = GAP_REDLINE_MM * pxPerMmView + 2;
      const upsampleFull = (): { w: number; h: number; px: Uint8Array } => {
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
        if (isl > 0) throw new ArkError('api', `L${L} 全分辨率缝隙精修后出现孤岛 ${isl}`);
      }
      const pixelGapPx = minGapPxRidge(m);
      const pixelGapMm = round2(pixelGapPx / pxPerMmWork);
      const fullGapMm = round2(fullGapPx / pxPerMmView);
      const vec = vectorizeMask(m, { scale, pxPerMm: pxPerMmWork });
      const minGapMm = Math.min(pixelGapMm, fullGapMm);
      const islandsFinal = countIslands(m);
      const pass = islandsFinal === 0 && minGapMm >= GAP_REDLINE_MM && vec.pathD.length > 0;

      const ev2 = evolvedLayers.find((l) => l.index === L);
      const srcNames = (bin.byL[L] ?? []).map((s) => s.name).join(' + ');
      const fabCheck: FabCheck = {
        islands: rep.islands,
        bridgesAdded: rep.bridges.map((b) => ({
          fromId: b.fromId,
          toTarget: b.toTarget,
          lengthMm: round2(b.lengthPx / pxPerMmWork),
          startPx: [Math.round(b.startPx[0] * scale), Math.round(b.startPx[1] * scale)] as [number, number],
          endPx: [Math.round(b.endPx[0] * scale), Math.round(b.endPx[1] * scale)] as [number, number],
        })),
        cutLengthMm: vec.cutLengthMm,
        minGapMm,
        pass,
      };
      layers.push({
        index: L,
        name: ev2?.name ?? `第 ${L} 层`,
        depth: round2(L * 0.05), // 相对 LED 面的层深（0.05 = 5mm 层距）
        description: ev2?.mergeNotes ?? srcNames,
        pathD: vec.pathD,
        fabCheck,
      });
      vectorStage.push({
        layer: L,
        islandsBeforeRepair: islandsBeforeRing,
        islandsAfterRepair: rep.islandsAfter,
        bridgeWidthMm: round2((2 * bridgeRadiusPx + 1) / pxPerMmWork),
        bridgesAdded: rep.bridges.length,
        healIters: [0, heal2],
        contours: vec.contourCount,
        subpaths: vec.pathD.length,
        minGapPixelMm: pixelGapMm,
        minGapFullResMm: fullGapMm,
        minGapMethod: 'inscribed width of hollow regions (distance-transform local maxima); coarse @workRes, refined @viewBox res',
      });
      callbacks.onDetail(
        'topology',
        `L${L}「${layers[L - 1].name}」孤岛 ${rep.islands.length}→${rep.islandsAfter}，加桥 ${rep.bridges.length}，切割 ${vec.cutLengthMm}mm，缝隙 ${minGapMm}mm`,
      );
    }
    const topologyMs = Date.now() - t0 - timings.decompose - timings.map - timings.vectorize;
    timings.topology = topologyMs;
    const totalCut = layers.reduce((s, l) => s + l.fabCheck.cutLengthMm, 0);
    const allPass = layers.every((l) => l.fabCheck.pass);
    callbacks.onStageDone('topology', topologyMs, `矢量化完成，切割总长 ${round2(totalCut)}mm，${allPass ? '全部图层通过制造检查' : '存在未通过图层'}`);

    /* ---------------- 组装 LayerSet v2 ---------------- */
    const layerSet: LayerSet = {
      schemaVersion: 2,
      sceneId,
      sourceImage: sceneImageUrl.replace(/^.*\/(scenes\/)/, '$1'),
      viewBox: `0 0 ${CW} ${CH}`,
      sizeMm: SIZE_MM,
      layers,
      pipeline: {
        decomposeModel: 'doubao-seedream-5-0-pro-260628',
        mapModel: 'doubao-seed-evolving',
        zItems: layerItems.length,
        mapSource: 'evolving',
        bakedAt: new Date().toISOString(),
        pxPerMm: round2(pxPerMmView),
        workRes: { w: TW, h: TH, scale: WORK_SCALE },
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
          threshold: 128,
          closeRadiusPx: 1,
          despeckleAreaPx: 64,
          decompose: { ms: timings.decompose, zItems: layerItems.length },
          evolve: { model: 'doubao-seed-evolving', ms: timings.map },
          layers: [1, 2, 3, 4, 5, 6].map((L) => ({ index: L, sources: (bin.byL[L] ?? []).map((s) => ({ z: s.z, name: s.name })) })),
        },
        vectorStage,
      },
    };
    callbacks.onSuccess(layerSet, Date.now() - t0, timings);
  } catch (err) {
    if (signal.aborted && !(err instanceof ArkError && err.category === 'cancelled')) {
      callbacks.onError('cancelled', '已取消');
      return;
    }
    const { category, message } = classifyError(err);
    callbacks.onError(category, message);
  }
}

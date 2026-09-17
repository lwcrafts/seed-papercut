// 蒙版制备（票 16 浏览器化：与 scripts/bake.mjs 的合成/二值化段同源移植）。
// 图层 PNG 是「bbox 裁剪 + 上采样」，必须按 bounding_box 缩放回原画布合成；
// alpha 阈值二值化 → 半分辨率闭运算（r=1）+ 去 <64px 噪点 → 6 层工作蒙版。
import type { Mask } from './topology';

// 与 bake.mjs 冻结参数一致
export const THRESHOLD = 128;
export const CLOSE_R = 1; // 闭运算半径（工作分辨率，重连细链断裂）
export const DESPECKLE_AREA = 64; // 小于该面积的独立白区视为噪点（工作分辨率）
export const SCALE = 0.5; // 形态学/拓扑/矢量化在半分辨率上跑（spike 验证参数）

/** 从解码后的图层 ImageData 取 alpha，按 bbox 的 absolute 数值最近邻缩放回 CW×CH 画布。 */
export function extractAlpha(
  img: { width: number; height: number; data: Uint8ClampedArray },
  bbox: [number, number, number, number],
  CW: number,
  CH: number,
): Uint8Array {
  const [bx0, by0, bx1, by1] = bbox;
  const bw = bx1 - bx0;
  const bh = by1 - by0;
  const out = new Uint8Array(CW * CH);
  for (let y = 0; y < bh; y++) {
    const cy = by0 + y;
    if (cy < 0 || cy >= CH) continue;
    const sy = Math.min(img.height - 1, Math.floor((y * img.height) / bh));
    for (let x = 0; x < bw; x++) {
      const cx = bx0 + x;
      if (cx < 0 || cx >= CW) continue;
      const sx = Math.min(img.width - 1, Math.floor((x * img.width) / bw));
      out[cy * CW + cx] = img.data[(sy * img.width + sx) * 4 + 3];
    }
  }
  return out;
}

/** 4 邻接连通分量（与 bake.mjs components() 同源；触摸边界的分量不视为噪点）。 */
export function borderComponents(w: number, h: number, px: Uint8Array): Array<{ areaPx: number; touchesBorder: boolean; pixels: number[] }> {
  const seen = new Uint8Array(w * h);
  const comps: Array<{ areaPx: number; touchesBorder: boolean; pixels: number[] }> = [];
  for (let i = 0; i < px.length; i++) {
    if (!px[i] || seen[i]) continue;
    const queue = [i];
    seen[i] = 1;
    let touchesBorder = false;
    const pixels: number[] = [];
    while (queue.length) {
      const p = queue.pop() as number;
      pixels.push(p);
      const x = p % w;
      const y = (p / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touchesBorder = true;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (px[q] && !seen[q]) {
          seen[q] = 1;
          queue.push(q);
        }
      }
    }
    comps.push({ areaPx: pixels.length, touchesBorder, pixels });
  }
  return comps;
}

/** 方形结构元闭运算 r=1（bake.mjs closeMask 同源；重连细链断裂）。 */
export function closeMaskSquare(w: number, h: number, px: Uint8Array, r: number): Uint8Array {
  const out = px.slice();
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (px[y * w + x]) continue;
      let any = false;
      for (let dy = -r; dy <= r && !any; dy++)
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h && px[ny * w + nx]) {
            any = true;
            break;
          }
        }
      if (any) out[y * w + x] = 1;
    }
  return out;
}

export function despeckle(w: number, h: number, px: Uint8Array, minArea: number): Uint8Array {
  const out = px.slice();
  for (const c of borderComponents(w, h, out)) {
    if (c.areaPx < minArea && !c.touchesBorder) for (const p of c.pixels) out[p] = 0;
  }
  return out;
}

export interface LayerSource {
  z: number;
  name: string;
  /** 该 z 层解码后的 ImageData（bbox 裁剪的上采样 PNG） */
  image: { width: number; height: number; data: Uint8ClampedArray };
  /** bounding_box.absolute */
  bbox: [number, number, number, number];
}

export interface BinarizeResult {
  canvas: { w: number; h: number };
  /** 每层实际并入的 z 列表 */
  byL: Record<number, LayerSource[]>;
  /** L(1..6) → 工作分辨率清理后蒙版 */
  cleanedMasks: Map<number, Mask>;
  workRes: { w: number; h: number };
}

/**
 * 六层蒙版合成 + 二值化（bake.mjs binarizeLayers 同源）。
 * z0 满版底图不并入任何蒙版：底图会吞掉天光元素形状，L1 只取映射到该层的天光图层。
 * canvasW/H 为拆层响应中底图（z0）的 size（全分辨率画布）。
 */
export function binarizeSixLayers(
  sources: LayerSource[],
  zToL: Record<string, number>,
  canvasW: number,
  canvasH: number,
): BinarizeResult {
  if (sources.length === 0) throw new Error('拆层结果中没有可用图层');
  const CW = canvasW;
  const CH = canvasH;
  const TW = Math.round(CW * SCALE);
  const TH = Math.round(CH * SCALE);

  const alphas = new Map<number, Uint8Array>();
  for (const s of sources) alphas.set(s.z, extractAlpha(s.image, s.bbox, CW, CH));

  const byL: Record<number, LayerSource[]> = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  for (const s of sources) {
    const L = zToL[String(s.z)];
    if (!L) throw new Error(`z${s.z}「${s.name}」未被映射到任何层`);
    if (!byL[L]) throw new Error(`映射目标层非法：z${s.z} → L${L}`);
    byL[L].push(s);
  }

  const cleanedMasks = new Map<number, Mask>();
  for (let L = 1; L <= 6; L++) {
    const zsL = byL[L];
    if (zsL.length === 0) throw new Error(`L${L} 没有被映射任何图层（空层）`);
    const alpha = new Uint8Array(CW * CH);
    for (const s of zsL) {
      const a = alphas.get(s.z) as Uint8Array;
      for (let i = 0; i < alpha.length; i++) {
        const v = alpha[i] + a[i];
        alpha[i] = v > 255 ? 255 : v; // 同层 alpha 相加，饱和截断
      }
    }
    // 半分辨率形态学清理
    const small = new Uint8Array(TW * TH);
    for (let y = 0; y < TH; y++)
      for (let x = 0; x < TW; x++) {
        small[y * TW + x] =
          alpha[Math.min(CH - 1, Math.round(y / SCALE)) * CW + Math.min(CW - 1, Math.round(x / SCALE))] >= THRESHOLD ? 1 : 0;
      }
    cleanedMasks.set(L, { w: TW, h: TH, px: despeckle(TW, TH, closeMaskSquare(TW, TH, small, CLOSE_R), DESPECKLE_AREA) });
  }
  return { canvas: { w: CW, h: CH }, byL, cleanedMasks, workRes: { w: TW, h: TH } };
}

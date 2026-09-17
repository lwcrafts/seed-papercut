// 矢量化（票 16 浏览器化：与 scripts/vectorize.mjs 同源移植）：
// 加桥/修复后的二值蒙版 → imagetracerjs 闭合路径 → LayerSet pathD
// + 矢量域精算指标（切割周长、最小缝隙精算）。
//
// 约定：输入 mask 白=纸。trace 空间里 纸=黑/镂空=白（与 route-a spike 相同），
// 取第 0 层（黑，纸）路径。所有 subpath（外轮廓+洞）合入同一 path 的 d 串即可用
// evenodd 正确填充（洞中岛也成立）。坐标系：trace 在工作分辨率上做，输出按
// scale 放大到全分辨率 viewBox（roundcoords 1，即 0.1px 精度）。
import type { Mask } from './topology';
import './vendor/imagetracer.js';

interface TracerGlobal {
  imagedataToTracedata(
    imgd: { width: number; height: number; data: Uint8ClampedArray },
    options: Record<string, unknown>,
  ): { layers: Array<Array<{ isholepath: boolean; segments: TracerSegment[]; holechildren?: number[] }>> };
}
interface TracerSegment {
  type: 'L' | 'Q';
  x1: number; y1: number; x2: number; y2: number; x3?: number; y3?: number;
}
function tracer(): TracerGlobal {
  const t = (globalThis as { ImageTracer?: TracerGlobal }).ImageTracer;
  if (!t) throw new Error('imagetracer 未加载');
  return t;
}

export const TRACER_OPTIONS = {
  ltres: 1,
  qtres: 1,
  pathomit: 8,
  roundcoords: 1,
  linefilter: true,
  rightangleenhance: false,
  colorsampling: 0,
  numberofcolors: 2,
  colorquantcycles: 1,
  pal: [
    { r: 0, g: 0, b: 0, a: 255 }, // 纸（trace 黑层）
    { r: 255, g: 255, b: 255, a: 255 }, // 镂空
  ],
};

// imagetracer 段：L=(x1,y1)→(x2,y2)；Q=(x1,y1)→(x3,y3) 控制 (x2,y2)。
// 二次曲线长度近似：(控制多边形长 + 弦长)/2
function quadLen(s: TracerSegment): number {
  const ctrlPoly = Math.hypot(s.x2 - s.x1, s.y2 - s.y1) + Math.hypot((s.x3 ?? 0) - s.x2, (s.y3 ?? 0) - s.y2);
  const chord = Math.hypot((s.x3 ?? 0) - s.x1, (s.y3 ?? 0) - s.y1);
  return (ctrlPoly + chord) / 2;
}

function segmentsLengthPx(segments: TracerSegment[]): number {
  let len = 0;
  for (const s of segments) {
    len += s.type === 'Q' ? quadLen(s) : Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
  }
  // 闭合边（Z）：末段终点回到首段起点
  const first = segments[0];
  const last = segments[segments.length - 1];
  const ex = last.type === 'Q' ? (last.x3 as number) : last.x2;
  const ey = last.type === 'Q' ? (last.y3 as number) : last.y2;
  len += Math.hypot(ex - first.x1, ey - first.y1);
  return len;
}

// 把 imagetracer 的段转成 d 子路径字符串（M ... L/Q ... Z），坐标 ×scale
function segmentsToD(segments: TracerSegment[], scale: number, roundcoords: number): string {
  const r = (v: number): number => +(v * scale).toFixed(roundcoords);
  let str = `M ${r(segments[0].x1)} ${r(segments[0].y1)} `;
  for (const s of segments) {
    if (s.type === 'Q') {
      str += `Q ${r(s.x2)} ${r(s.y2)} ${r(s.x3 as number)} ${r(s.y3 as number)} `;
    } else {
      str += `L ${r(s.x2)} ${r(s.y2)} `;
    }
  }
  return str + 'Z';
}

/**
 * 矢量化一层蒙版。
 * 返回 { pathD: string[], cutLengthMm, contourCount }
 *  - pathD：每条外轮廓（含其洞）一个 d 串（坐标已 ×scale 到 viewBox 分辨率），
 *    供 evenodd 填充
 *  - cutLengthMm：全部轮廓周长的矢量精算（含纸外框矩形边），mm
 * pxPerMm 为 trace（工作）分辨率下的像素/mm。
 */
export function vectorizeMask(mask: Mask, { scale, pxPerMm, roundcoords = 1 }: { scale: number; pxPerMm: number; roundcoords?: number }): {
  pathD: string[];
  cutLengthMm: number;
  contourCount: number;
} {
  const { w, h, px } = mask;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = px[i] === 1 ? 0 : 255; // 纸=黑（trace 目标），镂空=白
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  const tracedata = tracer().imagedataToTracedata({ width: w, height: h, data }, { ...TRACER_OPTIONS, roundcoords });
  const paperLayer = tracedata.layers[0]; // pal[0] = 黑 = 纸
  if (!paperLayer || paperLayer.length === 0) throw new Error('矢量化结果为空（纸层无路径）');

  const pathD: string[] = [];
  let cutLengthPx = 0;
  for (const p of paperLayer) {
    if (p.isholepath) continue; // 洞已并入父轮廓的 d 串
    let d = segmentsToD(p.segments, scale, roundcoords);
    for (const hci of p.holechildren ?? []) {
      d += ' ' + segmentsToD(paperLayer[hci].segments, scale, roundcoords);
    }
    pathD.push(d);
  }
  for (const p of paperLayer) {
    cutLengthPx += segmentsLengthPx(p.segments);
  }

  return {
    pathD,
    cutLengthMm: round2(cutLengthPx / pxPerMm),
    contourCount: paperLayer.length,
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

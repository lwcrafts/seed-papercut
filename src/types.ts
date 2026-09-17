/**
 * LayerSet JSON schema v2（spec §3 冻结契约）
 *
 * 数据流：scripts/bake.mjs 烘焙管线产出 public/data/baked/<sceneId>.json；
 * 预览器（src/preview/LightboxScene）与制造检查面板只依赖这里声明的字段。
 *
 * 层序约定：layers[0] = L1 靠 LED（最远/最亮），layers[5] = L6 靠观者（最近）。
 * 深度单位：dm（0.05 = 5mm 层距），L1=0.05 … L6=0.30。
 */

/** 制造检查：孤岛（拓扑修复前的未锚定连通分量）。坐标为 viewBox 像素。 */
export interface FabIsland {
  id: number;
  areaPx: number;
  bbox: { x: number; y: number; w: number; h: number };
  /** 到最近保留区域的最短距离（px，穿过镂空）；-1 = 无路径 */
  nearestDistancePx: number;
  /** 最近目标分量 id（加桥对象） */
  nearestTargetId: number;
}

/** 制造检查：自动加的连接桥（3mm 圆头胶囊，矢量域即矩形/圆头几何）。 */
export interface FabBridge {
  fromId: number;
  /** 'frame' = 连到外框纸环/触边主体；数字 = 链式加桥的中间孤岛 id */
  toTarget: number | 'frame';
  lengthMm: number;
  startPx: [number, number];
  endPx: [number, number];
}

/** 制造检查结果。pass = 加桥后 0 孤岛 且 最小缝隙 ≥ 红线 1mm。 */
export interface FabCheck {
  islands: FabIsland[];
  bridgesAdded: FabBridge[];
  /** 切割路径总长（矢量轮廓周长精算，含每层纸外框矩形边） */
  cutLengthMm: number;
  /** 最小镂空缝隙（内切宽度，像素粗判 + 全分辨率精算取小） */
  minGapMm: number;
  pass: boolean;
}

export interface Layer {
  /** 1-based 层号；1 = 靠 LED，6 = 靠观者 */
  index: number;
  name: string;
  /** 层深（单位 dm，0.05 = 5mm 层距） */
  depth: number;
  description: string;
  /**
   * evenodd 填充的 SVG path d 数组；每条 = 一个外轮廓（含其洞的子路径）。
   * 渲染时 join(' ') 成单个 path 的 d（evenodd 下洞/洞中岛都正确）。
   */
  pathD: string[];
  fabCheck: FabCheck;
}

/** 烘焙管线元数据（物理换算、参数与各阶段记录）。 */
export interface PipelineMeta {
  decomposeModel: string;
  mapModel: string;
  zItems: number;
  mapSource: string;
  bakedAt: string;
  /** viewBox 像素 / mm（全分辨率口径） */
  pxPerMm: number;
  /** 拓扑/矢量化工作分辨率（半分辨率）与其相对 viewBox 的缩放 */
  workRes: { w: number; h: number; scale: number };
  pxPerMmWork: number;
  topology: Record<string, unknown>;
  tracer: Record<string, unknown>;
  maskStage: Record<string, unknown>;
  vectorStage: Array<Record<string, unknown>>;
}

export interface LayerSet {
  schemaVersion: 2;
  sceneId: string;
  /** 源图路径（相对站点根或 public/），如 "scenes/xiake.jpg" */
  sourceImage: string;
  /** SVG viewBox 字符串，如 "0 0 2368 1776" */
  viewBox: string;
  /** 成品物理尺寸（mm） */
  sizeMm: { width: number; height: number };
  /** 恒 6 项，L1 靠 LED → L6 靠观者 */
  layers: Layer[];
  pipeline: PipelineMeta;
}

/** 解析 viewBox 字符串；非法时回退 800x600。 */
export interface ViewBox {
  minX: number;
  minY: number;
  width: number;
  height: number;
}

export function parseViewBox(viewBox: string): ViewBox {
  const parts = viewBox.trim().split(/[\s,]+/).map(Number);
  if (parts.length === 4 && parts.every((n) => Number.isFinite(n)) && parts[2] > 0 && parts[3] > 0) {
    return { minX: parts[0], minY: parts[1], width: parts[2], height: parts[3] };
  }
  return { minX: 0, minY: 0, width: 800, height: 600 };
}

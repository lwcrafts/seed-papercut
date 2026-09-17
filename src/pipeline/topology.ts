// 纸雕蒙版拓扑修复（票 16 浏览器化：与 scripts/topology.mjs 同源移植，
// 参数按票 09 作者拍板：桥宽 3mm、缝隙红线 1mm 两段式、形态学开运算去毛刺）。
//
// 约定：px[i] = 1 白纸（保留），0 镂空。连通判定一律 4 邻接（激光切割语境：
// 对角点接触是零宽连接，8 邻接会漏报孤岛）；距离/最短路传播用 8 邻（几何度量）。

export interface Mask {
  w: number;
  h: number;
  px: Uint8Array;
}

export interface Component {
  id: number;
  areaPx: number;
  bbox: { x: number; y: number; w: number; h: number };
  touchesBorder: boolean;
  pixels: number[];
  centroid: { x: number; y: number };
}

export interface Island {
  id: number;
  areaPx: number;
  bbox: { x: number; y: number; w: number; h: number };
  nearestDistancePx: number;
  nearestTargetId: number;
}

export interface Bridge {
  fromId: number;
  toTarget: number | 'frame';
  lengthPx: number;
  startPx: [number, number];
  endPx: [number, number];
}

export function inside(m: Mask, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < m.w && y < m.h;
}

const N4: Array<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
// 距离传播用 8 邻（带 √2 权重），仅用于几何度量，不用于连通判定
const N8: Array<[number, number, number]> = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];

export function connectedComponents(m: Mask): { label: Int32Array; comps: Component[] } {
  const { w, h, px } = m;
  const label = new Int32Array(w * h).fill(-1);
  const comps: Component[] = [];
  const q: number[] = [];
  let nextId = 0;
  for (let s = 0; s < px.length; s++) {
    if (px[s] !== 1 || label[s] !== -1) continue;
    const id = nextId++;
    let area = 0;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    let sumX = 0, sumY = 0;
    let touchesBorder = false;
    const pixels: number[] = [];
    label[s] = id;
    q.length = 0;
    q.push(s);
    while (q.length) {
      const p = q.pop() as number;
      const x = p % w;
      const y = (p / w) | 0;
      pixels.push(p);
      area++;
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touchesBorder = true;
      for (const [dx, dy] of N4) {
        const nx = x + dx;
        const ny = y + dy;
        if (!inside(m, nx, ny)) continue;
        const np = ny * w + nx;
        if (px[np] === 1 && label[np] === -1) {
          label[np] = id;
          q.push(np);
        }
      }
    }
    comps.push({
      id,
      areaPx: area,
      bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
      touchesBorder,
      pixels,
      centroid: { x: sumX / area, y: sumY / area },
    });
  }
  return { label, comps };
}

// ---------- 形态学（圆盘结构元，欧氏宽度口径；画布外按白纸处理保边框） ----------

// 预生成半径 r 的圆盘偏移表
export function discOffsets(r: number): Array<[number, number]> {
  const offs: Array<[number, number]> = [];
  const r2 = r * r;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy <= r2) offs.push([dx, dy]);
    }
  }
  return offs;
}

function morph(m: Mask, r: number, mode: 'dilate' | 'erode'): Mask {
  // mode: 'dilate'（白膨胀）| 'erode'（白腐蚀，画布外按白处理）
  const { w, h, px } = m;
  const offs = discOffsets(r);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (mode === 'dilate') {
        let any = false;
        for (const [dx, dy] of offs) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue; // 画布外不能提供白
          if (px[ny * w + nx] === 1) { any = true; break; }
        }
        out[p] = any ? 1 : 0;
      } else {
        let all = true;
        for (const [dx, dy] of offs) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue; // 画布外按白处理（保住纸边框）
          if (px[ny * w + nx] === 0) { all = false; break; }
        }
        out[p] = all ? 1 : 0;
      }
    }
  }
  return { w, h, px: out };
}

/** 轻量形态学开运算去毛刺：先腐蚀后膨胀，去掉 <2r 宽的白刺/白屑。 */
export function openMask(m: Mask, r: number): Mask {
  if (r <= 0) return m;
  return morph(morph(m, r, 'erode'), r, 'dilate');
}

/** 缝隙闭合：先膨胀后腐蚀，填掉 <~2r+1（欧氏）宽的黑缝（激光烧穿红线 1mm 的物理修复）。 */
export function closeMaskDisc(m: Mask, r: number): Mask {
  if (r <= 0) return m;
  return morph(morph(m, r, 'dilate'), r, 'erode');
}

/** 外框纸环：每层四周保留一条纸边，给孤岛提供锚定目标（物理上每张雕刻纸都有保留边框）。 */
export function addFrameRing(m: Mask, widthPx: number): void {
  const { w, h, px } = m;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x < widthPx || y < widthPx || x >= w - widthPx || y >= h - widthPx) px[y * w + x] = 1;
    }
  }
}

// ---------- 最短逃生路径（8 邻带权 Dijkstra，只走黑像素） ----------

class Heap {
  private d: Float64Array;
  private nodes: number[] = [];
  constructor(d: Float64Array) {
    this.d = d;
  }
  get size(): number {
    return this.nodes.length;
  }
  push(n: number): void {
    const a = this.nodes;
    a.push(n);
    let i = a.length - 1;
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (this.d[a[par]] <= this.d[a[i]]) break;
      [a[par], a[i]] = [a[i], a[par]];
      i = par;
    }
  }
  pop(): number {
    const top = this.nodes[0];
    const last = this.nodes.pop() as number;
    const a = this.nodes;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let best = i;
        if (l < a.length && this.d[a[l]] < this.d[a[best]]) best = l;
        if (r < a.length && this.d[a[r]] < this.d[a[best]]) best = r;
        if (best === i) break;
        [a[best], a[i]] = [a[i], a[best]];
        i = best;
      }
    }
    return top;
  }
}

// 从「分量组」（ownIds，含已被桥并进来的分量）出发在镂空黑像素上做 Dijkstra；
// 第一次碰到组外白纸即最短逃生路径。只走黑像素 → 路径不会穿过别的孤岛；
// 嵌套（环中核）：核先与环并组，下一轮整组向外逃生，天然支持链式。
export function shortestEscape(
  m: Mask,
  label: Int32Array,
  ownIds: Set<number>,
): { distPx: number; targetId: number; path: number[] } | null {
  const { w, h, px } = m;
  const n = w * h;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const heap = new Heap(dist);
  for (let p = 0; p < n; p++) {
    if (px[p] === 1 && ownIds.has(label[p])) {
      dist[p] = 0;
      heap.push(p);
    }
  }
  while (heap.size) {
    const p = heap.pop();
    const x = p % w;
    const y = (p / w) | 0;
    const dp = dist[p];
    for (const [dx, dy, c] of N8) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inside(m, nx, ny)) continue;
      const np = ny * w + nx;
      if (px[np] === 1) {
        if (ownIds.has(label[np])) continue;
        const path = [np];
        let cur = p;
        while (cur !== -1 && (px[cur] === 0 || !ownIds.has(label[cur]))) {
          path.push(cur);
          cur = prev[cur];
        }
        if (cur !== -1) path.push(cur);
        path.reverse();
        return { distPx: dp + c, targetId: label[np], path };
      }
      // 对角移动若两个正交侧格都是纸则禁止（不从纸角缝斜穿，与 4 邻接连通同理）
      if (dx !== 0 && dy !== 0) {
        const s1 = (y + dy) * w + x;
        const s2 = y * w + (x + dx);
        if (px[s1] === 1 && px[s2] === 1) continue;
      }
      const nd = dp + c;
      if (nd < dist[np]) {
        dist[np] = nd;
        prev[np] = p;
        heap.push(np);
      }
    }
  }
  return null;
}

// 圆头桥：沿路径中心线以 radius 扫掠圆盘（capsule = 矩形 + 圆头端），
// 无条件置白（与两端纸体重叠焊接），新像素归入目标分量标签供下一轮寻路。
function paintCapsule(
  m: Mask,
  label: Int32Array,
  path: number[],
  radius: number,
  newLabel: number,
  cells: Set<number>,
): void {
  const { w, h } = m;
  for (const p of path) {
    const x = p % w;
    const y = (p / w) | 0;
    for (let dy = -radius; dy <= radius; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= h) continue;
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dy * dy > radius * radius) continue;
        const nx = x + dx;
        if (nx < 0 || nx >= w) continue;
        const np = ny * w + nx;
        if (m.px[np] === 0) {
          m.px[np] = 1;
          label[np] = newLabel;
          cells.add(np);
        }
      }
    }
  }
}

function chainLength(path: number[], w: number): number {
  let len = 0;
  for (let i = 1; i < path.length; i++) {
    len += Math.hypot((path[i - 1] % w) - (path[i] % w), ((path[i - 1] / w) | 0) - ((path[i] / w) | 0));
  }
  return len;
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

// ---------- 主入口：孤岛检测 + 链式加桥（就地修改 mask） ----------

/**
 * 在 mask（已含外框纸环）上检测孤岛并自动加桥。
 * bridgeRadiusPx：桥扫掠半径（px）；桥宽 = 2r+1。
 * 返回 { islands, bridges, islandsAfter, pass }，mask 被就地修改为加桥后的版本。
 */
export function repairTopology(m: Mask, bridgeRadiusPx: number): {
  islands: Island[];
  bridges: Bridge[];
  islandsAfter: number;
  pass: boolean;
} {
  const { label: rawLabel, comps } = connectedComponents(m);
  const safeIds = comps.filter((c) => c.touchesBorder).map((c) => c.id);
  const safeSet = new Set(safeIds);
  const islandComps = comps.filter((c) => !c.touchesBorder);

  // 孤岛表（最近目标/距离 = 原始栅格上的最短逃生路径）
  const islands: Island[] = islandComps.map((c) => {
    const esc = shortestEscape(m, rawLabel, new Set([c.id]));
    return {
      id: c.id,
      areaPx: c.areaPx,
      bbox: c.bbox,
      nearestDistancePx: esc ? round2(esc.distPx) : -1,
      nearestTargetId: esc ? esc.targetId : -1,
    };
  });

  // DSU：桥把分量并成组；组一旦含安全分量即 anchored
  const parent = new Int32Array(comps.length).map((_, i) => i);
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const anchored = (id: number): boolean => {
    if (id < 0) return false;
    const r = find(id);
    for (const s of safeIds) if (find(s) === r) return true;
    return false;
  };
  const groupLabels = new Map<number, Set<number>>();
  for (const c of comps) groupLabels.set(c.id, new Set([c.id]));

  const label = rawLabel;
  const bridges: Bridge[] = [];
  const remaining = new Set(islandComps.map((c) => c.id));
  let guard = 0;
  while (remaining.size > 0) {
    if (++guard > 1000) throw new Error('加桥循环异常（不应出现）');
    let pick: { from: Component; esc: { distPx: number; targetId: number; path: number[] }; toAnchored: boolean } | null = null;
    for (const c of islandComps) {
      if (!remaining.has(c.id)) continue;
      const own = groupLabels.get(find(c.id)) as Set<number>;
      const esc = shortestEscape(m, label, own);
      if (!esc) continue;
      const toAnchored = anchored(esc.targetId);
      if (!pick || (toAnchored && !pick.toAnchored) || (toAnchored === pick.toAnchored && esc.distPx < pick.esc.distPx)) {
        pick = { from: c, esc, toAnchored };
      }
    }
    if (!pick) throw new Error('存在无法逃逸的孤岛（不应出现）');
    const { from, esc } = pick;
    paintCapsule(m, label, esc.path, bridgeRadiusPx, esc.targetId, new Set());
    const ra = find(from.id);
    const rb = find(esc.targetId);
    if (ra !== rb) {
      parent[ra] = rb;
      const merged = groupLabels.get(ra) as Set<number>;
      for (const t of merged) (groupLabels.get(rb) as Set<number>).add(t);
      groupLabels.delete(ra);
    }
    remaining.delete(from.id);
    bridges.push({
      fromId: from.id,
      toTarget: safeSet.has(esc.targetId) ? 'frame' : esc.targetId,
      lengthPx: chainLength(esc.path, m.w),
      startPx: [esc.path[0] % m.w, (esc.path[0] / m.w) | 0],
      endPx: [esc.path[esc.path.length - 1] % m.w, (esc.path[esc.path.length - 1] / m.w) | 0],
    });
  }

  // 加桥后重跑连通性验证（4 邻接）
  const after = connectedComponents(m);
  const islandsAfter = after.comps.filter((c) => !c.touchesBorder).length;
  return { islands, bridges, islandsAfter, pass: islandsAfter === 0 };
}

// ---------- 缝隙指标（像素粗判：黑像素距离变换脊线） ----------

// 全局距离变换：每个黑像素到最近白纸的欧氏近似距离
function distanceTransform(m: Mask): Float64Array {
  const { w, h, px } = m;
  const n = w * h;
  const dist = new Float64Array(n).fill(Infinity);
  const heap = new Heap(dist);
  for (let p = 0; p < n; p++) {
    if (px[p] === 1) {
      dist[p] = 0;
      heap.push(p);
    }
  }
  while (heap.size) {
    const p = heap.pop();
    const x = p % w;
    const y = (p / w) | 0;
    const dp = dist[p];
    for (const [dx, dy, c] of N8) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inside(m, nx, ny)) continue;
      const np = ny * w + nx;
      if (px[np] === 1) continue;
      const nd = dp + c;
      if (nd < dist[np]) {
        dist[np] = nd;
        heap.push(np);
      }
    }
  }
  return dist;
}

/**
 * 槽中心线判据：黑像素距离场的局部极大（平台）= 内切圆心。槽宽 ≈ 2×内切半径。
 * 注意不能用 spike 的「两相反方向下坡」判据：它把纸边 1px 深的边界凹坑（锯齿
 * 阶梯的副产品，激光沿单一走线切割、无烧穿风险）也当成缝，导致误报和修复不收敛。
 */
function isSlotCenterline(dist: Float64Array, px: Uint8Array, w: number, h: number, x: number, y: number): boolean {
  const p = y * w + x;
  const d = dist[p];
  // d ≥ 2：排除镂空区凸角像素（凸角处 d=1 的像素也是局部极大，但那是纸边转角
  // 不是缝；真正的槽在闭运算+修复后宽度 ≥ 目标，中心线 d 远大于 2）
  if (px[p] !== 0 || !isFinite(d) || d < 2) return false;
  for (const [dx, dy] of N8) {
    const nx = x + dx;
    const ny = y + dy;
    let nd: number;
    if (nx < 0 || ny < 0 || nx >= w || ny >= h) nd = 0; // 画布外按白纸
    else {
      const np = ny * w + nx;
      nd = px[np] === 1 ? 0 : dist[np];
    }
    if (nd > d + 0.01) return false; // 邻居更高 → 不是局部极大
  }
  return true;
}

/**
 * 最小镂空缝隙（像素域粗判）：黑像素距离场局部极大（内切圆心）处宽度 ≈ 2×d，
 * 取全局最小。无任何槽（如整层白纸）返回 0。
 */
export function minGapPxRidge(m: Mask): number {
  const { w, h, px } = m;
  const dist = distanceTransform(m);
  let minD = Infinity;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (isSlotCenterline(dist, px, w, h, x, y) && dist[y * w + x] < minD) minD = dist[y * w + x];
    }
  }
  return minD === Infinity ? 0 : 2 * minD;
}

/**
 * 窄缝修复：找所有宽度 < minGapPx 的槽中心线（局部极大判据），就地涂白半径
 * halfR 的圆盘把槽填掉，迭代到没有窄槽为止（每次迭代黑像素严格减少，必收敛）。
 * 与闭运算互补：闭运算填「整段均匀的窄通道」，本函数填「瓶颈/变宽窄槽」。
 * 返回迭代次数。
 */
export function healNarrowGaps(m: Mask, minGapPx: number, maxIter = 30): number {
  const { w, h, px } = m;
  const halfR = Math.max(1, Math.ceil(minGapPx / 2));
  const disc = discOffsets(halfR);
  for (let it = 1; it <= maxIter; it++) {
    const dist = distanceTransform(m);
    const bad: Array<[number, number]> = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (isSlotCenterline(dist, px, w, h, x, y) && 2 * dist[y * w + x] < minGapPx + 0.5) bad.push([x, y]);
      }
    }
    if (bad.length === 0) return it - 1;
    for (const [x, y] of bad) {
      for (const [dx, dy] of disc) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < w && ny < h) m.px[ny * w + nx] = 1; // 涂白（含原本就是白的，幂等）
      }
    }
  }
  return maxIter;
}

/**
 * 3×3 中值滤波：去二值化阶梯锯齿、1px 边界凹坑与发丝裂缝（亚 0.2mm 特征本就
 * 不可切割）。pass 次数默认 2。
 */
export function median3(m: Mask, passes = 2): Mask {
  const { w, h } = m;
  let cur = m.px;
  for (let t = 0; t < passes; t++) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let ones = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) { ones += 3; continue; } // 画布外按白计（保边）
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) { ones++; continue; }
            if (cur[yy * w + xx] === 1) ones++;
          }
        }
        out[y * w + x] = ones >= 5 ? 1 : 0;
      }
    }
    cur = out;
  }
  return { w, h, px: cur };
}

import './style.css';
import { LightboxScene, type CameraViewName, type StructurePart } from '../preview/LightboxScene';
import { parseViewBox, type FabCheck, type Layer, type LayerSet } from '../types';

const EMPTY_FAB: FabCheck = {
  islands: [],
  bridgesAdded: [],
  cutLengthMm: 0,
  minGapMm: 0,
  pass: false,
};

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
}

interface LegacyLayer {
  index?: number;
  name?: string;
  depth?: number;
  description?: string;
  pathD?: string | string[];
  svgPath?: string;
  svgContent?: string;
  fabCheck?: Partial<FabCheck>;
}

interface LegacyLayerSet {
  sceneId?: string;
  sourceImage?: string;
  viewBox?: string;
  sizeMm?: { width: number; height: number };
  pipeline?: unknown;
  layers?: LegacyLayer[];
}

/** Accept LayerSet v2 plus the legacy v1 JSON ({layers:[{svgPath,svgContent}]}). */
function normalizeLayerSet(raw: unknown, fallbackSceneId = 'uploaded-layers'): LayerSet {
  const container: LegacyLayerSet = Array.isArray(raw)
    ? { layers: raw as LegacyLayer[] }
    : ((raw ?? {}) as LegacyLayerSet);
  const rawLayers = container.layers ?? [];
  if (rawLayers.length === 0) {
    throw new Error('未检测到有效的 layers 数组');
  }

  const layers: Layer[] = rawLayers.map((l, idx) => {
    let pathD: string[] = Array.isArray(l.pathD) ? l.pathD : l.pathD ? [l.pathD] : [];
    if (pathD.length === 0 && l.svgPath) pathD = [l.svgPath];
    if (pathD.length === 0 && l.svgContent) {
      pathD = [...l.svgContent.matchAll(/\bd="([^"]+)"/g)].map((m) => m[1]);
    }
    if (pathD.length === 0) throw new Error(`第 ${idx + 1} 层缺少 pathD (svg path d)`);
    return {
      index: l.index ?? idx + 1,
      name: l.name ?? `图层 L${idx + 1}`,
      depth: typeof l.depth === 'number' ? l.depth : Number(((idx + 1) * 0.2).toFixed(2)),
      description: l.description ?? `第 ${idx + 1} 层`,
      pathD,
      fabCheck: (l.fabCheck as FabCheck) ?? EMPTY_FAB,
    };
  });

  return {
    schemaVersion: 2,
    sceneId: container.sceneId ?? fallbackSceneId,
    sourceImage: container.sourceImage ?? '',
    viewBox: container.viewBox ?? '0 0 800 600',
    sizeMm: container.sizeMm ?? { width: 200, height: 150 },
    layers,
    pipeline: (container.pipeline as LayerSet['pipeline']) ?? {
      decomposeModel: '',
      mapModel: '',
      zItems: 0,
      mapSource: 'upload',
      bakedAt: '',
      pxPerMm: 0,
      workRes: { w: 0, h: 0, scale: 1 },
      pxPerMmWork: 0,
      topology: {},
      tracer: {},
      maskStage: {},
      vectorStage: [],
    },
  };
}

const state: {
  layerSet: LayerSet | null;
  active2DLayer: number;
  mode2D: 'solid' | 'laser';
  autoDemo: boolean;
} = {
  layerSet: null,
  active2DLayer: 0,
  mode2D: 'solid',
  autoDemo: false,
};

const container = $<HTMLElement>('webgl-container');
const scene = new LightboxScene(container);

/* ---------------- toast ---------------- */

let toastTimer: number | undefined;
function showToast(msg: string): void {
  const toast = $('toast');
  $('toast-msg').textContent = msg;
  toast.classList.remove('hidden');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.add('hidden'), 2600);
}

/* ---------------- explode ---------------- */

const explodeSlider = $<HTMLInputElement>('slider-explode');
const explodePill = $('explode-percent-pill');

function describeExplode(percent: number): string {
  if (percent === 0) return '0% 完全组装';
  if (percent < 30) return `${percent}% 微隙层析`;
  if (percent < 70) return `${percent}% 结构剖析`;
  return `${percent}% 宽距爆炸`;
}

function setExplode(percent: number, syncSlider = true): void {
  if (syncSlider) explodeSlider.value = String(percent);
  explodePill.textContent = describeExplode(percent);
  scene.setExplode(percent / 100);
  document.querySelectorAll('.btn-jump').forEach((b) => {
    b.classList.toggle('active', Number((b as HTMLElement).dataset.explode) === percent);
  });
}

explodeSlider.addEventListener('input', () => {
  state.autoDemo = false;
  setExplode(Number(explodeSlider.value));
});
document.querySelectorAll('.btn-jump').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.autoDemo = false;
    setExplode(Number((btn as HTMLElement).dataset.explode));
  });
});

$('btn-auto-demo').addEventListener('click', (e) => {
  state.autoDemo = !state.autoDemo;
  (e.currentTarget as HTMLButtonElement).textContent = state.autoDemo ? '停止演示' : '自动演示';
});

function autoDemoLoop(t: number): void {
  if (state.autoDemo && state.layerSet) {
    const v = (Math.sin(t * 0.00075) + 1) / 2;
    setExplode(Math.round(v * 100));
  }
  requestAnimationFrame(autoDemoLoop);
}
requestAnimationFrame(autoDemoLoop);

/* ---------------- lighting ---------------- */

$<HTMLInputElement>('slider-intensity').addEventListener('input', (e) => {
  const v = Number((e.target as HTMLInputElement).value);
  $('light-intensity-val').textContent = `${v.toFixed(1)}x`;
  scene.updateSettings({ intensity: v });
});

document.querySelectorAll('.preset').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.preset').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const hex = (btn as HTMLElement).dataset.color!;
    $<HTMLInputElement>('picker-light-color').value = hex;
    $('hex-color-val').textContent = hex;
    scene.updateSettings({ color: hex });
  });
});

$<HTMLInputElement>('picker-light-color').addEventListener('input', (e) => {
  const hex = (e.target as HTMLInputElement).value;
  $('hex-color-val').textContent = hex;
  document.querySelectorAll('.preset').forEach((b) => b.classList.remove('active'));
  scene.updateSettings({ color: hex });
});

$<HTMLInputElement>('toggle-darkroom').addEventListener('change', (e) => {
  scene.updateSettings({ darkRoom: (e.target as HTMLInputElement).checked });
});
$<HTMLInputElement>('toggle-translucency').addEventListener('change', (e) => {
  scene.updateSettings({ translucent: (e.target as HTMLInputElement).checked });
});

/* ---------------- structure visibility ---------------- */

const visBindings: Array<[string, StructurePart]> = [
  ['check-vis-frame', 'frame'],
  ['check-vis-paper', 'paper'],
  ['check-vis-spacers', 'spacers'],
  ['check-vis-backplate', 'backplate'],
];
for (const [id, part] of visBindings) {
  $<HTMLInputElement>(id).addEventListener('change', (e) => {
    scene.setPartVisible(part, (e.target as HTMLInputElement).checked);
  });
}

/* ---------------- camera ---------------- */

const camBindings: Array<[string, CameraViewName]> = [
  ['cam-front', 'front'],
  ['cam-persp', 'perspective'],
  ['cam-side', 'side'],
  ['cam-top', 'top'],
];
function markCamera(active: CameraViewName): void {
  for (const [id, name] of camBindings) $(id).classList.toggle('active', name === active);
}
for (const [id, name] of camBindings) {
  $(id).addEventListener('click', () => {
    scene.setCameraView(name);
    markCamera(name);
  });
}
$('btn-reset-view').addEventListener('click', () => {
  scene.setCameraView('perspective');
  markCamera('perspective');
  showToast('相机视角已重置');
});

/* ---------------- sidebar tabs ---------------- */

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const name = (tab as HTMLElement).dataset.tab!;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    for (const panel of document.querySelectorAll('.tab-panel')) {
      panel.classList.toggle('hidden', panel.id !== `tab-${name}`);
    }
  });
});

/* ---------------- solo layer list ---------------- */

function renderSoloList(set: LayerSet): void {
  const list = $('solo-layer-list');
  list.innerHTML = '';
  set.layers.forEach((layer, idx) => {
    const btn = document.createElement('button');
    btn.className = 'btn solo-item';
    btn.id = `btn-solo-${idx}`;
    btn.innerHTML =
      `<span class="solo-name"><span class="solo-badge">L${idx + 1}</span><span></span></span>` +
      `<span class="solo-depth">深 ${layer.depth}</span>`;
    (btn.querySelector('.solo-name span:last-child') as HTMLElement).textContent = layer.name;
    btn.addEventListener('click', () => {
      scene.setSolo(idx);
      markSolo(idx);
      showToast(`已单独查看第 ${idx + 1} 层：${layer.name}`);
    });
    list.appendChild(btn);
  });
}

function markSolo(active: number | null): void {
  $('btn-solo-all').classList.toggle('active', active === null);
  state.layerSet?.layers.forEach((_, idx) => {
    const el = document.getElementById(`btn-solo-${idx}`);
    el?.classList.toggle('active', active === idx);
  });
}

$('btn-solo-all').addEventListener('click', () => {
  scene.setSolo(null);
  markSolo(null);
  showToast('已恢复全部图层装配显示');
});

/* ---------------- 2D drawer (real paths only, no fabricated checks) ---------------- */

const drawer = $('drawer-2d');
$('btn-toggle-2d').addEventListener('click', () => drawer.classList.add('open'));
$('btn-close-2d').addEventListener('click', () => drawer.classList.remove('open'));

$('btn-mode-solid').addEventListener('click', () => {
  state.mode2D = 'solid';
  $('btn-mode-solid').classList.add('active');
  $('btn-mode-laser').classList.remove('active');
  render2D();
});
$('btn-mode-laser').addEventListener('click', () => {
  state.mode2D = 'laser';
  $('btn-mode-laser').classList.add('active');
  $('btn-mode-solid').classList.remove('active');
  render2D();
});

function renderDrawerTabs(set: LayerSet): void {
  const tabs = $('drawer-layer-tabs');
  tabs.innerHTML = '';
  set.layers.forEach((layer, idx) => {
    const btn = document.createElement('button');
    btn.className = `btn drawer-tab ${idx === state.active2DLayer ? 'active' : ''}`;
    btn.textContent = `L${idx + 1} ${layer.name.slice(0, 8)}`;
    btn.addEventListener('click', () => {
      state.active2DLayer = idx;
      renderDrawerTabs(set);
      render2D();
    });
    tabs.appendChild(btn);
  });
}

function render2D(): void {
  const set = state.layerSet;
  if (!set) return;
  const layer = set.layers[state.active2DLayer];
  if (!layer) return;
  const vb = parseViewBox(set.viewBox);

  $('card-layer-name').textContent = `L${state.active2DLayer + 1}：${layer.name}`;
  $('card-layer-depth').textContent = `景深 ${layer.depth}`;
  $('card-layer-desc').textContent = layer.description;
  $('svg-canvas-badge').textContent = `viewBox ${vb.width} x ${vb.height}`;

  const isLaser = state.mode2D === 'laser';
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `${vb.minX} ${vb.minY} ${vb.width} ${vb.height}`);
  const path = document.createElementNS(svgNS, 'path');
  path.setAttribute('d', layer.pathD.join(' '));
  path.setAttribute('fill-rule', 'evenodd');
  path.setAttribute('fill', isLaser ? '#151922' : '#f5f1e8');
  path.setAttribute('stroke', isLaser ? '#ef4444' : '#8d7b68');
  path.setAttribute('stroke-width', isLaser ? '1.6' : '1');
  svg.appendChild(path);

  /* fabCheck 叠加：桥位胶囊（黄色）+ 未修复孤岛 bbox（红色虚线）。仅绘制 JSON 里真实存在的几何。 */
  const fc = layer.fabCheck;
  const has = hasFabData(layer);
  let bridgesDrawn = 0;
  let unrepaired = 0;
  if (has) {
    const pxPerMm =
      set.pipeline && set.pipeline.pxPerMm > 0
        ? set.pipeline.pxPerMm
        : vb.width / (set.sizeMm.width || vb.width);
    const topo = set.pipeline?.topology as { bridgeWidthMm?: unknown } | undefined;
    const bridgeWidthMm = typeof topo?.bridgeWidthMm === 'number' ? topo.bridgeWidthMm : 3;
    const bridgeWpx = bridgeWidthMm * pxPerMm;

    for (const b of fc.bridgesAdded) {
      if (!b.startPx || !b.endPx) continue;
      const line = document.createElementNS(svgNS, 'line');
      line.setAttribute('x1', String(b.startPx[0]));
      line.setAttribute('y1', String(b.startPx[1]));
      line.setAttribute('x2', String(b.endPx[0]));
      line.setAttribute('y2', String(b.endPx[1]));
      line.setAttribute('stroke', '#fbbf24');
      line.setAttribute('stroke-width', String(bridgeWpx));
      line.setAttribute('stroke-linecap', 'round');
      line.setAttribute('opacity', '0.9');
      svg.appendChild(line);
      bridgesDrawn++;
    }
    const covered = new Set<number>();
    for (const b of fc.bridgesAdded) {
      covered.add(b.fromId);
      if (typeof b.toTarget === 'number') covered.add(b.toTarget);
    }
    for (const isl of fc.islands) {
      if (covered.has(isl.id)) continue;
      const rect = document.createElementNS(svgNS, 'rect');
      rect.setAttribute('x', String(isl.bbox.x));
      rect.setAttribute('y', String(isl.bbox.y));
      rect.setAttribute('width', String(isl.bbox.w));
      rect.setAttribute('height', String(isl.bbox.h));
      rect.setAttribute('class', 'fab-island-marker');
      svg.appendChild(rect);
      unrepaired++;
    }
  }

  const containerEl = $('svg-preview-container');
  containerEl.innerHTML = '';
  containerEl.appendChild(svg);

  /* 本层 fabCheck 摘要 + 缝隙提示 */
  const fabLine = $('card-fab-line');
  fabLine.innerHTML = '';
  const legend = $('card-fab-legend');
  if (!has) {
    fabLine.textContent = '本层无制造检查数据';
    legend.classList.add('hidden');
  } else {
    const after = unrepairedIslandCount(layer);
    const parts: Array<{ text: string; cls?: string }> = [
      { text: `孤岛 ${fc.islands.length}→${after}` },
      { text: `加桥 ${fc.bridgesAdded.length}` },
      { text: `切割 ${fmtMm(fc.cutLengthMm)} mm` },
      { text: `缝隙 ${fmtMm(fc.minGapMm)} mm` },
    ];
    if (fc.minGapMm > 0 && fc.minGapMm < GAP_CAUTION_MM) {
      parts.push({ text: '缝隙低于 2mm，装裱与运输时注意', cls: 'warn' });
    }
    if (!fc.pass || after > 0) {
      parts.push({ text: '本层未通过制造检查', cls: 'island-warn' });
    }
    for (const p of parts) {
      const span = document.createElement('span');
      span.textContent = p.text;
      if (p.cls) span.className = p.cls;
      fabLine.appendChild(span);
    }
    legend.classList.toggle('hidden', bridgesDrawn === 0 && unrepaired === 0);
  }
}

/* ---------------- fab check panel (all numbers read straight from LayerSet JSON) ---------------- */

/** 2D 视图缝隙提示阈值（展示用，非核验数据）；核验红线以 pipeline.topology.gapRedLineMm 为准 */
const GAP_CAUTION_MM = 2;

function hasFabData(layer: Layer): boolean {
  const fc = layer.fabCheck;
  return fc.cutLengthMm > 0 || fc.islands.length > 0 || fc.bridgesAdded.length > 0;
}

/** 修复后仍未锚定的孤岛数：未被任何桥（fromId / 数字 toTarget）覆盖的孤岛 */
function unrepairedIslandCount(layer: Layer): number {
  const covered = new Set<number>();
  for (const b of layer.fabCheck.bridgesAdded) {
    covered.add(b.fromId);
    if (typeof b.toTarget === 'number') covered.add(b.toTarget);
  }
  return layer.fabCheck.islands.filter((i) => !covered.has(i.id)).length;
}

function fmtMm(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}

function renderFabPanel(set: LayerSet): void {
  const layers = set.layers;
  const withData = layers.filter(hasFabData);
  const passCount = withData.filter((l) => l.fabCheck.pass).length;
  const allPass = withData.length > 0 && passCount === withData.length;

  const badge = $('fab-pass-badge');
  if (withData.length === 0) {
    badge.textContent = '无检查数据';
    badge.className = 'fab-badge none';
  } else {
    badge.textContent = allPass
      ? `全部通过 ${passCount}/${withData.length}`
      : `${passCount}/${withData.length} 层通过`;
    badge.className = `fab-badge ${allPass ? 'ok' : 'fail'}`;
  }
  $('fab-meta').textContent = `${layers.length} 层 · 场景 ${set.sceneId}`;

  const totalCut = withData.reduce((s, l) => s + l.fabCheck.cutLengthMm, 0);
  const totalBridges = withData.reduce((s, l) => s + l.fabCheck.bridgesAdded.length, 0);
  const gaps = withData.map((l) => l.fabCheck.minGapMm).filter((g) => g > 0);
  $('fab-total-cut').textContent = withData.length > 0 ? (Math.round(totalCut * 10) / 10).toString() : '--';
  $('fab-total-bridges').textContent = withData.length > 0 ? String(totalBridges) : '--';
  $('fab-min-gap').textContent = gaps.length > 0 ? fmtMm(Math.min(...gaps)) : '--';

  const rows = $('fab-rows');
  rows.innerHTML = '';
  layers.forEach((layer, idx) => {
    const fc = layer.fabCheck;
    const has = hasFabData(layer);
    const after = has ? unrepairedIslandCount(layer) : 0;
    const row = document.createElement('div');
    row.className = `fab-row${has && !fc.pass ? ' fail' : ''}`;
    row.innerHTML =
      '<div class="fab-row-head">' +
      '<span class="solo-badge"></span>' +
      '<span class="fab-row-name"></span>' +
      `<span class="fab-mini ${has ? (fc.pass ? 'ok' : 'fail') : 'none'}">${has ? (fc.pass ? '通过' : '未通过') : '无数据'}</span>` +
      '</div>' +
      '<div class="fab-row-metrics mono">' +
      (has
        ? `<span>孤岛 <b class="${after > 0 ? 'island-warn' : ''}">${fc.islands.length}→${after}</b></span>`
        : '<span>孤岛 --</span>') +
      `<span>加桥 ${has ? fc.bridgesAdded.length : '--'}</span>` +
      `<span>切割 ${has ? fmtMm(fc.cutLengthMm) : '--'} mm</span>` +
      `<span>缝隙 <b class="${has && fc.minGapMm > 0 && fc.minGapMm < GAP_CAUTION_MM ? 'warn' : ''}">${has ? fmtMm(fc.minGapMm) : '--'}</b> mm</span>` +
      '</div>';
    (row.querySelector('.solo-badge') as HTMLElement).textContent = `L${idx + 1}`;
    (row.querySelector('.fab-row-name') as HTMLElement).textContent = layer.name;
    rows.appendChild(row);
  });

  const panel = $('fab-panel');
  panel.classList.toggle('fail', withData.length > 0 && !allPass);
  const topo = set.pipeline?.topology as { gapRedLineMm?: unknown } | undefined;
  const redLine = typeof topo?.gapRedLineMm === 'number' ? topo.gapRedLineMm : null;
  $('fab-note').textContent =
    '检查在烘焙阶段由本地几何算法完成，此面板直读其结果。' +
    (redLine != null ? `通过 = 修复后 0 孤岛且缝隙不低于红线 ${fmtMm(redLine)}mm。` : '');
}

/* ---------------- screenshot & file load ---------------- */

$('btn-screenshot').addEventListener('click', () => {
  const url = scene.screenshot();
  const link = document.createElement('a');
  link.download = `shadow-box-${Date.now()}.png`;
  link.href = url;
  link.click();
  showToast('渲染图已导出');
});

$<HTMLInputElement>('file-input').addEventListener('change', (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result));
      loadSet(normalizeLayerSet(parsed));
      showToast(`已载入 ${state.layerSet?.layers.length ?? 0} 个图层`);
    } catch (err) {
      window.alert(`载入 JSON 失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };
  reader.readAsText(file);
  (e.target as HTMLInputElement).value = '';
});

/* ---------------- data loading ---------------- */

function loadSet(set: LayerSet): void {
  state.layerSet = set;
  state.active2DLayer = 0;
  scene.loadLayerSet(set);
  scene.setCameraView('perspective');
  renderSoloList(set);
  renderDrawerTabs(set);
  renderFabPanel(set);
  render2D();
  const vb = parseViewBox(set.viewBox);
  $('data-status-text').textContent = `${set.layers.length} 图层装配就绪 (${vb.width}x${vb.height})`;
  $('struct-paper-label').textContent = `${set.layers.length} 层激光纸雕卡纸`;
  $('footer-layers').textContent = `L1 ~ L${set.layers.length}`;
  $('footer-assembly').textContent = `图层数: ${set.layers.length} · 层距 10mm`;
}

async function bootstrap(): Promise<void> {
  setExplode(0);
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}data/baked/xiake.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const set = normalizeLayerSet(await res.json(), 'xiake');
    loadSet(set);
    // 自测/调试句柄（不影响 UI）
    (window as unknown as Record<string, unknown>).__seedPapercut = { scene, layerSet: set };
  } catch (err) {
    console.error('failed to load baked layer set', err);
    $('data-status-text').textContent = '烘焙图层载入失败';
    showToast('烘焙图层数据载入失败，请用“载入 JSON”选择本地文件');
  }
}

void bootstrap();

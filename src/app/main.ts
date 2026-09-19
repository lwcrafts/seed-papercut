import Sortable from 'sortablejs';
import './style.css';
import { LightboxScene, type CameraViewName, type StructurePart } from '../preview/LightboxScene';
import { parseViewBox, type FabCheck, type Layer, type LayerSet } from '../types';
import {
  buildStoreZip,
  buildZipEntries,
  downloadBytes,
  validateLayerSetExport,
} from '../pipeline/svg-export';
// evolving prompt/schema 打进 bundle（?raw / JSON 内联），保证离线可用

/**
 * 预置场景清单（与 scripts/bake.mjs 的 SCENES 保持一致；spec §4.5）。
 * 未来加场景 = 烘焙出 data/baked/<id>.json + scenes/<id>.jpg 后，在这里加一条，
 * 切换器 / 数据载入 / 现场重跑全部吃这份清单，不需要改其他代码。
 * 只有 1 个场景时切换器自动隐藏。
 */
interface SceneEntry {
  id: string;
  name: string;
  hint: string;
  image: string;
}
const SCENES: SceneEntry[] = [
  {
    id: 'test',
    name: '案例一',
    hint: '海边椰子树下',
    image: 'scenes/test.png',
  },
  {
    id: 'xiake',
    name: '案例二',
    hint: '侠客策马',
    image: 'scenes/xiake.jpg',
  },
];
let currentScene: SceneEntry = SCENES[0];

/** 烘焙 LayerSet JSON 地址（与 scripts/bake.mjs 的产出路径对应） */
function bakedJsonUrl(sceneId: string): string {
  return `${import.meta.env.BASE_URL}data/baked/${sceneId}.json`;
}
/** 预置场景原图地址（现场重跑用） */


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
  /** 烘焙数据（演示回退的基准）；重跑成功后替换 layerSet 但保留这里 */
  bakedLayerSet: LayerSet | null;
  /** 重跑失败回退后为 true → 显示全局「演示数据」徽标 */
  demoMode: boolean;
} = {
  layerSet: null,
  active2DLayer: 0,
  mode2D: 'solid',
  autoDemo: false,
  bakedLayerSet: null,
  demoMode: false,
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



function markSolo(active: number | null): void {
  const allBtn = document.getElementById('btn-solo-all');
  if (allBtn) allBtn.classList.toggle('active', active === null);
  
  // Update left nav thumbs
  const strip = document.getElementById('slice-strip');
  if (strip) {
    const thumbs = strip.querySelectorAll('.slice-thumb');
    thumbs.forEach((thumb, idx) => {
      thumb.classList.toggle('active', active === idx);
    });
  }
}

$('btn-solo-all').addEventListener('click', () => {
  scene.setSolo(null);
  markSolo(null);
  showToast('已恢复全部图层装配显示');
});

/* ---------------- 2D drawer (real paths only, no fabricated checks) ---------------- */

const drawer = $('drawer-2d');
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


let stripSortableInstance: Sortable | null = null;

function renderSliceStrip(set: LayerSet): void {
  const strip = document.getElementById('slice-strip');
  if (!strip) return;
  strip.innerHTML = '';
  const vb = parseViewBox(set.viewBox);
  
  set.layers.forEach((layer, idx) => {
    const wrapper = document.createElement('div');
    wrapper.style.display = 'flex';
    wrapper.style.alignItems = 'center';
    wrapper.style.gap = '6px';
    wrapper.dataset.index = String(idx);
    
    const dragHandle = document.createElement('div');
    dragHandle.className = 'drag-handle';
    dragHandle.style.cursor = 'grab';
    dragHandle.style.display = 'flex';
    dragHandle.style.color = 'rgba(255,255,255,0.4)';
    dragHandle.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>';
    
    // Add hover effect via mouse events since it's inline styled (or we can use CSS class, we already have .drag-handle in style.css but it might be removed).
    dragHandle.onmouseenter = () => dragHandle.style.color = 'rgba(255,255,255,0.9)';
    dragHandle.onmouseleave = () => dragHandle.style.color = 'rgba(255,255,255,0.4)';
    
    const thumb = document.createElement('div');
    thumb.className = `slice-thumb ${idx === state.active2DLayer ? 'active' : ''}`;

    
    const badge = document.createElement('div');
    badge.className = 'slice-thumb-badge';
    badge.textContent = `L${idx + 1}`;
    
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `${vb.minX} ${vb.minY} ${vb.width} ${vb.height}`);
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', layer.pathD.join(' '));
    path.setAttribute('fill-rule', 'evenodd');
    path.setAttribute('fill', '#f5f1e8');
    svg.appendChild(path);
    
    thumb.appendChild(badge);
    thumb.appendChild(svg);
    
    thumb.addEventListener('click', () => {
      state.active2DLayer = idx;
      scene.setSolo(idx);
      markSolo(idx);
      renderDrawerTabs(set);
      // Removed renderSortList call since we deleted it
      render2D();
    });
    
    wrapper.appendChild(dragHandle);
    wrapper.appendChild(thumb);
    strip.appendChild(wrapper);
  });
  
  if (stripSortableInstance) {
    stripSortableInstance.destroy();
  }
  
  stripSortableInstance = new Sortable(strip, {
    animation: 150,
    handle: '.drag-handle',
    ghostClass: 'sortable-ghost',
    onEnd: (evt) => {
      const oldIdx = evt.oldIndex;
      const newIdx = evt.newIndex;
      if (oldIdx !== undefined && newIdx !== undefined && oldIdx !== newIdx) {
        const layer = set.layers.splice(oldIdx, 1)[0];
        set.layers.splice(newIdx, 0, layer);
        
        set.layers.forEach((l, i) => { l.index = i + 1; });
        
        scene.reorderLayer(oldIdx, newIdx);
        
        // Update solo index if it moved
        if (state.active2DLayer === oldIdx) {
          state.active2DLayer = newIdx;
        } else if (oldIdx < state.active2DLayer && newIdx >= state.active2DLayer) {
          state.active2DLayer--;
        } else if (oldIdx > state.active2DLayer && newIdx <= state.active2DLayer) {
          state.active2DLayer++;
        }
        
        // Defer UI re-render to let SortableJS finish its own DOM cleanup
        setTimeout(() => {
          renderDrawerTabs(set);
          renderSliceStrip(set); // re-render thumbnails to get correct L1-L6 numbers and active state
        }, 0);
      }
    }
  });
}

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
  renderSliceStrip(set);
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

  const container = $('svg-preview-container');
  container.innerHTML = '';
  container.appendChild(svg);
}

/* ---------------- SVG/ZIP export (issue 15) ---------------- */

const exportZipBtn = $<HTMLButtonElement>('btn-export-zip');

function refreshExportReadiness(): void {
  const set = state.layerSet;
  if (!set) {
    exportZipBtn.disabled = true;
    exportZipBtn.title = '等待图层数据载入…';
    return;
  }
  const issues = validateLayerSetExport(set);
  exportZipBtn.disabled = issues.length > 0;
  exportZipBtn.title =
    issues.length > 0
      ? `导出自检未通过：${issues[0].message}${issues.length > 1 ? `（共 ${issues.length} 项）` : ''}`
      : '打包下载全部切割 SVG + README.txt';
}

exportZipBtn.addEventListener('click', () => {
  const set = state.layerSet;
  if (!set || exportZipBtn.disabled) return;
  const issues = validateLayerSetExport(set);
  if (issues.length > 0) {
    showToast(`导出自检未通过：${issues[0].message}`);
    return;
  }
  const zip = buildStoreZip(buildZipEntries(set));
  const filename = `${set.sceneId}-layers.zip`;
  downloadBytes(filename, zip);
  showToast(`切割图纸已导出：${filename}（${set.layers.length} 层 SVG + README）`);
});

/* ---------------- data loading ---------------- */


function loadSet(set: LayerSet): void {
  state.layerSet = set;
  state.active2DLayer = 0;
  scene.loadLayerSet(set);
  scene.setCameraView('perspective');

  renderDrawerTabs(set);
  renderSliceStrip(set);

  render2D();
  const vb = parseViewBox(set.viewBox);
  $('data-status-text').textContent = `${set.layers.length} 图层装配就绪 (${vb.width}x${vb.height})`;
  $('struct-paper-label').textContent = `${set.layers.length} 层激光纸雕卡纸`;
      refreshExportReadiness();
}

async function bootstrap(): Promise<void> {
  setExplode(100);
  renderSceneSwitcher();
  try {
    const res = await fetch(bakedJsonUrl(currentScene.id));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const set = normalizeLayerSet(await res.json(), currentScene.id);
    state.bakedLayerSet = set;
    
    // Set initial source image preview
    const img = document.getElementById('img-source');
    if (img) img.setAttribute('src', currentScene.image);
    const preview = document.getElementById('source-image-preview');
    if (preview) preview.style.display = 'flex';
    
    loadSet(set);
    // 自测/调试句柄（不影响 UI）
    (window as unknown as Record<string, unknown>).__seedPapercut = { scene, layerSet: set, scenes: SCENES };
  } catch (err) {
    console.error('failed to load baked layer set', err);
    $('data-status-text').textContent = '烘焙图层载入失败';
    showToast('烘焙图层数据载入失败，请用“载入 JSON”选择本地文件');
  }
}

/* ---------------- 场景切换（票 17）：由 SCENES 清单驱动，单场景隐藏 ---------------- */

/** 渲染场景切换器；只有 1 个场景时保持隐藏（spec §4.5，selftest 有断言） */
function renderSceneSwitcher(): void {
  const brandName = document.getElementById('brand-scene-name');
  if (brandName) brandName.textContent = currentScene.name;

  const menu = document.getElementById('brand-dropdown-menu');
  if (!menu) return;
  menu.innerHTML = '';
  
  if (SCENES.length <= 1) {
    const toggle = document.getElementById('brand-dropdown-toggle');
    if (toggle) toggle.style.pointerEvents = 'none';
    return;
  }
  
  for (const s of SCENES) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-block';
    if (s.id === currentScene.id) btn.classList.add('active');
    btn.textContent = s.name + (s.hint ? ' (' + s.hint + ')' : '');
    btn.style.textAlign = 'left';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.classList.add('hidden');
      void switchScene(s.id);
    });
    menu.appendChild(btn);
  }
  
  // Setup dropdown toggle logic once
  const toggle = document.getElementById('brand-dropdown-toggle');
  if (toggle && !toggle.dataset.bound) {
    toggle.dataset.bound = 'true';
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.classList.toggle('hidden');
    });
    document.addEventListener('click', () => {
      menu.classList.add('hidden');
    });
  }
}

/** 切换预置场景：换烘焙数据 + 换现场重跑的对象；失败不动当前场景 */
async function switchScene(sceneId: string): Promise<void> {
  const target = SCENES.find((s) => s.id === sceneId);
  if (!target || sceneId === currentScene.id) return;
  try {
    const res = await fetch(bakedJsonUrl(sceneId));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const set = normalizeLayerSet(await res.json(), sceneId);
    currentScene = target;
    state.bakedLayerSet = set;
    const img = document.getElementById('img-source');
    if (img) img.setAttribute('src', target.image);
    const preview = document.getElementById('source-image-preview');
    if (preview) preview.style.display = 'flex';
        loadSet(set);
    renderSceneSwitcher();
    showToast(`已切换到场景：${target.name}`);
  } catch (err) {
    console.error('failed to switch scene', err);
    showToast(`场景 ${sceneId} 数据载入失败，保留当前场景`);
  }
}


/* ---------------- dock menus ---------------- */
document.addEventListener('click', () => {
  $('cam-menu')?.classList.add('hidden');
  $('light-menu')?.classList.add('hidden');
  $('explode-menu')?.classList.add('hidden');
  $('bg-menu')?.classList.add('hidden');
  $('struct-menu')?.classList.add('hidden');
});

$('explode-toggle')?.addEventListener('click', (e) => {
  $('explode-menu')?.classList.toggle('hidden');
  $('cam-menu')?.classList.add('hidden');
  $('light-menu')?.classList.add('hidden');
  $('bg-menu')?.classList.add('hidden');
  $('struct-menu')?.classList.add('hidden');
  e.stopPropagation();
});

$('light-toggle')?.addEventListener('click', (e) => {
  $('light-menu')?.classList.toggle('hidden');
  $('cam-menu')?.classList.add('hidden');
  $('explode-menu')?.classList.add('hidden');
  $('bg-menu')?.classList.add('hidden');
  $('struct-menu')?.classList.add('hidden');
  e.stopPropagation();
});

$('cam-toggle')?.addEventListener('click', (e) => {
  $('cam-menu')?.classList.toggle('hidden');
  $('explode-menu')?.classList.add('hidden');
  $('light-menu')?.classList.add('hidden');
  $('bg-menu')?.classList.add('hidden');
  $('struct-menu')?.classList.add('hidden');
  e.stopPropagation();
});

$('bg-toggle')?.addEventListener('click', (e) => {
  $('bg-menu')?.classList.toggle('hidden');
  $('cam-menu')?.classList.add('hidden');
  $('explode-menu')?.classList.add('hidden');
  $('light-menu')?.classList.add('hidden');
  $('struct-menu')?.classList.add('hidden');
  e.stopPropagation();
});

$('struct-toggle')?.addEventListener('click', (e) => {
  $('struct-menu')?.classList.toggle('hidden');
  $('cam-menu')?.classList.add('hidden');
  $('explode-menu')?.classList.add('hidden');
  $('light-menu')?.classList.add('hidden');
  $('bg-menu')?.classList.add('hidden');
  e.stopPropagation();
});

$('struct-menu')?.addEventListener('click', (e) => e.stopPropagation());
$('light-menu')?.addEventListener('click', (e) => e.stopPropagation());
$('cam-menu')?.addEventListener('click', (e) => e.stopPropagation());
$('explode-menu')?.addEventListener('click', (e) => e.stopPropagation());
$('bg-menu')?.addEventListener('click', (e) => e.stopPropagation());


/* ---------------- background toggles ---------------- */
document.querySelectorAll('.bg-preset').forEach((btn) => {
  btn.addEventListener('click', () => {
    const bg = (btn as HTMLElement).dataset.bg!;
    document.documentElement.style.setProperty('--bg', bg);
    document.querySelectorAll('.bg-preset').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const toggle = document.getElementById('bg-toggle');
    if (toggle) toggle.style.background = bg;
  });
});

$('picker-bg-color')?.addEventListener('input', (e) => {
  const hex = (e.target as HTMLInputElement).value;
  $('hex-bg-val').textContent = hex.toUpperCase();
  document.documentElement.style.setProperty('--bg', hex);
  document.querySelectorAll('.bg-preset').forEach((b) => b.classList.remove('active'));
  const toggle = document.getElementById('bg-toggle');
  if (toggle) toggle.style.background = hex;
});


$('btn-open-2d')?.addEventListener('click', () => {
  render2D();
  document.getElementById('drawer-2d')?.classList.add('open');
});

void bootstrap();


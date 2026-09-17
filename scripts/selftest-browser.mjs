// headless 浏览器自测（issue 13 + 14 + 15 + 16）：加载 dist/ 构建产物，验证
//   1) xiake.json 加载成功、无 console error / pageerror
//   2) 6 层挤出网格就位、z 序 L1 靠 LED（paperZ 最小）
//   3) WebGL（SwiftShader 软渲染）可用且画面非空白
//   4) 制造检查面板（票 14）：占位块已替换，面板字段与 xiake.json fabCheck 逐字段一致
//   5) 2D 切片视图：桥位黄色标记数量 == JSON bridgesAdded、缝隙 <2mm 层有 caution
//   6) SVG/ZIP 导出（票 15）：点击导出 → 拦截下载 → 解析 ZIP（STORE+CRC32 校验）
//      → 逐层断言 mm 尺寸/viewBox/红色 0.1mm stroke/闭合 path/无 mask/filter/text
//   7) 现场重跑（票 16）：mock fetch（拆层 b64_json + evolving SSE 流）跑通五段
//      状态机与结果切换；401 失败分支降级回烘焙数据并显示「演示数据」徽标；
//      Key 不落盘（localStorage/sessionStorage/cookie 无 Key 字样）
// 用法：npm run build 后 node scripts/selftest-browser.mjs
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(REPO, 'dist');
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('dist/index.html 不存在，先 npm run build');
  process.exit(1);
}

const server = createServer((req, res) => {
  const url = req.url.split('?')[0];
  // 线上 Pages 把站点挂在 /seed-papercut/ 前缀下（vite base），本地同构
  const rel = url.startsWith('/seed-papercut/') ? url.slice('/seed-papercut'.length) : url;
  let path = join(DIST, decodeURIComponent(rel));
  if (!existsSync(path) || extname(path) === '') path = join(DIST, 'index.html');
  try {
    const body = readFileSync(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const consoleErrors = [];
const pageErrors = [];
const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--disable-gpu-driver-bug-workarounds', '--use-gl=angle', '--use-angle=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => pageErrors.push(String(err)));

await page.goto(`${base}seed-papercut/`, { waitUntil: "networkidle" });

// 等 bootstrap 完成（data-status-text 由 loadSet 更新为「6 图层装配就绪」）
await page.waitForFunction(
  () => document.getElementById('data-status-text')?.textContent?.includes('装配就绪'),
  null,
  { timeout: 20000 },
);

const info = await page.evaluate(() => {
  const handle = window.__seedPapercut;
  const gl = document.createElement('canvas').getContext('webgl2') ?? document.createElement('canvas').getContext('webgl');
  return {
    webgl: gl ? gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info')?.UNMASKED_RENDERER_WEBGL ?? 0) || gl.getParameter(gl.RENDERER) : null,
    layerCount: handle?.layerSet?.layers.length ?? 0,
    meshCount: handle?.scene?.paperMeshes?.length ?? 0,
    zSlots: handle?.scene?.paperMeshes?.map((m) => +m.position.z.toFixed(2)) ?? [],
    geometryTris: handle?.scene?.paperMeshes?.map((m) => (m.geometry?.index?.count ?? 0) / 3) ?? [],
    layerNames: handle?.layerSet?.layers.map((l) => l.name) ?? [],
    statusText: document.getElementById('data-status-text')?.textContent ?? '',
    fabPlaceholder: !!document.querySelector('.fab-placeholder'),
    soloItems: document.querySelectorAll('#solo-layer-list button').length,
  };
});

/* ---- 票 14：结构 tab 制造检查面板字段与 JSON 逐字段比对 ---- */
const baked = JSON.parse(readFileSync(join(DIST, 'data', 'baked', 'xiake.json'), 'utf8'));
const fmt2 = (n) => String(Math.round(n * 100) / 100);
const unrepaired = (fc) => {
  const covered = new Set();
  for (const b of fc.bridgesAdded) {
    covered.add(b.fromId);
    if (typeof b.toTarget === 'number') covered.add(b.toTarget);
  }
  return fc.islands.filter((i) => !covered.has(i.id)).length;
};
const expectedRows = baked.layers.map((l, idx) => {
  const fc = l.fabCheck;
  const after = unrepaired(fc);
  return {
    idx,
    badge: fc.pass ? '通过' : '未通过',
    head: `L${idx + 1}`,
    islands: `孤岛 ${fc.islands.length}→${after}`,
    bridges: `加桥 ${fc.bridgesAdded.length}`,
    cut: `切割 ${fmt2(fc.cutLengthMm)} mm`,
    gap: `缝隙 ${fmt2(fc.minGapMm)} mm`,
  };
});
const expectedTotalCut = Math.round(
  baked.layers.reduce((s, l) => s + l.fabCheck.cutLengthMm, 0) * 10,
) / 10;
const expectedTotalBridges = baked.layers.reduce((s, l) => s + l.fabCheck.bridgesAdded.length, 0);
const expectedMinGap = Math.min(...baked.layers.map((l) => l.fabCheck.minGapMm).filter((g) => g > 0));

await page.click('.tab[data-tab="struct"]');
const fabPanel = await page.evaluate(() => ({
  panelExists: !!document.getElementById('fab-panel'),
  badge: document.getElementById('fab-pass-badge')?.textContent ?? '',
  badgeCls: document.getElementById('fab-pass-badge')?.className ?? '',
  totalCut: document.getElementById('fab-total-cut')?.textContent ?? '',
  totalBridges: document.getElementById('fab-total-bridges')?.textContent ?? '',
  minGap: document.getElementById('fab-min-gap')?.textContent ?? '',
  rows: [...document.querySelectorAll('#fab-rows .fab-row')].map((row) => ({
    head: row.querySelector('.solo-badge')?.textContent ?? '',
    name: row.querySelector('.fab-row-name')?.textContent ?? '',
    badge: row.querySelector('.fab-mini')?.textContent ?? '',
    metrics: row.querySelector('.fab-row-metrics')?.textContent ?? '',
  })),
}));

/* ---- 2D 切片视图：桥位黄色标记与 fab 摘要行 ---- */
await page.click('#btn-toggle-2d');
await page.waitForSelector('#svg-preview-container svg', { timeout: 5000 });
const drawerL1 = await page.evaluate(() => ({
  bridgeLines: document.querySelectorAll('#svg-preview-container svg line[stroke="#fbbf24"]').length,
  islandRects: document.querySelectorAll('#svg-preview-container svg rect.fab-island-marker').length,
  fabLine: document.getElementById('card-fab-line')?.textContent ?? '',
  legendHidden: document.getElementById('card-fab-legend')?.classList.contains('hidden') ?? true,
}));
await page.click('#drawer-layer-tabs button:nth-child(3)');
await page.waitForTimeout(200);
const drawerL3 = await page.evaluate(() => ({
  bridgeLines: document.querySelectorAll('#svg-preview-container svg line[stroke="#fbbf24"]').length,
  islandRects: document.querySelectorAll('#svg-preview-container svg rect.fab-island-marker').length,
  fabLine: document.getElementById('card-fab-line')?.textContent ?? '',
}));
await page.click('#btn-close-2d');
await page.waitForTimeout(400);

// 截图（暗室正面视角），验证非空白
await page.click('#cam-front');
await page.waitForTimeout(1200);
mkdirSync(join(REPO, '.bake', 'selftest'), { recursive: true });
const shotPath = join(REPO, '.bake', 'selftest', 'home.png');
await page.screenshot({ path: shotPath });
const pixels = await page.evaluate(() => {
  const canvas = document.querySelector('#webgl-container canvas');
  const c = document.createElement('canvas');
  c.width = 160;
  c.height = 100;
  const ctx = c.getContext('2d');
  ctx.drawImage(canvas, 0, 0, 160, 100);
  const data = ctx.getImageData(0, 0, 160, 100).data;
  const colors = new Set();
  for (let i = 0; i < data.length; i += 4) colors.add(`${data[i] >> 4},${data[i + 1] >> 4},${data[i + 2] >> 4}`);
  return colors.size;
});

// 面板与 2D 抽屉截图（存 .bake/selftest/，供票据回填引用）
mkdirSync(join(REPO, '.bake', 'selftest'), { recursive: true });
await page.click('.tab[data-tab="struct"]');
await page.locator('#fab-panel').screenshot({ path: join(REPO, '.bake', 'selftest', 'fab-panel.png') });
await page.click('#btn-toggle-2d');
await page.waitForTimeout(300);
await page.screenshot({ path: join(REPO, '.bake', 'selftest', 'drawer-2d.png') });
await page.click('#btn-close-2d');

/* ---- 票 15：SVG/ZIP 导出 —— 拦截下载流 → 解析 ZIP → 逐层断言 ---- */
const exportBtnReady = await page.evaluate(() => {
  const btn = document.getElementById('btn-export-zip');
  return { exists: !!btn, disabled: btn?.disabled ?? true, title: btn?.title ?? '' };
});

const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 15000 }),
  page.click('#btn-export-zip'),
]);
const suggestedName = download.suggestedFilename();
const dlPath = await download.path();
const zipBytes = readFileSync(dlPath);
mkdirSync(join(REPO, '.bake', 'selftest'), { recursive: true });
copyFileSync(dlPath, join(REPO, '.bake', 'selftest', 'export.zip'));

// 最小 ZIP 读取器：扫 local file header（我们导出的是 STORE，无 data descriptor）
function parseStoreZip(buf) {
  const files = {};
  let off = 0;
  while (off < buf.length - 4) {
    if (buf.readUInt32LE(off) !== 0x04034b50) {
      off++;
      continue;
    }
    const flags = buf.readUInt16LE(off + 6);
    const method = buf.readUInt16LE(off + 8);
    const crc = buf.readUInt32LE(off + 14);
    const compSize = buf.readUInt32LE(off + 18);
    const uncompSize = buf.readUInt32LE(off + 22);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.slice(off + 30, off + 30 + nameLen).toString('utf8');
    const dataStart = off + 30 + nameLen + extraLen;
    files[name] = { flags, method, crc, compSize, uncompSize, data: buf.slice(dataStart, dataStart + compSize) };
    off = dataStart + compSize;
  }
  return files;
}

// CRC32（与导出端同表算法，独立实现校验）
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const zipFiles = parseStoreZip(zipBytes);
const zipNames = Object.keys(zipFiles).sort();
const expectedNames = [...baked.layers.map((_, i) => `xiake-L${i + 1}.svg`), 'README.txt'].sort();
const crcOk = Object.entries(zipFiles).every(([n, f]) => crc32(f.data) === f.crc);
const storeOk = Object.values(zipFiles).every((f) => f.method === 0 && f.compSize === f.uncompSize && (f.flags & 0x0800) !== 0);

const pxPerMm = baked.viewBox.split(/\s+/).map(Number)[2] / baked.sizeMm.width; // 11.84
const expectedStroke = Number((0.1 * pxPerMm).toFixed(4)); // 1.184
const layerSvgs = baked.layers.map((layer, i) => {
  const entry = zipFiles[`xiake-L${i + 1}.svg`];
  if (!entry) return { i, errors: ['missing from ZIP'] };
  const text = entry.data.toString('utf8');
  const errors = [];
  const width = text.match(/width="([^"]+)"/)?.[1];
  const height = text.match(/height="([^"]+)"/)?.[1];
  const viewBox = text.match(/viewBox="([^"]+)"/)?.[1];
  if (width !== `${baked.sizeMm.width}mm`) errors.push(`width=${width}`);
  if (height !== `${baked.sizeMm.height}mm`) errors.push(`height=${height}`);
  if (viewBox !== baked.viewBox) errors.push(`viewBox=${viewBox}`);
  if (!text.includes('xmlns="http://www.w3.org/2000/svg"')) errors.push('missing xmlns');
  const d = text.match(/<path [^>]*d="([^"]+)"/)?.[1];
  const paths = text.match(/<path /g)?.length ?? 0;
  if (paths !== 1) errors.push(`path count=${paths}`);
  if (!d) errors.push('no path d');
  else {
    const mCount = (d.match(/M/g) ?? []).length;
    const zCount = (d.match(/Z/g) ?? []).length;
    if (mCount === 0 || mCount !== zCount || !/Z\s*$/.test(d)) errors.push(`open subpaths M=${mCount} Z=${zCount}`);
    if (d !== layer.pathD.join(' ')) errors.push('path d != baked pathD');
  }
  if (!/fill="none"/.test(text)) errors.push('fill not none');
  if (!/stroke="#FF0000"/.test(text)) errors.push('stroke not #FF0000');
  const sw = Number(text.match(/stroke-width="([^"]+)"/)?.[1]);
  if (!Number.isFinite(sw) || Math.abs(sw - expectedStroke) > 1e-6) errors.push(`stroke-width=${sw} expect ${expectedStroke}`);
  if (Number.isFinite(sw) && Math.abs(sw / pxPerMm - 0.1) > 1e-9) errors.push('stroke-width != 0.1mm');
  if (/<mask|<filter|<text|[\s"']mask=|[\s"']filter=/i.test(text)) errors.push('has mask/filter/text');
  // 元素白名单：只允许 svg 与 path 标签（朴素 path 规范）
  const tagNames = [...text.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/g)].map((m) => m[2].toLowerCase());
  if (tagNames.some((t) => t !== 'svg' && t !== 'path')) errors.push(`unexpected tags: ${[...new Set(tagNames.filter((t) => t !== 'svg' && t !== 'path'))].join(',')}`);
  return { i, errors };
});

const readmeText = zipFiles['README.txt']?.data.toString('utf8') ?? '';
const readmeErrors = [];
for (const [label, re] of [
  ['red cut note', /红色\s*\(?#FF0000\)?[^]*切割/],
  ['blue engrave note', /蓝色[^]*刻痕/],
  ['no engrave lines disclaimer', /没有蓝色刻痕线/],
  ['cardstock 250-300g', /250-300g/],
  ['kerf software-side', /kerf/i],
  ['L1 near LED', /L1[^]*靠 LED/],
  ['L6 near viewer', /L6[^]*观者/],
]) {
  if (!re.test(readmeText)) readmeErrors.push(`missing: ${label}`);
}
for (const layer of baked.layers) {
  if (!readmeText.includes(layer.name)) readmeErrors.push(`missing layer name: ${layer.name}`);
}

/* ---- 票 16：现场重跑 —— mock fetch（拆层 b64_json + evolving SSE）跑通五段状态机 ---- */

// 小尺寸图层 PNG（64x48，中央 24x18 透明洞 = 镂空），bbox 覆盖 128x96 全画布。
// 工作分辨率 64x48、阈值 128、去噪点 64px：洞 432px 不被去噪，单连通无孤岛。
const MOCK_CANVAS_W = 128;
const MOCK_CANVAS_H = 96;
function tinyLayerB64() {
  const w = 64, h = 48;
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const inHole = x >= 20 && x < 44 && y >= 15 && y < 33;
      png.data[idx] = png.data[idx + 1] = png.data[idx + 2] = 255;
      png.data[idx + 3] = inHole ? 0 : 255;
    }
  }
  return PNG.sync.write(png).toString('base64');
}
function tinyBaseB64() {
  const png = new PNG({ width: 8, height: 8 });
  for (let i = 0; i < 64; i++) {
    png.data[i * 4] = png.data[i * 4 + 1] = png.data[i * 4 + 2] = 200;
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png).toString('base64');
}
const mockNames = ['远山剪纸', '古亭剪纸', '松树剪纸', '马匹剪纸', '前景草丛剪纸', '山峦剪纸'];
const decomposeItems = [
  { size: `${MOCK_CANVAS_W}x${MOCK_CANVAS_H}`, output_format: 'jpeg', z_index: 0, b64_json: tinyBaseB64() },
  ...mockNames.map((name, i) => ({
    size: '64x48',
    output_format: 'png',
    z_index: i + 1,
    b64_json: tinyLayerB64(),
    bounding_box: { absolute: [0, 0, MOCK_CANVAS_W, MOCK_CANVAS_H], normalized: [0, 0, 999, 999] },
    name,
    description: `mock 图层 ${i + 1}`,
  })),
];
const mappingJson = JSON.stringify({
  layers: mockNames.map((name, i) => ({
    index: i + 1,
    name: `测试层${i + 1}`,
    elements: [{ name, bbox: [0, 0, 999, 999], anchor: 'frame', notes: 'mock' }],
    mergeNotes: `mock 归并 L${i + 1}`,
  })),
});
// SSE 分 3 段推送 content，另带 usage 行 + [DONE]
const sseParts = [];
for (let i = 0; i < 3; i++) {
  const part = mappingJson.slice((mappingJson.length / 3) * i | 0, (mappingJson.length / 3) * (i + 1) | 0);
  sseParts.push(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`);
}
sseParts.push(`data: ${JSON.stringify({ usage: { total_tokens: 4321, completion_tokens: 100 } })}\n\n`);
sseParts.push('data: [DONE]\n\n');

await page.evaluate(
  ({ items, parts }) => {
    const realFetch = window.fetch.bind(window);
    window.__mockSse = parts;
    window.__mockMode = 'success';
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || String(input);
      if (url.includes('images/generations')) {
        if (window.__mockMode === 'fail401') {
          return Promise.resolve(
            new Response(JSON.stringify({ error: { code: 'AuthenticationError', message: 'invalid api key' } }), {
              status: 401,
              headers: { 'content-type': 'application/json' },
            }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ data: items }), { status: 200, headers: { 'content-type': 'application/json' } }),
        );
      }
      if (url.includes('chat/completions')) {
        const enc = new TextEncoder();
        const stream = new ReadableStream({
          start(c) {
            for (const p of window.__mockSse) c.enqueue(enc.encode(p));
            c.close();
          },
        });
        return Promise.resolve(new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
      }
      return realFetch(input, init);
    };
  },
  { items: decomposeItems, parts: sseParts },
);

const MOCK_KEY = 'mock-ark-key-0001-自测勿用';
await page.click('#btn-rerun');
await page.waitForSelector('#rerun-modal:not(.hidden)', { timeout: 5000 });
await page.fill('#rerun-key-input', MOCK_KEY);
await page.click('#btn-rerun-start');
await page.waitForSelector('#rerun-step-success:not(.hidden)', { timeout: 60000 });

const rerunOk = await page.evaluate(() => {
  const h = window.__seedPapercut;
  return {
    ok: h.rerun.ok,
    stageSeq: h.rerun.events.filter((e) => e.type === 'stage').map((e) => e.stage),
    stageRows: [...document.querySelectorAll('#rerun-stages .stage')].map((el) => ({
      stage: el.dataset.stage,
      done: el.classList.contains('done'),
      time: el.querySelector('.stage-time')?.textContent ?? '',
      detail: el.querySelector('.stage-detail')?.textContent ?? '',
    })),
    mapSource: h.layerSet?.pipeline?.mapSource ?? '',
    layerCount: h.layerSet?.layers.length ?? 0,
    layerNames: h.layerSet?.layers.map((l) => l.name) ?? [],
    pathCounts: h.layerSet?.layers.map((l) => l.pathD.length) ?? [],
    allPass: h.layerSet?.layers.every((l) => l.fabCheck.pass) ?? false,
    totalTokensDetail: h.rerun.events.some((e) => e.type === 'done' && e.stage === 'map' && (e.text ?? '').includes('4321')),
    detailSawItems: h.rerun.events.some((e) => e.type === 'detail' && (e.text ?? '').includes('模型返回 7 项')),
    demoBadgeVisible: !document.getElementById('demo-badge')?.classList.contains('hidden'),
    exportDisabled: document.getElementById('btn-export-zip')?.disabled ?? true,
    modalStillOpen: !document.getElementById('rerun-modal')?.classList.contains('hidden'),
  };
});

// Key 不落盘：扫 localStorage / sessionStorage / cookie
const keyLeak = await page.evaluate((k) => {
  const scan = (store) => Object.keys(store).map((kk) => `${kk}=${store.getItem(kk)}`).join('|');
  const hay = `${scan(localStorage)}|${scan(sessionStorage)}|${document.cookie}`;
  return { hay: hay.slice(0, 400), leaked: hay.includes(k) };
}, MOCK_KEY);

/* ---- 票 16：失败降级分支 —— 401 → 错误类别 → 回退烘焙数据 + 「演示数据」徽标 ---- */
await page.click('#btn-rerun-finish'); // 关闭成功模态
await page.evaluate(() => {
  window.__mockMode = 'fail401';
});
await page.click('#btn-rerun');
await page.waitForSelector('#rerun-modal:not(.hidden)', { timeout: 5000 });
await page.fill('#rerun-key-input', MOCK_KEY);
await page.click('#btn-rerun-start');
await page.waitForSelector('#rerun-step-error:not(.hidden)', { timeout: 15000 });
const rerunFail = await page.evaluate(() => ({
  cat: document.getElementById('rerun-error-cat')?.textContent ?? '',
  msg: document.getElementById('rerun-error-msg')?.textContent ?? '',
  fallbackVisible: !document.getElementById('btn-rerun-fallback')?.hidden,
}));
await page.click('#btn-rerun-fallback');
await page.waitForTimeout(400);
const rerunFallback = await page.evaluate(() => ({
  badge: !document.getElementById('demo-badge')?.classList.contains('hidden'),
  mapSource: window.__seedPapercut.layerSet?.pipeline?.mapSource ?? '',
  pxPerMm: window.__seedPapercut.layerSet?.pipeline?.pxPerMm ?? 0,
  layerCount: window.__seedPapercut.layerSet?.layers.length ?? 0,
  modalClosed: document.getElementById('rerun-modal')?.classList.contains('hidden') ?? false,
  keyInputEmpty: document.getElementById('rerun-key-input')?.value === '',
}));

await browser.close();
server.close();

const fabRowChecks = expectedRows.map((exp, i) => {
  const got = fabPanel.rows[i] ?? {};
  const metricsOk =
    (got.metrics ?? '').includes(exp.islands) &&
    (got.metrics ?? '').includes(exp.bridges) &&
    (got.metrics ?? '').includes(exp.cut) &&
    (got.metrics ?? '').includes(exp.gap);
  return {
    name: `fab row L${i + 1} fields == JSON`,
    pass: got.head === exp.head && got.badge === exp.badge && metricsOk && got.name === baked.layers[i].name,
    detail: JSON.stringify(got),
  };
});

const checks = [
  { name: 'no console errors', pass: consoleErrors.length === 0, detail: consoleErrors.slice(0, 3) },
  { name: 'no page errors', pass: pageErrors.length === 0, detail: pageErrors.slice(0, 3) },
  { name: 'webgl context (swiftshader)', pass: !!info.webgl, detail: info.webgl },
  { name: 'layerset has 6 layers', pass: info.layerCount === 6, detail: info.layerNames.join(',') },
  { name: '6 extruded meshes', pass: info.meshCount === 6 && info.geometryTris.every((v) => v >= 30), detail: info.geometryTris.join(',') },
  { name: 'z-order L1 nearest LED', pass: info.zSlots.length === 6 && Math.min(...info.zSlots) === info.zSlots[0] && Math.max(...info.zSlots) === info.zSlots[5], detail: info.zSlots.join(',') },
  { name: 'fab placeholder replaced by panel', pass: !info.fabPlaceholder && fabPanel.panelExists, detail: `placeholder=${info.fabPlaceholder} panel=${fabPanel.panelExists}` },
  { name: 'fab summary badge all pass', pass: fabPanel.badge === `全部通过 ${baked.layers.length}/${baked.layers.length}` && fabPanel.badgeCls.includes('ok'), detail: fabPanel.badge },
  { name: 'fab total cut length == JSON sum', pass: fabPanel.totalCut === String(expectedTotalCut), detail: `${fabPanel.totalCut} vs ${expectedTotalCut}` },
  { name: 'fab total bridges == JSON sum', pass: fabPanel.totalBridges === String(expectedTotalBridges), detail: `${fabPanel.totalBridges} vs ${expectedTotalBridges}` },
  { name: 'fab min gap == JSON min', pass: fabPanel.minGap === fmt2(expectedMinGap), detail: `${fabPanel.minGap} vs ${fmt2(expectedMinGap)}` },
  ...fabRowChecks,
  { name: '2D L1 bridge markers == JSON bridges', pass: drawerL1.bridgeLines === baked.layers[0].fabCheck.bridgesAdded.length && drawerL1.islandRects === 0 && !drawerL1.legendHidden, detail: JSON.stringify(drawerL1) },
  { name: '2D L1 fab line matches JSON', pass: drawerL1.fabLine.includes(`孤岛 ${baked.layers[0].fabCheck.islands.length}→${unrepaired(baked.layers[0].fabCheck)}`) && drawerL1.fabLine.includes(`切割 ${fmt2(baked.layers[0].fabCheck.cutLengthMm)} mm`), detail: drawerL1.fabLine },
  { name: '2D L3 bridge markers == JSON bridges', pass: drawerL3.bridgeLines === baked.layers[2].fabCheck.bridgesAdded.length, detail: JSON.stringify(drawerL3) },
  { name: '2D L3 caution for gap < 2mm', pass: drawerL3.fabLine.includes('缝隙低于 2mm'), detail: drawerL3.fabLine },
  { name: 'solo list has 6 items', pass: info.soloItems === 6, detail: info.soloItems },
  { name: 'render non-blank', pass: pixels >= 12, detail: `${pixels} distinct colors` },
  // ---- 票 15：SVG/ZIP 导出 ----
  { name: 'export button enabled after load', pass: exportBtnReady.exists && !exportBtnReady.disabled && !exportBtnReady.title.includes('未通过'), detail: JSON.stringify(exportBtnReady) },
  { name: 'download triggered with suggested filename', pass: suggestedName === 'xiake-layers.zip', detail: suggestedName },
  { name: 'zip contains exactly 6 SVG + README.txt', pass: zipNames.length === 7 && JSON.stringify(zipNames) === JSON.stringify(expectedNames), detail: zipNames.join(',') },
  { name: 'zip STORE method + UTF-8 flag + CRC32 all valid', pass: storeOk && crcOk, detail: `store=${storeOk} crc=${crcOk}` },
  ...layerSvgs.map(
    (s) => ({
      name: `SVG L${s.i + 1}: mm size/viewBox/red 0.1mm stroke/closed plain path`,
      pass: s.errors.length === 0,
      detail: s.errors.join('; ') || 'ok',
    }),
  ),
  { name: 'README: colors/cardstock/kerf/positions/layer names', pass: readmeErrors.length === 0, detail: readmeErrors.join('; ') || 'ok' },
  // ---- 票 16：现场重跑（mock SSE 全链路） ----
  { name: 'rerun success: task finished & modal shows success step', pass: rerunOk.ok === true && rerunOk.modalStillOpen, detail: JSON.stringify({ ok: rerunOk.ok, modalStillOpen: rerunOk.modalStillOpen }) },
  { name: 'rerun: five stages advance in order with per-stage time', pass: JSON.stringify(rerunOk.stageSeq) === JSON.stringify(['decompose', 'map', 'vectorize', 'topology']) && rerunOk.stageRows.every((r) => r.done && r.time.length > 0), detail: JSON.stringify({ seq: rerunOk.stageSeq, rows: rerunOk.stageRows.map((r) => `${r.stage}:${r.time}`) }) },
  { name: 'rerun: decompose detail reports model item count', pass: rerunOk.detailSawItems, detail: 'expect detail containing 模型返回 7 项' },
  { name: 'rerun: map stage reports token usage from SSE', pass: rerunOk.totalTokensDetail, detail: 'expect map done summary containing 4321' },
  { name: 'rerun: new LayerSet replaces preview (same schema, 6 layers, all pass)', pass: rerunOk.mapSource === 'evolving' && rerunOk.layerCount === 6 && rerunOk.pathCounts.length === 6 && rerunOk.pathCounts.every((n) => n > 0) && rerunOk.allPass, detail: JSON.stringify({ mapSource: rerunOk.mapSource, layerCount: rerunOk.layerCount, pathCounts: rerunOk.pathCounts, allPass: rerunOk.allPass }) },
  { name: 'rerun: success does NOT show demo badge & export stays enabled', pass: !rerunOk.demoBadgeVisible && !rerunOk.exportDisabled, detail: JSON.stringify(rerunOk) },
  { name: 'rerun: API key not in localStorage/sessionStorage/cookie', pass: !keyLeak.leaked, detail: keyLeak.hay },
  { name: 'rerun: API key not in console/page error logs', pass: !consoleErrors.join('|').includes(MOCK_KEY) && !pageErrors.join('|').includes(MOCK_KEY), detail: 'key absent from captured logs' },
  { name: 'rerun 401: error step shows category + fallback button', pass: rerunFail.cat.includes('Key') && rerunFail.msg.length > 0 && rerunFail.fallbackVisible, detail: JSON.stringify(rerunFail) },
  { name: 'rerun fallback: demo badge shown, baked data restored, key cleared', pass: rerunFallback.badge && rerunFallback.mapSource === 'evolving' && Math.abs(rerunFallback.pxPerMm - baked.pipeline.pxPerMm) < 1e-9 && rerunFallback.layerCount === 6 && rerunFallback.modalClosed && rerunFallback.keyInputEmpty, detail: JSON.stringify(rerunFallback) },
];
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'} ${c.name}${c.pass ? '' : ' :: ' + JSON.stringify(c.detail)}`);
writeFileSync(
  join(REPO, '.bake', 'selftest', 'result.json'),
  JSON.stringify({ at: new Date().toISOString(), info, consoleErrors, pageErrors, checks }, null, 2),
);
const ok = checks.every((c) => c.pass);
console.log(ok ? 'SELFTEST_PASS' : 'SELFTEST_FAIL');
process.exit(ok ? 0 : 2);

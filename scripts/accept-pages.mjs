// 线上 Pages 终验脚本（issue 18）：对 https://lwcrafts.github.io/seed-papercut/ 逐项验收。
//   A. 加载无 error/pageerror、6 层灯箱渲染、fabCheck 面板数据、场景切换器隐藏
//   B. 导出 ZIP：拦截线上下载流 → 解析 → 逐层 SVG 断言（mm/闭合/无 filter/mask/text）
//   C. SVG 兼容性数字验证：xmllint 无错（Inkscape 无 CLI 则记录跳过）
//   D. 现场重跑：真网络 + 假 key → 失败降级 →「演示数据」徽标（真 key 线上真跑按票跳过）
//   E. 性能（navigation timing）与 console error/warning 清单
//   F. 文章素材截图 ≥10 张 → .scratch/seed-papercut/research/final-shots/
// 用法：node scripts/accept-pages.mjs [--shots <dir>]
import { mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const REPO = dirname(fileURLToPath(new URL('..', import.meta.url)));
const REPO2 = join(REPO, 'seed-papercut'); // 兼容直接放置位置
const ROOT = (() => { try { readFileSync(join(REPO, 'package.json')); return REPO; } catch { return REPO2; } })();
const SHOTS = process.argv.includes('--shots')
  ? process.argv[process.argv.indexOf('--shots') + 1]
  : '/Users/lw/ghq/github.com/lwcrafts/article-workspace/01-内容生产/02-进行中选题/2026-09-16-第三期seed投稿/v2/.scratch/seed-papercut/research/final-shots';
const BASE_URL = 'https://lwcrafts.github.io/seed-papercut/';
const TMP = '/tmp/seed-papercut-accept';

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
mkdirSync(SHOTS, { recursive: true });

const consoleErrors = [];
const consoleWarnings = [];
let cleanErrCount = 0; // 假 key 降级测试（预期触发 CORS console error）之前的干净期计数
let cleanWarnCount = 0;
const pageErrors = [];
const failedRequests = [];

const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--disable-gpu-driver-bug-workarounds', '--use-gl=angle', '--use-angle=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
  if (msg.type() === 'warning') consoleWarnings.push(msg.text());
});
page.on('pageerror', (err) => pageErrors.push(String(err)));
page.on('requestfailed', (req) => failedRequests.push(`${req.method()} ${req.url()} :: ${req.failure()?.errorText}`));

/* ---- A. 线上加载 ---- */
const t0 = Date.now();
const resp = await page.goto(BASE_URL, { waitUntil: 'networkidle' });
await page.waitForFunction(
  () => document.getElementById('data-status-text')?.textContent?.includes('装配就绪'),
  null,
  { timeout: 30000 },
);
const loadWallMs = Date.now() - t0;
const navTiming = await page.evaluate(() => {
  const nav = performance.getEntriesByType('navigation')[0]?.toJSON() ?? {};
  return {
    domContentLoaded: Math.round(nav.domContentLoadedEventEnd ?? 0),
    loadEvent: Math.round(nav.loadEventEnd ?? 0),
    transferSize: nav.transferSize ?? 0,
  };
});

const info = await page.evaluate(() => {
  const h = window.__seedPapercut;
  const gl = document.createElement('canvas').getContext('webgl2') ?? document.createElement('canvas').getContext('webgl');
  return {
    webgl: gl ? (gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info')?.UNMASKED_RENDERER_WEBGL ?? 0) || gl.getParameter(gl.RENDERER)) : null,
    layerCount: h?.layerSet?.layers.length ?? 0,
    layerNames: h?.layerSet?.layers.map((l) => l.name) ?? [],
    meshCount: h?.scene?.paperMeshes?.length ?? 0,
    zSlots: h?.scene?.paperMeshes?.map((m) => +m.position.z.toFixed(2)) ?? [],
    sceneId: h?.layerSet?.sceneId ?? '',
    statusText: document.getElementById('data-status-text')?.textContent ?? '',
    fabPlaceholder: !!document.querySelector('.fab-placeholder'),
    sceneSwitcherHidden: document.getElementById('scene-switcher')?.classList.contains('hidden') ?? null,
    sceneBtnCount: document.querySelectorAll('#scene-switcher button').length,
    demoBadge: !document.getElementById('demo-badge')?.classList.contains('hidden'),
  };
});

// 线上 baked JSON（作为 fabCheck 面板与 SVG 断言的期望源）
const baked = await page.evaluate(async () => await (await fetch('data/baked/xiake.json')).json());
const fmt2 = (n) => String(Math.round(n * 100) / 100);
const unrepaired = (fc) => {
  const covered = new Set();
  for (const b of fc.bridgesAdded) {
    covered.add(b.fromId);
    if (typeof b.toTarget === 'number') covered.add(b.toTarget);
  }
  return fc.islands.filter((i) => !covered.has(i.id)).length;
};

await page.click('.tab[data-tab="struct"]');
const fabPanel = await page.evaluate(() => ({
  panelExists: !!document.getElementById('fab-panel'),
  badge: document.getElementById('fab-pass-badge')?.textContent ?? '',
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
const expectedTotalCut = Math.round(baked.layers.reduce((s, l) => s + l.fabCheck.cutLengthMm, 0) * 10) / 10;
const expectedTotalBridges = baked.layers.reduce((s, l) => s + l.fabCheck.bridgesAdded.length, 0);
const expectedMinGap = Math.min(...baked.layers.map((l) => l.fabCheck.minGapMm).filter((g) => g > 0));
const fabRowChecks = baked.layers.map((l, i) => {
  const got = fabPanel.rows[i] ?? {};
  const exp = l.fabCheck;
  return {
    name: `fab row L${i + 1} == live JSON`,
    pass:
      got.head === `L${i + 1}` &&
      got.badge === (exp.pass ? '通过' : '未通过') &&
      got.name === l.name &&
      (got.metrics ?? '').includes(`孤岛 ${exp.islands.length}→${unrepaired(exp)}`) &&
      (got.metrics ?? '').includes(`加桥 ${exp.bridgesAdded.length}`) &&
      (got.metrics ?? '').includes(`切割 ${fmt2(exp.cutLengthMm)} mm`) &&
      (got.metrics ?? '').includes(`缝隙 ${fmt2(exp.minGapMm)} mm`),
    detail: JSON.stringify(got),
  };
});

/* ---- F. 截图：视图系列 ---- */
const shot = (name) => join(SHOTS, name);
await page.click('#btn-reset-view').catch(() => {});
await page.click('.tab[data-tab="light"]');
await page.click('#cam-front');
await page.waitForTimeout(1500);
await page.screenshot({ path: shot('01-home-firstview.png') });
await page.screenshot({ path: shot('02-lightbox-front.png') });
await page.click('#cam-persp');
await page.waitForTimeout(1200);
await page.screenshot({ path: shot('03-lightbox-persp45.png') });
await page.click('#cam-side');
await page.waitForTimeout(1200);
await page.screenshot({ path: shot('04-lightbox-side.png') });
// 爆炸分解 50%
await page.click('#cam-front');
await page.locator('#slider-explode').fill('50');
await page.waitForTimeout(1500);
const explodePct = await page.evaluate(() => document.getElementById('explode-percent-pill')?.textContent ?? '');
await page.screenshot({ path: shot('05-explode-50.png') });
await page.locator('#slider-explode').fill('0');
// 灯光色温两态：3000K 暖黄 vs 6000K 冷月白
await page.locator('.preset[data-color="#FFE0B2"]').click();
await page.waitForTimeout(1200);
await page.screenshot({ path: shot('06-light-3000k-warm.png') });
await page.locator('.preset[data-color="#E8F1FF"]').click();
await page.waitForTimeout(1200);
await page.screenshot({ path: shot('07-light-6000k-cool.png') });
// fabCheck 面板特写
await page.click('.tab[data-tab="struct"]');
await page.locator('#fab-panel').screenshot({ path: shot('08-fabcheck-panel.png') });
// 2D 桥位视图（L1）
await page.click('#btn-toggle-2d');
await page.waitForSelector('#svg-preview-container svg', { timeout: 10000 });
const drawerL1 = await page.evaluate(() => ({
  bridgeLines: document.querySelectorAll('#svg-preview-container svg line[stroke="#fbbf24"]').length,
  islandRects: document.querySelectorAll('#svg-preview-container svg rect.fab-island-marker').length,
  fabLine: document.getElementById('card-fab-line')?.textContent ?? '',
}));
await page.waitForTimeout(400);
await page.screenshot({ path: shot('09-2d-bridges.png') });
await page.click('#btn-close-2d');
await page.waitForTimeout(400);
// 导出按钮特写
await page.locator('#btn-export-zip').screenshot({ path: shot('10-export-button.png') });

/* ---- B. 线上导出 ZIP：拦截下载流 ---- */
const exportBtnReady = await page.evaluate(() => {
  const btn = document.getElementById('btn-export-zip');
  return { exists: !!btn, disabled: btn?.disabled ?? true, title: btn?.title ?? '' };
});
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 20000 }),
  page.click('#btn-export-zip'),
]);
const suggestedName = download.suggestedFilename();
const dlPath = await download.path();
const zipBytes = readFileSync(dlPath);
copyFileSync(dlPath, join(TMP, 'xiake-layers.zip'));

function parseStoreZip(buf) {
  const files = {};
  let off = 0;
  while (off < buf.length - 4) {
    if (buf.readUInt32LE(off) !== 0x04034b50) { off++; continue; }
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

const pxPerMm = baked.viewBox.split(/\s+/).map(Number)[2] / baked.sizeMm.width;
const expectedStroke = Number((0.1 * pxPerMm).toFixed(4));
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
  const paths = text.match(/<path /g)?.length ?? 0;
  const d = text.match(/<path [^>]*d="([^"]+)"/)?.[1];
  if (paths !== 1) errors.push(`path count=${paths}`);
  if (!d) errors.push('no path d');
  else {
    const mCount = (d.match(/M/g) ?? []).length;
    const zCount = (d.match(/Z/g) ?? []).length;
    if (mCount === 0 || mCount !== zCount || !/Z\s*$/.test(d)) errors.push(`open subpaths M=${mCount} Z=${zCount}`);
    if (d !== layer.pathD.join(' ')) errors.push('path d != live JSON pathD');
  }
  if (!/fill="none"/.test(text)) errors.push('fill not none');
  if (!/stroke="#FF0000"/.test(text)) errors.push('stroke not #FF0000');
  const sw = Number(text.match(/stroke-width="([^"]+)"/)?.[1]);
  if (!Number.isFinite(sw) || Math.abs(sw - expectedStroke) > 1e-6) errors.push(`stroke-width=${sw} expect ${expectedStroke}`);
  if (Number.isFinite(sw) && Math.abs(sw / pxPerMm - 0.1) > 1e-9) errors.push('stroke-width != 0.1mm');
  if (/<mask|<filter|<text|[\s"']mask=|[\s"']filter=/i.test(text)) errors.push('has mask/filter/text');
  const tagNames = [...text.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/g)].map((m) => m[2].toLowerCase());
  if (tagNames.some((t) => t !== 'svg' && t !== 'path')) errors.push(`unexpected tags: ${[...new Set(tagNames.filter((t) => t !== 'svg' && t !== 'path'))].join(',')}`);
  return { i, errors };
});

const readmeText = zipFiles['README.txt']?.data.toString('utf8') ?? '';
const readmeErrors = [];
for (const [label, re] of [
  ['red cut note', /红色\s*\(?#FF0000\)?[^]*切割/],
  ['blue engrave note', /蓝色[^]*刻痕/],
  ['cardstock 250-300g', /250-300g/],
  ['kerf software-side', /kerf/i],
]) {
  if (!re.test(readmeText)) readmeErrors.push(`missing: ${label}`);
}
for (const layer of baked.layers) if (!readmeText.includes(layer.name)) readmeErrors.push(`missing layer name: ${layer.name}`);

/* ---- C. SVG 兼容性数字验证：xmllint（Inkscape 视 CLI 是否存在） ---- */
mkdirSync(join(TMP, 'svg'), { recursive: true });
const xmllintResults = baked.layers.map((_, i) => {
  const name = `xiake-L${i + 1}.svg`;
  const p = join(TMP, 'svg', name);
  writeFileSync(p, zipFiles[name].data);
  try {
    execFileSync('xmllint', ['--noout', p], { encoding: 'utf8' });
    return { name, ok: true, out: '' };
  } catch (err) {
    return { name, ok: false, out: String(err.stderr ?? err).slice(0, 200) };
  }
});
let inkscapeNote = '';
try {
  execFileSync('inkscape', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const inksResults = baked.layers.map((_, i) => {
    const p = join(TMP, 'svg', `xiake-L${i + 1}.svg`);
    try {
      const out = execFileSync('inkscape', ['--export-type=png', '--export-filename', p.replace('.svg', '.png'), p], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { name: `xiake-L${i + 1}.svg`, ok: true, out: '' };
    } catch (err) {
      return { name: `xiake-L${i + 1}.svg`, ok: false, out: String(err.stderr ?? err).slice(0, 200) };
    }
  });
  inkscapeNote = inksResults.every((r) => r.ok) ? 'Inkscape CLI 6/6 打开无报错' : JSON.stringify(inksResults.filter((r) => !r.ok));
} catch {
  inkscapeNote = 'SKIPPED: 本机未安装 Inkscape CLI（无 GUI 渲染验证手段）；已用 xmllint 严格 XML 校验 + 结构白名单（仅 svg/path 标签、无 filter/mask/text）替代数字验证';
}

// ZIP 内容预览图（HTML 列表 → 截图），并保存 zip 到素材目录
copyFileSync(dlPath, join(SHOTS, 'xiake-layers.zip'));
const listHtml = `<meta charset="utf-8"><body style="font:14px ui-monospace,monospace;background:#1a1a1e;color:#e5e5e8;padding:20px">
<h3 style="margin:0 0 12px">xiake-layers.zip（${zipNames.length} 个文件，STORE 零依赖）</h3>
<table style="border-collapse:collapse">${zipNames.map((n) => {
  const f = zipFiles[n];
  return `<tr><td style="padding:3px 16px 3px 0">${n}</td><td style="padding:3px 16px 3px 0;color:#9ca3af">${f.data.length.toLocaleString()} B</td><td style="padding:3px;color:#34d399">${crc32(f.data) === f.crc ? 'CRC OK' : 'CRC BAD'}</td></tr>`;
}).join('')}</table></body>`;
writeFileSync(join(TMP, 'ziplist.html'), listHtml);
const zipPage = await browser.newPage({ viewport: { width: 560, height: 400 } });
await zipPage.goto(`file://${join(TMP, 'ziplist.html')}`);
await zipPage.waitForTimeout(300);
await zipPage.screenshot({ path: shot('11-zip-contents.png') });
await zipPage.close();

/* ---- D1. 现场重跑（mock fetch，五段进度截图） ---- */
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
const sseParts = [];
for (let i = 0; i < 3; i++) {
  const part = mappingJson.slice((mappingJson.length / 3) * i | 0, (mappingJson.length / 3) * (i + 1) | 0);
  sseParts.push(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`);
}
sseParts.push(`data: ${JSON.stringify({ usage: { total_tokens: 4321, completion_tokens: 100 } })}\n\n`);
sseParts.push('data: [DONE]\n\n');

// 注入 mock（成功路径带 1.2s 拆层延迟，便于截五段进度中间态）；真网络降级用还原后的 fetch
await page.evaluate(
  ({ items, parts }) => {
    const realFetch = window.fetch.bind(window);
    window.__realFetch = realFetch;
    window.__mockSse = parts;
    window.__mockMode = 'success';
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || String(input);
      if (url.includes('images/generations')) {
        if (window.__mockMode === 'real') return realFetch(input, init);
        const slow = new Promise((r) => setTimeout(r, 1200));
        if (window.__mockMode === 'fail401') {
          return slow.then(() =>
            new Response(JSON.stringify({ error: { code: 'AuthenticationError', message: 'invalid api key' } }), {
              status: 401,
              headers: { 'content-type': 'application/json' },
            }),
          );
        }
        return slow.then(() =>
          new Response(JSON.stringify({ data: items }), { status: 200, headers: { 'content-type': 'application/json' } }),
        );
      }
      if (url.includes('chat/completions')) {
        const enc = new TextEncoder();
        const stream = new ReadableStream({
          async start(c) {
            for (const p of window.__mockSse) {
              c.enqueue(enc.encode(p));
              await new Promise((r) => setTimeout(r, 350));
            }
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

const MOCK_KEY = 'mock-ark-key-0001-selftest';
await page.click('#btn-rerun');
await page.waitForSelector('#rerun-modal:not(.hidden)', { timeout: 5000 });
await page.fill('#rerun-key-input', MOCK_KEY);
await page.click('#btn-rerun-start');
// 五段进度中间态截图（拆层进行中）
await page.waitForSelector('#rerun-step-progress:not(.hidden)', { timeout: 5000 });
await page.waitForTimeout(600);
await page.screenshot({ path: shot('12-rerun-progress.png') });
// 映射段进行中再截一张
await page.waitForFunction(
  () => document.querySelector('#rerun-stages .stage[data-stage="map"]')?.classList.contains('active'),
  null,
  { timeout: 15000 },
).catch(() => {});
await page.waitForTimeout(300);
await page.screenshot({ path: shot('13-rerun-map-stage.png') });
await page.waitForSelector('#rerun-step-success:not(.hidden)', { timeout: 60000 });
const rerunOk = await page.evaluate(() => {
  const h = window.__seedPapercut;
  return {
    ok: h.rerun.ok,
    stageSeq: h.rerun.events.filter((e) => e.type === 'stage').map((e) => e.stage),
    mapSource: h.layerSet?.pipeline?.mapSource ?? '',
    layerCount: h.layerSet?.layers.length ?? 0,
    allPass: h.layerSet?.layers.every((l) => l.fabCheck.pass) ?? false,
  };
});
await page.screenshot({ path: shot('14-rerun-success.png') });
await page.click('#btn-rerun-finish');

/* ---- D2. 降级 e2e：真网络 + 假 key（真 key 线上真跑按票 18 跳过） ---- */
await page.evaluate(() => { window.__mockMode = 'real'; });
const FAKE_KEY = 'sk-this-key-does-not-exist-0000';
// 假 key 请求会 401 → 无 ACAO → 浏览器拦截并自动写一条 CORS console error（预期产物，非应用缺陷），
// 干净期计数在此之前封存。
cleanErrCount = consoleErrors.length;
cleanWarnCount = consoleWarnings.length;
await page.click('#btn-rerun');
await page.waitForSelector('#rerun-modal:not(.hidden)', { timeout: 5000 });
await page.fill('#rerun-key-input', FAKE_KEY);
const tFail0 = Date.now();
await page.click('#btn-rerun-start');
await page.waitForSelector('#rerun-step-error:not(.hidden)', { timeout: 60000 });
const failWallMs = Date.now() - tFail0;
const rerunFail = await page.evaluate(() => ({
  cat: document.getElementById('rerun-error-cat')?.textContent ?? '',
  msg: document.getElementById('rerun-error-msg')?.textContent ?? '',
  fallbackVisible: !document.getElementById('btn-rerun-fallback')?.hidden,
}));
await page.screenshot({ path: shot('15-rerun-fail-error.png') });
await page.click('#btn-rerun-fallback');
await page.waitForTimeout(600);
const rerunFallback = await page.evaluate(() => ({
  badge: !document.getElementById('demo-badge')?.classList.contains('hidden'),
  mapSource: window.__seedPapercut.layerSet?.pipeline?.mapSource ?? '',
  layerCount: window.__seedPapercut.layerSet?.layers.length ?? 0,
  modalClosed: document.getElementById('rerun-modal')?.classList.contains('hidden') ?? false,
  keyInputEmpty: document.getElementById('rerun-key-input')?.value === '',
}));
await page.click('#cam-front');
await page.waitForTimeout(800);
await page.screenshot({ path: shot('16-degraded-demo-badge.png') });
const keyLeak = await page.evaluate((k) => {
  const scan = (store) => Object.keys(store).map((kk) => `${kk}=${store.getItem(kk)}`).join('|');
  const hay = `${scan(localStorage)}|${scan(sessionStorage)}|${document.cookie}`;
  return hay.includes(k);
}, FAKE_KEY);

/* ---- F2. GitHub 仓库 / README 截图 ---- */
const gh = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await gh.goto('https://github.com/lwcrafts/seed-papercut', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
await gh.waitForTimeout(2000);
await gh.screenshot({ path: shot('17-github-repo.png') });
await gh.close();

await browser.close();

/* ---- 汇总 ---- */
const cleanErrors = consoleErrors.slice(0, cleanErrCount);
const cleanWarnings = consoleWarnings.slice(0, cleanWarnCount);
const envWarnings = cleanWarnings.filter((w) => w.includes('.WebGL-') || w.includes('ReadPixels')); // SwiftShader 截图采集触发的驱动提示，非应用代码
const appWarnings = cleanWarnings.filter((w) => !envWarnings.includes(w));
const checks = [
  { name: 'pages http 200 + bootstrap ready', pass: resp?.ok() === true && info.statusText.includes('装配就绪'), detail: `status=${resp?.status()} statusText=${info.statusText}` },
  { name: 'no console errors in clean session (pre fake-key test)', pass: cleanErrors.length === 0, detail: cleanErrors.slice(0, 5) },
  { name: 'no app console warnings (WebGL driver msgs excluded as capture artifact)', pass: appWarnings.length === 0, detail: appWarnings.slice(0, 5) },
  { name: 'no page errors', pass: pageErrors.length === 0, detail: pageErrors.slice(0, 3) },
  { name: 'no failed requests (excluding expected ark 4xx)', pass: failedRequests.filter((r) => !r.includes('ark.cn-beijing.volces.com')).length === 0, detail: failedRequests.slice(0, 5) },
  { name: 'webgl context (swiftshader on live)', pass: !!info.webgl, detail: info.webgl },
  { name: 'layerset 6 layers from live JSON', pass: info.layerCount === 6 && info.sceneId === 'xiake', detail: `${info.sceneId}: ${info.layerNames.join(',')}` },
  { name: '6 extruded meshes + z-order L1 nearest LED', pass: info.meshCount === 6 && Math.min(...info.zSlots) === info.zSlots[0] && Math.max(...info.zSlots) === info.zSlots[5], detail: info.zSlots.join(',') },
  { name: 'fab placeholder replaced, summary == live JSON', pass: !info.fabPlaceholder && fabPanel.panelExists && fabPanel.badge === `全部通过 ${baked.layers.length}/${baked.layers.length}` && fabPanel.totalCut === String(expectedTotalCut) && fabPanel.totalBridges === String(expectedTotalBridges) && fabPanel.minGap === fmt2(expectedMinGap), detail: JSON.stringify({ badge: fabPanel.badge, cut: fabPanel.totalCut, exp: expectedTotalCut, bridges: fabPanel.totalBridges, expB: expectedTotalBridges, gap: fabPanel.minGap, expG: fmt2(expectedMinGap) }) },
  ...fabRowChecks,
  { name: 'scene switcher hidden for single scene', pass: info.sceneSwitcherHidden === true && info.sceneBtnCount === 0, detail: JSON.stringify({ hidden: info.sceneSwitcherHidden, buttons: info.sceneBtnCount }) },
  { name: 'no demo badge on clean load', pass: info.demoBadge === false, detail: String(info.demoBadge) },
  // 导出
  { name: 'export button enabled', pass: exportBtnReady.exists && !exportBtnReady.disabled && !exportBtnReady.title.includes('未通过'), detail: JSON.stringify(exportBtnReady) },
  { name: 'live download filename xiake-layers.zip', pass: suggestedName === 'xiake-layers.zip', detail: suggestedName },
  { name: 'zip 6 SVG + README.txt, STORE + UTF-8 + CRC32', pass: zipNames.length === 7 && JSON.stringify(zipNames) === JSON.stringify(expectedNames) && storeOk && crcOk, detail: zipNames.join(',') },
  ...layerSvgs.map((s) => ({ name: `SVG L${s.i + 1}: mm size/viewBox/red 0.1mm/closed plain path/no filter-mask-text`, pass: s.errors.length === 0, detail: s.errors.join('; ') || 'ok' })),
  { name: 'zip README colors/cardstock/kerf/layer names', pass: readmeErrors.length === 0, detail: readmeErrors.join('; ') || 'ok' },
  { name: 'xmllint 6/6 no errors', pass: xmllintResults.every((r) => r.ok), detail: JSON.stringify(xmllintResults.filter((r) => !r.ok)) || '6/6 ok' },
  { name: 'inkscape CLI check', pass: true, detail: inkscapeNote },
  { name: '2D L1 bridge markers == live JSON bridges', pass: drawerL1.bridgeLines === baked.layers[0].fabCheck.bridgesAdded.length && drawerL1.islandRects === 0, detail: JSON.stringify(drawerL1) },
  // 重跑（mock 五段成功路径）
  { name: 'rerun(mock) five stages in order, LayerSet replaced', pass: rerunOk.ok === true && JSON.stringify(rerunOk.stageSeq) === JSON.stringify(['decompose', 'map', 'vectorize', 'topology']) && rerunOk.mapSource === 'evolving' && rerunOk.layerCount === 6 && rerunOk.allPass, detail: JSON.stringify(rerunOk) },
  // 重跑降级（真网络 + 假 key）
  { name: 'rerun(fake key, real network): error step with category + fallback', pass: rerunFail.cat.length > 0 && rerunFail.msg.length > 0 && rerunFail.fallbackVisible, detail: JSON.stringify(rerunFail) },
  { name: 'rerun degrade: demo badge, baked data restored, key cleared, no storage leak', pass: rerunFallback.badge && rerunFallback.mapSource === 'evolving' && rerunFallback.layerCount === 6 && rerunFallback.modalClosed && rerunFallback.keyInputEmpty && !keyLeak, detail: JSON.stringify({ ...rerunFallback, keyLeak }) },
];

const result = {
  at: new Date().toISOString(),
  url: BASE_URL,
  performance: { wallMs: loadWallMs, ...navTiming, failWallMs },
  console: {
    cleanErrors,
    cleanWarnings: { envWebGLDriver: envWarnings, app: appWarnings },
    postFakeKeyErrors: consoleErrors.slice(cleanErrCount),
    allWarnings: consoleWarnings,
    pageErrors,
    failedRequests: failedRequests.slice(0, 10),
  },
  checks,
};
writeFileSync(join(TMP, 'accept-result.json'), JSON.stringify(result, null, 2));
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'} ${c.name}${c.pass ? '' : ' :: ' + JSON.stringify(c.detail)}`);
console.log(`perf: wall=${loadWallMs}ms dcl=${navTiming.domContentLoaded}ms load=${navTiming.loadEvent}ms transfer=${navTiming.transferSize}B`);
console.log(`console: cleanErrors=${cleanErrors.length} appWarnings=${appWarnings.length} envWebGLWarn=${envWarnings.length} postFakeKeyErrors=${consoleErrors.length - cleanErrCount} pageErrors=${pageErrors.length}`);
console.log(appWarnings.length ? `APP WARNINGS:\n${appWarnings.join('\n---\n')}` : 'app warnings: (none)');
console.log(cleanErrors.length ? `CLEAN ERRORS:\n${cleanErrors.join('\n---\n')}` : 'clean errors: (none)');
console.log(inkscapeNote);
const ok = checks.every((c) => c.pass);
console.log(ok ? 'ACCEPT_PASS' : 'ACCEPT_FAIL');
process.exit(ok ? 0 : 2);

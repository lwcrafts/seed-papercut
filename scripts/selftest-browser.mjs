// headless 浏览器自测（issue 13 + 14）：加载 dist/ 构建产物，验证
//   1) xiake.json 加载成功、无 console error / pageerror
//   2) 6 层挤出网格就位、z 序 L1 靠 LED（paperZ 最小）
//   3) WebGL（SwiftShader 软渲染）可用且画面非空白
//   4) 制造检查面板（票 14）：占位块已替换，面板字段与 xiake.json fabCheck 逐字段一致
//   5) 2D 切片视图：桥位黄色标记数量 == JSON bridgesAdded、缝隙 <2mm 层有 caution
// 用法：npm run build 后 node scripts/selftest-browser.mjs
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

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
];
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'} ${c.name}${c.pass ? '' : ' :: ' + JSON.stringify(c.detail)}`);
writeFileSync(
  join(REPO, '.bake', 'selftest', 'result.json'),
  JSON.stringify({ at: new Date().toISOString(), info, consoleErrors, pageErrors, checks }, null, 2),
);
const ok = checks.every((c) => c.pass);
console.log(ok ? 'SELFTEST_PASS' : 'SELFTEST_FAIL');
process.exit(ok ? 0 : 2);

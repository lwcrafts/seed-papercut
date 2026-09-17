// headless 浏览器自测（issue 13）：加载 dist/ 构建产物，验证
//   1) xiake.json 加载成功、无 console error / pageerror
//   2) 6 层挤出网格就位、z 序 L1 靠 LED（paperZ 最小）
//   3) WebGL（SwiftShader 软渲染）可用且画面非空白
//   4) fabCheck 占位块存在且不报错（面板本体是票 14）
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

await browser.close();
server.close();

const checks = [
  { name: 'no console errors', pass: consoleErrors.length === 0, detail: consoleErrors.slice(0, 3) },
  { name: 'no page errors', pass: pageErrors.length === 0, detail: pageErrors.slice(0, 3) },
  { name: 'webgl context (swiftshader)', pass: !!info.webgl, detail: info.webgl },
  { name: 'layerset has 6 layers', pass: info.layerCount === 6, detail: info.layerNames.join(',') },
  { name: '6 extruded meshes', pass: info.meshCount === 6 && info.geometryTris.every((v) => v >= 30), detail: info.geometryTris.join(',') },
  { name: 'z-order L1 nearest LED', pass: info.zSlots.length === 6 && Math.min(...info.zSlots) === info.zSlots[0] && Math.max(...info.zSlots) === info.zSlots[5], detail: info.zSlots.join(',') },
  { name: 'fab placeholder present', pass: info.fabPlaceholder, detail: 'ticket 14 会替换为真实面板' },
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

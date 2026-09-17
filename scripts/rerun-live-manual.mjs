// 票 16 手动真跑脚本：对预置场景用真实方舟 Key 现场重跑全链路（不走 CI）。
//
// 用法：
//   1) npm run build
//   2) ARK_API_KEY=xxx node scripts/rerun-live-manual.mjs
//      （或依赖仓库外 v2/.env 的 ARK_API_KEY）
//   3) 结果（各段耗时 JSON + 截图）落 .bake/selftest/live-rerun/
//
// Key 只从环境变量/文件读入并填进页面内存输入框，不打印、不写入任何产物。
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(REPO, 'dist');
const OUT = join(REPO, '.bake', 'selftest', 'live-rerun');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png' };

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('dist/index.html 不存在，先 npm run build');
  process.exit(1);
}

// key 读取顺序：环境变量 → v2/.env（仓库外）。只进内存。
let key = process.env.ARK_API_KEY?.trim();
if (!key) {
  const envPath = join(REPO, '..', '.env');
  const m = readFileSync(envPath, 'utf8').match(/^ARK_API_KEY=(.+)$/m);
  if (m) key = m[1].trim();
}
if (!key) {
  console.error('未提供 ARK_API_KEY');
  process.exit(1);
}

const server = createServer((req, res) => {
  const url = req.url.split('?')[0];
  const rel = url.startsWith('/seed-papercut/') ? url.slice('/seed-papercut'.length) : url;
  let path = join(DIST, decodeURIComponent(rel));
  if (!existsSync(path) || extname(path) === '') path = join(DIST, 'index.html');
  try {
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
    res.end(readFileSync(path));
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--disable-gpu-driver-bug-workarounds', '--use-gl=angle', '--use-angle=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const logs = [];
page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`.slice(0, 300)));
page.on('pageerror', (e) => logs.push(`pageerror: ${String(e).slice(0, 300)}`));

await page.goto(`${base}seed-papercut/`, { waitUntil: 'networkidle' });
await page.waitForFunction(
  () => document.getElementById('data-status-text')?.textContent?.includes('装配就绪'),
  null,
  { timeout: 20000 },
);

await page.click('#btn-rerun');
await page.fill('#rerun-key-input', key);
await page.click('#btn-rerun-start');

// 全链路 5–7 分钟（evolving 最长 ~9 分钟），上限 12 分钟
const outcome = await Promise.race([
  page
    .waitForSelector('#rerun-step-success:not(.hidden)', { timeout: 720_000 })
    .then(() => 'success'),
  page
    .waitForSelector('#rerun-step-error:not(.hidden)', { timeout: 720_000 })
    .then(() => 'error'),
]);

const result = await page.evaluate(() => {
  const h = window.__seedPapercut;
  return {
    outcome: !document.getElementById('rerun-step-success')?.classList.contains('hidden') ? 'success' : 'error',
    error: {
      cat: document.getElementById('rerun-error-cat')?.textContent ?? '',
      msg: document.getElementById('rerun-error-msg')?.textContent ?? '',
    },
    stageRows: [...document.querySelectorAll('#rerun-stages .stage')].map((el) => ({
      stage: el.dataset.stage,
      done: el.classList.contains('done'),
      fail: el.classList.contains('fail'),
      time: el.querySelector('.stage-time')?.textContent ?? '',
      detail: el.querySelector('.stage-detail')?.textContent ?? '',
    })),
    events: h?.rerun?.events ?? [],
    totalElapsed: document.getElementById('rerun-elapsed')?.textContent ?? '',
    totalFinal: document.getElementById('rerun-total-final')?.textContent ?? '',
    mapSource: h?.layerSet?.pipeline?.mapSource ?? '',
    pxPerMm: h?.layerSet?.pipeline?.pxPerMm ?? 0,
    layerCount: h?.layerSet?.layers.length ?? 0,
    layers: (h?.layerSet?.layers ?? []).map((l) => ({
      index: l.index,
      name: l.name,
      subpaths: l.pathD.length,
      cutLengthMm: l.fabCheck?.cutLengthMm ?? 0,
      minGapMm: l.fabCheck?.minGapMm ?? 0,
      bridges: l.fabCheck?.bridgesAdded?.length ?? 0,
      pass: l.fabCheck?.pass ?? false,
    })),
    demoBadge: !document.getElementById('demo-badge')?.classList.contains('hidden'),
  };
});
result.consoleLogs = logs.filter((l) => !l.startsWith('warning:')).slice(0, 20);

// 先落盘再截图：截图失败不允许丢耗时数据
writeFileSync(join(OUT, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, events: undefined, consoleLogs: undefined }, null, 2));

// 截图（新结果灯箱 + 制造检查面板）；模态还开着先关掉，失败不影响结果
try {
  if (result.outcome === 'success') {
    await page.click('#btn-rerun-finish', { timeout: 5000 });
  }
  await page.screenshot({ path: join(OUT, 'lightbox-after-rerun.png') });
  await page.click('.tab[data-tab="struct"]', { timeout: 5000 });
  await page.waitForTimeout(400);
  await page.locator('#fab-panel').screenshot({ path: join(OUT, 'fab-panel-after-rerun.png') });
} catch (e) {
  result.screenshotError = String(e).slice(0, 200);
  writeFileSync(join(OUT, 'result.json'), JSON.stringify(result, null, 2));
}

// Key 不落盘复核（真跑后）
result.keyLeakCheck = await page.evaluate((k) => {
  const scan = (store) => Object.keys(store).map((kk) => `${kk}=${store.getItem(kk)}`).join('|');
  const hay = `${scan(localStorage)}|${scan(sessionStorage)}|${document.cookie}`;
  return { leaked: hay.includes(k) };
}, key);

await browser.close();
server.close();

console.log(result.outcome === 'success' ? 'LIVE_RERUN_SUCCESS' : 'LIVE_RERUN_FAILED');
process.exit(result.outcome === 'success' ? 0 : 2);

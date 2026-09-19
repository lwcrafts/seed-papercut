// 蒙版语义自查（issue 12）：对 .bake/<sceneId>/masks/L1..6.png 做宽松的空间统计断言。
// 白=纸。规则来自 CONTEXT.md 六层语义（L1 天光在上、L5 主体居中偏下、L6 前景贴底），
// 阈值刻意放宽——只挡住「层映射明显错乱」的情况，不做像素级验收。
// L6 前景框景允许贴底（草丛）或贴顶（垂落树冠）两种框景形态。
//
// 用法：npm run bake:check -- xiake   （bake.mjs 结束时会自动跑一遍）
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

function maskStats(pngPath) {
  const png = PNG.sync.read(readFileSync(pngPath));
  const { width: w, height: h, data } = png;
  let white = 0;
  let topWhite = 0;    // 上部 60% 行内的白像素
  let bottomWhite = 0; // 下部 30% 行内的白像素
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    const inTop = y < h * 0.6;
    const inBottom = y >= h * 0.7;
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4] < 128) continue;
      white++;
      if (inTop) topWhite++;
      if (inBottom) bottomWhite++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const total = w * h;
  return {
    whiteRatio: white / total,
    topShare: white ? topWhite / white : 0,
    bottomShare: white ? bottomWhite / white : 0,
    bbox: white ? { cx: (minX + maxX) / 2 / w, cy: (minY + maxY) / 2 / h, w: (maxX - minX + 1) / w, h: (maxY - minY + 1) / h } : null,
  };
}

export function runMaskChecks(meta) {
  const sceneId = meta.sceneId;
  const results = [];
  const stats = {};
  for (let L = 1; L <= 6; L++) {
    const path = join(REPO, '.bake', sceneId, 'masks', `L${L}.png`);
    if (!existsSync(path)) { results.push({ layer: L, pass: false, checks: [{ name: 'exists', pass: false }] }); continue; }
    stats[L] = maskStats(path);
    const s = stats[L];
    const c = [];
    const nonEmpty = s.whiteRatio > 0.0005 && s.whiteRatio < 0.995;
    c.push({ name: 'nonEmpty', pass: nonEmpty, detail: `whiteRatio=${s.whiteRatio.toFixed(4)}` });
    if (L === 1) {
      // 天光/云/月光：白像素主体应落在画面上部（60% 行以上占多数）
      c.push({ name: 'skyInUpperHalf', pass: s.topShare > 0.6, detail: `topShare=${s.topShare.toFixed(3)}` });
    }
    if (L === 5) {
      // 视觉主体：剪影居中偏下，且面积占比合理（不是整层白也不是噪点）
      const inPlace = s.bbox && s.bbox.cx > 0.25 && s.bbox.cx < 0.9 && s.bbox.cy > 0.4 && s.bbox.cy < 0.95;
      c.push({ name: 'subjectCenteredLower', pass: inPlace, detail: s.bbox ? `cx=${s.bbox.cx.toFixed(2)} cy=${s.bbox.cy.toFixed(2)}` : 'no white' });
      c.push({ name: 'subjectAreaSane', pass: s.whiteRatio > 0.005 && s.whiteRatio < 0.4, detail: `whiteRatio=${s.whiteRatio.toFixed(4)}` });
    }
    if (L === 6) {
      // 前景框景：白像素主体应贴画面外缘——底部（水岸草丛）或顶部（垂落树冠）均可
      const framesEdge = s.bottomShare > 0.5 || s.topShare > 0.5;
      c.push({ name: 'foregroundFramesEdge', pass: framesEdge, detail: `topShare=${s.topShare.toFixed(3)} bottomShare=${s.bottomShare.toFixed(3)}` });
    }
    results.push({ layer: L, pass: c.every((x) => x.pass), checks: c });
  }
  return { sceneId, checkedAt: new Date().toISOString(), pass: results.every((r) => r.pass), results };
}

// standalone: node scripts/check-masks.mjs <sceneId>
if (process.argv[1] && process.argv[1].endsWith('check-masks.mjs')) {
  const sceneId = process.argv[2];
  const metaPath = join(REPO, '.bake', sceneId ?? '', 'bake-meta.json');
  if (!sceneId || !existsSync(metaPath)) {
    console.error(`usage: npm run bake:check -- <sceneId>  (需要 ${metaPath})`);
    process.exit(1);
  }
  const checks = runMaskChecks(JSON.parse(readFileSync(metaPath, 'utf8')));
  console.log(JSON.stringify(checks, null, 2));
  process.exit(checks.pass ? 0 : 2);
}

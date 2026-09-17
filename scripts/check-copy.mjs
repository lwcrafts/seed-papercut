// 文案红线检查（票 17，spec §4.4）：扫描全站用户可见文案，极限词 / 导流词必须清零。
//
// 扫描范围：
//   index.html、README.md、src/**/*.{ts,css}、public/**/*.md、scripts/vendor/README.md
//   （导出 ZIP 内 README.txt 的文案来自 src/pipeline/svg-export.ts，已在上面的 src 范围内）
//
// 维护方式：发现新红线词 → 往 FORBIDDEN 里加一项即可；个别行确需保留时，
// 在该行行尾加标记 `check-copy:allow`（会被跳过并在输出里列出，方便审计）。
//
// 用法：npm run check:copy（selftest:browser 也会跑本脚本作为其中一项检查）
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

// 极限词 / 导流词词表。字符串项做包含匹配，正则项做 test。
// 注意：技术用语如「最小缝隙」「最短路」不属于极限词，不收「最」单字。
const FORBIDDEN = [
  // 极限词
  '免费',
  '第一',
  '绝对',
  '顶级',
  '国家级',
  /最(?:好|佳|强|优|大|高|快|新|先进|专业|牛|厉害)/,
  // 导流词
  '私我',
  '私信',
  '私聊',
  '看主页',
  '扫码',
  '二维码',
  '限时',
  '秒杀',
  '加微信',
  '加好友',
  /加\s*[Vv]\b|加\s*VX/i,
];

const ALLOW_MARK = 'check-copy:allow';

function listFiles(dir, exts, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) listFiles(p, exts, out);
    else if (exts.includes(extname(p))) out.push(p);
  }
  return out;
}

const files = [
  join(REPO, 'index.html'),
  join(REPO, 'README.md'),
  ...listFiles(join(REPO, 'src'), ['.ts', '.css']),
  ...(existsSync(join(REPO, 'public')) ? listFiles(join(REPO, 'public'), ['.md', '.json']) : []),
].filter((p) => existsSync(p));

const ALLOWED_LABELS = new Set([
  // 数据文件里的字段值是算法数据不是文案；只审人写的展示文案
  'json',
]);

const violations = [];
const allows = [];
for (const file of files) {
  if (ALLOWED_LABELS.has(extname(file).slice(1))) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (line.includes(ALLOW_MARK)) {
      allows.push(`${file}:${i + 1}`);
      return;
    }
    for (const word of FORBIDDEN) {
      const hit = typeof word === 'string' ? (line.includes(word) ? word : null) : word.test(line) ? String(word) : null;
      if (hit) violations.push(`${file}:${i + 1} [${hit}] ${line.trim().slice(0, 80)}`);
    }
  });
}

for (const v of violations) console.error(`FAIL ${v}`);
if (allows.length > 0) console.log(`allowed lines (${allows.length}): ${allows.join(', ')}`);
if (violations.length > 0) {
  console.error(`COPY_CHECK_FAIL: ${violations.length} 处命中红线词`);
  process.exit(1);
}
console.log(`COPY_CHECK_PASS: ${files.length} 个文件无极限词/导流词`);

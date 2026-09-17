/**
 * SVG / ZIP 导出（票 15）
 *
 * 规范依据 research/browser-imaging-laser-svg.md（LightBurn 口径）：
 * - 物理尺寸：width/height 用 mm 制，viewBox 与 pathD 坐标系一致（ LightBurn 按 1:1 尺寸导入）
 * - 切割线 = stroke 路径（Line 模式走刀），红 #FF0000、0.1mm；不做填充
 * - pathD 本身是 evenodd 单条 d（外轮廓含镂空子路径），stroke 线模式下镂空子路径
 *   即切割内轮廓，无需 fill-rule
 * - 朴素 path，无 mask / filter / text；kerf 不烤进几何（切割软件端 Kerf Offset 补偿）
 * - 当前烘焙数据没有刻痕线（蓝色路径），故不输出蓝色层；README 中说明
 */

import { parseViewBox, type Layer, type LayerSet } from '../types';

/** 切割线物理线宽（mm），LightBurn / RDWorks / xTool 社区通行口径 */
export const CUT_STROKE_MM = 0.1;

/** viewBox 用户单位 / mm（横向），用于把 0.1mm 线宽换算进 path 坐标系 */
function pxPerMm(set: LayerSet): number {
  const vb = parseViewBox(set.viewBox);
  if (set.sizeMm.width > 0) return vb.width / set.sizeMm.width;
  if (set.pipeline && set.pipeline.pxPerMm > 0) return set.pipeline.pxPerMm;
  return 1;
}

function fmtNum(n: number): string {
  // 4 位小数足够（0.1mm @ 11.84px/mm = 1.184），去掉尾零
  return String(Number(n.toFixed(4)));
}

/** 单层切割 SVG：物理 mm 尺寸 + 与 pathD 一致的 viewBox + 红色 0.1mm stroke 闭合 path */
export function buildLayerSvg(set: LayerSet, layer: Layer): string {
  const vb = parseViewBox(set.viewBox);
  const strokeUnits = CUT_STROKE_MM * pxPerMm(set);
  const d = layer.pathD.join(' ');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `width="${fmtNum(set.sizeMm.width)}mm" height="${fmtNum(set.sizeMm.height)}mm" ` +
    `viewBox="${vb.minX} ${vb.minY} ${vb.width} ${vb.height}">\n` +
    `<path d="${d}" fill="none" stroke="#FF0000" stroke-width="${fmtNum(strokeUnits)}" ` +
    `stroke-linejoin="round" stroke-linecap="round"/>\n` +
    `</svg>\n`
  );
}

/** ZIP 内 README.txt：颜色约定、层清单与装灯位置、板材与 kerf 说明 */
export function buildReadme(set: LayerSet): string {
  const lines: string[] = [];
  lines.push(`${set.sceneId} 纸雕光影灯 · 分层切割图纸`);
  lines.push('='.repeat(36));
  lines.push('');
  lines.push('【颜色约定】');
  lines.push('红色 (#FF0000) 线 = 切割线，线宽 0.1mm，走 Line（切割）模式切透。');
  lines.push('蓝色 (#0000FF) 线 = 刻痕线（浅雕折线/细节线）。');
  lines.push('注意：本包当前版本只含红色切割线，没有蓝色刻痕线（当前场景数据未生成刻痕层），');
  lines.push('如切割软件中出现蓝色图层可直接忽略或删除。');
  lines.push('');
  lines.push('【尺寸与板材】');
  lines.push(`成品物理尺寸：${fmtNum(set.sizeMm.width)}mm x ${fmtNum(set.sizeMm.height)}mm（与 SVG 内声明一致）。`);
  lines.push('建议卡纸：250-300g（过薄易卷曲，过厚细缝切不透）。');
  lines.push('kerf（激光切缝宽度）补偿不烤进本图纸：请在切割软件端（如 LightBurn 的 Kerf Offset）按机器实际 kerf 自行补偿。');
  lines.push('');
  lines.push('【层数与装灯位置】');
  lines.push(`共 ${set.layers.length} 层，层号越小越靠近 LED 光源，越大越靠近观者：`);
  for (const layer of set.layers) {
    const pos =
      layer.index === 1
        ? '最靠 LED 光源（底）'
        : layer.index === set.layers.length
          ? '最靠观者（面）'
          : '中间层';
    lines.push(`  xiake-L${layer.index}.svg — L${layer.index} ${layer.name}（${pos}，层距 ${fmtNum(layer.depth * 100)}mm）`);
  }
  lines.push('');
  lines.push('【装配顺序】');
  lines.push('从 LED 侧到面板依次叠放 L1 → L6，层间用遮光垫条隔开，最外侧加亚克力面板与外框。');
  lines.push('');
  return lines.join('\n');
}

/* ---------------- 零依赖 STORE ZIP（无压缩 + CRC32，PKWARE APPNOTE 口径） ---------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  /** 文本内容，UTF-8 编码写入 */
  text: string;
}

/** 打包 STORE ZIP：不压缩（SVG 小文本无收益）、UTF-8 文件名（置 GP bit 11），零依赖。 */
export function buildStoreZip(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = enc.encode(entry.name);
    const data = enc.encode(entry.text);
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // flags: UTF-8 name
    lv.setUint16(8, 0, true); // method: STORE
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true); // extra len
    local.set(name, 30);
    locals.push(local, data);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true); // extra
    cv.setUint16(32, 0, true); // comment
    cv.setUint16(34, 0, true); // disk start
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, offset, true); // local header offset
    central.set(name, 46);
    centrals.push(central);

    offset += local.length + data.length;
  }

  const cdSize = centrals.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true); // cd offset
  ev.setUint16(20, 0, true);

  const total = offset + cdSize + 22;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}

/** 组装整包条目：<sceneId>-L1..N.svg + README.txt */
export function buildZipEntries(set: LayerSet): ZipEntry[] {
  const entries: ZipEntry[] = set.layers.map((layer) => ({
    name: `${set.sceneId}-L${layer.index}.svg`,
    text: buildLayerSvg(set, layer),
  }));
  entries.push({ name: 'README.txt', text: buildReadme(set) });
  return entries;
}

/* ---------------- 导出前数字自检（浏览器内断言） ---------------- */

export interface ExportIssue {
  /** 关联层号（1-based），整体问题时为 0 */
  layerIndex: number;
  message: string;
}

/**
 * 导出前断言（票 15 验收项）：
 * 1. SVG 声明物理尺寸 == LayerSet.sizeMm
 * 2. 所有子路径闭合（M 与 Z 数量一致且 d 以 Z 收尾）
 * 3. 无 <mask>/<filter>/<text> 元素（含属性写法）
 * 4. SVG 可被 DOMParser 解析且 path 数 > 0
 * 任一不过 → 禁用导出按钮并提示。
 */
export function validateLayerSetExport(set: LayerSet): ExportIssue[] {
  const issues: ExportIssue[] = [];
  for (const layer of set.layers) {
    const svg = buildLayerSvg(set, layer);
    const d = layer.pathD.join(' ');
    const mCount = (d.match(/M/g) ?? []).length;
    const zCount = (d.match(/Z/g) ?? []).length;
    if (mCount === 0 || mCount !== zCount || !/Z\s*$/.test(d)) {
      issues.push({ layerIndex: layer.index, message: `L${layer.index} 存在未闭合子路径（M=${mCount} Z=${zCount}）` });
    }
    if (/<mask|<filter|<text|[\s"']mask=|[\s"']filter=/i.test(svg)) {
      issues.push({ layerIndex: layer.index, message: `L${layer.index} SVG 含 mask/filter/text 等不兼容元素` });
    }
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    if (doc.querySelector('parsererror')) {
      issues.push({ layerIndex: layer.index, message: `L${layer.index} SVG 无法被 DOMParser 解析` });
      continue;
    }
    const root = doc.documentElement;
    const wOk = root.getAttribute('width') === `${fmtNum(set.sizeMm.width)}mm`;
    const hOk = root.getAttribute('height') === `${fmtNum(set.sizeMm.height)}mm`;
    const vb = parseViewBox(set.viewBox);
    const vbOk = root.getAttribute('viewBox') === `${vb.minX} ${vb.minY} ${vb.width} ${vb.height}`;
    if (!wOk || !hOk || !vbOk) {
      issues.push({ layerIndex: layer.index, message: `L${layer.index} SVG 声明尺寸/viewBox 与 LayerSet 不一致` });
    }
    const pathCount = doc.querySelectorAll('path').length;
    if (pathCount === 0 || !doc.querySelector('path')?.getAttribute('d')) {
      issues.push({ layerIndex: layer.index, message: `L${layer.index} SVG 无有效 path` });
    }
  }
  if (set.layers.length === 0) {
    issues.push({ layerIndex: 0, message: 'LayerSet 无图层' });
  }
  return issues;
}

/** 触发浏览器下载（blob → a[download]），返回文件名便于提示 */
export function downloadBytes(filename: string, bytes: Uint8Array, mime = 'application/zip'): string {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const blob = new Blob([buffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
  return filename;
}

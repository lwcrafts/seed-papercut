import * as THREE from 'three';
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js';
import type { ViewBox } from '../types';

const loader = new SVGLoader();

/**
 * Collapse near-duplicate and collinear points from a traced contour.
 * imagetracer output contains stair-step collinear runs and healed-pinch
 * artifacts; leaving them in place makes earcut triangulation produce
 * overlapping cap triangles that render as full opaque sheets.
 */
function pruneContour(points: THREE.Vector2[], eps = 0.35): THREE.Vector2[] {
  const deduped: THREE.Vector2[] = [];
  for (const p of points) {
    const last = deduped[deduped.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < eps) continue;
    deduped.push(p.clone());
  }
  // 闭环首尾重复点必须去掉，否则共线判定会误删真实角点
  if (deduped.length > 1) {
    const first = deduped[0];
    const last = deduped[deduped.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) < eps) deduped.pop();
  }
  const result: THREE.Vector2[] = [];
  const n = deduped.length;
  for (let i = 0; i < n; i++) {
    const prev = deduped[(i - 1 + n) % n];
    const cur = deduped[i];
    const next = deduped[(i + 1) % n];
    const cross = (cur.x - prev.x) * (next.y - prev.y) - (cur.y - prev.y) * (next.x - prev.x);
    const chord = Math.hypot(next.x - prev.x, next.y - prev.y) || 1;
    if (Math.abs(cross) / chord < eps) continue;
    result.push(cur);
  }
  if (result.length > 1) {
    const first = result[0];
    const last = result[result.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) < eps) result.pop();
  }
  return result.length >= 3 ? result : points;
}

/**
 * Build a 1 mm extruded paper geometry from SVG path `d` string(s).
 * Uses the evenodd fill rule (outer sheet contour + cutouts); arrays are
 * joined into a single path so holes / islands-in-holes resolve correctly.
 *
 * Caps are triangulated directly with ShapeUtils (earcut) instead of
 * ExtrudeGeometry: traced contours contain collinear runs and the generic
 * extrusion pipeline can emit overlapping cap triangles for them.
 */
export function buildPaperGeometry(pathD: string | string[], viewBox: ViewBox): THREE.BufferGeometry {
  const d = Array.isArray(pathD) ? pathD.join(' ') : pathD;
  const svgText =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox.minX} ${viewBox.minY} ${viewBox.width} ${viewBox.height}">` +
    `<path fill="#ffffff" fill-rule="evenodd" stroke="none" d="${d}" /></svg>`;

  const svgData = loader.parse(svgText);
  const rawShapes: THREE.Shape[] = [];

  for (const path of svgData.paths) {
    path.userData = path.userData ?? {};
    path.userData.style = path.userData.style ?? {};
    path.userData.style.fillRule = 'evenodd';
    rawShapes.push(...SVGLoader.createShapes(path));
  }

  if (rawShapes.length === 0) {
    throw new Error('SVG path produced no shapes');
  }

  // Drop a stand-alone full-frame solid sheet (no holes) so it cannot block
  // the backlight; the real contour carries its cutouts as evenodd holes.
  const { minX, minY, width, height } = viewBox;
  const maxX = minX + width;
  const maxY = minY + height;
  const filtered = rawShapes.filter((shape) => {
    if (rawShapes.length <= 1 || shape.holes.length > 0) return true;
    const pts = shape.getPoints();
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const p of pts) {
      x0 = Math.min(x0, p.x);
      x1 = Math.max(x1, p.x);
      y0 = Math.min(y0, p.y);
      y1 = Math.max(y1, p.y);
    }
    const coversCanvas = x0 <= minX + 5 && x1 >= maxX - 5 && y0 <= minY + 5 && y1 >= maxY - 5;
    return !coversCanvas;
  });
  const usable = filtered.length > 0 ? filtered : rawShapes;

  const positions: number[] = [];
  const indices: number[] = [];
  const depth = 1;
  const half = depth / 2;
  let vertexCount = 0;

  for (const shape of usable) {
    const extracted = shape.extractPoints(12);
    const contour = pruneContour(extracted.shape);
    if (contour.length < 3) continue;
    const holes = extracted.holes
      .map((hole) => pruneContour(hole))
      .filter((hole) => hole.length >= 3);

    let faces: number[][];
    try {
      faces = THREE.ShapeUtils.triangulateShape(contour, holes);
    } catch {
      continue;
    }
    if (faces.length === 0) continue;

    const rings = [contour, ...holes];
    const ringStarts = rings.map((ring) => {
      const start = vertexCount;
      for (const p of ring) {
        positions.push(p.x, p.y, half, p.x, p.y, -half);
        vertexCount += 2;
      }
      return start;
    });

    // 前后盖板（earcut 索引基于 contour+holes 顺序）
    for (const f of faces) {
      const a = f[0] * 2;
      const b = f[1] * 2;
      const c = f[2] * 2;
      indices.push(a, b, c); // front (+z)
      indices.push(a + 1, c + 1, b + 1); // back (-z)
    }

    // 侧壁：沿每条闭合环连接前后两圈
    for (const start of ringStarts) {
      const count = (start === ringStarts[0] ? contour.length : rings[ringStarts.indexOf(start)].length);
      for (let i = 0; i < count; i++) {
        const j = (i + 1) % count;
        const aF = start + i * 2;
        const bF = start + j * 2;
        const aB = aF + 1;
        const bB = bF + 1;
        indices.push(aF, aB, bB, aF, bB, bF);
      }
    }
  }

  if (indices.length === 0) {
    throw new Error('SVG path produced no triangles');
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);

  // SVG y grows downward; centre the sheet on the origin and flip Y.
  geometry.translate(-width / 2, -height / 2, 0);
  geometry.scale(1, -1, 1);

  // Flip triangle winding so the lit front faces point toward +Z.
  const index = geometry.getIndex();
  if (index) {
    const arr = index.array;
    for (let i = 0; i < arr.length; i += 3) {
      const tmp = arr[i + 1];
      arr[i + 1] = arr[i + 2];
      arr[i + 2] = tmp;
    }
    index.needsUpdate = true;
  }
  geometry.computeVertexNormals();
  return geometry;
}

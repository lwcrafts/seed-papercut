import * as THREE from 'three';
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js';
import type { ViewBox } from '../types';

const loader = new SVGLoader();

/**
 * Build a 1 mm extruded paper geometry from an SVG path `d` string.
 * The path uses the evenodd fill rule (outer sheet contour + cutouts).
 */
export function buildPaperGeometry(pathD: string, viewBox: ViewBox): THREE.BufferGeometry {
  const svgText =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox.minX} ${viewBox.minY} ${viewBox.width} ${viewBox.height}">` +
    `<path fill="#ffffff" fill-rule="evenodd" stroke="none" d="${pathD}" /></svg>`;

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
  const shapes = filtered.length > 0 ? filtered : rawShapes;

  const geometry = new THREE.ExtrudeGeometry(shapes, {
    depth: 1.0,
    bevelEnabled: true,
    bevelSegments: 1,
    steps: 1,
    bevelSize: 0.25,
    bevelThickness: 0.25,
    curveSegments: 16,
  });

  // SVG y grows downward; centre the sheet on the origin and flip Y.
  geometry.translate(-width / 2, -height / 2, -0.5);
  geometry.scale(1, -1, 1);

  // Flip triangle winding so the lit front faces point toward +Z.
  if (geometry.index) {
    const arr = geometry.index.array;
    for (let i = 0; i < arr.length; i += 3) {
      const tmp = arr[i + 1];
      arr[i + 1] = arr[i + 2];
      arr[i + 2] = tmp;
    }
  }
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * LayerSet JSON schema (draft v0)
 *
 * A LayerSet is the data contract between the segmentation/vectorization
 * pipeline (VLM layering + local geometry algorithms) and the 3D previewer.
 *
 * The pipeline produces one LayerSet per source image. Preview and
 * fabrication code must only depend on the fields declared here.
 */

/** SVG viewBox tuple, e.g. "0 0 800 600" -> { minX: 0, minY: 0, width: 800, height: 600 }. */
export interface ViewBox {
  minX: number;
  minY: number;
  width: number;
  height: number;
}

/**
 * Fabrication check result for a single layer.
 *
 * The topology / manufacturability algorithms are not wired in yet
 * (see issue 09). Baked example fixtures therefore set every field to
 * `null` — never a hard-coded PASS. The UI renders a disabled
 * "制造检查（算法接入中）" block until real values arrive.
 */
export interface FabCheck {
  /** Number of disconnected islands detected inside the layer silhouette. */
  islands: number | null;
  /** Number of support bridges added/required to anchor floating islands. */
  bridgesAdded: number | null;
  /** Total laser-cut path length in millimetres. */
  cutLengthMm: number | null;
  /** Whether every cut path forms a closed contour. */
  closed: boolean | null;
  /** Whether the contour intersects itself. */
  selfIntersecting: boolean | null;
  /** Overall manufacturability verdict. `null` until the algorithm runs. */
  pass: boolean | null;
}

export interface Layer {
  /** 1-based layer index, front (1) to back (n). */
  index: number;
  /** Human-readable layer name. */
  name: string;
  /** Normalised depth position in [0, 1]; 0 = front, 1 = back light plate. */
  depth: number;
  /** Description of what the layer depicts / its structural role. */
  description: string;
  /** SVG path `d` attribute, in viewBox coordinates, using evenodd fill rule. */
  pathD: string;
  /** Fabrication/topology check result for this layer (null until computed). */
  fabCheck: FabCheck;
}

export interface LayerSet {
  /** Stable scene id, e.g. "example-horse-rider". */
  sceneId: string;
  /** Path (relative to site root or in public/scenes) of the source image; "" when absent. */
  sourceImage: string;
  /** SVG viewBox string as serialized in JSON, e.g. "0 0 800 600". */
  viewBox: string;
  layers: Layer[];
}

/** Parse the viewBox string into numeric parts. Falls back to 800x600. */
export function parseViewBox(viewBox: string): ViewBox {
  const parts = viewBox.trim().split(/[\s,]+/).map(Number);
  if (parts.length === 4 && parts.every((n) => Number.isFinite(n)) && parts[2] > 0 && parts[3] > 0) {
    return { minX: parts[0], minY: parts[1], width: parts[2], height: parts[3] };
  }
  return { minX: 0, minY: 0, width: 800, height: 600 };
}

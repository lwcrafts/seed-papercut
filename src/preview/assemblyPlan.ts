/**
 * Z-axis assembly coordinates for the stacked shadow box.
 * Front is +Z, back is -Z. Positions are derived from the layer count so
 * non-five-layer sets also assemble sensibly.
 */
export interface AssemblyPlan {
  layerCount: number;
  paperZ: number[];
  spacerZ: number[];
  ledZ: number;
  backplateZ: number;
  frameZ: number;
  glassZ: number;
  paperExplodedZ: number[];
  spacerExplodedZ: number[];
  ledExplodedZ: number;
  backplateExplodedZ: number;
  frameExplodedZ: number;
  glassExplodedZ: number;
}

const LAYER_PITCH = 10;
const EXPLODE_PITCH = 75;

export function buildAssemblyPlan(layerCount: number): AssemblyPlan {
  const n = Math.max(1, layerCount);

  const paperZ: number[] = [];
  const spacerZ: number[] = [];
  const paperExplodedZ: number[] = [];
  const spacerExplodedZ: number[] = [];

  for (let i = 0; i < n; i++) {
    paperZ.push(20 - i * LAYER_PITCH);
    spacerZ.push(20 - i * LAYER_PITCH - 5);
    paperExplodedZ.push(160 - i * EXPLODE_PITCH);
    spacerExplodedZ.push(160 - i * EXPLODE_PITCH - 35);
  }

  const lastPaper = paperZ[n - 1];
  const lastPaperExploded = paperExplodedZ[n - 1];

  return {
    layerCount: n,
    paperZ,
    spacerZ,
    ledZ: lastPaper - 9,
    backplateZ: lastPaper - 13,
    frameZ: paperZ[0] - 5,
    glassZ: paperZ[0] + 8,
    paperExplodedZ,
    spacerExplodedZ,
    ledExplodedZ: lastPaperExploded - 80,
    backplateExplodedZ: lastPaperExploded - 120,
    frameExplodedZ: paperExplodedZ[0] + 80,
    glassExplodedZ: paperExplodedZ[0] + 160,
  };
}

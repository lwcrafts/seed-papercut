import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { parseViewBox, type Layer, type LayerSet } from '../types';
import { buildAssemblyPlan, type AssemblyPlan } from './assemblyPlan';
import { buildPaperGeometry } from './paperGeometry';

export type CameraViewName = 'front' | 'perspective' | 'side' | 'top';
export type StructurePart = 'frame' | 'paper' | 'spacers' | 'backplate';

export interface LightboxSettings {
  intensity: number;
  color: string;
  bgColor: string;
  darkRoom: boolean;
  translucent: boolean;
}

interface LayerTheme {
  darkBase: number;
  darkEmissiveMult: number;
  lightBase: number;
}

// Front layers read as deep silhouettes; back layers transmit warm light.
// Index = distance from viewer (0 = L6 观者侧 … 5 = L1 LED 侧最亮)。
const LAYER_THEMES: LayerTheme[] = [
  { darkBase: 0x3d281e, darkEmissiveMult: 0.18, lightBase: 0xf5f2eb }, // L6 观者侧 (原 0.05)
  { darkBase: 0x613f2d, darkEmissiveMult: 0.32, lightBase: 0xf8f5ee }, // L5 主体层 (原 0.16)
  { darkBase: 0x8a5938, darkEmissiveMult: 0.48, lightBase: 0xfbf8f2 }, // L4 (原 0.35)
  { darkBase: 0xc68542, darkEmissiveMult: 0.75, lightBase: 0xfdfaf5 }, // L3
  { darkBase: 0xf6c56b, darkEmissiveMult: 1.15, lightBase: 0xfffdfa }, // L2
  { darkBase: 0xfada8f, darkEmissiveMult: 1.35, lightBase: 0xfffdfb }, // L1 LED 侧
];

function themeFor(index: number, total: number): LayerTheme {
  return (
    LAYER_THEMES[index] ?? {
      darkBase: 0x332219,
      darkEmissiveMult: 0.2 + (index / Math.max(1, total)) * 0.7,
      lightBase: 0xfcfbf7,
    }
  );
}

function createWalnutTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#2b1b11';
  ctx.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 600; i++) {
    const y = Math.random() * 512;
    const h = Math.random() * 4 + 1;
    const alpha = Math.random() * 0.12 + 0.02;
    ctx.fillStyle = Math.random() > 0.5 ? `rgba(60,38,24,${alpha})` : `rgba(20,12,7,${alpha})`;
    ctx.fillRect(0, y, 512, h);
  }
  ctx.strokeStyle = 'rgba(15,9,5,0.08)';
  ctx.lineWidth = 3;
  for (let i = 0; i < 12; i++) {
    ctx.beginPath();
    ctx.moveTo(0, i * 45 + Math.random() * 20);
    ctx.bezierCurveTo(170, i * 45 + 30, 340, i * 45 - 20, 512, i * 45 + 10);
    ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(2, 2);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Physical shadow-box preview: walnut frame, acrylic panel, EVA spacers,
 * extruded paper layers, LED bead array and a multi-light backlight rig.
 */
export class LightboxScene {
  private readonly container: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;

  private enclosure: THREE.Group | null = null;
  private paperGroup = new THREE.Group();

  private frame: THREE.Mesh | null = null;
  private glass: THREE.Mesh | null = null;
  private spacers: THREE.Mesh[] = [];
  private backplate: THREE.Mesh | null = null;
  private ledGroup: THREE.Group | null = null;
  private ledBeads: THREE.Mesh[] = [];
  private rectLight: THREE.RectAreaLight | null = null;
  private keyLight: THREE.PointLight | null = null;
  private fillLights: THREE.PointLight[] = [];
  private ambient: THREE.AmbientLight;
  private dirFill: THREE.DirectionalLight;

  private paperMeshes: THREE.Mesh[] = [];
  private layers: Layer[] = [];
  private plan: AssemblyPlan = buildAssemblyPlan(5);
  private sheetWidth = 800;
  private sheetHeight = 600;

  private explode = 0;
  private slotTweens: { mesh: THREE.Mesh, startZ: number, targetZ: number, startTime: number }[] = [];
  private soloIndex: number | null = null;
  private visibility: Record<StructurePart, boolean> = {
    frame: true,
    paper: true,
    spacers: true,
    backplate: true,
  };
  private settings: LightboxSettings = {
    intensity: 2.2,
    color: '#FFE0B2',
    bgColor: '#05070d',
    darkRoom: true,
    translucent: true,
  };

  private raf = 0;
  private readonly resizeObserver: ResizeObserver;

  constructor(container: HTMLElement) {
    this.container = container;
    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;

    this.scene = new THREE.Scene();
    this.scene.background = null;

    this.camera = new THREE.PerspectiveCamera(42, width / height, 1, 5000);
    this.camera.position.set(450, 250, 800);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    RectAreaLightUniformsLib.init();

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.maxDistance = 3600;
    this.controls.minDistance = 120;
    this.controls.maxPolarAngle = Math.PI / 2 + 0.12;
    this.controls.target.set(0, 0, 0);

    this.ambient = new THREE.AmbientLight(0xffffff, 0.06);
    this.scene.add(this.ambient);

    this.dirFill = new THREE.DirectionalLight(0xffffff, 0.18);
    this.dirFill.position.set(180, 360, 500);
    this.dirFill.castShadow = true;
    this.dirFill.shadow.mapSize.set(2048, 2048);
    this.dirFill.shadow.camera.near = 50;
    this.dirFill.shadow.camera.far = 1400;
    this.dirFill.shadow.camera.left = -450;
    this.dirFill.shadow.camera.right = 450;
    this.dirFill.shadow.camera.top = 350;
    this.dirFill.shadow.camera.bottom = -350;
    this.dirFill.shadow.bias = -0.0004;
    this.dirFill.shadow.radius = 2.0;
    this.scene.add(this.dirFill);

    this.scene.add(this.paperGroup);

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(container);

    this.animate();
  }

  loadLayerSet(set: LayerSet): void {
    this.layers = set.layers;
    this.plan = buildAssemblyPlan(set.layers.length);
    const vb = parseViewBox(set.viewBox);
    this.sheetWidth = vb.width;
    this.sheetHeight = vb.height;

    this.buildEnclosure();
    this.buildPaperLayers(set);
    this.applyExplode(this.explode);
    this.applyVisibility();
    this.updateMaterials();
  }

  private buildEnclosure(): void {
    if (this.enclosure) {
      this.scene.remove(this.enclosure);
      this.enclosure.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
        }
      });
    }
    this.spacers = [];
    this.ledBeads = [];
    this.fillLights = [];

    const W = this.sheetWidth;
    const H = this.sheetHeight;
    const group = new THREE.Group();
    const p = this.plan;

    // Wooden outer frame: sheet + 60 mm outer, aperture overlaps the sheet by 10 mm.
    const fw = (W + 60) / 2;
    const fh = (H + 60) / 2;
    const frameShape = new THREE.Shape();
    frameShape.moveTo(-fw, -fh);
    frameShape.lineTo(fw, -fh);
    frameShape.lineTo(fw, fh);
    frameShape.lineTo(-fw, fh);
    frameShape.closePath();
    const iw = (W - 20) / 2;
    const ih = (H - 20) / 2;
    const innerHole = new THREE.Path();
    innerHole.moveTo(-iw, -ih);
    innerHole.lineTo(iw, -ih);
    innerHole.lineTo(iw, ih);
    innerHole.lineTo(-iw, ih);
    innerHole.closePath();
    frameShape.holes.push(innerHole);

    const frameGeo = new THREE.ExtrudeGeometry(frameShape, {
      depth: 95,
      bevelEnabled: true,
      bevelThickness: 6,
      bevelSize: 6,
      bevelSegments: 3,
    });
    frameGeo.translate(0, 0, -47.5);
    this.frame = new THREE.Mesh(
      frameGeo,
      new THREE.MeshStandardMaterial({
        color: 0x3d271d,
        map: createWalnutTexture(),
        roughness: 0.6,
        metalness: 0.05,
      }),
    );
    this.frame.castShadow = true;
    this.frame.receiveShadow = true;
    this.frame.position.z = p.frameZ;
    group.add(this.frame);

    // Acrylic front panel.
    this.glass = new THREE.Mesh(
      new THREE.BoxGeometry(W, H, 2.5),
      new THREE.MeshPhysicalMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.18,
        roughness: 0.06,
        metalness: 0.1,
        clearcoat: 1.0,
        clearcoatRoughness: 0.05,
      }),
    );
    this.glass.position.z = p.glassZ;
    group.add(this.glass);

    // EVA light-blocking spacer rims (20 mm rim, 4 mm thick).
    const spacerShape = new THREE.Shape();
    spacerShape.moveTo(-W / 2, -H / 2);
    spacerShape.lineTo(W / 2, -H / 2);
    spacerShape.lineTo(W / 2, H / 2);
    spacerShape.lineTo(-W / 2, H / 2);
    spacerShape.closePath();
    const spacerHole = new THREE.Path();
    spacerHole.moveTo(-(W / 2 - 20), -(H / 2 - 20));
    spacerHole.lineTo(W / 2 - 20, -(H / 2 - 20));
    spacerHole.lineTo(W / 2 - 20, H / 2 - 20);
    spacerHole.lineTo(-(W / 2 - 20), H / 2 - 20);
    spacerHole.closePath();
    spacerShape.holes.push(spacerHole);
    const spacerGeo = new THREE.ExtrudeGeometry(spacerShape, { depth: 4, bevelEnabled: false });
    spacerGeo.translate(0, 0, -2);
    const spacerMat = new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.95, metalness: 0.05 });
    for (let i = 0; i < this.plan.layerCount; i++) {
      const spacer = new THREE.Mesh(spacerGeo, spacerMat);
      spacer.castShadow = true;
      spacer.receiveShadow = true;
      spacer.position.z = p.spacerZ[i];
      group.add(spacer);
      this.spacers.push(spacer);
    }

    // Back cover plate.
    this.backplate = new THREE.Mesh(
      new THREE.BoxGeometry(W + 20, H + 20, 4),
      new THREE.MeshStandardMaterial({ color: 0x1a1918, roughness: 0.85, metalness: 0.1 }),
    );
    this.backplate.receiveShadow = true;
    this.backplate.position.z = p.backplateZ;
    group.add(this.backplate);

    // LED bead array: perimeter loop plus a centre booster cluster.
    this.ledGroup = new THREE.Group();
    const beadGeo = new THREE.BoxGeometry(8, 8, 2.5);
    const beadMat = new THREE.MeshStandardMaterial({
      color: 0xfff0d0,
      emissive: new THREE.Color(this.settings.color),
      emissiveIntensity: 3.5,
      roughness: 0.2,
    });
    const xEdge = W / 2 - 40;
    const yEdge = H / 2 - 40;
    for (let x = -xEdge; x <= xEdge; x += 60) {
      for (const y of [yEdge, -yEdge]) {
        const bead = new THREE.Mesh(beadGeo, beadMat);
        bead.position.set(x, y, 0);
        this.ledGroup.add(bead);
        this.ledBeads.push(bead);
      }
    }
    for (let y = -yEdge + 60; y <= yEdge - 60; y += 60) {
      for (const x of [-xEdge, xEdge]) {
        const bead = new THREE.Mesh(beadGeo, beadMat);
        bead.position.set(x, y, 0);
        this.ledGroup.add(bead);
        this.ledBeads.push(bead);
      }
    }
    for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 4) {
      const bead = new THREE.Mesh(beadGeo, beadMat);
      bead.position.set(Math.cos(angle) * 70, H * 0.067 + Math.sin(angle) * 70, 0);
      this.ledGroup.add(bead);
      this.ledBeads.push(bead);
    }
    this.ledGroup.position.z = p.ledZ;
    group.add(this.ledGroup);

    // Backlight rig: area light for diffuse glow, key point light casting
    // shadows through the cut-outs, and two side fill lights.
    this.rectLight = new THREE.RectAreaLight(new THREE.Color(this.settings.color), 6, W - 60, H - 60);
    this.rectLight.position.set(0, 0, p.ledZ + 3);
    group.add(this.rectLight);

    this.keyLight = new THREE.PointLight(new THREE.Color(this.settings.color), 14, 1800, 1.4);
    this.keyLight.position.set(0, H * 0.067, p.ledZ + 8);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    this.keyLight.shadow.bias = -0.0006;
    this.keyLight.shadow.radius = 2.4;
    group.add(this.keyLight);

    for (const sx of [-1, 1]) {
      const fill = new THREE.PointLight(new THREE.Color(this.settings.color), 5, 1400, 1.4);
      fill.position.set(sx * (W * 0.325), -H * 0.067, p.ledZ + 8);
      group.add(fill);
      this.fillLights.push(fill);
    }

    this.enclosure = group;
    this.scene.add(group);
  }

  private buildPaperLayers(set: LayerSet): void {
    this.paperGroup.clear();
    this.paperMeshes = [];
    const vb = parseViewBox(set.viewBox);
    const n = set.layers.length;

    // 层序：layers[0] = L1 靠 LED（最靠背板），最后一层靠观者。
    // 装配坐标里 paperZ[0] 是最靠前（+Z 观者侧）的槽位，故第 idx 层落在 slot = n-1-idx。
    set.layers.forEach((layer, idx) => {
      const slot = n - 1 - idx;
      try {
        const geometry = buildPaperGeometry(layer.pathD, vb);
        const material = new THREE.MeshStandardMaterial({
          color: 0xfcfbf7,
          roughness: 0.88,
          metalness: 0.02,
          emissive: new THREE.Color(0x000000),
          side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData = { layerIndex: idx, name: layer.name, depth: layer.depth };
        mesh.position.z = this.plan.paperZ[slot];
        this.paperGroup.add(mesh);
        this.paperMeshes.push(mesh);
      } catch (err) {
        console.error(`Failed to build layer ${idx + 1} (${layer.name}):`, err);
      }
    });
  }

  setExplode(progress: number): void {
    this.applyExplode(progress);
  }

  private applyExplode(progress: number): void {
    this.slotTweens = [];
    this.explode = progress;
    const p = this.plan;
    const n = this.plan.layerCount;
    const lerp = THREE.MathUtils.lerp;

    if (this.frame) this.frame.position.z = lerp(p.frameZ, p.frameExplodedZ, progress);
    if (this.glass) this.glass.position.z = lerp(p.glassZ, p.glassExplodedZ, progress);

    this.paperMeshes.forEach((mesh, idx) => {
      const slot = n - 1 - idx; // 与 buildPaperLayers 的层序映射一致
      mesh.position.z = lerp(p.paperZ[slot], p.paperExplodedZ[slot], progress);
    });
    this.spacers.forEach((mesh, idx) => {
      mesh.position.z = lerp(p.spacerZ[idx], p.spacerExplodedZ[idx], progress);
    });
    if (this.backplate) this.backplate.position.z = lerp(p.backplateZ, p.backplateExplodedZ, progress);

    const ledZ = lerp(p.ledZ, p.ledExplodedZ, progress);
    if (this.ledGroup) this.ledGroup.position.z = ledZ;
    if (this.rectLight) this.rectLight.position.z = ledZ + 3;
    if (this.keyLight) this.keyLight.position.z = ledZ + 8;
    for (const fill of this.fillLights) fill.position.z = ledZ + 8;
  }


  reorderLayer(oldIndex: number, newIndex: number): void {
    if (oldIndex === newIndex) return;
    // this.layers is already updated by caller since they share the same array reference.
    
    const mesh = this.paperMeshes.splice(oldIndex, 1)[0];
    this.paperMeshes.splice(newIndex, 0, mesh);
    
    this.updateMaterials();
    
    const p = this.plan;
    const n = this.plan.layerCount;
    const lerp = THREE.MathUtils.lerp;
    const now = performance.now();
    
    this.paperMeshes.forEach((m, idx) => {
      const slot = n - 1 - idx;
      const targetZ = lerp(p.paperZ[slot], p.paperExplodedZ[slot], this.explode);
      if (Math.abs(m.position.z - targetZ) > 0.1) {
        this.slotTweens.push({
          mesh: m,
          startZ: m.position.z,
          targetZ,
          startTime: now
        });
      }
    });
  }

  updateSettings(patch: Partial<LightboxSettings>): void {
    this.settings = { ...this.settings, ...patch };
    this.updateMaterials();
  }

  setSolo(index: number | null): void {
    this.soloIndex = index;
    this.updateMaterials();
  }

  setPartVisible(part: StructurePart, visible: boolean): void {
    this.visibility[part] = visible;
    this.applyVisibility();
  }

  private applyVisibility(): void {
    if (this.frame) this.frame.visible = this.visibility.frame;
    if (this.glass) this.glass.visible = this.visibility.frame;
    this.paperGroup.visible = this.visibility.paper;
    for (const spacer of this.spacers) spacer.visible = this.visibility.spacers;
    if (this.backplate) this.backplate.visible = this.visibility.backplate;
    if (this.ledGroup) this.ledGroup.visible = this.visibility.backplate;
  }

  private updateMaterials(): void {
    const { intensity, color: hex, darkRoom, translucent } = this.settings;
    const color = new THREE.Color(hex);
    const total = this.layers.length;

    if (this.rectLight) {
      this.rectLight.color.copy(color);
      this.rectLight.intensity = intensity * 2.8;
    }
    if (this.keyLight) {
      this.keyLight.color.copy(color);
      this.keyLight.intensity = intensity * 6.5;
    }
    for (const fill of this.fillLights) {
      fill.color.copy(color);
      fill.intensity = intensity * 2.4;
    }
    for (const bead of this.ledBeads) {
      const mat = bead.material as THREE.MeshStandardMaterial;
      mat.emissive.copy(color);
      mat.emissiveIntensity = intensity * 1.8;
    }

    this.paperMeshes.forEach((mesh, idx) => {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      const dimmed = this.soloIndex !== null && this.soloIndex !== idx;
      mat.transparent = dimmed;
      mat.opacity = dimmed ? 0.15 : 1.0;

      // 主题按视距排：靠观者的层是深色剪影（theme 0），靠 LED 的层最亮（theme n-1）。
      // mesh 数组顺序 = layers 顺序（L1 靠 LED 在前），故主题下标取 total-1-idx。
      const theme = themeFor(total - 1 - idx, total);
      if (darkRoom) {
        mat.color.setHex(theme.darkBase);
        if (translucent) {
          mat.emissive.copy(color).multiplyScalar(theme.darkEmissiveMult * (intensity / 2.2));
        } else {
          mat.emissive.setHex(0x050403);
        }
        mat.roughness = 0.88;
      } else {
        mat.color.setHex(theme.lightBase);
        if (translucent) {
          mat.emissive.copy(color).multiplyScalar(0.06 * (intensity / 2.2));
        } else {
          mat.emissive.setHex(0x000000);
        }
        mat.roughness = 0.94;
      }
    });

    this.ambient.intensity = darkRoom ? 0.12 : 0.5;
    this.dirFill.intensity = darkRoom ? 0.28 : 0.8;
  }

  setCameraView(name: CameraViewName): void {
    const s = Math.max(this.sheetWidth / 800, this.sheetHeight / 600);
    const views: Record<CameraViewName, [number, number, number]> = {
      front: [0, 0, 950 * s],
      perspective: [450 * s, 250 * s, 800 * s],
      side: [760 * s, 60 * s, 240 * s],
      top: [0, 860 * s, 180 * s],
    };
    const [x, y, z] = views[name];
    this.camera.position.set(x, y, z);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  screenshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  private handleResize(): void {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (width === 0 || height === 0) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  private animate = (): void => {
    this.raf = requestAnimationFrame(this.animate);
    
    if (this.slotTweens.length > 0) {
      const now = performance.now();
      const duration = 400; // ms
      this.slotTweens = this.slotTweens.filter(tween => {
        let t = (now - tween.startTime) / duration;
        if (t >= 1) {
          tween.mesh.position.z = tween.targetZ;
          return false;
        }
        t = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; // easeInOutQuad
        tween.mesh.position.z = THREE.MathUtils.lerp(tween.startZ, tween.targetZ, t);
        return true;
      });
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

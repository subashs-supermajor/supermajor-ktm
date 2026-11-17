import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { Axis, HotspotAnchor, HotspotConfig, PaintFinish, PaintSlot, Variant } from '../../config/models/types';
import { fetchModel, ModelLoadError, type LoadFailure } from '../../services/modelFetch';
import { createStudio, type Studio } from './studio';

export type PresetName = 'three-quarter' | 'front' | 'left' | 'rear' | 'right';

/** Hotspot anchor in the model's own coordinates. */
interface Anchor {
  p: THREE.Vector3;
  n: THREE.Vector3;
  /** Camera position relative to p for this hotspot's close-up. */
  v?: THREE.Vector3;
}

/** Model file name; keys the saved hotspot placements for that model. */
export function modelKeyFor(url: string) {
  if (url.startsWith('blob:')) return 'local-preview';
  return decodeURIComponent(url.split('?')[0].split('/').pop() ?? url);
}

export type EngineStatus =
  | { kind: 'loading'; progress: number | null }
  /** firstModel is false when a variant swap kept the current camera */
  | { kind: 'ready'; firstModel: boolean }
  | { kind: 'error'; reason: LoadFailure | 'context-lost'; detail?: string };

export interface ScreenPoint {
  x: number;
  y: number;
  /** false when the point is behind the camera */
  onScreen: boolean;
  /** -1 = on the far side of the bike from the camera, 1 = facing the camera */
  facing: number;
}

interface EngineOptions {
  frontAxis: Axis;
  reducedMotion: boolean;
  onStatus: (status: EngineStatus) => void;
  onInteract: (kind: 'rotate' | 'zoom') => void;
  /** Fired when the user drags the camera away from a preset. */
  onFreeCamera: () => void;
  /** Fired after every rendered frame. Keep it cheap. */
  onRender: () => void;
  /** Called when the WebGL context is lost so the React layer can remount the engine. */
  onContextLost?: () => void;
}

interface CameraTween {
  from: { target: THREE.Vector3; offset: THREE.Spherical };
  to: { target: THREE.Vector3; offset: THREE.Spherical };
  start: number;
  duration: number;
}

const UP = new THREE.Vector3(0, 1, 0);
const AXIS_VECTORS: Record<Axis, THREE.Vector3> = {
  '+x': new THREE.Vector3(1, 0, 0),
  '-x': new THREE.Vector3(-1, 0, 0),
  '+z': new THREE.Vector3(0, 0, 1),
  '-z': new THREE.Vector3(0, 0, -1),
};

const FOV = 30;
const CROSSFADE_MS = 650;
const PRESET_ELEVATION: Record<PresetName, number> = {
  // Low, showroom-floor eye height.
  'three-quarter': 0.14,
  front: 0.1,
  rear: 0.1,
  left: 0.05,
  right: 0.05,
};

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * Owns the renderer, scene, camera and model lifecycle. Framework-agnostic:
 * the React layer talks to it through the public methods below.
 */
export class ViewerEngine {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 100);
  private readonly controls: OrbitControls;
  private readonly loader: GLTFLoader;
  private readonly draco: DRACOLoader;
  private readonly ktx2: KTX2Loader;
  private readonly pmrem: THREE.PMREMGenerator;
  private readonly envMap: THREE.Texture;
  private readonly keyLight: THREE.DirectionalLight;
  private readonly rimLight: THREE.DirectionalLight;
  private readonly studio: Studio;
  private readonly resizeObserver: ResizeObserver;
  /** Holds the outgoing picture during a colour change crossfade. */
  private readonly fadeCanvas = document.createElement('canvas');
  private fadeTimer = 0;

  /** Parsed models by URL, so switching back to a variant is instant. */
  private readonly cache = new Map<string, THREE.Object3D>();
  private readonly pending = new Map<string, Promise<THREE.Object3D>>();

  private readonly forward: THREE.Vector3;
  private readonly right: THREE.Vector3;

  private model: THREE.Object3D | null = null;
  private bounds = new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 1, 1));
  private radius = 1;
  private fitDistance = 4;

  private hotspots: HotspotConfig[] = [];
  private anchors = new Map<string, Anchor>();
  private anchorCache = new WeakMap<THREE.Object3D, Map<string, Anchor>>();
  private readonly raycaster = new THREE.Raycaster();

  private originalMaterials = new Map<THREE.Mesh, THREE.Material[]>();
  private paintedMaterials = new Map<string, THREE.Material>();
  private autoPaint = new Set<THREE.Material>();

  private tween: CameraTween | null = null;
  private needsRender = true;
  private loadToken = 0;
  private disposed = false;
  private reducedMotion: boolean;

  constructor(
    private readonly container: HTMLElement,
    private readonly opts: EngineOptions,
  ) {
    this.reducedMotion = opts.reducedMotion;
    this.forward = AXIS_VECTORS[opts.frontAxis].clone();
    this.right = new THREE.Vector3().crossVectors(this.forward, UP).normalize();

    // On high-DPR mobile screens (Retina iPhones), native resolution already
    // eliminates jaggies — MSAA just wastes GPU memory and causes context loss on iOS.
    const mobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const renderer = new THREE.WebGLRenderer({ antialias: !mobile, powerPreference: 'default' });
    // Cap at 1.5 on mobile: beyond that, extra pixels cost VRAM without visible gain.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, mobile ? 1.5 : 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // Slightly under-exposed: a moody showroom where the overhead spot does the work.
    renderer.toneMappingExposure = 0.86;
    renderer.shadowMap.enabled = true;
    // VSM gives genuinely blurred shadows (radius-controlled) instead of hard-edged ones.
    renderer.shadowMap.type = THREE.VSMShadowMap;
    renderer.setClearColor(0x030303, 1);
    renderer.domElement.setAttribute('aria-hidden', 'true');
    this.renderer = renderer;
    container.appendChild(renderer.domElement);
    this.fadeCanvas.className = 'viewer__fade';
    this.fadeCanvas.setAttribute('aria-hidden', 'true');
    container.appendChild(this.fadeCanvas);

    // Neutral studio reflections without shipping an HDR file.
    this.pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    this.envMap = this.pmrem.fromScene(room, 0.04).texture;
    room.dispose();
    this.scene.environment = this.envMap;
    // Dimmed so the overhead spot, not the reflections, sets the mood.
    this.scene.environmentIntensity = 0.32;

    // The overhead spot (in the studio) does the main lighting and the shadow;
    // these two just keep the paint and silhouette readable.
    this.keyLight = new THREE.DirectionalLight(0xffffff, 0.38);
    this.scene.add(this.keyLight, this.keyLight.target);
    this.rimLight = new THREE.DirectionalLight(0xdfe6ff, 0.35);
    this.scene.add(this.rimLight);

    this.studio = createStudio(renderer);
    this.scene.add(this.studio.group);

    this.draco = new DRACOLoader().setDecoderPath('/decoders/draco/');
    this.ktx2 = new KTX2Loader().setTranscoderPath('/decoders/basis/').detectSupport(renderer);
    this.loader = new GLTFLoader()
      .setDRACOLoader(this.draco)
      .setKTX2Loader(this.ktx2)
      .setMeshoptDecoder(MeshoptDecoder);

    this.camera.fov = FOV;
    const controls = new OrbitControls(this.camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = false;
    controls.enableZoom = false;
    controls.rotateSpeed = 0.7;
    controls.zoomSpeed = 0.8;
    controls.autoRotateSpeed = 0.8;
    // Full vertical orbit: over the top and underneath the bike. The tiny margin
    // at each pole stops the camera flipping when it passes straight over.
    controls.minPolarAngle = 0.02;
    controls.maxPolarAngle = Math.PI - 0.02;
    controls.addEventListener('change', this.requestRender);
    controls.addEventListener('start', this.handleControlStart);
    this.controls = controls;

    renderer.domElement.addEventListener('webglcontextlost', this.handleContextLost);
    renderer.domElement.addEventListener('webglcontextrestored', this.handleContextRestored);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.layoutStage();
    this.jumpToPreset('left');

    renderer.setAnimationLoop(this.tick);
  }

  // ---------------------------------------------------------------- loading

  /**
   * Shows the model at `url`. Cached models swap in instantly; the camera is
   * kept when the new model is a similar size (a colour variant).
   */
  async load(url: string): Promise<void> {
    const token = ++this.loadToken;
    const stale = () => this.disposed || token !== this.loadToken;

    const cached = this.cache.get(url);
    if (cached) {
      this.setModel(cached);
      return;
    }

    this.opts.onStatus({ kind: 'loading', progress: this.pending.has(url) ? null : 0 });
    try {
      const root = await this.fetchScene(url, (progress) => {
        if (!stale()) this.opts.onStatus({ kind: 'loading', progress });
      });
      if (!stale()) this.setModel(root);
    } catch (error) {
      if (stale()) return;
      const reason = error instanceof ModelLoadError ? error.reason : 'invalid';
      this.opts.onStatus({ kind: 'error', reason, detail: (error as Error).message });
    }
  }

  /** Downloads and parses models in the background, one at a time. */
  async preload(urls: string[]) {
    for (const url of urls) {
      if (this.disposed) return;
      if (this.cache.has(url)) continue;
      try {
        await this.fetchScene(url, () => {});
      } catch {
        // A failed preload is retried, with a visible error, if the user picks it.
      }
    }
  }

  private fetchScene(url: string, onProgress: (p: number | null) => void): Promise<THREE.Object3D> {
    const inFlight = this.pending.get(url);
    if (inFlight) return inFlight;

    const job = (async () => {
      const data = await fetchModel(url, onProgress);
      const basePath = url.startsWith('blob:') ? '' : url.slice(0, url.lastIndexOf('/') + 1);
      const gltf = await this.loader.parseAsync(data, basePath).catch((error: Error) => {
        throw new ModelLoadError('invalid', error.message);
      });
      if (this.disposed) {
        disposeObject(gltf.scene);
        throw new ModelLoadError('network', 'viewer closed');
      }
      prepareModel(gltf.scene);
      gltf.scene.userData.modelKey = modelKeyFor(url);
      // Keep at most 2 variants in GPU memory; evict the oldest to prevent
      // iOS WebGL context loss when VRAM fills up with all 3 colour variants.
      if (this.cache.size >= 2) {
        const [oldestUrl, oldestScene] = this.cache.entries().next().value as [string, THREE.Object3D];
        if (oldestScene !== this.model) {
          disposeObject(oldestScene);
          this.cache.delete(oldestUrl);
        }
      }
      this.cache.set(url, gltf.scene);
      return gltf.scene;
    })();

    this.pending.set(url, job);
    job.finally(() => this.pending.delete(url)).catch(() => {});
    return job;
  }

  private setModel(root: THREE.Object3D) {
    const previousRadius = this.model ? this.radius : null;
    // Colour change: freeze the current picture on top, swap underneath, then fade it away.
    const crossfade = this.model !== null && this.model !== root && !this.reducedMotion;
    if (crossfade) this.freezeFrame();
    if (this.model) this.scene.remove(this.model);
    this.originalMaterials.clear();

    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      this.originalMaterials.set(mesh, mesh.userData.originalMaterials as THREE.Material[]);
    });

    this.bounds.setFromObject(root);
    this.radius = this.bounds.getBoundingSphere(new THREE.Sphere()).radius;
    this.model = root;
    this.scene.add(root);

    if (import.meta.env.DEV) {
      const names = new Set<string>();
      for (const mats of this.originalMaterials.values()) mats.forEach((m) => names.add(m.name || '(unnamed)'));
      console.info('[viewer] material names in model:', [...names]);
    }

    this.detectBodyPaint();
    this.layoutStage();
    this.anchors = this.anchorsFor(root);

    const similarSize = previousRadius !== null && Math.abs(this.radius / previousRadius - 1) < 0.3;
    if (!similarSize) this.introCamera();
    this.requestRender();
    if (crossfade) this.releaseFrame();
    this.opts.onStatus({ kind: 'ready', firstModel: !similarSize });
  }

  /** Copies the last rendered picture into the overlay canvas, fully opaque. */
  private freezeFrame() {
    const source = this.renderer.domElement;
    // Render now and copy in the same task, while the drawing buffer still holds the frame.
    this.renderer.render(this.scene, this.camera);
    const overlay = this.fadeCanvas;
    overlay.width = source.width;
    overlay.height = source.height;
    overlay.getContext('2d')?.drawImage(source, 0, 0);
    overlay.style.transition = 'none';
    overlay.style.opacity = '1';
    this.container.classList.add('is-swapping');
    window.clearTimeout(this.fadeTimer);
  }

  /** Fades the frozen picture out once the new model has drawn underneath it. */
  private releaseFrame() {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (this.disposed) return;
        this.fadeCanvas.style.transition = `opacity ${CROSSFADE_MS}ms ease`;
        this.fadeCanvas.style.opacity = '0';
        this.fadeTimer = window.setTimeout(() => this.container.classList.remove('is-swapping'), CROSSFADE_MS);
      }),
    );
  }

  /** Sizes camera limits, lights and floor to the loaded model. */
  private layoutStage() {
    const r = this.radius;
    this.camera.near = r / 100;
    this.camera.far = r * 60;
    this.camera.updateProjectionMatrix();
    this.updateFitDistance();

    this.controls.minDistance = r * 0.4;
    this.controls.maxDistance = this.fitDistance * 2.0;

    const height = this.bounds.max.y;
    this.keyLight.position
      .copy(this.right.clone().multiplyScalar(-r * 1.2))
      .add(this.forward.clone().multiplyScalar(r * 1.4));
    // Kept low so it grazes the floor and lights the bike's flank, not the ground.
    this.keyLight.position.y = height + r * 0.3;
    this.keyLight.target.position.set(0, height * 0.4, 0);

    this.rimLight.position.copy(this.forward.clone().multiplyScalar(-r * 2)).setY(height + r * 0.6);
    this.studio.fit(r, height);
    const size = this.bounds.getSize(new THREE.Vector3());
    const alongX = Math.abs(this.forward.x) > 0.5;
    this.studio.setFootprint(alongX ? size.x : size.z, alongX ? size.z : size.x, alongX, this.bounds.min.y);
  }

  private updateFitDistance() {
    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const limiting = Math.min(vFov, hFov);
    // Scale bike to prominently fill frame matching presentation view
    this.fitDistance = (this.radius / Math.sin(limiting / 2)) * 0.92;
  }

  // ---------------------------------------------------------------- variants

  /**
   * Paints the configured body panels. If none of the configured names exist in
   * the model, falls back to the auto-detected body paint so colours still switch.
   * Returns how many materials changed.
   */
  applyVariant(variant: Variant, slots: PaintSlot[]): number {
    if (!this.model) return 0;

    const slotFor = (mesh: THREE.Mesh, material: THREE.Material) =>
      slots.find((s) => matches(s, mesh.name.toLowerCase()) || matches(s, material.name.toLowerCase()));

    let anyNamed = false;
    for (const [mesh, originals] of this.originalMaterials) {
      if (originals.some((m) => slotFor(mesh, m))) {
        anyNamed = true;
        break;
      }
    }

    const finishes = variant.finish ?? {};
    const primaryFinish = slots.map((s) => finishes[s.id]).find(Boolean);
    let painted = 0;

    for (const [mesh, originals] of this.originalMaterials) {
      const next = originals.map((original, index) => {
        if (anyNamed) {
          const slot = slotFor(mesh, original);
          const finish = slot ? finishes[slot.id] : undefined;
          if (!finish) return original;
          painted += 1;
          return this.paint(mesh, index, original, finish, false);
        }
        if (!primaryFinish || !this.autoPaint.has(original)) return original;
        painted += 1;
        return this.paint(mesh, index, original, primaryFinish, true);
      });
      mesh.material = Array.isArray(mesh.material) ? next : next[0];
    }

    this.requestRender();
    return painted;
  }

  /**
   * Guesses which materials are the body paint: the largest coloured surface
   * (plus any other material in the same hue), skipping glass, rubber, chrome
   * and similar. Used only when the config names don't match the model.
   */
  private detectBodyPaint() {
    this.autoPaint.clear();
    const area = new Map<THREE.Material, number>();

    for (const [mesh, materials] of this.originalMaterials) {
      const perGroup = meshAreaByMaterial(mesh, materials.length);
      materials.forEach((material, i) => {
        if (!isPaintCandidate(mesh, material)) return;
        area.set(material, (area.get(material) ?? 0) + perGroup[i]);
      });
    }
    if (area.size === 0) return;

    const hsl = { h: 0, s: 0, l: 0 };
    const colourful = [...area.entries()].filter(([material]) => {
      const color = (material as THREE.MeshStandardMaterial).color;
      if (!(color instanceof THREE.Color)) return false;
      color.getHSL(hsl);
      return hsl.s >= 0.35 && hsl.l > 0.12 && hsl.l < 0.85;
    });

    const pool = colourful.length > 0 ? colourful : [...area.entries()];
    pool.sort((a, b) => b[1] - a[1]);
    const [lead] = pool[0];
    this.autoPaint.add(lead);

    if (colourful.length > 0) {
      const leadHue = (lead as THREE.MeshStandardMaterial).color.getHSL(hsl).h;
      for (const [material] of colourful) {
        const hue = (material as THREE.MeshStandardMaterial).color.getHSL(hsl).h;
        const diff = Math.min(Math.abs(hue - leadHue), 1 - Math.abs(hue - leadHue));
        if (diff < 0.06) this.autoPaint.add(material);
      }
    }

    if (import.meta.env.DEV) {
      console.info(
        '[viewer] no paintSlots matched by name; auto-detected body paint:',
        [...this.autoPaint].map((m) => m.name || '(unnamed)'),
      );
    }
  }

  private paint(
    mesh: THREE.Mesh,
    index: number,
    original: THREE.Material,
    finish: PaintFinish,
    dropTexture: boolean,
  ): THREE.Material {
    const key = `${mesh.uuid}:${index}`;
    let material = this.paintedMaterials.get(key);
    if (!material) {
      material = original.clone();
      this.paintedMaterials.set(key, material);
    }

    const target = material as THREE.MeshPhysicalMaterial;
    const source = original as THREE.MeshPhysicalMaterial;
    if (target.color instanceof THREE.Color) target.color.set(finish.color);
    // A colour texture would tint the new paint, so auto-painted parts get a clean coat.
    if (dropTexture && 'map' in target && target.map) {
      target.map = null;
      target.needsUpdate = true;
    }
    if (target.isMeshStandardMaterial) {
      target.metalness = finish.metalness ?? source.metalness;
      target.roughness = finish.roughness ?? source.roughness;
    }
    if (target.isMeshPhysicalMaterial && finish.clearcoat !== undefined) {
      target.clearcoat = finish.clearcoat;
      target.clearcoatRoughness = 0.08;
    }
    return material;
  }

  // ---------------------------------------------------------------- hotspots

  setHotspots(hotspots: HotspotConfig[]) {
    this.hotspots = hotspots;
    this.anchorCache = new WeakMap();
    if (this.model) this.anchors = this.anchorsFor(this.model);
    this.requestRender();
  }

  /**
   * Where each hotspot sits on this particular model, in the model's own
   * coordinates. Saved placements win; otherwise the rough position is snapped
   * onto the first real surface, so markers sit on the bike instead of floating.
   */
  private anchorsFor(root: THREE.Object3D): Map<string, Anchor> {
    const cached = this.anchorCache.get(root);
    if (cached) return cached;

    const key = root.userData.modelKey as string;
    const toLocal = root.matrixWorld.clone().invert();
    const size = this.bounds.getSize(new THREE.Vector3());
    const centre = this.bounds.getCenter(new THREE.Vector3());
    const length = Math.abs(this.forward.x) * size.x + Math.abs(this.forward.z) * size.z;
    const width = Math.abs(this.right.x) * size.x + Math.abs(this.right.z) * size.z;

    const anchors = new Map<string, Anchor>();
    for (const hotspot of this.hotspots) {
      const saved = hotspot.anchors?.[key];
      if (saved) {
        anchors.set(hotspot.id, fromJson(saved));
        continue;
      }
      const { along, height, side } = hotspot.position;
      const guess = new THREE.Vector3(centre.x, this.bounds.min.y + height * size.y, centre.z)
        .addScaledVector(this.forward, (along - 0.5) * length)
        .addScaledVector(this.right, (side * width) / 2);
      const hit = this.snapToSurface(root, guess, along, side);
      const normal = hit?.normal ?? guess.clone().sub(centre).setY(0).normalize();
      anchors.set(hotspot.id, {
        p: (hit?.point ?? guess).clone().applyMatrix4(toLocal),
        n: normal.clone().transformDirection(toLocal),
      });
    }

    this.anchorCache.set(root, anchors);
    return anchors;
  }

  /** Casts in from outside the bike towards the rough position; takes the first solid surface. */
  private snapToSurface(root: THREE.Object3D, guess: THREE.Vector3, along: number, side: number) {
    const reach = this.radius * 2;
    const rays: [THREE.Vector3, THREE.Vector3][] = [];

    if (Math.abs(side) >= 0.15) {
      const inward = this.right.clone().multiplyScalar(-Math.sign(side));
      rays.push([guess.clone().addScaledVector(inward, -reach), inward]);
    } else {
      rays.push([guess.clone().setY(this.bounds.max.y + reach / 2), new THREE.Vector3(0, -1, 0)]);
    }
    const end = along >= 0.5 ? 1 : -1;
    const fromEnd = this.forward.clone().multiplyScalar(-end);
    rays.push([guess.clone().addScaledVector(fromEnd, -reach), fromEnd]);

    for (const [origin, direction] of rays) {
      this.raycaster.set(origin, direction);
      this.raycaster.far = reach * 2;
      const hit = this.raycaster.intersectObject(root, true).find(isSolidHit);
      if (hit) return surfacePoint(hit, direction, this.radius);
    }
    return null;
  }

  private hotspotWorld(id: string) {
    const anchor = this.anchors.get(id);
    const model = this.model;
    if (!anchor || !model) return null;
    return {
      point: model.localToWorld(anchor.p.clone()),
      normal: anchor.n.clone().transformDirection(model.matrixWorld),
    };
  }

  /** Screen position of a hotspot in CSS pixels relative to the container. */
  projectHotspot(id: string): ScreenPoint | null {
    const world = this.hotspotWorld(id);
    if (!world) return null;

    const ndc = world.point.clone().project(this.camera);
    const { clientWidth: w, clientHeight: h } = this.container;
    const toCamera = this.camera.position.clone().sub(world.point).normalize();

    return {
      x: ((ndc.x + 1) / 2) * w,
      y: ((1 - ndc.y) / 2) * h,
      onScreen: ndc.z < 1 && Math.abs(ndc.x) < 1.05 && Math.abs(ndc.y) < 1.05,
      // Surface facing away from the camera means the marker is on the far side.
      facing: world.normal.dot(toCamera),
    };
  }

  // ------------------------------------------------------- placement tool

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  /** File name of the model on show; keys saved hotspot placements. */
  get modelKey(): string | null {
    return (this.model?.userData.modelKey as string | undefined) ?? null;
  }

  /** The model surface under a screen point, in model coordinates. */
  pickSurface(clientX: number, clientY: number): HotspotAnchor | null {
    const model = this.model;
    if (!model) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    this.raycaster.far = Infinity;
    const hit = this.raycaster.intersectObject(model, true).find(isSolidHit);
    if (!hit) return null;

    const { point, normal } = surfacePoint(hit, this.raycaster.ray.direction, this.radius);
    const toLocal = model.matrixWorld.clone().invert();
    const p = point.clone().applyMatrix4(toLocal);
    // The current camera, relative to the point, becomes this hotspot's close-up view.
    const v = this.camera.position.clone().applyMatrix4(toLocal).sub(p);
    return toJson({ p, n: normal.transformDirection(toLocal), v });
  }

  /** Dev helper for the placement tool: look at a model-space point from a direction. */
  frameLocal(point: [number, number, number], from: [number, number, number], distance: number) {
    const model = this.model;
    if (!model) return;
    const target = model.localToWorld(new THREE.Vector3(...point));
    const offset = new THREE.Vector3(...from).transformDirection(model.matrixWorld).multiplyScalar(distance);
    this.controls.minDistance = Math.min(this.radius, distance * 0.5);
    this.animateTo(target, offset, 0);
  }

  /** Places a hotspot on the model on show (kept for this model while the viewer is open). */
  setAnchor(id: string, anchor: HotspotAnchor) {
    this.anchors.set(id, fromJson(anchor));
    this.requestRender();
  }

  /**
   * Flies to the hotspot's close-up: the exact view saved when it was placed,
   * or failing that a view along the direction its surface faces.
   */
  focusHotspot(id: string) {
    const world = this.hotspotWorld(id);
    const anchor = this.anchors.get(id);
    const model = this.model;
    if (!world || !anchor || !model) return;
    const point = world.point;

    if (anchor.v) {
      const offset = anchor.v.clone().transformDirection(model.matrixWorld).multiplyScalar(anchor.v.length());
      // Close-ups may sit nearer than the normal zoom limit allows.
      this.controls.minDistance = Math.min(this.radius, offset.length() * 0.5);
      this.animateTo(point, offset, 1100);
      return;
    }

    const direction = world.normal.clone().setY(0);
    if (direction.lengthSq() < 0.05) direction.copy(point).setY(0);
    if (direction.lengthSq() < 1e-6) direction.copy(this.camera.position).sub(this.controls.target).setY(0);
    direction.normalize();

    const elevation = 0.28;
    const offset = direction.multiplyScalar(Math.cos(elevation)).add(new THREE.Vector3(0, Math.sin(elevation), 0));
    const target = point.clone().lerp(this.defaultTarget(), 0.35);
    this.animateTo(target, offset.multiplyScalar(this.radius * 1.15), 950);
  }

  // ---------------------------------------------------------------- camera

  goToPreset(name: PresetName) {
    this.controls.minDistance = this.radius; // back to the normal zoom limit
    const { target, offset } = this.presetPose(name);
    this.animateTo(target, offset, 900);
  }

  reset() {
    this.goToPreset('left');
  }

  zoomBy(factor: number) {
    const target = this.controls.target.clone();
    const offset = this.camera.position.clone().sub(target);
    const distance = THREE.MathUtils.clamp(
      offset.length() * factor,
      this.controls.minDistance,
      this.controls.maxDistance,
    );
    this.animateTo(target, offset.setLength(distance), 320);
  }

  /** Keyboard orbit: small steps around the current target. */
  nudge(deltaAzimuth: number, deltaPolar: number) {
    this.cancelTween();
    const target = this.controls.target;
    const spherical = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(target));
    spherical.theta += deltaAzimuth;
    spherical.phi = THREE.MathUtils.clamp(
      spherical.phi + deltaPolar,
      this.controls.minPolarAngle,
      this.controls.maxPolarAngle,
    );
    this.camera.position.copy(target).add(new THREE.Vector3().setFromSpherical(spherical));
    this.controls.update();
    this.opts.onFreeCamera();
    this.requestRender();
  }

  setAutoRotate(enabled: boolean) {
    this.controls.autoRotate = enabled;
    this.requestRender();
  }

  setReducedMotion(reduced: boolean) {
    this.reducedMotion = reduced;
  }

  private defaultTarget() {
    const center = this.bounds.getCenter(new THREE.Vector3());
    return new THREE.Vector3(center.x, this.bounds.min.y + (this.bounds.max.y - this.bounds.min.y) * 0.44, center.z);
  }

  private presetPose(name: PresetName) {
    let horizontal: THREE.Vector3;
    switch (name) {
      case 'front':
        horizontal = this.forward.clone();
        break;
      case 'rear':
        horizontal = this.forward.clone().negate();
        break;
      case 'left':
        // Direct left-facing side profile matching Image 1
        horizontal = this.right.clone().negate().multiplyScalar(0.99).add(this.forward.clone().multiplyScalar(0.12)).normalize();
        break;
      case 'right':
        horizontal = this.right.clone();
        break;
      case 'three-quarter':
        // Front-right: the side the hotspots and the 360° section open on.
        horizontal = this.forward.clone().multiplyScalar(0.85).add(this.right).normalize();
        break;
    }
    const elevation = PRESET_ELEVATION[name];
    // Scale model closer to match exact presentation framing in user screenshot
    const portrait = this.camera.aspect < 1;
    const distanceMultiplier = name === 'left' ? (portrait ? 0.95 : 0.72) : portrait ? 1.1 : 0.85;
    const offset = horizontal
      .multiplyScalar(Math.cos(elevation))
      .add(new THREE.Vector3(0, Math.sin(elevation), 0))
      .multiplyScalar(this.fitDistance * distanceMultiplier);
    return { target: this.defaultTarget(), offset };
  }

  private jumpToPreset(name: PresetName) {
    const { target, offset } = this.presetPose(name);
    this.controls.target.copy(target);
    this.camera.position.copy(target).add(offset);
    this.controls.update();
    this.requestRender();
  }

  /** Position directly at the requested showroom left-profile view */
  private introCamera() {
    this.jumpToPreset('left');
  }

  private animateTo(target: THREE.Vector3, offset: THREE.Vector3, duration: number) {
    if (this.reducedMotion || duration <= 0) {
      this.cancelTween();
      this.controls.target.copy(target);
      this.camera.position.copy(target).add(offset);
      this.controls.update();
      this.requestRender();
      return;
    }

    const fromOffset = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target));
    const toOffset = new THREE.Spherical().setFromVector3(offset);
    // Take the short way round.
    let delta = toOffset.theta - fromOffset.theta;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    toOffset.theta = fromOffset.theta + delta;

    this.tween = {
      from: { target: this.controls.target.clone(), offset: fromOffset },
      to: { target: target.clone(), offset: toOffset },
      start: performance.now(),
      duration,
    };
    this.requestRender();
  }

  private cancelTween() {
    this.tween = null;
  }

  /** Keeps the pan target within reach of the bike so it can't be dragged off screen. */
  private clampPan() {
    const target = this.controls.target;
    const limit = this.bounds.clone().expandByScalar(this.radius * 0.35);
    if (limit.containsPoint(target)) return;
    const shift = target.clone().clamp(limit.min, limit.max).sub(target);
    target.add(shift);
    this.camera.position.add(shift);
    this.needsRender = true;
  }

  private stepTween(now: number) {
    const tween = this.tween;
    if (!tween) return;
    const t = Math.min(1, (now - tween.start) / tween.duration);
    const k = easeInOut(t);

    const spherical = new THREE.Spherical(
      THREE.MathUtils.lerp(tween.from.offset.radius, tween.to.offset.radius, k),
      THREE.MathUtils.lerp(tween.from.offset.phi, tween.to.offset.phi, k),
      THREE.MathUtils.lerp(tween.from.offset.theta, tween.to.offset.theta, k),
    );
    this.controls.target.lerpVectors(tween.from.target, tween.to.target, k);
    this.camera.position.copy(this.controls.target).add(new THREE.Vector3().setFromSpherical(spherical));
    this.needsRender = true;
    if (t >= 1) this.tween = null;
  }

  // ---------------------------------------------------------------- loop

  private readonly tick = () => {
    this.stepTween(performance.now());
    // update() returns true while damping or auto-rotate moves the camera.
    if (this.controls.update()) this.needsRender = true;
    if (!this.tween) this.clampPan();
    if (!this.needsRender) return;
    this.needsRender = false;
    this.renderer.render(this.scene, this.camera);
    this.opts.onRender();
  };

  private readonly requestRender = () => {
    this.needsRender = true;
  };

  private resize() {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (width === 0 || height === 0) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.updateFitDistance();
    this.controls.maxDistance = this.fitDistance * 1.8;
    this.requestRender();
  }

  // ---------------------------------------------------------------- input

  private readonly handleControlStart = () => {
    this.cancelTween();
    this.opts.onFreeCamera();
    this.opts.onInteract('rotate');
  };

  private contextLostTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly handleContextLost = (event: Event) => {
    event.preventDefault();
    this.renderer.setAnimationLoop(null);
    // Give the browser up to 4 s to restore the context automatically.
    // If it does, handleContextRestored will trigger a silent remount.
    // If it doesn't, show the error card so the user can retry manually.
    this.contextLostTimer = setTimeout(() => {
      this.contextLostTimer = null;
      this.opts.onStatus({ kind: 'error', reason: 'context-lost' });
    }, 4000);
  };

  private readonly handleContextRestored = () => {
    if (this.contextLostTimer !== null) {
      clearTimeout(this.contextLostTimer);
      this.contextLostTimer = null;
    }
    // Ask the React layer to remount the engine with a fresh GL context.
    this.opts.onContextLost?.();
  };

  // ---------------------------------------------------------------- cleanup

  private disposeModels() {
    for (const root of this.cache.values()) disposeObject(root);
    this.cache.clear();
    this.paintedMaterials.forEach((m) => m.dispose());
    this.paintedMaterials.clear();
    this.originalMaterials.clear();
    this.autoPaint.clear();
    this.model = null;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.loadToken += 1;

    const canvas = this.renderer.domElement;
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    if (this.contextLostTimer !== null) clearTimeout(this.contextLostTimer);
    canvas.removeEventListener('webglcontextlost', this.handleContextLost);
    canvas.removeEventListener('webglcontextrestored', this.handleContextRestored);
    this.controls.removeEventListener('change', this.requestRender);
    this.controls.removeEventListener('start', this.handleControlStart);
    this.controls.dispose();

    this.disposeModels();
    this.studio.dispose();
    this.envMap.dispose();
    this.pmrem.dispose();
    this.draco.dispose();
    this.ktx2.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    canvas.remove();
    window.clearTimeout(this.fadeTimer);
    this.fadeCanvas.remove();
  }
}

/** Glass and see-through parts don't count as a surface for hotspots. */
function isSolidHit(hit: THREE.Intersection) {
  const mesh = hit.object as THREE.Mesh;
  if (!mesh.isMesh || !mesh.visible) return false;
  const material = Array.isArray(mesh.material) ? mesh.material[hit.face?.materialIndex ?? 0] : mesh.material;
  if (!material) return false;
  if ((material as THREE.MeshPhysicalMaterial).transmission > 0) return false;
  return !(material.transparent && material.opacity < 0.5);
}

/** World hit point nudged just off the surface, with the normal facing the viewer. */
function surfacePoint(hit: THREE.Intersection, rayDirection: THREE.Vector3, radius: number) {
  const normal = hit.face
    ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
    : rayDirection.clone().negate();
  if (normal.dot(rayDirection) > 0) normal.negate();
  return { point: hit.point.clone().addScaledVector(normal, radius * 0.006), normal };
}

const round = (v: number) => Math.round(v * 10000) / 10000;

const triple = (v: THREE.Vector3): [number, number, number] => [round(v.x), round(v.y), round(v.z)];

function toJson(anchor: Anchor): HotspotAnchor {
  const json: HotspotAnchor = { p: triple(anchor.p), n: triple(anchor.n.clone().normalize()) };
  if (anchor.v) json.v = triple(anchor.v);
  return json;
}

function fromJson(anchor: HotspotAnchor): Anchor {
  return {
    p: new THREE.Vector3(...anchor.p),
    n: new THREE.Vector3(...anchor.n).normalize(),
    v: anchor.v ? new THREE.Vector3(...anchor.v) : undefined,
  };
}

/** One-time setup when a model is parsed: shadows, original materials, floor-centred. */
function prepareModel(root: THREE.Object3D) {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    // Soft (VSM) shadows streak when a model shadows itself; the floor takes the shadow instead.
    mesh.receiveShadow = false;
    mesh.userData.originalMaterials = toArray(mesh.material);
  });

  // Centre on the floor so orbiting pivots around the middle of the bike.
  const box = new THREE.Box3().setFromObject(root);
  const centre = box.getCenter(new THREE.Vector3());
  root.position.x -= centre.x;
  root.position.z -= centre.z;
  root.position.y -= box.min.y;
  root.updateMatrixWorld(true);
}

function toArray(material: THREE.Material | THREE.Material[]) {
  return Array.isArray(material) ? material : [material];
}

const NOT_PAINT =
  /glass|lens|tyre|tire|rubber|chrome|steel|alumin|engine|exhaust|pipe|light|lamp|mirror|seat|disc|brake|chain|frame|screen|display|decal|logo|black/i;

function isPaintCandidate(mesh: THREE.Mesh, material: THREE.Material) {
  const physical = material as THREE.MeshPhysicalMaterial;
  if (material.transparent && material.opacity < 0.95) return false;
  if (physical.transmission > 0) return false;
  if (NOT_PAINT.test(material.name) || NOT_PAINT.test(mesh.name)) return false;
  return physical.color instanceof THREE.Color;
}

/** World-space surface area per material group. Large meshes are sampled. */
function meshAreaByMaterial(mesh: THREE.Mesh, materialCount: number): number[] {
  const totals = new Array<number>(materialCount).fill(0);
  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position');
  if (!position) return totals;

  const index = geometry.getIndex();
  const triCount = (index ? index.count : position.count) / 3;
  const groups = geometry.groups.length > 0 ? geometry.groups : [{ start: 0, count: triCount * 3, materialIndex: 0 }];
  const stride = Math.max(1, Math.floor(triCount / 20000));
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const vertex = (i: number) => (index ? index.getX(i) : i);

  for (const group of groups) {
    const slot = group.materialIndex ?? 0;
    if (slot >= materialCount) continue;
    for (let i = group.start; i + 2 < group.start + group.count; i += 3 * stride) {
      a.fromBufferAttribute(position, vertex(i)).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(position, vertex(i + 1)).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(position, vertex(i + 2)).applyMatrix4(mesh.matrixWorld);
      totals[slot] += b.sub(a).cross(c.sub(a)).length() * 0.5 * stride;
    }
  }
  return totals;
}

function matches(slot: PaintSlot, name: string) {
  return name.length > 0 && slot.match.some((fragment) => name.includes(fragment.toLowerCase()));
}

function disposeObject(root: THREE.Object3D) {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    for (const material of toArray(mesh.material)) {
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) value.dispose();
      }
      material.dispose();
    }
  });
}

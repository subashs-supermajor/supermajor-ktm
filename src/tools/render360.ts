import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { Axis, ModelConfig } from '../config/models/types';
import { fetchModel } from '../services/modelFetch';
import type { SpinManifest } from '../components/Spin360/manifest';

/**
 * Renders the 360° image sequences for the showcase section: each variant on a
 * black stage, standing on a turntable with a bright rim, photographed side-on
 * at a fixed step. Frames go to public/assets/360/<variant>/ via the dev server.
 */

export const FRAME_COUNT = 72; // 5° per frame
const WIDTH = 1600;
const HEIGHT = 900;
const QUALITY = 0.86;
const ELEVATION = THREE.MathUtils.degToRad(5);
const FOV = 20;

const AXES: Record<Axis, THREE.Vector3> = {
  '+x': new THREE.Vector3(1, 0, 0),
  '-x': new THREE.Vector3(-1, 0, 0),
  '+z': new THREE.Vector3(0, 0, 1),
  '-z': new THREE.Vector3(0, 0, -1),
};

export interface RenderProgress {
  variant: string;
  frame: number;
  frames: number;
  done: number;
  total: number;
}

export async function render360(config: ModelConfig, onProgress: (p: RenderProgress) => void): Promise<SpinManifest> {
  const variants = config.variants.filter((v) => v.model);
  if (variants.length === 0) throw new Error('No variants with their own model file to render.');

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(WIDTH, HEIGHT, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#000000');
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const envMap = pmrem.fromScene(room, 0.04).texture;
  room.dispose();
  scene.environment = envMap;
  // Same moody balance as the live viewer: top light leads, reflections stay low.
  scene.environmentIntensity = 0.4;

  const forward = AXES[config.frontAxis].clone();
  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

  const key = new THREE.DirectionalLight('#ffffff', 1.05);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0003;
  const rim = new THREE.DirectionalLight('#dfe6ff', 0.6);
  scene.add(key, key.target, rim);

  // Platform and bike turn together; the camera and lights stay put.
  const table = new THREE.Group();
  scene.add(table);
  const platform = buildTurntable();
  table.add(platform.group);

  const camera = new THREE.PerspectiveCamera(FOV, WIDTH / HEIGHT, 0.01, 100);
  const loader = new GLTFLoader()
    .setDRACOLoader(new DRACOLoader().setDecoderPath('/decoders/draco/'))
    .setKTX2Loader(new KTX2Loader().setTranscoderPath('/decoders/basis/').detectSupport(renderer))
    .setMeshoptDecoder(MeshoptDecoder);

  const manifest: SpinManifest = {
    frames: FRAME_COUNT,
    width: WIDTH,
    height: HEIGHT,
    ext: 'webp',
    rendered: new Date().toISOString(),
    variants: {},
  };

  const total = variants.length * FRAME_COUNT;
  let done = 0;

  try {
    for (const variant of variants) {
      const data = await fetchModel(variant.model as string, () => {});
      const base = variant.model as string;
      const gltf = await loader.parseAsync(data, base.slice(0, base.lastIndexOf('/') + 1));
      const model = gltf.scene;
      model.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.castShadow = true;
          mesh.receiveShadow = true;
        }
      });

      // Centre the bike on the platform.
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const centre = box.getCenter(new THREE.Vector3());
      const halfLength = (Math.abs(forward.x) * size.x + Math.abs(forward.z) * size.z) / 2;
      const deck = platform.fit(halfLength);
      model.position.set(-centre.x, deck - box.min.y, -centre.z);
      table.add(model);

      // Side-on with the front to the right, slightly above, ring filling the width.
      const ringRadius = halfLength * 1.2;
      const halfV = THREE.MathUtils.degToRad(FOV) / 2;
      const halfH = Math.atan(Math.tan(halfV) * (WIDTH / HEIGHT));
      // Fit whichever is tighter: the ring across the width, or bike + ring top to bottom.
      const fitWidth = (ringRadius * 1.12) / Math.tan(halfH);
      const fitHeight = (size.y * 0.72) / Math.tan(halfV);
      const distance = Math.max(fitWidth, fitHeight);
      const target = new THREE.Vector3(0, deck + size.y * 0.4, 0);
      const view = right
        .clone()
        .multiplyScalar(Math.cos(ELEVATION))
        .add(new THREE.Vector3(0, Math.sin(ELEVATION), 0));
      camera.position.copy(target).addScaledVector(view, distance);
      camera.lookAt(target);
      camera.near = distance / 50;
      camera.far = distance * 4;
      camera.updateProjectionMatrix();

      key.position
        .copy(right)
        .multiplyScalar(distance * 0.6)
        .addScaledVector(forward, distance * 0.4);
      key.position.y = size.y * 3;
      key.target.position.copy(target);
      const shadowCam = key.shadow.camera;
      shadowCam.left = shadowCam.bottom = -ringRadius * 1.3;
      shadowCam.right = shadowCam.top = ringRadius * 1.3;
      shadowCam.far = distance * 3;
      shadowCam.updateProjectionMatrix();
      rim.position
        .copy(right)
        .multiplyScalar(-distance)
        .setY(size.y * 2);

      const folder = `/assets/360/${variant.id}/`;
      for (let i = 0; i < FRAME_COUNT; i++) {
        table.rotation.y = (i / FRAME_COUNT) * Math.PI * 2;
        renderer.render(scene, camera);
        const blob = await canvasBlob(renderer.domElement);
        await save(`/__studio/frame?variant=${encodeURIComponent(variant.id)}&index=${i}`, blob);
        done += 1;
        onProgress({ variant: variant.name, frame: i + 1, frames: FRAME_COUNT, done, total });
      }
      manifest.variants[variant.id] = folder;

      table.remove(model);
      disposeObject(model);
    }

    await save('/__studio/manifest', new Blob([JSON.stringify(manifest)], { type: 'application/json' }));
    return manifest;
  } finally {
    platform.dispose();
    envMap.dispose();
    pmrem.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  }
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('frame encode failed'))), 'image/webp', QUALITY),
  );
}

async function save(url: string, body: Blob) {
  const response = await fetch(url, { method: 'POST', body });
  if (!response.ok) throw new Error(`Save failed (${response.status}): ${await response.text()}`);
}

/** Glossy black deck with a crisp white rim and a soft halo. */
function buildTurntable() {
  const group = new THREE.Group();
  // Unlit black: from this low camera any lit surface turns grey with glancing
  // reflections, and the reference look is a pure black deck outlined by the rim.
  const deckMaterial = new THREE.MeshBasicMaterial({ color: '#050505' });
  const deck = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 200, 1), deckMaterial);
  group.add(deck);

  const rimMaterial = new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false });
  const rim = new THREE.Mesh(new THREE.TorusGeometry(1, 0.004, 8, 400), rimMaterial);
  rim.rotation.x = Math.PI / 2;
  group.add(rim);

  const haloMaterial = new THREE.MeshBasicMaterial({
    color: '#ffffff',
    transparent: true,
    opacity: 0.18,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const halo = new THREE.Mesh(new THREE.TorusGeometry(1, 0.014, 8, 400), haloMaterial);
  halo.rotation.x = Math.PI / 2;
  group.add(halo);

  return {
    group,
    fit(halfLength: number) {
      const radius = halfLength * 1.2;
      const height = radius * 0.03;
      deck.scale.set(radius, height, radius);
      deck.position.y = height / 2;
      for (const ring of [rim, halo]) {
        ring.scale.setScalar(radius);
        ring.position.y = height;
      }
      return height;
    },
    dispose() {
      for (const mesh of [deck, rim, halo]) mesh.geometry.dispose();
      deckMaterial.dispose();
      rimMaterial.dispose();
      haloMaterial.dispose();
    },
  };
}

function disposeObject(root: THREE.Object3D) {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) value.dispose();
      material.dispose();
    }
  });
}

import * as THREE from 'three';

/**
 * The showroom set: a dark concrete floor lit by an overhead spot, fading into
 * a black backdrop with a low grey haze along the horizon.
 */
export interface Studio {
  group: THREE.Group;
  spot: THREE.SpotLight;
  /** Re-sizes everything around a model of the given bounding radius. */
  fit(radius: number, height: number): void;
  /** Sizes the soft contact shadow under the vehicle. */
  setFootprint(length: number, width: number, alongX: boolean, lift: number): void;
  dispose(): void;
}

const BACKDROP = {
  top: '#020202',
  horizon: '#323232',
  bottom: '#060606',
};

export function createStudio(renderer: THREE.WebGLRenderer): Studio {
  const group = new THREE.Group();

  // ---------------------------------------------------------- backdrop dome
  const backdropMaterial = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    toneMapped: false,
    uniforms: {
      top: { value: new THREE.Color(BACKDROP.top) },
      horizon: { value: new THREE.Color(BACKDROP.horizon) },
      bottom: { value: new THREE.Color(BACKDROP.bottom) },
      resolution: { value: new THREE.Vector2(1, 1) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 top;
      uniform vec3 horizon;
      uniform vec3 bottom;
      uniform vec2 resolution;
      varying vec3 vDir;
      void main() {
        float y = vDir.y;
        // A glow tied to the screen, always centred behind the bike, falling off to the sides.
        float sx = gl_FragCoord.x / resolution.x - 0.5;
        float glow = 1.0 - smoothstep(0.0, 0.62, abs(sx));
        vec3 haze = mix(horizon * 0.35, horizon * 1.3, glow * glow);
        // It hugs the horizon and dies off upwards, like smoke under a light rig.
        vec3 col = y >= 0.0
          ? mix(haze, top, pow(smoothstep(0.0, 0.34, y), 0.55))
          : mix(haze, bottom, smoothstep(0.0, 0.12, -y));
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
  const backdrop = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), backdropMaterial);
  backdrop.renderOrder = -1;
  const drawingSize = new THREE.Vector2();
  backdrop.onBeforeRender = (r) => {
    backdropMaterial.uniforms.resolution.value.copy(r.getDrawingBufferSize(drawingSize));
  };
  group.add(backdrop);

  // ------------------------------------------------------------------ floor
  const concrete = new THREE.CanvasTexture(concreteCanvas(1536));
  concrete.colorSpace = THREE.SRGBColorSpace;
  concrete.wrapS = concrete.wrapT = THREE.RepeatWrapping;
  concrete.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  const relief = concrete.clone();
  relief.colorSpace = THREE.NoColorSpace;

  const fade = new THREE.CanvasTexture(radialFadeCanvas(512));
  // Large, soft light/dark patches stretched over the whole floor (not tiled),
  // so the surface reads as a real, worn floor instead of one repeated texture.
  const patches = new THREE.CanvasTexture(patchCanvas(256));
  patches.colorSpace = THREE.NoColorSpace;
  const fractures = new THREE.CanvasTexture(fractureCanvas(2048));
  fractures.colorSpace = THREE.NoColorSpace;
  fractures.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  // Matte concrete: uniform high roughness (a roughness map from this dark
  // texture made it read glossy, almost wet) and only a light surface relief.
  const floorMaterial = new THREE.MeshStandardMaterial({
    color: '#a6a29c',
    map: concrete,
    bumpMap: relief,
    // Rugged relief: cracks and breaks read as real dents; roughness keeps it matte.
    bumpScale: 1.15,
    roughness: 0.93,
    metalness: 0,
    alphaMap: fade,
    transparent: true,
  });
  floorMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.patchMap = { value: patches };
    shader.uniforms.fractureMap = { value: fractures };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D patchMap;\nuniform sampler2D fractureMap;')
      .replace(
        '#include <map_fragment>',
        // vAlphaMapUv spans the floor exactly once, so the patches never repeat.
        '#include <map_fragment>\ndiffuseColor.rgb *= mix(0.6, 1.25, texture2D(patchMap, vAlphaMapUv).r) * texture2D(fractureMap, vAlphaMapUv).r;',
      );
  };
  // Seen from underneath, the floor simply disappears so the bike stays visible.
  floorMaterial.side = THREE.FrontSide;

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  group.add(floor);

  // ------------------------------------------------------------ spot light
  const spot = new THREE.SpotLight('#ffffff');
  // A wider, gentler pool so the floor isn't one hot spot in the dark.
  spot.angle = 0.46;
  spot.penumbra = 1;
  spot.decay = 2;
  spot.castShadow = true;
  // Soft, blurred shadow (the renderer uses VSM shadows): wide gradual edges, no hard outline.
  spot.shadow.mapSize.set(1024, 1024);
  spot.shadow.radius = 58;
  spot.shadow.blurSamples = 24;
  spot.shadow.bias = -0.0006;
  spot.shadow.normalBias = 0;
  group.add(spot, spot.target);

  // ------------------------------------------------------- contact shadow
  // A soft dark pool right under the vehicle, the grounded look of a studio shot.
  const contactTexture = new THREE.CanvasTexture(contactCanvas(256));
  const contactMaterial = new THREE.MeshBasicMaterial({
    color: '#000000',
    alphaMap: contactTexture,
    transparent: true,
    depthWrite: false,
    opacity: 0.78,
  });
  const contact = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), contactMaterial);
  contact.rotation.x = -Math.PI / 2;
  contact.renderOrder = 1;
  group.add(contact);

  /** Sizes the contact shadow to the vehicle's footprint. `alongX` = the length runs along x. */
  function setFootprint(length: number, width: number, alongX: boolean, lift: number) {
    const long = length * 1.12;
    const short = Math.max(width * 1.5, length * 0.38);
    contact.scale.set(alongX ? long : short, alongX ? short : long, 1);
    contact.position.y = lift + 0.002;
  }

  function fit(radius: number, height: number) {
    backdrop.scale.setScalar(radius * 30);

    const floorSize = radius * 16;
    floor.scale.set(floorSize, floorSize, 1);
    // A larger tile so cracks and breaks don't visibly repeat.
    const tiles = floorSize / (radius * 2.6);
    concrete.repeat.set(tiles, tiles);
    relief.repeat.set(tiles, tiles);

    const lift = height + radius * 3.2;
    spot.position.set(0, lift, radius * 0.6);
    spot.target.position.set(0, 0, 0);
    // Physical units: intensity scales with distance² to land at a steady brightness.
    spot.intensity = 7.6 * lift * lift;
    spot.distance = 0;
    spot.shadow.camera.near = radius * 0.5;
    spot.shadow.camera.far = lift + radius * 2;
    spot.shadow.camera.updateProjectionMatrix();
  }

  function dispose() {
    backdrop.geometry.dispose();
    backdropMaterial.dispose();
    floor.geometry.dispose();
    floorMaterial.dispose();
    concrete.dispose();
    relief.dispose();
    fade.dispose();
    patches.dispose();
    fractures.dispose();
    contact.geometry.dispose();
    contactMaterial.dispose();
    contactTexture.dispose();
    spot.dispose();
  }

  fit(1, 1);
  return { group, spot, fit, setFootprint, dispose };
}

// --------------------------------------------------------------- textures

/** Tileable concrete: layered value noise plus aggregate speckle. */
function concreteCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(size, size);
  const data = image.data;

  const random = mulberry32(390);
  const octaves = [4, 8, 16, 32, 64, 128, 256].map((cells, i) => ({
    cells,
    // Mostly fine grain, with only gentle large-scale patching (worn asphalt).
    weight: [0.1, 0.1, 0.1, 0.12, 0.14, 0.14, 0.12][i],
    lattice: Float32Array.from({ length: cells * cells }, () => random()),
  }));

  const smooth = (t: number) => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let value = 0;
      for (const { cells, weight, lattice } of octaves) {
        const fx = (x / size) * cells;
        const fy = (y / size) * cells;
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const x1 = (x0 + 1) % cells;
        const y1 = (y0 + 1) % cells;
        const tx = smooth(fx - x0);
        const ty = smooth(fy - y0);
        const top = lattice[y0 * cells + x0] * (1 - tx) + lattice[y0 * cells + x1] * tx;
        const bottom = lattice[y1 * cells + x0] * (1 - tx) + lattice[y1 * cells + x1] * tx;
        value += (top * (1 - ty) + bottom * ty) * weight;
      }
      // Coarse grit on top of the cloudy base: the rough, open surface of old asphalt.
      value += (random() - 0.5) * 0.46;
      const grey = Math.max(0, Math.min(255, 22 + value * 142));
      const i = (y * size + x) * 4;
      data[i] = grey;
      data[i + 1] = grey;
      data[i + 2] = grey * 1.02;
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  // (Fractures are not in this tile: they're drawn once across the whole floor
  // by fractureCanvas, so no crack ever repeats.)

  // Aggregate: bright stone chips that catch the light, plus dark pits.
  for (let n = 0; n < size * 24; n++) {
    const light = random() > 0.4;
    const x = random() * size;
    const y = random() * size;
    const r = light ? 0.4 + random() * 1.7 : 0.4 + random() * 1.3;
    const alpha = light ? 0.2 + random() * 0.45 : 0.2 + random() * 0.35;
    ctx.fillStyle = light ? `rgba(225,220,210,${alpha})` : `rgba(0,0,0,${alpha})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  return canvas;
}

/**
 * Earthquake-style fractures over the whole floor (white = untouched, dark =
 * crack): a few long, jagged faults that branch, with chipped edges and a soft
 * shadow alongside. No closed shapes, and it's drawn once, so nothing repeats.
 */
function fractureCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'miter';
  const random = mulberry32(7310);

  type Path = { points: [number, number][]; width: number };
  const paths: Path[] = [];

  // Jagged fault line: mostly straight runs with sudden small kinks.
  const fault = (x: number, y: number, angle: number, length: number, width: number, depth: number) => {
    const points: [number, number][] = [[x, y]];
    let travelled = 0;
    const heading = angle;
    while (travelled < length) {
      const step = size * (0.004 + random() * 0.009);
      // Wander around the overall heading instead of drifting into curls.
      angle = heading + (angle - heading) * 0.6 + (random() - 0.5) * 0.85;
      x += Math.cos(angle) * step;
      y += Math.sin(angle) * step;
      travelled += step;
      points.push([x, y]);
      if (depth < 2 && random() < 0.045) {
        const turn = (random() > 0.5 ? 1 : -1) * (0.5 + random() * 0.7);
        fault(x, y, angle + turn, length * (0.25 + random() * 0.3), width * 0.55, depth + 1);
      }
    }
    paths.push({ points, width });
  };

  // Just a few faults: a lightly damaged floor, not rubble.
  const faults = 4;
  for (let n = 0; n < faults; n++) {
    // Start near the edges and run across, so faults cross the floor like real ruptures.
    const side = random() * Math.PI * 2;
    const x = size / 2 + Math.cos(side) * size * (0.25 + random() * 0.2);
    const y = size / 2 + Math.sin(side) * size * (0.25 + random() * 0.2);
    const angle = side + Math.PI + (random() - 0.5) * 1.1;
    fault(x, y, angle, size * (0.3 + random() * 0.35), 1.8 + random() * 1.4, 0);
  }

  const trace = (points: [number, number][]) => {
    ctx.beginPath();
    points.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
  };

  // 1. Soft shadow band: the slabs either side sit at slightly different heights.
  for (const { points, width } of paths) {
    trace(points);
    ctx.strokeStyle = 'rgba(0,0,0,0.09)';
    ctx.lineWidth = width * 4;
    ctx.stroke();
  }

  // 2. Spalling: small chips broken off along the edges of the bigger faults.
  for (const { points, width } of paths) {
    if (width < 1.5) continue;
    for (let i = 1; i < points.length; i++) {
      if (random() > 0.18) continue;
      const [px, py] = points[i];
      const chip = width * (1.5 + random() * 3);
      ctx.beginPath();
      const corners = 4 + Math.floor(random() * 3);
      for (let c = 0; c < corners; c++) {
        const a = (c / corners) * Math.PI * 2 + random() * 0.6;
        const r = chip * (0.4 + random() * 0.8);
        const cx = px + Math.cos(a) * r;
        const cy = py + Math.sin(a) * r * 0.7;
        if (c === 0) ctx.moveTo(cx, cy);
        else ctx.lineTo(cx, cy);
      }
      ctx.closePath();
      ctx.fillStyle = `rgba(0,0,0,${0.25 + random() * 0.25})`;
      ctx.fill();
    }
  }

  // 3. The cracks themselves, tapering towards their tips.
  for (const { points, width } of paths) {
    const segments = points.length - 1;
    for (let i = 0; i < segments; i++) {
      const taper = 1 - (i / segments) * 0.7;
      ctx.beginPath();
      ctx.moveTo(...points[i]);
      ctx.lineTo(...points[i + 1]);
      ctx.strokeStyle = 'rgba(0,0,0,0.82)';
      ctx.lineWidth = Math.max(0.6, width * taper);
      ctx.stroke();
    }
  }
  return canvas;
}

/** Elliptical falloff for the contact shadow: dense in the middle, feathered far out. */
function contactCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const c = size / 2;
  const gradient = ctx.createRadialGradient(c, c, 0, c, c, c);
  gradient.addColorStop(0, 'rgba(255,255,255,0.95)');
  gradient.addColorStop(0.3, 'rgba(255,255,255,0.7)');
  gradient.addColorStop(0.6, 'rgba(255,255,255,0.28)');
  gradient.addColorStop(0.85, 'rgba(255,255,255,0.06)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

/** Soft, low-frequency blotches (0–1), used once across the whole floor. */
function patchCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(size, size);
  const random = mulberry32(1290);
  const layers = [3, 6, 12, 24].map((cells, i) => ({
    cells,
    weight: [0.45, 0.3, 0.17, 0.08][i],
    lattice: Float32Array.from({ length: (cells + 1) * (cells + 1) }, () => random()),
  }));
  const smooth = (t: number) => t * t * (3 - 2 * t);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0;
      for (const { cells, weight, lattice } of layers) {
        const fx = (x / size) * cells;
        const fy = (y / size) * cells;
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const tx = smooth(fx - x0);
        const ty = smooth(fy - y0);
        const at = (cx: number, cy: number) => lattice[cy * (cells + 1) + cx];
        const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
        const bottom = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
        v += (top * (1 - ty) + bottom * ty) * weight;
      }
      const grey = Math.round(Math.min(1, Math.max(0, (v - 0.2) / 0.6)) * 255);
      const i = (y * size + x) * 4;
      image.data[i] = image.data[i + 1] = image.data[i + 2] = grey;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** Opaque centre fading to transparent edges, so the floor melts into the haze. */
function radialFadeCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const c = size / 2;
  const gradient = ctx.createRadialGradient(c, c, 0, c, c, c);
  gradient.addColorStop(0, '#fff');
  gradient.addColorStop(0.3, '#fff');
  gradient.addColorStop(0.62, '#7a7a7a');
  gradient.addColorStop(1, '#000');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

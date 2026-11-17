// Copies the Draco and Basis (KTX2) decoders that ship with three.js into
// public/decoders so compressed models load without hitting a third-party CDN.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const libs = resolve(root, 'node_modules/three/examples/jsm/libs');
const out = resolve(root, 'public/decoders');

const folders = [
  ['draco/gltf', 'draco'],
  ['basis', 'basis'],
];

for (const [from, to] of folders) {
  const src = resolve(libs, from);
  if (!existsSync(src)) {
    console.warn(`[decoders] skipped, not found: ${src}`);
    continue;
  }
  const dest = resolve(out, to);
  mkdirSync(dest, { recursive: true });
  // Encoders and readmes aren't needed at runtime.
  cpSync(src, dest, { recursive: true, filter: (path) => !/encoder|README/i.test(path) });
}

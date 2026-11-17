import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';

const root = dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 8 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function reply(res: ServerResponse, status: number, message = '') {
  res.statusCode = status;
  res.end(message);
}

/**
 * Dev-server-only endpoints used by the in-browser tools:
 *   ?render=360       renders the 360° image sequences into public/assets/360/
 *   ?edit=hotspots    saves exact hotspot positions into the model config folder
 * They write to fixed folders only and don't exist in the production build.
 */
function studioTools(): Plugin {
  return {
    name: 'studio-tools',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.method !== 'POST' || !req.url?.startsWith('/__studio/')) return next();
        const url = new URL(req.url, 'http://localhost');
        try {
          const body = await readBody(req);

          if (url.pathname === '/__studio/frame') {
            const variant = url.searchParams.get('variant') ?? '';
            const index = Number(url.searchParams.get('index'));
            if (!/^[a-z0-9-]{1,64}$/.test(variant) || !Number.isInteger(index) || index < 0 || index > 719) {
              return reply(res, 400, 'bad frame parameters');
            }
            const dir = resolve(root, 'public/assets/360', variant);
            mkdirSync(dir, { recursive: true });
            writeFileSync(resolve(dir, `${String(index).padStart(3, '0')}.webp`), body);
            return reply(res, 204);
          }

          if (url.pathname === '/__studio/manifest') {
            const manifest = JSON.parse(body.toString('utf8'));
            mkdirSync(resolve(root, 'public/assets/360'), { recursive: true });
            writeFileSync(resolve(root, 'public/assets/360/manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
            return reply(res, 204);
          }

          if (url.pathname === '/__studio/anchors') {
            const anchors = JSON.parse(body.toString('utf8'));
            if (typeof anchors !== 'object' || anchors === null || Array.isArray(anchors)) {
              return reply(res, 400, 'expected an object');
            }
            const file = resolve(root, 'src/config/models/ktm-390-duke.anchors.json');
            writeFileSync(file, JSON.stringify(anchors, null, 2) + '\n');
            return reply(res, 204);
          }

          return reply(res, 404);
        } catch (error) {
          return reply(res, 400, String(error));
        }
      });
    },
  };
}

/** This machine's Wi-Fi/LAN address, so a QR code shown on localhost can still be opened on a phone. */
function lanOrigin(port: number): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) return `http://${net.address}:${port}`;
    }
  }
  return '';
}

export default defineConfig(({ command }) => ({
  plugins: [react(), studioTools()],
  define: { __LAN_ORIGIN__: JSON.stringify(command === 'serve' ? lanOrigin(5173) : '') },
  // host: true exposes the dev server on the LAN so it can be opened on a phone.
  // Build output and zips are often locked by Windows tools while packaging; watching them crashes the server.
  server: { host: true, watch: { ignored: ['**/dist/**', '**/*.zip'] } },
  preview: { host: true },
  build: { chunkSizeWarningLimit: 900 },
}));

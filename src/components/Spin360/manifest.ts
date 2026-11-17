/** Written by the 360° renderer to public/assets/360/manifest.json. */
export interface SpinManifest {
  frames: number;
  width: number;
  height: number;
  ext: string;
  rendered: string;
  /** variant id → folder holding 000.webp, 001.webp, … */
  variants: Record<string, string>;
}

let manifestRequest: Promise<SpinManifest | null> | null = null;

/** Loaded once per page. Resolves to null when the frames haven't been rendered yet. */
export function loadManifest(): Promise<SpinManifest | null> {
  manifestRequest ??= fetch('/assets/360/manifest.json', { cache: 'no-cache' })
    .then((r) => (r.ok && !(r.headers.get('content-type') ?? '').includes('text/html') ? r.json() : null))
    .catch(() => null);
  return manifestRequest;
}

export function frameUrl(manifest: SpinManifest, variantId: string, index: number) {
  const folder = manifest.variants[variantId];
  if (!folder) return null;
  return `${folder}${String(index).padStart(3, '0')}.${manifest.ext}?v=${encodeURIComponent(manifest.rendered)}`;
}

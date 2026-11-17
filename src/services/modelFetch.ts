export type LoadFailure = 'not-found' | 'invalid' | 'network';

export class ModelLoadError extends Error {
  constructor(
    readonly reason: LoadFailure,
    message: string,
  ) {
    super(message);
    this.name = 'ModelLoadError';
  }
}

/**
 * Downloads a model with byte-level progress. Done by hand rather than via
 * GLTFLoader.load so a missing file is reported as "not found" instead of a
 * parse error (dev servers and SPA hosts often answer 404s with index.html).
 */
export async function fetchModel(url: string, onProgress: (fraction: number | null) => void): Promise<ArrayBuffer> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new ModelLoadError('network', 'The model could not be downloaded.');
  }

  if (response.status === 404) throw new ModelLoadError('not-found', `No model at ${url}`);
  if (!response.ok) throw new ModelLoadError('network', `Server answered ${response.status}`);
  if ((response.headers.get('content-type') ?? '').includes('text/html')) {
    throw new ModelLoadError('not-found', `No model at ${url}`);
  }

  const total = Number(response.headers.get('content-length')) || 0;
  if (!response.body || total === 0) {
    onProgress(null);
    return response.arrayBuffer();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress(Math.min(received / total, 1));
  }

  const buffer = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer.buffer;
}

/** HEAD-checks that a file really exists (and isn't the SPA fallback page). */
export async function assetExists(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    return response.ok && !(response.headers.get('content-type') ?? '').includes('text/html');
  } catch {
    return false;
  }
}

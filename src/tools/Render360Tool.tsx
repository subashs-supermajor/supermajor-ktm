import { useState } from 'react';
import type { ModelConfig } from '../config/models/types';
import { render360, type RenderProgress } from './render360';

/** Dev-only panel (open the page with ?edit=360) that renders the 360° frames. */
export function Render360Tool({ config }: { config: ModelConfig }) {
  const [progress, setProgress] = useState<RenderProgress | null>(null);
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');

  async function start() {
    setState('running');
    setMessage('');
    try {
      await render360(config, setProgress);
      setState('done');
      setMessage('Frames saved to public/assets/360/. Reload the page to see the 360° section.');
    } catch (error) {
      setState('error');
      setMessage((error as Error).message);
    }
  }

  const pct = progress ? Math.round((progress.done / progress.total) * 100) : 0;
  const count = config.variants.filter((v) => v.model).length;

  return (
    <section className="tool" aria-labelledby="tool-title" data-render-state={state}>
      <h2 id="tool-title" className="eyebrow">
        360° renderer
      </h2>
      <p className="note">
        Renders {count} colour{count === 1 ? '' : 's'} × 72 frames from the 3D models into public/assets/360/.
      </p>
      {state === 'running' && progress && (
        <p className="tool__progress">
          {progress.variant} · frame {progress.frame}/{progress.frames} · {pct}%
        </p>
      )}
      {message && <p className={state === 'error' ? 'note note--warn' : 'note'}>{message}</p>}
      <button type="button" className="btn btn--primary" disabled={state === 'running'} onClick={start}>
        {state === 'running' ? 'Rendering…' : state === 'done' ? 'Render again' : 'Render 360° frames'}
      </button>
    </section>
  );
}

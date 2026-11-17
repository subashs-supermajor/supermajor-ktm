import type { EngineStatus } from './viewerEngine';

interface Props {
  status: EngineStatus;
  webgl: boolean;
  modelPath: string;
  fallbackImage?: string;
  displayName: string;
  onRetry: () => void;
  onChooseFile: () => void;
}

/** Loading, error and unsupported-device states for the stage. */
export function StageStatus({ status, webgl, modelPath, fallbackImage, displayName, onRetry, onChooseFile }: Props) {
  if (!webgl) {
    return (
      <div className="status status--card" role="status">
        {fallbackImage && <img className="status__image" src={fallbackImage} alt={displayName} />}
        <h2 className="status__title">3D isn't available in this browser</h2>
        <p className="status__text">
          Your browser or device has WebGL switched off. Try a recent version of Chrome, Safari, Edge or Firefox.
        </p>
      </div>
    );
  }

  if (status.kind === 'ready') return null;

  if (status.kind === 'loading') {
    const pct = status.progress === null ? null : Math.round(status.progress * 100);
    return (
      <div className="status status--loading" role="status" aria-live="polite">
        <span className="status__label">
          Loading model{pct !== null && <span className="status__pct">{pct}%</span>}
        </span>
        <span className="progress" data-indeterminate={pct === null}>
          <span className="progress__bar" style={{ transform: `scaleX(${pct === null ? 0.3 : pct / 100})` }} />
        </span>
      </div>
    );
  }

  const copy: Record<typeof status.reason, { title: string; text: string; action: 'file' | 'retry' }> = {
    'not-found': {
      title: 'The 3D model hasn’t been added yet',
      text: `Place the model at public${modelPath}, or drop a .glb file onto this stage to preview it.`,
      action: 'file',
    },
    invalid: {
      title: 'This file couldn’t be read',
      text: 'It doesn’t look like a valid glTF/GLB model. Export it again as binary glTF (.glb) and retry.',
      action: 'file',
    },
    network: {
      title: 'The model didn’t download',
      text: 'Check the connection and try again.',
      action: 'retry',
    },
    'context-lost': {
      title: 'The 3D view stopped responding',
      text: 'The graphics processor reset. Reloading the viewer usually fixes it.',
      action: 'retry',
    },
  };
  const { title, text, action } = copy[status.reason];

  return (
    <div className="status status--card" role="alert">
      <h2 className="status__title">{title}</h2>
      <p className="status__text">{text}</p>
      {action === 'file' ? (
        <button type="button" className="btn btn--ghost" onClick={onChooseFile}>
          Choose a .glb file
        </button>
      ) : (
        <button type="button" className="btn btn--ghost" onClick={onRetry}>
          Reload viewer
        </button>
      )}
    </div>
  );
}

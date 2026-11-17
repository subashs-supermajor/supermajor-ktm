import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import type { HotspotAnchor, ModelConfig } from '../../config/models/types';
import { ViewerEngine, type EngineStatus } from './viewerEngine';

interface Props {
  config: ModelConfig;
  modelUrl: string;
  reducedMotion: boolean;
  showHotspots: boolean;
  activeHotspotId: string | null;
  onEngine: (engine: ViewerEngine | null) => void;
  onStatus: (status: EngineStatus) => void;
  onInteract: (kind: 'rotate' | 'zoom') => void;
  onFreeCamera: () => void;
  onHotspotSelect: (id: string) => void;
  /** Called when the WebGL context is lost so the parent can remount the viewer. */
  onContextLost?: () => void;
  /** Placement tool: a click (not a drag) on the model reports the surface under it. */
  onSurfacePick?: (anchor: HotspotAnchor) => void;
}

const STEP = Math.PI / 18; // 10° per arrow key press

export function MotorcycleViewer({
  config,
  modelUrl,
  reducedMotion,
  showHotspots,
  activeHotspotId,
  onEngine,
  onStatus,
  onInteract,
  onFreeCamera,
  onHotspotSelect,
  onContextLost,
  onSurfacePick,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pressRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const engineRef = useRef<ViewerEngine | null>(null);
  const markerRefs = useRef(new Map<string, HTMLButtonElement>());

  // Callbacks change identity on every App render; the engine reads them through a ref.
  const callbacks = useRef({ onStatus, onInteract, onFreeCamera, onContextLost });
  callbacks.current = { onStatus, onInteract, onFreeCamera, onContextLost };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const engine = new ViewerEngine(container, {
      frontAxis: config.frontAxis,
      reducedMotion,
      onStatus: (s) => callbacks.current.onStatus(s),
      onInteract: (k) => callbacks.current.onInteract(k),
      onFreeCamera: () => callbacks.current.onFreeCamera(),
      onContextLost: () => callbacks.current.onContextLost?.(),
      onRender: () => positionMarkers(engine),
    });
    engine.setHotspots(config.hotspots);
    engineRef.current = engine;
    onEngine(engine);

    return () => {
      onEngine(null);
      engineRef.current = null;
      engine.dispose();
    };
    // The engine is created once per mount; reducedMotion is synced separately below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  useEffect(() => {
    engineRef.current?.load(modelUrl);
  }, [modelUrl, config]);

  useEffect(() => {
    engineRef.current?.setReducedMotion(reducedMotion);
  }, [reducedMotion]);

  // Runs after every frame, so it writes styles directly instead of setting state.
  function positionMarkers(engine: ViewerEngine) {
    for (const [id, marker] of markerRefs.current) {
      const point = engine.projectHotspot(id);
      if (!point) continue;
      marker.style.transform = `translate3d(${point.x.toFixed(1)}px, ${point.y.toFixed(1)}px, 0)`;
      marker.dataset.hidden = String(!point.onScreen);
      marker.dataset.dim = String(point.facing < -0.05);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const engine = engineRef.current;
    if (!engine || event.target !== event.currentTarget) return;
    const actions: Record<string, () => void> = {
      ArrowLeft: () => engine.nudge(-STEP, 0),
      ArrowRight: () => engine.nudge(STEP, 0),
      ArrowUp: () => engine.nudge(0, -STEP / 2),
      ArrowDown: () => engine.nudge(0, STEP / 2),
    };
    const action = actions[event.key];
    if (action) {
      event.preventDefault();
      action();
    }
  }

  // A click is a short press that barely moved; anything else is an orbit drag.
  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    pressRef.current = { x: event.clientX, y: event.clientY, t: performance.now() };
  }

  function handlePointerUp(event: PointerEvent<HTMLDivElement>) {
    const press = pressRef.current;
    pressRef.current = null;
    if (!onSurfacePick || !press || event.target !== engineRef.current?.canvas) return;
    const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y);
    if (moved > 5 || performance.now() - press.t > 500) return;
    const anchor = engineRef.current?.pickSurface(event.clientX, event.clientY);
    if (anchor) onSurfacePick(anchor);
  }

  return (
    <div
      ref={containerRef}
      className="viewer"
      data-placing={Boolean(onSurfacePick)}
      tabIndex={0}
      role="application"
      aria-roledescription="3D viewer"
      aria-label={`${config.displayName}, 3D view. Arrow keys rotate.`}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
    >
      <div className="hotspots" hidden={!showHotspots}>
        {config.hotspots.map((hotspot, index) => (
          <button
            key={hotspot.id}
            ref={(el) => {
              if (el) markerRefs.current.set(hotspot.id, el);
              else markerRefs.current.delete(hotspot.id);
            }}
            type="button"
            className="hotspot"
            data-hidden="true"
            aria-expanded={activeHotspotId === hotspot.id}
            aria-label={`${hotspot.title}: show details`}
            onClick={() => onHotspotSelect(hotspot.id)}
          >
            <span className="hotspot__dot" aria-hidden="true" />
            <span className="hotspot__label" aria-hidden="true">
              <span className="hotspot__index">{String(index + 1).padStart(2, '0')}</span>
              {hotspot.title}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

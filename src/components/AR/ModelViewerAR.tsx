import { useEffect, useRef, useState } from 'react';
import type { Axis, Variant } from '../../config/models/types';
import { ARIcon, CloseIcon } from '../Icons';
import {
  installSurfaceGate,
  restoreModelVisibility,
  type SurfaceIssue,
  type SurfaceState,
} from './arSurfaceGate';

const SURFACE_TIPS: Record<SurfaceIssue, string> = {
  tilted: 'Point at flat floor',
  high: 'Point at the floor',
  cramped: 'Need more open space',
  far: 'Move a little closer',
  close: 'Step back a little',
};

// Registers the <model-viewer> custom element globally.
import '@google/model-viewer';

interface Props {
  glb: string;
  title: string;
  variantId: string;
  variants?: Variant[];
  frontAxis: Axis;
  onClose: () => void;
  onSelectVariant?: (variantId: string) => void;
}

interface MVElement extends HTMLElement {
  canActivateAR: boolean;
  activateAR(): Promise<void>;
}

function getModelViewerScale(el: HTMLElement | null): number {
  if (!el) return 1;
  try {
    const target = el as any;
    const syms = Object.getOwnPropertySymbols(target);
    for (let i = 0; i < syms.length; i++) {
      try {
        const val = target[syms[i]];
        if (val && typeof val === 'object' && val.scenePivot?.scale) {
          const x = val.scenePivot.scale.x;
          if (typeof x === 'number' && Number.isFinite(x) && x > 0) return x;
        }
      } catch {
        // safe ignore
      }
    }
  } catch {
    // fallback
  }
  return 1;
}

export function ModelViewerAR({
  glb,
  title,
  variantId,
  variants,
  frontAxis,
  onClose,
  onSelectVariant,
}: Props) {
  const mvRef = useRef<HTMLElement>(null);
  const [selectedVariantId, setSelectedVariantId] = useState(variantId);
  const [progress, setProgress] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [arAvailable, setArAvailable] = useState(false);
  const [scalePercent, setScalePercent] = useState(100);
  const [arPhase, setArPhase] = useState<'idle' | 'scanning' | 'placed'>('idle');
  const [surface, setSurface] = useState<SurfaceState>({ phase: 'scanning' });

  // Hold the bike back in WebXR until a suitable floor is found.
  useEffect(() => installSurfaceGate(mvRef.current, setSurface), []);

  useEffect(() => {
    setSelectedVariantId(variantId);
  }, [variantId]);

  const currentVariant = variants?.find((v) => v.id === selectedVariantId) ?? variants?.[0];
  const activeGlb = currentVariant?.model ?? glb;

  function handleVariantChange(id: string) {
    if (id === selectedVariantId) return;
    setSelectedVariantId(id);
    setLoaded(false);
    setProgress(0);
    onSelectVariant?.(id);
  }

  function resetScale() {
    const mv = mvRef.current as any;
    if (!mv) return;
    try {
      for (let proto = mv; proto; proto = Object.getPrototypeOf(proto)) {
        const sym = Object.getOwnPropertySymbols(proto).find((s) => s.description === 'renderer');
        if (sym) {
          const ar = mv[sym]?.arRenderer;
          if (ar && 'goalScale' in ar) ar.goalScale = 1;
          break;
        }
      }
      const syms = Object.getOwnPropertySymbols(mv);
      for (let i = 0; i < syms.length; i++) {
        try {
          const val = mv[syms[i]];
          if (val && typeof val === 'object' && val.scenePivot?.scale) {
            val.scenePivot.scale.set(1, 1, 1);
            setScalePercent(100);
            return;
          }
        } catch {
          // safe ignore
        }
      }
    } catch {
      // fallback
    }
    setScalePercent(100);
  }

  // Scene Viewer and Quick Look both need an absolute HTTPS URL.
  const absGlb = new URL(activeGlb, window.location.href).href;
  // Pre-built USDZ for iOS Quick Look — correct colour, better quality than auto-convert.
  // Falls back to model-viewer's auto-conversion when the file isn't deployed yet.
  const iosUsdz = currentVariant?.usdz
    ? new URL(currentVariant.usdz, window.location.href).href
    : undefined;
  // Use the 360-render frame-0 as the poster so something shows before the GLB loads.
  const poster = `/assets/360/${currentVariant?.id ?? selectedVariantId}/000.webp`;
  // Open on the side, where length and height both read clearly.
  const orbit = frontAxis.endsWith('z') ? '70deg 75deg 105%' : '-20deg 75deg 105%';

  useEffect(() => {
    const mv = mvRef.current as MVElement | null;
    if (!mv) return;

    function onProgress(e: Event) {
      const p = (e as CustomEvent<{ totalProgress: number }>).detail.totalProgress;
      setProgress(Math.round(p * 100));
    }

    function onLoad() {
      setLoaded(true);
      setArAvailable(Boolean(mv!.canActivateAR));
    }

    function onArStatus(e: Event) {
      const status = (e as CustomEvent<{ status: string }>).detail?.status;
      if (status === 'session-started') {
        setSurface({ phase: 'scanning' });
        setArPhase('scanning');
      } else if (status === 'object-placed') setArPhase('placed');
      else if (status === 'not-presenting') {
        restoreModelVisibility(mv);
        setArPhase('idle');
      }
    }

    setLoaded(false);
    setProgress(0);
    mv.addEventListener('progress', onProgress);
    mv.addEventListener('load', onLoad);
    mv.addEventListener('ar-status', onArStatus);

    return () => {
      mv.removeEventListener('progress', onProgress);
      mv.removeEventListener('load', onLoad);
      mv.removeEventListener('ar-status', onArStatus);
    };
  }, [absGlb]);

  // Pinch-scaling in WebXR fires no DOM events, so read the scale every frame while AR is open.
  useEffect(() => {
    const mv = mvRef.current;
    if (!mv || arPhase === 'idle') return;

    let raf = 0;
    const tick = () => {
      const pct = Math.round(getModelViewerScale(mv) * 100);
      setScalePercent((prev) => (prev === pct ? prev : pct));
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [arPhase]);

  function onBackdrop(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose();
  }

  return (
    <div
      className="ar-overlay"
      onClick={onBackdrop}
      role="dialog"
      aria-modal="true"
      aria-label={`${title} — AR viewer`}
    >
      <div className="ar-overlay__panel">
        <div className="ar-overlay__head">
          <span className="eyebrow">View in your space</span>
          <button className="ar-overlay__close icon-btn" onClick={onClose} aria-label="Close AR viewer">
            <CloseIcon />
          </button>
        </div>

        {/* Wrapper lets the fallback img and HTML UI overlay sit alongside model-viewer
            so controls are 100% immune to Safari WebKit Shadow-DOM stacking bugs. */}
        <div className="ar-viewer-wrap">
          <model-viewer
            ref={mvRef}
            src={absGlb}
            alt={title}
            poster={poster}
            ios-src={iosUsdz}
            ar=""
            ar-modes="webxr scene-viewer quick-look"
            ar-scale="auto"
            ar-placement="floor"
            ar-usdz-max-texture-size="1024"
            camera-controls=""
            camera-orbit={orbit}
            auto-rotate=""
            shadow-intensity="1"
            environment-image="neutral"
            exposure="1.5"
            tone-mapping="commerce"
            loading="eager"
            reveal="auto"
            class="ar-viewer"
          >
            {/* Surface scanning guidance — shown during WebXR before model is placed */}
            {arPhase === 'scanning' && surface.phase === 'scanning' && (
              <div className="ar-surface-hint ar-webxr-only" aria-live="polite">
                <div className="ar-surface-hint__ring" />
                <p className="ar-surface-hint__text">Scanning floor… move phone slowly</p>
              </div>
            )}
            {arPhase === 'scanning' && surface.phase === 'unsuitable' && (
              <div className="ar-surface-hint ar-surface-hint--bad ar-webxr-only" role="alert">
                <div className="ar-surface-hint__ring" />
                <p className="ar-surface-hint__text">
                  <strong>Can’t place here</strong>
                  <span>{SURFACE_TIPS[surface.issue]}</span>
                </p>
              </div>
            )}
            {arPhase === 'placed' && (
              <div className="ar-surface-hint ar-surface-hint--placed ar-webxr-only" aria-live="polite">
                <p className="ar-surface-hint__text">Pinch to resize · Drag to move</p>
              </div>
            )}

            {/* Slotted WebXR controls for Android WebXR camera overlay */}
            <div className="ar-xr-scale ar-webxr-only interactive" role="status" onClick={resetScale}>
              {scalePercent}%
            </div>

            {/* Replaces model-viewer's own floating AR button */}
            <span slot="ar-button" hidden />
          </model-viewer>

          <img className="ar-viewer-image" src={poster} alt={`${title}, ${currentVariant?.name ?? ''}`} draggable={false} />

          {/* HTML UI OVERLAY: direct sibling of model-viewer with z-index: 10.
              Guaranteed to render reliably on iPhone Safari, Android, and Desktop. */}
          <div className="ar-viewer-ui">
            {/* Model scale % badge (top center, safely below camera cutout) */}
            <div
              className="ar-scale-badge"
              role="status"
              title="Model scale (click to reset to 100%)"
              onClick={resetScale}
            >
              <span className="ar-scale-badge__lbl">Size</span>
              <span className="ar-scale-badge__val">{scalePercent}%</span>
            </div>

            {/* Color variant switching pill (bottom right) */}
            {variants && variants.length > 1 && (
              <div className="ar-variant-pill" role="radiogroup" aria-label="Select colour">
                <span className="ar-variant-pill__name">{currentVariant?.name ?? 'White'}</span>
                <div className="ar-variant-pill__dots">
                  {variants.map((v) => {
                    const isSelected = v.id === selectedVariantId;
                    const solidColor =
                      v.id === 'variant-white' || v.name.toLowerCase().includes('white')
                        ? '#FFFFFF'
                        : v.id === 'variant-orange' || v.name.toLowerCase().includes('orange')
                          ? '#E8521C'
                          : v.id === 'variant-red' || v.name.toLowerCase().includes('red')
                            ? '#C01820'
                            : v.swatch[0];

                    return (
                      <button
                        key={v.id}
                        type="button"
                        role="radio"
                        aria-checked={isSelected}
                        aria-label={v.name}
                        className="ar-variant-pill__dot"
                        data-active={isSelected ? 'true' : 'false'}
                        style={{ backgroundColor: solidColor }}
                        onClick={() => handleVariantChange(v.id)}
                      />
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="ar-overlay__foot">

          <button
            type="button"
            className="btn btn--primary ar-launch"
            disabled={!loaded || !arAvailable}
            onClick={() => (mvRef.current as MVElement | null)?.activateAR()}
          >
            {!loaded && <span className="ar-launch__fill" style={{ width: `${progress}%` }} aria-hidden="true" />}
            <span className="ar-launch__label">
              <ARIcon /> {loaded ? 'Launch in AR' : `Loading 3D model ${progress}%`}
            </span>
          </button>

          <p className="ar-overlay__hint">
            {!loaded
              ? 'Getting AR ready…'
              : arAvailable
                ? 'Tap "Launch in AR" to place the bike in your room at real size.'
                : window.location.protocol === 'https:'
                  ? 'AR isn’t supported on this device.'
                  : 'AR needs HTTPS. It will work once the site is hosted.'}
          </p>
        </div>
      </div>
    </div>
  );
}

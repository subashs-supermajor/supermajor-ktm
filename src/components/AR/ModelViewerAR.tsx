import { useEffect, useRef, useState } from 'react';
import type { Axis, Variant } from '../../config/models/types';
import { ARIcon, CloseIcon, DimensionsIcon } from '../Icons';

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

type Vec = { x: number; y: number; z: number };

interface MVElement extends HTMLElement {
  canActivateAR: boolean;
  activateAR(): Promise<void>;
  getDimensions(): Vec;
  getBoundingBoxCenter(): Vec;
  queryHotspot(name: string): { canvasPosition: Vec; facingCamera: boolean } | null;
}

interface Measure {
  key: 'length' | 'height' | 'width';
  label: string;
  value: number;
  from: Vec;
  to: Vec;
}

const fmt = (v: Vec) => `${v.x}m ${v.y}m ${v.z}m`;
const mid = (a: Vec, b: Vec): Vec => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });
const fmtDim = (metres: number) => {
  const cm = Math.round(metres * 100);
  const totalIn = metres / 0.0254;
  const ft = Math.floor(totalIn / 12);
  const inch = Math.round(totalIn % 12);
  const ftPart = ft > 0 ? `${ft}′` : '';
  const inPart = inch > 0 || ft === 0 ? `${inch}″` : '';
  return `${cm} cm / ${ftPart}${inPart}`;
};

/**
 * Three edges of the bounding box meeting at one bottom corner on the side the
 * camera opens on: length along the nose axis, width across, height up.
 */
function measuresFor(size: Vec, centre: Vec, frontAxis: Axis): Measure[] {
  if (!size || !centre) return [];
  const lengthOnZ = frontAxis.endsWith('z');
  const sx = typeof size.x === 'number' && Number.isFinite(size.x) ? size.x : 0.8;
  const sy = typeof size.y === 'number' && Number.isFinite(size.y) ? size.y : 1.1;
  const sz = typeof size.z === 'number' && Number.isFinite(size.z) ? size.z : 2.0;
  const safeSize = { x: sx, y: sy, z: sz };
  const cx = typeof centre.x === 'number' && Number.isFinite(centre.x) ? centre.x : 0;
  const cy = typeof centre.y === 'number' && Number.isFinite(centre.y) ? centre.y : 0.5;
  const cz = typeof centre.z === 'number' && Number.isFinite(centre.z) ? centre.z : 0;
  const safeCentre = { x: cx, y: cy, z: cz };

  const half = { x: safeSize.x / 2, y: safeSize.y / 2, z: safeSize.z / 2 };
  const corner: Vec = { x: safeCentre.x + half.x, y: safeCentre.y - half.y, z: safeCentre.z + half.z };
  const along = (axis: 'x' | 'y' | 'z'): Vec => ({ ...corner, [axis]: safeCentre[axis] - half[axis] });
  const up: Vec = { ...corner, y: safeCentre.y + half.y };
  const lenAxis = lengthOnZ ? 'z' : 'x';
  const widAxis = lengthOnZ ? 'x' : 'z';
  return [
    { key: 'length', label: 'Length', value: safeSize[lenAxis], from: along(lenAxis), to: corner },
    { key: 'height', label: 'Height', value: safeSize.y, from: corner, to: up },
    { key: 'width', label: 'Width', value: safeSize[widAxis], from: along(widAxis), to: corner },
  ];
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
  const linesRef = useRef<SVGSVGElement>(null);
  const [selectedVariantId, setSelectedVariantId] = useState(variantId);
  const [progress, setProgress] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [measures, setMeasures] = useState<Measure[] | null>(null);
  const [showDims, setShowDims] = useState(false);
  const [arAvailable, setArAvailable] = useState(false);
  const [scalePercent, setScalePercent] = useState(100);
  const [arPhase, setArPhase] = useState<'idle' | 'scanning' | 'placed'>('idle');

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

    function calculateMeasures() {
      if (!mv) return;
      try {
        const dims = mv.getDimensions?.();
        const center = mv.getBoundingBoxCenter?.();
        if (dims && center) {
          setMeasures(measuresFor(dims, center, frontAxis));
        }
      } catch (err) {
        console.warn('Could not calculate AR measures:', err);
      }
    }

    function onLoad() {
      setLoaded(true);
      setArAvailable(Boolean(mv!.canActivateAR));
      calculateMeasures();
    }

    function onArStatus(e: Event) {
      const status = (e as CustomEvent<{ status: string }>).detail?.status;
      if (status === 'session-started') setArPhase('scanning');
      else if (status === 'object-placed') setArPhase('placed');
      else if (status === 'not-presenting') setArPhase('idle');
    }

    setLoaded(false);
    setProgress(0);
    mv.addEventListener('progress', onProgress);
    mv.addEventListener('load', onLoad);
    mv.addEventListener('camera-change', calculateMeasures);
    mv.addEventListener('ar-status', onArStatus);

    return () => {
      mv.removeEventListener('progress', onProgress);
      mv.removeEventListener('load', onLoad);
      mv.removeEventListener('camera-change', calculateMeasures);
      mv.removeEventListener('ar-status', onArStatus);
    };
  }, [frontAxis, absGlb]);

  // Track live model scale in percentage (especially during AR scaling).
  useEffect(() => {
    const mv = mvRef.current;
    if (!mv) return;

    const checkScale = () => {
      const s = getModelViewerScale(mv);
      setScalePercent(Math.round(s * 100));
    };

    mv.addEventListener('camera-change', checkScale);
    mv.addEventListener('ar-status', checkScale);

    return () => {
      mv.removeEventListener('camera-change', checkScale);
      mv.removeEventListener('ar-status', checkScale);
    };
  }, []);

  // Guide lines follow the hotspot ends every time the camera (or AR view) moves.
  useEffect(() => {
    const mv = mvRef.current as MVElement | null;
    const svg = linesRef.current;
    if (!mv || !svg || !measures || !showDims) return;

    const draw = () => {
      for (const m of measures) {
        const line = svg.querySelector<SVGLineElement>(`[data-line="${m.key}"]`);
        const a = mv.queryHotspot(`hotspot-${m.key}-a`);
        const b = mv.queryHotspot(`hotspot-${m.key}-b`);
        if (!line || !a || !b) continue;
        line.setAttribute('x1', String(a.canvasPosition.x));
        line.setAttribute('y1', String(a.canvasPosition.y));
        line.setAttribute('x2', String(b.canvasPosition.x));
        line.setAttribute('y2', String(b.canvasPosition.y));
      }
    };

    const raf = requestAnimationFrame(draw);
    mv.addEventListener('camera-change', draw);
    mv.addEventListener('ar-status', draw);
    window.addEventListener('resize', draw);
    return () => {
      cancelAnimationFrame(raf);
      mv.removeEventListener('camera-change', draw);
      mv.removeEventListener('ar-status', draw);
      window.removeEventListener('resize', draw);
    };
  }, [measures, showDims]);

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
            auto-rotate={showDims ? undefined : ''}
            shadow-intensity="1"
            environment-image="neutral"
            exposure="1.5"
            tone-mapping="commerce"
            loading="eager"
            reveal="auto"
            class="ar-viewer"
            data-dims={showDims ? 'on' : 'off'}
          >
            {/* Surface scanning guidance — shown during WebXR before model is placed */}
            {arPhase === 'scanning' && (
              <div className="ar-surface-hint ar-webxr-only" aria-live="polite">
                <div className="ar-surface-hint__ring" />
                <p className="ar-surface-hint__text">Move camera slowly over a flat surface</p>
              </div>
            )}
            {arPhase === 'placed' && (
              <div className="ar-surface-hint ar-surface-hint--placed ar-webxr-only" aria-live="polite">
                <p className="ar-surface-hint__text">Pinch to resize · Drag to move</p>
              </div>
            )}

            {/* Slotted WebXR controls for Android WebXR camera overlay */}
            <div className="ar-scale-badge ar-webxr-only" role="status" onClick={resetScale}>
              <span className="ar-scale-badge__val">{scalePercent} %</span>
            </div>

            {measures && (
              <button
                type="button"
                className="ar-dims-toggle ar-webxr-only"
                aria-pressed={showDims}
                onClick={() => {
                  setShowDims((v) => !v);
                }}
              >
                <DimensionsIcon />
              </button>
            )}

            {variants && variants.length > 1 && (
              <div className="ar-variant-pill ar-webxr-only" role="radiogroup" aria-label="Select colour">
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

            {measures?.map((m) => [
              <span key={`${m.key}-a`} slot={`hotspot-${m.key}-a`} data-position={fmt(m.from)} className="ar-dim-end" />,
              <span key={`${m.key}-b`} slot={`hotspot-${m.key}-b`} data-position={fmt(m.to)} className="ar-dim-end" />,
              <span key={m.key} slot={`hotspot-${m.key}`} data-position={fmt(mid(m.from, m.to))} className="ar-dim-label">
                <span className="ar-dim-label__name">{m.label}</span> {fmtDim(m.value)}
              </span>,
            ])}

            <svg ref={linesRef} className="ar-dim-lines" aria-hidden="true">
              {measures?.map((m) => <line key={m.key} data-line={m.key} />)}
            </svg>

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

          {showDims && measures && (
            <p className="ar-dims-summary">
              {measures.map((m) => (
                <span key={m.key}>
                  {m.label} <b>{fmtDim(m.value)}</b>
                </span>
              ))}
              <span>
                Scale <b>{scalePercent} %</b>
              </span>
            </p>
          )}
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

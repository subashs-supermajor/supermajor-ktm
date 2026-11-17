import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import type { Variant } from '../../config/models/types';
import { useInView } from '../../hooks/useInView';
import { track } from '../../services/analytics';
import { ArrowIcon } from '../Icons';
import { frameUrl, loadManifest, type SpinManifest } from './manifest';

interface Props {
  displayName: string;
  variants: Variant[];
  selectedId: string;
  reducedMotion: boolean;
  onSelect: (id: string) => void;
  /** Buttons shown beside the colour picker (AR, share). */
  actions?: ReactNode;
}

/** Decoded frames per variant, kept for the session so switching back is instant. */
const frameCache = new Map<string, HTMLImageElement[]>();

/** Pixels of drag per frame, relative to the stage width: one full turn ≈ one stage width. */
const DRAG_TURN = 1;
const AUTO_SPIN_MS = 90;

export function Spin360Section({ displayName, variants, selectedId, reducedMotion, onSelect, actions }: Props) {
  const sectionRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fadeRef = useRef<HTMLCanvasElement>(null);
  const paintedVariant = useRef<string | null>(null);
  const inView = useInView(sectionRef, '300px');

  const [manifest, setManifest] = useState<SpinManifest | null | undefined>(undefined);
  const [loaded, setLoaded] = useState(0);
  const [frame, setFrame] = useState(0);
  const [autoSpin, setAutoSpin] = useState(false);
  const drag = useRef<{ x: number; frame: number } | null>(null);
  const interacted = useRef(false);

  const variant = variants.find((v) => v.id === selectedId) ?? variants[0];
  const total = manifest?.frames ?? 0;
  const hasFrames = Boolean(manifest && manifest.variants[variant.id]);

  useEffect(() => {
    if (inView) loadManifest().then(setManifest);
  }, [inView]);

  // Load every frame of the selected colour; draw as soon as the current one arrives.
  useEffect(() => {
    if (!manifest || !hasFrames) return;
    let images = frameCache.get(variant.id);
    if (!images) {
      images = Array.from({ length: manifest.frames }, (_, i) => {
        const img = new Image();
        img.decoding = 'async';
        img.src = frameUrl(manifest, variant.id, i) ?? '';
        return img;
      });
      frameCache.set(variant.id, images);
    }
    const list = images;
    const count = () => list.filter((img) => img.complete && img.naturalWidth > 0).length;
    setLoaded(count());
    const onLoad = () => setLoaded(count());
    list.forEach((img) => img.addEventListener('load', onLoad));
    return () => list.forEach((img) => img.removeEventListener('load', onLoad));
  }, [manifest, hasFrames, variant.id]);

  // Paint the current frame (falls back to the nearest loaded one while loading).
  useEffect(() => {
    const canvas = canvasRef.current;
    const images = frameCache.get(variant.id);
    if (!canvas || !manifest || !images) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const ready = (img: HTMLImageElement) => img.complete && img.naturalWidth > 0;
    const changedColour = paintedVariant.current !== null && paintedVariant.current !== variant.id;
    let img = images[frame];
    // On a colour change, hold the old picture until the same angle is ready.
    if (changedColour && !ready(img)) return;
    if (!ready(img)) img = images.find(ready) ?? img;
    if (!ready(img)) return;

    // First picture of a new colour: keep the old one on top and fade it away.
    const fade = fadeRef.current;
    if (changedColour && fade && !reducedMotion) {
      fade.width = canvas.width;
      fade.height = canvas.height;
      fade.getContext('2d')?.drawImage(canvas, 0, 0);
      fade.style.transition = 'none';
      fade.style.opacity = '1';
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          fade.style.transition = 'opacity 650ms ease';
          fade.style.opacity = '0';
        }),
      );
    }
    paintedVariant.current = variant.id;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  }, [frame, loaded, manifest, variant.id, reducedMotion]);

  const allLoaded = total > 0 && loaded >= total;

  // Slow showroom spin until the visitor takes over.
  useEffect(() => {
    if (!autoSpin || !allLoaded || !inView || reducedMotion) return;
    const timer = window.setInterval(() => setFrame((f) => (f + 1) % total), AUTO_SPIN_MS);
    return () => window.clearInterval(timer);
  }, [autoSpin, allLoaded, inView, reducedMotion, total]);

  function takeOver() {
    setAutoSpin(false);
    if (!interacted.current) {
      interacted.current = true;
      track('rotation_interaction', { section: '360' });
    }
  }

  const step = (n: number) => {
    takeOver();
    setFrame((f) => (((f + n) % total) + total) % total);
  };

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (!allLoaded) return;
    takeOver();
    drag.current = { x: e.clientX, frame };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const start = drag.current;
    const stage = stageRef.current;
    if (!start || !stage) return;
    const perFrame = (stage.clientWidth * DRAG_TURN) / total;
    const moved = Math.round((e.clientX - start.x) / perFrame);
    setFrame((((start.frame + moved) % total) + total) % total);
  }

  function onPointerUp() {
    drag.current = null;
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const big = Math.round(total / 8);
    const map: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, PageDown: big, PageUp: -big };
    const n = map[e.key];
    if (n && allLoaded) {
      e.preventDefault();
      step(e.shiftKey ? n * big : n);
    }
  }

  const degrees = total ? Math.round((frame / total) * 360) : 0;

  return (
    <section ref={sectionRef} className="spin" aria-labelledby="spin-title">
      <header className="spin__head">
        <span className="eyebrow">360° view</span>
        <h2 id="spin-title" className="spin__title">
          {displayName}
        </h2>
      </header>

      <div className="spin__frame">
        <div
          ref={stageRef}
          className="spin__stage"
          data-ready={allLoaded}
          tabIndex={hasFrames ? 0 : -1}
          role={hasFrames ? 'slider' : undefined}
          aria-label={hasFrames ? `${displayName}, ${variant.name}. Rotate with arrow keys or drag.` : undefined}
          aria-valuemin={hasFrames ? 0 : undefined}
          aria-valuemax={hasFrames ? 359 : undefined}
          aria-valuenow={hasFrames ? degrees : undefined}
          aria-valuetext={hasFrames ? `${degrees} degrees` : undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={onKeyDown}
        >
          {hasFrames && manifest && (
            <>
              <canvas ref={canvasRef} className="spin__canvas" width={manifest.width} height={manifest.height} />
              <canvas ref={fadeRef} className="spin__canvas spin__fade" aria-hidden="true" />
            </>
          )}

          {hasFrames && !allLoaded && (
            <div className="spin__loading" role="status">
              <span className="status__label">
                Loading 360°<span className="status__pct">{Math.round((loaded / Math.max(total, 1)) * 100)}%</span>
              </span>
            </div>
          )}

          {manifest !== undefined && !hasFrames && (
            <div className="spin__empty" role="status">
              <p className="status__title">360° view coming soon</p>
              <p className="note">
                The 360° frames for this colour haven’t been rendered yet.
                {import.meta.env.DEV && (
                  <>
                    {' '}
                    <a className="link-btn" href="/?edit=360">
                      Open the renderer
                    </a>
                  </>
                )}
              </p>
            </div>
          )}

          {/* {hasFrames && (
            <span className="spin__handle" aria-hidden="true">
              <ArrowIcon flip />
              <ArrowIcon />
            </span>
          )} */}
        </div>

        {hasFrames && (
          <>
            <button
              type="button"
              className="spin__nav spin__nav--prev"
              aria-label="Rotate left"
              disabled={!allLoaded}
              onClick={() => step(-Math.round(total / 8))}
            >
              <ArrowIcon flip />
            </button>
            <button
              type="button"
              className="spin__nav spin__nav--next"
              aria-label="Rotate right"
              disabled={!allLoaded}
              onClick={() => step(Math.round(total / 8))}
            >
              <ArrowIcon />
            </button>
          </>
        )}
      </div>

      <div className="spin__foot">
        {/* <p className="hint">{hasFrames ? 'Drag or swipe to spin' : ' '}</p> */}
        <div className="spin__colours" role="radiogroup" aria-label="Colour">
          <span className="spin__colour-name">{variant.name}</span>
          {variants.map((v) => (
            <button
              key={v.id}
              type="button"
              role="radio"
              aria-checked={v.id === variant.id}
              aria-label={v.name}
              className="spin__dot"
              style={{ '--c1': v.swatch[0] } as CSSProperties}
              onClick={() => onSelect(v.id)}
            />
          ))}
        </div>
        {actions && <div className="spin__actions">{actions}</div>}
      </div>
    </section>
  );
}

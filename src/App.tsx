import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type DragEvent,
} from 'react';
import { modelConfig as config, type AnchorFile } from './config/models';
import type { HotspotAnchor } from './config/models/types';
import { HotspotPlacer } from './components/Hotspots/HotspotPlacer';
import { Spin360Section } from './components/Spin360/Spin360Section';
import { brand } from './config/brand';
import { StageStatus } from './components/Viewer/StageStatus';
import type { EngineStatus, ViewerEngine } from './components/Viewer/viewerEngine';
import { ViewerControls } from './components/ViewerControls/ViewerControls';
import { HotspotPanel } from './components/Hotspots/HotspotPanel';
import { ARLauncher } from './components/AR/ARLauncher';
import { ShareButton } from './components/Layout/ShareButton';
import { TopBar } from './components/Layout/TopBar';
import { Toast, useToast } from './components/Layout/Toast';
import { useReducedMotion } from './hooks/useReducedMotion';
import { useInView } from './hooks/useInView';
import { useFullscreen } from './hooks/useFullscreen';
import { AR_FALLBACK_HASH } from './services/arSupport';
import { track } from './services/analytics';
import { hasWebGL } from './utils/webgl';
import { IS_EMBED, isMobileDevice, readVariantFromUrl, writeVariantToUrl, WANTS_AR } from './utils/url';

// three.js is most of the bundle; split it out so the page shell paints first.
const MotorcycleViewer = lazy(() =>
  import('./components/Viewer/MotorcycleViewer').then((m) => ({ default: m.MotorcycleViewer })),
);
// Dev-only studio tools, never part of the production bundle.
const Render360Tool = import.meta.env.DEV
  ? lazy(() => import('./tools/Render360Tool').then((m) => ({ default: m.Render360Tool })))
  : null;

const devTool = import.meta.env.DEV ? new URLSearchParams(window.location.search).get('edit') : null;
const PLACING = devTool === 'hotspots';
const RENDERING = devTool === '360';

function anchorsFromConfig(): AnchorFile {
  return Object.fromEntries(config.hotspots.map((h) => [h.id, { ...h.anchors }]));
}

export default function App() {
  const reducedMotion = useReducedMotion();
  const stageRef = useRef<HTMLElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inView = useInView(viewRef, '200px');
  const webgl = useMemo(hasWebGL, []);
  const fullscreen = useFullscreen(stageRef);
  const toast = useToast();

  const [engine, setEngine] = useState<ViewerEngine | null>(null);
  const [status, setStatus] = useState<EngineStatus>({ kind: 'loading', progress: null });
  const [viewerKey, setViewerKey] = useState(0);
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const [localFile, setLocalFile] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [variantId, setVariantId] = useState(() => readVariantFromUrl(config));
  const [autoRotate, setAutoRotate] = useState(false);
  const [hotspotId, setHotspotId] = useState<string | null>(null);
  const [arActive, setArActive] = useState(() => WANTS_AR && !IS_EMBED && isMobileDevice());
  const mobile = useMemo(() => isMobileDevice(), []);

  // Placement tool state (?edit=hotspots)
  const [placingId, setPlacingId] = useState(config.hotspots[0]?.id ?? '');
  const [placed, setPlaced] = useState<AnchorFile>(anchorsFromConfig);
  const [placedDirty, setPlacedDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const ready = status.kind === 'ready';
  const variant = config.variants.find((v) => v.id === variantId) ?? config.variants[0];
  // Variants with their own GLB swap the model; the others repaint the default one.
  const projectUrl = variant.model ?? config.asset.glb;
  const modelUrl = localUrl ?? projectUrl;

  useEffect(() => {
    if (engine) track('viewer_loaded', { model: config.modelId });
  }, [engine]);

  // Re-applied after every model load, so a swapped GLB picks up the current colour.
  useEffect(() => {
    if (!engine || !ready) return;
    if (variant.model && !localUrl) return;
    engine.applyVariant(variant, config.paintSlots);
  }, [engine, ready, variant, localUrl]);

  // Once the first model is up, fetch the other colours quietly so switching is instant.
  const preloaded = useRef(false);
  useEffect(() => {
    if (!engine || !ready || preloaded.current) return;
    // Don't preload other heavy 30MB 3D models on mobile to prevent WebKit memory exhaustion
    if (isMobileDevice()) return;
    preloaded.current = true;
    const others = config.variants.map((v) => v.model).filter((url): url is string => !!url && url !== projectUrl);
    engine.preload(others);
  }, [engine, ready, projectUrl]);

  useEffect(() => {
    engine?.setAutoRotate(autoRotate);
  }, [engine, autoRotate]);

  // Placement tool only: lets the camera be framed precisely from the console.
  useEffect(() => {
    if (!PLACING) return;
    (window as Window & { __viewerEngine?: ViewerEngine | null }).__viewerEngine = engine;
  }, [engine]);

  // Scene Viewer sends people back here with this hash when AR can't start.
  const showToast = toast.show;
  useEffect(() => {
    if (window.location.hash !== AR_FALLBACK_HASH) return;
    history.replaceState(null, '', window.location.pathname + window.location.search);
    showToast('AR couldn’t start on this device. You can keep exploring in 3D.');
  }, [showToast]);

  useEffect(() => {
    if (!hotspotId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      engine?.reset();
      setHotspotId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hotspotId, engine]);

  // Blob URLs for dropped files are released only when replaced, never by an
  // effect cleanup (hot reload and Strict Mode re-run those and would kill the file).
  const blobUrlRef = useRef<string | null>(null);
  const swapLocalUrl = (next: string | null) => {
    if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    blobUrlRef.current = next;
    setLocalUrl(next);
  };

  const handleStatus = useCallback((next: EngineStatus) => {
    setStatus(next);
    if (next.kind === 'ready') {
      track('model_loaded', { model: config.modelId });
    }
  }, []);

  const handleInteract = useCallback((kind: 'rotate' | 'zoom') => {
    track(kind === 'rotate' ? 'rotation_interaction' : 'zoom_interaction');
  }, []);

  const handleFreeCamera = useCallback(() => {}, []);

  function selectVariant(id: string) {
    const next = config.variants.find((v) => v.id === id);
    if (next?.model && localUrl) {
      setLocalFile(null);
      swapLocalUrl(null);
    }
    setVariantId(id);
    writeVariantToUrl(id);
    track('variant_selected', { variant: id });
  }

  function resetView() {
    engine?.reset();
    setHotspotId(null);
  }

  function placeHotspot(anchor: HotspotAnchor) {
    const key = engine?.modelKey;
    if (!engine || !key || !placingId) return;
    engine.setAnchor(placingId, anchor);
    setPlaced((prev) => ({ ...prev, [placingId]: { ...prev[placingId], [key]: anchor } }));
    setPlacedDirty(true);
    // Move on to the next hotspot so a full set is six clicks.
    const index = config.hotspots.findIndex((h) => h.id === placingId);
    const next = config.hotspots[index + 1];
    if (next) setPlacingId(next.id);
  }

  async function savePlacements() {
    setSaving(true);
    try {
      const response = await fetch('/__studio/anchors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(placed),
      });
      if (!response.ok) throw new Error(await response.text());
      setPlacedDirty(false);
      toast.show('Hotspot positions saved to ktm-390-duke.anchors.json');
    } catch (error) {
      toast.show(`Couldn’t save: ${(error as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  function selectHotspot(id: string) {
    if (PLACING) {
      setPlacingId(id);
      return;
    }
    setHotspotId(id);
    engine?.focusHotspot(id);
    track('hotspot_opened', { hotspot: id });
  }

  async function toggleFullscreen() {
    const entered = await fullscreen.toggle();
    if (entered) track('fullscreen_opened');
  }

  function openLocalFile(file: File | undefined) {
    if (!file) return;
    if (!/\.glb$/i.test(file.name)) {
      toast.show('Only binary glTF (.glb) files can be previewed this way.');
      return;
    }
    setHotspotId(null);
    setLocalFile(file.name);
    swapLocalUrl(URL.createObjectURL(file));
  }

  function backToDefaultModel() {
    setLocalFile(null);
    swapLocalUrl(null);
  }

  const dropHandlers = {
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      setDragging(true);
    },
    onDragLeave: (e: DragEvent) => {
      if (e.currentTarget === e.target) setDragging(false);
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setDragging(false);
      openLocalFile(e.dataTransfer.files[0]);
    },
  };

  const actions = (
    <>
      <ARLauncher
        config={config}
        glb={projectUrl}
        variantId={variant.id}
        onMessage={toast.show}
        onAROpenChange={setArActive}
        onSelectVariant={selectVariant}
      />
      <ShareButton title={config.displayName} variantId={variant.id} onMessage={toast.show} />
    </>
  );

  return (
    <div className="app" data-embed={IS_EMBED || undefined}>
      {!IS_EMBED && (
        <TopBar
          logoSrc={brand.clientLogo}
          clientName={brand.clientName}
          agency={brand.agency}
          displayName={config.displayName}
          market={config.market}
          modelYear={config.modelYear}
        />
      )}

      <main ref={stageRef} className="stage" data-fullscreen={fullscreen.active}>
        <div ref={viewRef} className="stage__view" {...dropHandlers}>
          {webgl && inView && !arActive && (
            <Suspense fallback={null}>
              <MotorcycleViewer
                key={viewerKey}
                config={config}
                modelUrl={modelUrl}
                reducedMotion={reducedMotion}
                showHotspots={ready}
                activeHotspotId={hotspotId}
                onEngine={setEngine}
                onStatus={handleStatus}
                onInteract={handleInteract}
                onFreeCamera={handleFreeCamera}
                onHotspotSelect={selectHotspot}
                onContextLost={() => setViewerKey((k) => k + 1)}
                onSurfacePick={PLACING ? placeHotspot : undefined}
              />
            </Suspense>
          )}

          <StageStatus
            status={status}
            webgl={webgl}
            modelPath={projectUrl}
            fallbackImage={config.asset.fallbackImage}
            displayName={config.displayName}
            onRetry={() => setViewerKey((k) => k + 1)}
            onChooseFile={() => fileInputRef.current?.click()}
          />

          {localFile && (
            <div className="local-chip">
              <span>
                Local preview · <b>{localFile}</b>
              </span>
              <button type="button" className="link-btn" onClick={backToDefaultModel}>
                Use project model
              </button>
            </div>
          )}

          {webgl && (
            <ViewerControls
              disabled={!ready}
              autoRotate={autoRotate}
              fullscreenSupported={fullscreen.supported}
              fullscreenActive={fullscreen.active}
              onZoomIn={() => engine?.zoomBy(0.8)}
              onZoomOut={() => engine?.zoomBy(1.25)}
              onReset={resetView}
              onToggleAutoRotate={() => setAutoRotate((v) => !v)}
              onToggleFullscreen={toggleFullscreen}
            />
          )}

          {hotspotId && (
            <HotspotPanel
              hotspots={config.hotspots}
              activeId={hotspotId}
              onSelect={selectHotspot}
              onClose={resetView}
            />
          )}

          <div className="stage__foot">
            <div className="stage-swatches" role="radiogroup" aria-label="Colour variant">
              <span className="stage-swatches__name">{variant.name}</span>
              {config.variants.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  role="radio"
                  aria-checked={v.id === variantId}
                  aria-label={v.name}
                  tabIndex={v.id === variantId ? 0 : -1}
                  className="stage-swatch"
                  disabled={!ready}
                  onClick={() => selectVariant(v.id)}
                  style={{ '--c1': v.swatch[0], '--c2': v.swatch[1] } as CSSProperties}
                />
              ))}
            </div>
          </div>

          {dragging && (
            <div className="dropzone" aria-hidden="true">
              <span>Drop .glb to preview</span>
            </div>
          )}
        </div>

        {PLACING && (
          <aside className="panel" aria-label="Configure">
            <HotspotPlacer
              hotspots={config.hotspots}
              modelKey={ready ? (engine?.modelKey ?? null) : null}
              selectedId={placingId}
              placed={placed}
              dirty={placedDirty}
              saving={saving}
              onSelect={setPlacingId}
              onSave={savePlacements}
            />
          </aside>
        )}
      </main>

      {mobile ? (
        <div className="spin__actions">{actions}</div>
      ) : (
        <Spin360Section
          displayName={config.displayName}
          variants={config.variants}
          selectedId={variant.id}
          reducedMotion={reducedMotion}
          onSelect={selectVariant}
          actions={actions}
        />
      )}
      <Toast message={toast.message} />

      {Render360Tool && RENDERING && (
        <Suspense fallback={null}>
          <Render360Tool config={config} />
        </Suspense>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept=".glb,model/gltf-binary"
        hidden
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          openLocalFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
    </div>
  );
}

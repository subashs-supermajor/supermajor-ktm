/**
 * Surface gate for model-viewer's WebXR (Android Chrome) AR mode.
 *
 * Stock model-viewer shows the model floating in front of the camera the moment
 * the session starts, then drops it onto the first upward-facing hit. This gate
 * replaces that step: the model stays hidden while the phone scans, every hit is
 * checked, and the bike only appears once a suitable floor has been tracked
 * steadily. Scene Viewer and iOS Quick Look are native apps with their own
 * surface detection, so they are unaffected.
 */

export type SurfaceIssue = 'tilted' | 'high' | 'cramped' | 'far' | 'close';
export type SurfaceState = { phase: 'scanning' } | { phase: 'unsuitable'; issue: SurfaceIssue };

const MIN_NORMAL_Y = 0.95; // ~18° max tilt
const MIN_DROP_BELOW_CAMERA = 0.6; // m — anything closer to the phone is a table/bed, not floor
const ABOVE_FLOOR_TOLERANCE = 0.25; // m above the lowest surface seen this session
const MAX_DISTANCE = 5; // m — hits further away are unreliable
const SIDE_HEIGHT_TOLERANCE = 0.1; // m — side rays must land on the same level
const SIDE_YAW_DEG = 25;
const HIT_PITCH_DEG = 20; // matches model-viewer's own placement ray
const STABLE_FRAMES = 15; // ~0.5 s of consistent good hits before placing
const STABLE_JITTER = 0.03; // m
const ISSUE_FRAMES = 8; // debounce before telling the user a surface is unsuitable
const SIDE_UNKNOWN_GRACE_FRAMES = 90; // place anyway if side rays never report (~3 s)

type Listener = (state: SurfaceState) => void;

interface GateSession {
  session: any;
  sideSources: any[];
  sidesRequested: boolean;
  floorY: number;
  lastY: number;
  goodFrames: number;
  issue: SurfaceIssue | null;
  issueFrames: number;
  reported: string;
  placed: boolean;
}

const PATCHED = Symbol('surfaceGatePatched');
let listener: Listener | null = null;

export function findArRenderer(mv: HTMLElement | null): any {
  if (!mv) return null;
  for (let proto: any = mv; proto; proto = Object.getPrototypeOf(proto)) {
    const sym = Object.getOwnPropertySymbols(proto).find((s) => s.description === 'renderer');
    if (sym) return (mv as any)[sym]?.arRenderer ?? null;
  }
  return null;
}

/** Installs the gate on model-viewer's (singleton) AR renderer. Returns an uninstall fn. */
export function installSurfaceGate(mv: HTMLElement | null, onChange: Listener): () => void {
  const ar = findArRenderer(mv);
  if (!ar || typeof ar.moveToFloor !== 'function') return () => {};

  listener = onChange;
  if (!ar[PATCHED]) {
    const original = ar.moveToFloor;
    ar.moveToFloor = function (this: any, frame: any) {
      if (!listener || this.xrMode !== 'screen-space' || this.placeOnWall) {
        return original.call(this, frame);
      }
      return gateFrame(this, frame);
    };
    ar[PATCHED] = true;
  }
  return () => {
    if (listener === onChange) listener = null;
  };
}

/** Makes sure the model is visible again after a session ends. */
export function restoreModelVisibility(mv: HTMLElement | null) {
  if (!mv) return;
  for (const sym of Object.getOwnPropertySymbols(mv)) {
    try {
      const val = (mv as any)[sym];
      if (val && typeof val === 'object' && val.scenePivot) {
        val.scenePivot.visible = true;
        return;
      }
    } catch {
      // ignore
    }
  }
}

function report(g: GateSession, state: SurfaceState) {
  const key = state.phase === 'unsuitable' ? state.issue : state.phase;
  if (g.reported === key) return;
  g.reported = key;
  listener?.(state);
}

function gateFrame(ar: any, frame: any) {
  const scene = ar.presentedScene;
  if (!scene) return;

  let g: GateSession = ar.__surfaceGate;
  if (!g || g.session !== ar.currentSession) {
    g = ar.__surfaceGate = {
      session: ar.currentSession,
      sideSources: [],
      sidesRequested: false,
      floorY: Infinity,
      lastY: NaN,
      goodFrames: 0,
      issue: null,
      issueFrames: 0,
      reported: '',
      placed: false,
    };
  }
  if (g.placed) return;

  // Keep the bike hidden until a good surface is confirmed.
  scene.scenePivot.visible = false;
  if (ar.placementBox) ar.placementBox.show = false;

  if (!g.sidesRequested && ar.currentSession) {
    g.sidesRequested = true;
    requestSideSources(ar.currentSession).then((sources) => {
      if (g.placed || ar.__surfaceGate !== g) sources.forEach((s) => s.cancel());
      else g.sideSources = sources;
    });
  }

  const hitSource = ar.initialHitSource;
  const refSpace = ar.threeRenderer.xr.getReferenceSpace();
  const viewer = frame.getViewerPose(refSpace);
  if (!hitSource || !viewer) return report(g, { phase: 'scanning' });

  const hit = readHit(frame, hitSource, refSpace);
  if (!hit) {
    g.goodFrames = 0;
    g.issueFrames = 0;
    return report(g, { phase: 'scanning' });
  }

  if (hit.normalY >= MIN_NORMAL_Y) g.floorY = Math.min(g.floorY, hit.y);

  const cam = viewer.transform.position;
  const dx = hit.x - cam.x;
  const dz = hit.z - cam.z;
  const horizontal = Math.hypot(dx, dz);
  const modelRadius = scene.boundingSphere?.radius ?? 1;

  let issue: SurfaceIssue | null = null;
  if (hit.normalY < MIN_NORMAL_Y) issue = 'tilted';
  else if (cam.y - hit.y < MIN_DROP_BELOW_CAMERA || hit.y > g.floorY + ABOVE_FLOOR_TOLERANCE) issue = 'high';
  else if (horizontal > MAX_DISTANCE) issue = 'far';
  else if (horizontal < modelRadius) issue = 'close';

  // Side rays check there is open floor on both sides of the aim point.
  let sidesKnown = g.sideSources.length > 0;
  if (!issue) {
    for (const src of g.sideSources) {
      const side = readHit(frame, src, refSpace);
      if (!side) {
        sidesKnown = false;
        continue;
      }
      if (side.normalY < MIN_NORMAL_Y || Math.abs(side.y - hit.y) > SIDE_HEIGHT_TOLERANCE) {
        issue = 'cramped';
        break;
      }
    }
  }

  if (issue) {
    g.goodFrames = 0;
    g.issueFrames = g.issue === issue ? g.issueFrames + 1 : 1;
    g.issue = issue;
    if (g.issueFrames >= ISSUE_FRAMES) report(g, { phase: 'unsuitable', issue });
    return;
  }

  g.issue = null;
  g.issueFrames = 0;
  g.goodFrames = Math.abs(hit.y - g.lastY) < STABLE_JITTER ? g.goodFrames + 1 : 1;
  g.lastY = hit.y;
  report(g, { phase: 'scanning' });

  const needed = sidesKnown ? STABLE_FRAMES : SIDE_UNKNOWN_GRACE_FRAMES;
  if (g.goodFrames < needed) return;

  // Place: start a few cm above the floor so model-viewer's damper settles it
  // down and finishes its own placement (shadow on, placement box off).
  g.placed = true;
  ar.goalPosition.set(hit.x, hit.y, hit.z);
  scene.scenePivot.position.set(hit.x, hit.y + 0.05, hit.z);
  scene.scenePivot.visible = true;
  if (ar.placementBox) ar.placementBox.show = true;

  hitSource.cancel();
  ar.initialHitSource = null;
  g.sideSources.forEach((s) => s.cancel());
  g.sideSources = [];
  ar.dispatchEvent({ type: 'status', status: 'object-placed' });
}

function readHit(frame: any, source: any, refSpace: any) {
  const results = frame.getHitTestResults(source);
  if (!results.length) return null;
  const pose = results[0].getPose(refSpace);
  if (!pose) return null;
  const m = pose.transform.matrix;
  return { x: m[12], y: m[13], z: m[14], normalY: m[5] };
}

async function requestSideSources(session: any): Promise<any[]> {
  const XRRayCtor = (window as any).XRRay;
  if (!XRRayCtor) return [];
  try {
    const space = await session.requestReferenceSpace('viewer');
    const pitch = (HIT_PITCH_DEG * Math.PI) / 180;
    const yaw = (SIDE_YAW_DEG * Math.PI) / 180;
    return await Promise.all(
      [-yaw, yaw].map((a) =>
        session.requestHitTestSource({
          space,
          offsetRay: new XRRayCtor(new DOMPoint(0, 0, 0), {
            x: Math.sin(a) * Math.cos(pitch),
            y: -Math.sin(pitch),
            z: -Math.cos(a) * Math.cos(pitch),
          }),
        }),
      ),
    );
  } catch {
    return [];
  }
}

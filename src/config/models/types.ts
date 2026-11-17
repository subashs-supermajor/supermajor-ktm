/** Which way the motorcycle's nose points in the model file (glTF convention is +z). */
export type Axis = '+x' | '-x' | '+z' | '-z';

/**
 * Every product asset and data item carries its approval state so demo and
 * placeholder content can never be mistaken for confirmed KTM information.
 */
export type ApprovalStatus = 'approved' | 'pending' | 'demo' | 'placeholder';

export interface PaintFinish {
  /** sRGB hex, e.g. "#FF6600" */
  color: string;
  metalness?: number;
  roughness?: number;
  clearcoat?: number;
}

/**
 * A group of body panels that change with the colour variant. `match` is a
 * list of case-insensitive fragments compared against mesh and material names
 * in the GLB, so the artist's naming decides what gets painted.
 */
export interface PaintSlot {
  id: string;
  label: string;
  match: string[];
}

export interface Variant {
  id: string;
  name: string;
  /** Two colours used to draw the swatch: main panel, secondary panel. */
  swatch: [string, string];
  /**
   * A separate GLB for this variant (colours baked into its textures).
   * When set, choosing the variant swaps the model instead of repainting.
   */
  model?: string;
  /**
   * Pre-built USDZ for iOS Quick Look. When set, model-viewer uses this
   * instead of auto-converting the GLB — better quality and correct colour.
   * Generate with: python tools/glb_to_usdz.py
   */
  usdz?: string;
  /** Keyed by PaintSlot id. Slots left out keep their original material. */
  finish?: Record<string, PaintFinish>;
  approvalStatus: ApprovalStatus;
}

/**
 * Hotspot positions are relative to the bike rather than absolute
 * coordinates, so they stay roughly right when the GLB is swapped:
 *   along  0 = rear tip, 1 = front tip
 *   height 0 = ground,   1 = highest point
 *   side  -1 = rider's left edge, 0 = centreline, 1 = rider's right edge
 */
export interface HotspotConfig {
  id: string;
  title: string;
  description: string;
  position: { along: number; height: number; side: number };
  /**
   * Exact placements per model file (e.g. "Scooter-Blue.glb"), in the model's
   * own coordinates. Written by the placement tool (?edit=hotspots, dev only).
   * Where present they override `position`, which is otherwise snapped onto
   * the model's surface automatically.
   */
  anchors?: Record<string, HotspotAnchor>;
  status: ApprovalStatus;
}

/** A point on the model surface and the direction that surface faces. */
export interface HotspotAnchor {
  p: [number, number, number];
  n: [number, number, number];
  /** Camera position relative to `p` when it was placed: the hotspot's close-up view. */
  v?: [number, number, number];
}

export interface ModelConfig {
  modelId: string;
  displayName: string;
  shortName: string;
  market: string;
  modelYear: string;
  frontAxis: Axis;
  asset: {
    glb: string;
    usdz?: string;
    /** Still image shown when WebGL isn't available. */
    fallbackImage?: string;
  };
  paintSlots: PaintSlot[];
  defaultVariantId: string;
  variants: Variant[];
  hotspots: HotspotConfig[];
}

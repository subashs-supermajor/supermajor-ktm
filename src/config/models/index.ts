import type { HotspotAnchor, ModelConfig } from './types';
import duke390 from './ktm-390-duke.json';
import duke390Anchors from './ktm-390-duke.anchors.json';

export type AnchorFile = Record<string, Record<string, HotspotAnchor>>;

/** Exact hotspot placements live in their own file so the placement tool can rewrite it safely. */
function withAnchors(config: ModelConfig, anchors: AnchorFile): ModelConfig {
  return {
    ...config,
    hotspots: config.hotspots.map((h) => ({ ...h, anchors: { ...h.anchors, ...anchors[h.id] } })),
  };
}

const AXES = ['+x', '-x', '+z', '-z'];

/** Catches config mistakes at startup instead of as odd behaviour in the viewer. */
function checkConfig(config: ModelConfig): ModelConfig {
  const problems: string[] = [];

  if (!AXES.includes(config.frontAxis)) {
    problems.push(`frontAxis must be one of ${AXES.join(', ')}`);
  }
  if (config.variants.length === 0) {
    problems.push('at least one variant is required');
  }
  if (!config.variants.some((v) => v.id === config.defaultVariantId)) {
    problems.push(`defaultVariantId "${config.defaultVariantId}" does not match any variant`);
  }
  const slotIds = new Set(config.paintSlots.map((s) => s.id));
  for (const variant of config.variants) {
    if (!variant.model && !variant.finish) problems.push(`variant "${variant.id}" needs a model or a finish`);
    for (const slot of Object.keys(variant.finish ?? {})) {
      if (!slotIds.has(slot)) problems.push(`variant "${variant.id}" uses unknown paint slot "${slot}"`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`Model config "${config.modelId}": ${problems.join('; ')}`);
  }
  return config;
}

export const modelConfig = checkConfig(
  withAnchors(duke390 as unknown as ModelConfig, duke390Anchors as unknown as AnchorFile),
);
export type { ModelConfig } from './types';

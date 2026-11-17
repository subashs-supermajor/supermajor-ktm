import type { ModelConfig } from '../config/models/types';
import { assetExists } from './modelFetch';

export type ARUnavailableReason = 'desktop' | 'no-asset' | 'insecure' | 'unsupported';

export type ARRoute =
  | { kind: 'quick-look'; href: string }
  | { kind: 'scene-viewer'; href: string }
  | { kind: 'unavailable'; reason: ARUnavailableReason };

export const AR_FALLBACK_HASH = '#ar-unavailable';

function isIOS() {
  const ua = navigator.userAgent;
  // iPadOS reports itself as a Mac; touch support gives it away.
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function supportsQuickLook() {
  const anchor = document.createElement('a');
  return Boolean(anchor.relList?.supports?.('ar'));
}

const absolute = (path: string) => new URL(path, window.location.href).href;

/**
 * Picks the AR route for this device: Quick Look (USDZ) on iOS/iPadOS,
 * Scene Viewer (GLB) on Android. Anything else gets an explanation instead
 * of a button that does nothing.
 */
export async function detectAR(asset: ModelConfig['asset'], title: string): Promise<ARRoute> {
  if (isIOS()) {
    if (!asset.usdz) return { kind: 'unavailable', reason: 'no-asset' };
    if (!supportsQuickLook()) return { kind: 'unavailable', reason: 'unsupported' };
    if (!(await assetExists(asset.usdz))) return { kind: 'unavailable', reason: 'no-asset' };
    return { kind: 'quick-look', href: absolute(asset.usdz) };
  }

  if (/Android/i.test(navigator.userAgent)) {
    // Scene Viewer downloads the file itself, so it must be reachable over HTTPS.
    if (window.location.protocol !== 'https:') return { kind: 'unavailable', reason: 'insecure' };
    if (!(await assetExists(asset.glb))) return { kind: 'unavailable', reason: 'no-asset' };

    const fallback = window.location.href.split('#')[0] + AR_FALLBACK_HASH;
    const params = new URLSearchParams({ file: absolute(asset.glb), mode: 'ar_preferred', resizable: 'false', title });
    const href =
      `intent://arvr.google.com/scene-viewer/1.0?${params.toString()}` +
      '#Intent;scheme=https;package=com.google.ar.core;action=android.intent.action.VIEW;' +
      `S.browser_fallback_url=${encodeURIComponent(fallback)};end;`;
    return { kind: 'scene-viewer', href };
  }

  return { kind: 'unavailable', reason: 'desktop' };
}

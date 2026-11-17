import type { ModelConfig } from '../config/models/types';

const params = new URLSearchParams(window.location.search);

/** ?embed=1 strips the page chrome so the experience sits cleanly inside another site. */
export const IS_EMBED = params.get('embed') === '1';

/** ?ar=1 opens the AR viewer on arrival (used when an embed hands AR off to a full tab). */
export const WANTS_AR = params.get('ar') === '1';

export function isMobileDevice() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /Android|iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** ?variant=<id> makes a shared link open on the same colour. */
export function readVariantFromUrl(config: ModelConfig): string {
  const requested = params.get('variant');
  return config.variants.some((v) => v.id === requested) ? (requested as string) : config.defaultVariantId;
}

export function writeVariantToUrl(id: string) {
  const url = new URL(window.location.href);
  url.searchParams.set('variant', id);
  window.history.replaceState(null, '', url);
}

const IS_LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);

/** A phone can't open "localhost", so in local testing shared links use the machine's LAN address. */
function shareOrigin() {
  return IS_LOCAL && __LAN_ORIGIN__ ? __LAN_ORIGIN__ : window.location.origin;
}

/** AR on phones only starts from a secure (https) page. */
export const AR_READY_ORIGIN = shareOrigin().startsWith('https:');

function baseUrl(variantId: string) {
  const url = new URL(window.location.pathname, shareOrigin());
  url.searchParams.set('variant', variantId);
  return url;
}

export function pageLink(variantId: string, extra: Record<string, string> = {}) {
  const url = baseUrl(variantId);
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
  return url.href;
}

export function embedLink(variantId: string) {
  return pageLink(variantId, { embed: '1' });
}

export function iframeCode(variantId: string, title: string) {
  return (
    `<iframe src="${embedLink(variantId)}" title="${title} in 3D" ` +
    'width="100%" height="720" style="border:0;max-width:100%" ' +
    'allow="fullscreen; xr-spatial-tracking; clipboard-write" allowfullscreen loading="lazy"></iframe>'
  );
}

/** Clipboard API, with a fallback for iframes or browsers that block it. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

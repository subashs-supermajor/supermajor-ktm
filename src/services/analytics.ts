export type AnalyticsEvent =
  | 'viewer_loaded'
  | 'model_loaded'
  | 'rotation_interaction'
  | 'zoom_interaction'
  | 'variant_selected'
  | 'hotspot_opened'
  | 'ar_clicked'
  | 'ar_launched'
  | 'fullscreen_opened'
  | 'share_clicked';

type Params = Record<string, string | number | boolean>;

/**
 * Pushes to window.dataLayer only when an approved analytics tag has created it.
 * Nothing is sent anywhere by default, and no personal data is collected.
 */
export function track(event: AnalyticsEvent, params: Params = {}) {
  const payload = { event, ...params };
  const w = window as Window & { dataLayer?: unknown[] };
  if (Array.isArray(w.dataLayer)) w.dataLayer.push(payload);
  if (import.meta.env.DEV) console.debug('[track]', payload);
}

import { useCallback, useEffect, useState, type RefObject } from 'react';

type PrefixedDocument = Document & {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type PrefixedElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

const doc = document as PrefixedDocument;

/** iPhone Safari has no element fullscreen, so `supported` hides the control there. */
export function useFullscreen(ref: RefObject<HTMLElement>) {
  const supported = Boolean(doc.fullscreenEnabled || doc.webkitFullscreenEnabled);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const onChange = () => setActive(Boolean(doc.fullscreenElement || doc.webkitFullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
    };
  }, []);

  const toggle = useCallback(async () => {
    const element = ref.current as PrefixedElement | null;
    if (!element) return false;
    try {
      if (doc.fullscreenElement || doc.webkitFullscreenElement) {
        await (doc.exitFullscreen ? doc.exitFullscreen() : doc.webkitExitFullscreen?.());
        return false;
      }
      await (element.requestFullscreen ? element.requestFullscreen() : element.webkitRequestFullscreen?.());
      return true;
    } catch {
      return false;
    }
  }, [ref]);

  return { supported, active, toggle };
}

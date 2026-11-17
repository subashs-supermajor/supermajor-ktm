import { useCallback, useState } from 'react';
import type { ModelConfig } from '../../config/models/types';
import { ARIcon } from '../Icons';
import { ModelViewerAR } from './ModelViewerAR';
import { ARQrDialog } from './ARQrDialog';
import { track } from '../../services/analytics';
import { IS_EMBED, isMobileDevice, pageLink, WANTS_AR } from '../../utils/url';

interface Props {
  config: ModelConfig;
  /** GLB path for the currently selected colour variant. */
  glb: string;
  variantId: string;
  onMessage: (message: string) => void;
  onAROpenChange?: (open: boolean) => void;
  onSelectVariant?: (variantId: string) => void;
}

type View = 'none' | 'viewer' | 'qr';

export function ARLauncher({ config, glb, variantId, onMessage, onAROpenChange, onSelectVariant }: Props) {
  const [view, setView] = useState<View>(() => (WANTS_AR && !IS_EMBED && isMobileDevice() ? 'viewer' : 'none'));
  const close = useCallback(() => {
    setView('none');
    onAROpenChange?.(false);
    if (WANTS_AR) {
      const url = new URL(window.location.href);
      url.searchParams.delete('ar');
      window.history.replaceState(null, '', url.pathname + url.search);
    }
  }, [onAROpenChange]);
  const colourName = config.variants.find((v) => v.id === variantId)?.name ?? '';

  function handleClick() {
    const mobile = isMobileDevice();
    track('ar_clicked', { kind: mobile ? 'mobile' : 'desktop', embed: IS_EMBED });

    if (!mobile) {
      setView('qr');
      return;
    }
    // Quick Look, Scene Viewer and WebXR are unreliable inside iframes, so AR runs in its own tab.
    if (IS_EMBED) {
      window.open(pageLink(variantId, { ar: '1' }), '_blank', 'noopener');
      return;
    }
    onAROpenChange?.(true);
    setView('viewer');
  }

  return (
    <>
      <button type="button" className="btn btn--outline" onClick={handleClick}>
        <ARIcon /> View in your space
      </button>

      {view === 'qr' && (
        <ARQrDialog
          url={pageLink(variantId, { ar: '1' })}
          title={config.displayName}
          colourName={colourName}
          onClose={close}
          onMessage={onMessage}
        />
      )}

      {view === 'viewer' && (
        <ModelViewerAR
          glb={glb}
          title={config.displayName}
          variantId={variantId}
          variants={config.variants}
          frontAxis={config.frontAxis}
          onClose={close}
          onSelectVariant={onSelectVariant}
        />
      )}
    </>
  );
}

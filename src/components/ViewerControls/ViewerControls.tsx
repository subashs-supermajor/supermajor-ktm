interface Props {
  disabled: boolean;
  autoRotate: boolean;
  fullscreenSupported: boolean;
  fullscreenActive: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
  onToggleAutoRotate: () => void;
  onToggleFullscreen: () => void;
}

export function ViewerControls(_p: Props) {
  return (
    <div className="rail" role="group" aria-label="View controls">
    </div>
  );
}

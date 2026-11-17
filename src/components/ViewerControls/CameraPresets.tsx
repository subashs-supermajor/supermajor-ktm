import type { PresetName } from '../Viewer/viewerEngine';

const PRESETS: { id: PresetName; label: string }[] = [
  { id: 'three-quarter', label: '¾ View' },
  { id: 'front', label: 'Front' },
  { id: 'left', label: 'Left' },
  { id: 'rear', label: 'Rear' },
  { id: 'right', label: 'Right' },
];

interface Props {
  active: PresetName | null;
  disabled: boolean;
  onSelect: (preset: PresetName) => void;
}

export function CameraPresets({ active, disabled, onSelect }: Props) {
  return (
    <div className="presets" role="group" aria-label="Camera angle">
      {PRESETS.map((preset, i) => (
        <button
          key={preset.id}
          type="button"
          className="presets__btn"
          aria-pressed={active === preset.id}
          disabled={disabled}
          onClick={() => onSelect(preset.id)}
        >
          <span className="presets__idx" aria-hidden="true">
            {String(i + 1).padStart(2, '0')}
          </span>
          {preset.label}
        </button>
      ))}
    </div>
  );
}

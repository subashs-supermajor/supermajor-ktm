import type { AnchorFile } from '../../config/models';
import type { HotspotConfig } from '../../config/models/types';

interface Props {
  hotspots: HotspotConfig[];
  modelKey: string | null;
  selectedId: string;
  placed: AnchorFile;
  dirty: boolean;
  saving: boolean;
  onSelect: (id: string) => void;
  onSave: () => void;
}

/**
 * Dev-only tool (open the page with ?edit=hotspots). Pick a hotspot, click the
 * bike where it belongs, repeat for each colour, then save. Positions are stored
 * per model file, so every variant gets its own exact placement.
 */
export function HotspotPlacer({ hotspots, modelKey, selectedId, placed, dirty, saving, onSelect, onSave }: Props) {
  const done = hotspots.filter((h) => modelKey && placed[h.id]?.[modelKey]).length;

  return (
    <section className="placer" aria-labelledby="placer-title">
      <div className="panel__head">
        <h2 id="placer-title" className="eyebrow">
          Hotspot placement
        </h2>
        <span className="panel__count">
          {done} / {hotspots.length}
        </span>
      </div>
      <p className="placer__model">{modelKey ?? 'Loading model…'}</p>
      <p className="note">Pick a hotspot, then click the bike where it belongs. Drag still rotates.</p>

      <ol className="placer__list">
        {hotspots.map((hotspot) => {
          const isPlaced = Boolean(modelKey && placed[hotspot.id]?.[modelKey]);
          return (
            <li key={hotspot.id}>
              <button
                type="button"
                className="placer__item"
                aria-pressed={selectedId === hotspot.id}
                onClick={() => onSelect(hotspot.id)}
              >
                <span>{hotspot.title}</span>
                <span className="placer__state" data-placed={isPlaced}>
                  {isPlaced ? 'Placed' : 'Auto'}
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      <button type="button" className="btn btn--primary" disabled={!dirty || saving} onClick={onSave}>
        {saving ? 'Saving…' : dirty ? 'Save positions' : 'Saved'}
      </button>
      <p className="note">Repeat for each colour: positions are saved per model file.</p>
    </section>
  );
}

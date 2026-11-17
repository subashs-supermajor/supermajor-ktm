import { useRef, type CSSProperties, type KeyboardEvent } from 'react';
import type { Variant } from '../../config/models/types';

interface Props {
  variants: Variant[];
  selectedId: string;
  disabled: boolean;
  /** false when no mesh in the loaded model matched a paint slot */
  paintable: boolean;
  onSelect: (id: string) => void;
}

export function VariantSelector({ variants, selectedId, disabled, paintable, onSelect }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const index = Math.max(
    0,
    variants.findIndex((v) => v.id === selectedId),
  );
  const selected = variants[index];
  const locked = disabled || !paintable;

  // Radio-group keyboard pattern: arrows move and select.
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step || locked) return;
    event.preventDefault();
    const next = (index + step + variants.length) % variants.length;
    onSelect(variants[next].id);
    listRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  }

  return (
    <section className="variants" aria-labelledby="variants-heading">
      <div className="panel__head">
        <h2 id="variants-heading" className="eyebrow">
          Colour
        </h2>
        <span className="panel__count">
          {String(index + 1).padStart(2, '0')} / {String(variants.length).padStart(2, '0')}
        </span>
      </div>

      <div
        ref={listRef}
        className="variants__list"
        role="radiogroup"
        aria-labelledby="variants-heading"
        onKeyDown={handleKeyDown}
      >
        {variants.map((variant) => {
          const checked = variant.id === selectedId;
          return (
            <button
              key={variant.id}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={variant.name}
              tabIndex={checked ? 0 : -1}
              className="swatch"
              disabled={locked}
              onClick={() => onSelect(variant.id)}
              style={{ '--c1': variant.swatch[0], '--c2': variant.swatch[1] } as CSSProperties}
            >
              <span className="swatch__fill" aria-hidden="true" />
            </button>
          );
        })}
      </div>

      <p className="variants__name" aria-live="polite">
        {selected.name}
      </p>
      {!disabled && !paintable && (
        <p className="note note--warn">Colour panels aren’t mapped for this model yet, so the finish can’t change.</p>
      )}
    </section>
  );
}

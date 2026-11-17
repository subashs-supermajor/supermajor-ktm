import { useEffect, useRef } from 'react';
import type { HotspotConfig } from '../../config/models/types';
import { ArrowIcon, CloseIcon } from '../Icons';

interface Props {
  hotspots: HotspotConfig[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}

export function HotspotPanel({ hotspots, activeId, onSelect, onClose }: Props) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const index = hotspots.findIndex((h) => h.id === activeId);
  const hotspot = hotspots[index];

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [activeId]);

  if (!hotspot) return null;
  const go = (step: number) => onSelect(hotspots[(index + step + hotspots.length) % hotspots.length].id);

  return (
    <section className="feature" aria-labelledby="feature-title">
      <div className="feature__head">
        <span className="eyebrow">
          Feature {String(index + 1).padStart(2, '0')} / {String(hotspots.length).padStart(2, '0')}
        </span>
        <button type="button" className="icon-btn" aria-label="Close feature details" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>

      <h3 id="feature-title" className="feature__title" ref={headingRef} tabIndex={-1}>
        {hotspot.title}
      </h3>
      <p className="feature__text">{hotspot.description}</p>
      {hotspot.status !== 'approved' && <p className="note">Placeholder copy. Approved KTM content to follow.</p>}

      <div className="feature__nav">
        <button type="button" className="icon-btn" aria-label="Previous feature" onClick={() => go(-1)}>
          <ArrowIcon flip />
        </button>
        <button type="button" className="icon-btn" aria-label="Next feature" onClick={() => go(1)}>
          <ArrowIcon />
        </button>
      </div>
    </section>
  );
}

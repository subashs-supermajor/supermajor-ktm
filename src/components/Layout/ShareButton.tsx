import { useEffect, useRef, useState } from 'react';
import { track } from '../../services/analytics';
import { copyText, embedLink, iframeCode, PUBLIC_URL } from '../../utils/url';
import { ShareIcon } from '../Icons';

interface Props {
  title: string;
  variantId: string;
  onMessage: (message: string) => void;
}

type Kind = 'link' | 'embed' | 'iframe';

export function ShareButton({ title, variantId, onMessage }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const items: { kind: Kind; label: string; detail: string; value: () => string; done: string }[] = [
    {
      kind: 'link',
      label: 'Copy link',
      detail: 'Opens the full page',
      value: () => PUBLIC_URL,
      done: 'Link copied.',
    },
    {
      kind: 'embed',
      label: 'Copy embed link',
      detail: 'Clean view without the header, for embedding',
      value: () => embedLink(variantId),
      done: 'Embed link copied.',
    },
    {
      kind: 'iframe',
      label: 'Copy iframe code',
      detail: 'Paste into any website or CMS',
      value: () => iframeCode(variantId, title),
      done: 'Iframe code copied. Paste it into your site’s HTML.',
    },
  ];

  async function copy(item: (typeof items)[number]) {
    track('share_clicked', { kind: item.kind });
    const ok = await copyText(item.value());
    onMessage(ok ? item.done : 'Couldn’t copy automatically. Please copy it from the address bar.');
    setOpen(false);
  }

  async function nativeShare() {
    track('share_clicked', { kind: 'native' });
    try {
      await navigator.share({ title, url: PUBLIC_URL });
    } catch {
      // Closing the share sheet throws; nothing to report.
    }
    setOpen(false);
  }

  return (
    <div ref={rootRef} className="share">
      <button
        type="button"
        className="btn btn--ghost"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ShareIcon /> Share
      </button>

      {open && (
        <div className="share__menu" role="menu">
          {items.map((item) => (
            <button key={item.kind} type="button" role="menuitem" className="share__item" onClick={() => copy(item)}>
              <span className="share__label">{item.label}</span>
              <span className="share__detail">{item.detail}</span>
            </button>
          ))}
          {typeof navigator.share === 'function' && (
            <button type="button" role="menuitem" className="share__item" onClick={nativeShare}>
              <span className="share__label">Share via…</span>
              <span className="share__detail">WhatsApp, Mail, Messages and more</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

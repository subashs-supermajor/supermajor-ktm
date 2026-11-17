import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { copyText, PUBLIC_URL } from '../../utils/url';
import { CloseIcon } from '../Icons';

interface Props {
  url: string;
  title: string;
  colourName: string;
  onClose: () => void;
  onMessage: (message: string) => void;
}

export function ARQrDialog({ url, title, colourName, onClose, onMessage }: Props) {
  const [qr, setQr] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(url, { width: 480, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#111111', light: '#ffffff' } })
      .then((data) => alive && setQr(data))
      .catch(() => alive && setQr(null));
    return () => {
      alive = false;
    };
  }, [url]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function copy() {
    onMessage((await copyText(PUBLIC_URL)) ?'Link copied.' : 'Couldn’t copy the link automatically.');
  }

  return (
    <div
      className="ar-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ar-qr-title"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="ar-overlay__panel ar-qr">
        <div className="ar-overlay__head">
          <span id="ar-qr-title" className="eyebrow">
            View in your space
          </span>
          <button ref={closeRef} className="ar-overlay__close icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>

        <div className="ar-qr__body">
          <div className="ar-qr__code">
            {qr ? <img src={qr} alt={`QR code to open ${title} in AR`} width={240} height={240} /> : <span className="ar-qr__wait" />}
          </div>

          <div className="ar-qr__text">
            <h3 className="ar-qr__title">Scan with your phone</h3>
            <ol className="ar-qr__steps">
              <li>Open the camera on your iPhone or Android phone.</li>
              <li>Point it at the code and tap the link.</li>
              <li>
                Tap <b>Launch in AR</b> to place the {title} in {colourName} in your room, at real size.
              </li>
            </ol>
            {/* {!AR_READY_ORIGIN && (
              <p className="note note--warn">
                Local preview: the phone must be on the same Wi-Fi. AR itself starts once the site is on its https
                address.
              </p>
            )} */}
            <button type="button" className="link-btn" onClick={copy}>
              Copy link
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

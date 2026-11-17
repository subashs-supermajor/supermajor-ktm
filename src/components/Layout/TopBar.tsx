// import { useState } from 'react';

interface Props {
  logoSrc?: string;
  clientName?: string;
  agency: string;
  displayName: string;
  market?: string;
  modelYear?: string;
}

export function TopBar({ agency, displayName }: Props) {
  // const [logoMissing, setLogoMissing] = useState(false);
  // const year = modelYear === 'TO_BE_CONFIRMED' ? 'Model year to be confirmed' : modelYear;

  return (
    <header className="topbar">
      <div className="topbar__brand">
        <div className="topbar__model">
          <h1>{displayName}</h1>
        </div>
      </div>

      <div className="topbar__meta">
        {/* <span className="badge">Proposal concept</span> */}
        <span className="topbar__agency">
          by <b>{agency}</b>
        </span>
      </div>
    </header>
  );
}

import type { ReactElement } from 'react';

export type NavIconId =
  | 'home'
  | 'documents'
  | 'orders'
  | 'assistant'
  | 'tax'
  | 'more'
  | 'scan'
  | 'archive';

interface NavIconProps {
  id: NavIconId;
  className?: string;
}

const ICONS: Record<NavIconId, ReactElement> = {
  home: (
    <>
      <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1v-9.5Z" />
    </>
  ),
  documents: (
    <>
      <path d="M4 7h16v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7Z" />
      <path d="M9 4h6l1 3H8l1-3Z" />
      <path d="M12 11v6M9 14h6" />
    </>
  ),
  orders: (
    <>
      <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
      <path d="M9 3h6v4H9V3Z" />
      <path d="M9 12h6M9 16h6" />
    </>
  ),
  assistant: (
    <>
      <rect x="5" y="8" width="14" height="11" rx="2" />
      <circle cx="9.5" cy="13" r="1" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="13" r="1" fill="currentColor" stroke="none" />
      <path d="M9 17h6M12 4v3" />
      <circle cx="12" cy="3" r="1.25" />
    </>
  ),
  tax: (
    <>
      <path d="M7 4h10v16H7z" />
      <path d="M9 8h6M9 12h6M9 16h4" />
      <path d="M14 4v3h3" />
    </>
  ),
  more: (
    <>
      <circle cx="6" cy="12" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="18" cy="12" r="1.25" fill="currentColor" stroke="none" />
    </>
  ),
  scan: (
    <>
      <path d="M4 7V5a1 1 0 0 1 1-1h2M4 17v2a1 1 0 0 0 1 1h2M16 4h2a1 1 0 0 1 1 1v2M16 20h2a1 1 0 0 0 1-1v-2" />
      <circle cx="12" cy="12" r="3.5" />
    </>
  ),
  archive: (
    <>
      <path d="M4 7h16v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7Z" />
      <path d="M9 4h6l1 3H8l1-3Z" />
      <path d="M9 12h6" />
    </>
  ),
};

export function NavIcon({ id, className = '' }: NavIconProps) {
  return (
    <svg
      className={`nav-icon ${className}`.trim()}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {ICONS[id]}
    </svg>
  );
}

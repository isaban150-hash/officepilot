import type { ReactElement } from 'react';

export type HeuteActionIconId =
  | 'scan'
  | 'understand'
  | 'invoice'
  | 'expense'
  | 'message'
  | 'search'
  | 'document'
  | 'calendar'
  | 'task';

interface HeuteActionIconProps {
  id: HeuteActionIconId;
  className?: string;
}

const ICONS: Record<HeuteActionIconId, ReactElement> = {
  scan: (
    <>
      <path d="M4 7V5a1 1 0 0 1 1-1h2M4 17v2a1 1 0 0 0 1 1h2M16 4h2a1 1 0 0 1 1 1v2M16 20h2a1 1 0 0 0 1-1v-2" />
      <circle cx="12" cy="12" r="3.5" />
    </>
  ),
  understand: (
    <>
      <path d="M4 6h16v12H4z" />
      <path d="M8 10h8M8 14h5" />
    </>
  ),
  invoice: (
    <>
      <path d="M7 4h10v16H7z" />
      <path d="M9 8h6M9 12h6M9 16h4" />
    </>
  ),
  expense: (
    <>
      <path d="M6 8h12v10H6z" />
      <path d="M9 6h6v2H9z" />
      <path d="M9 12h6" />
    </>
  ),
  message: (
    <>
      <path d="M4 6h16v10H4z" />
      <path d="M4 16l4-3 4 3 4-3 4 3" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="5.5" />
      <path d="M15.5 15.5 20 20" />
    </>
  ),
  document: (
    <>
      <path d="M8 4h8l2 2v14H8z" />
      <path d="M16 4v4h4" />
    </>
  ),
  calendar: (
    <>
      <path d="M5 6h14v14H5z" />
      <path d="M8 4v4M16 4v4M5 10h14" />
    </>
  ),
  task: (
    <>
      <path d="M5 7h14v12H5z" />
      <path d="M9 5h6v2H9z" />
      <path d="M9 12l2 2 4-4" />
    </>
  ),
};

export function HeuteActionIcon({ id, className = '' }: HeuteActionIconProps) {
  return (
    <svg
      className={`heute-action-icon ${className}`.trim()}
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

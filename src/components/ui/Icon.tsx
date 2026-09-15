import type { ReactElement } from 'react';

/**
 * UIUX-FOUNDATION-01B — kanonische SVG-Icon-Basis.
 *
 * Alle Icons sind 24×24-Strichzeichnungen in `currentColor` (derselbe Stil
 * wie `NavIcon`), damit sie Text- und Tokenfarben erben. Emojis sind als
 * UI-Icons nicht zulässig; neue Symbole werden hier ergänzt, nicht inline.
 *
 * Ohne `label` ist ein Icon dekorativ (`aria-hidden`). Mit `label` wird es
 * als eigenständiges Bild vorgelesen — nur für Icon-only-Flächen nötig.
 */
export type IconId =
  | 'check'
  | 'close'
  | 'info'
  | 'warning'
  | 'alert'
  | 'plus'
  | 'minus'
  | 'search'
  | 'chevron-down'
  | 'chevron-right'
  | 'chevron-left'
  | 'arrow-left'
  | 'arrow-right'
  | 'camera'
  | 'file'
  | 'image'
  | 'scanner'
  | 'mail'
  | 'paperclip'
  | 'lock'
  | 'calendar'
  | 'euro'
  | 'edit'
  | 'trash'
  | 'more'
  | 'settings'
  | 'user'
  | 'external'
  | 'download'
  | 'upload'
  | 'print'
  | 'clock'
  | 'refresh';

export type IconSize = 'sm' | 'md' | 'lg';

const ICONS: Record<IconId, ReactElement> = {
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  warning: (
    <>
      <path d="M12 3.5 21 19H3L12 3.5Z" />
      <path d="M12 10v4M12 17h.01" />
    </>
  ),
  alert: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5M12 16h.01" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" />
    </>
  ),
  'chevron-down': <path d="m6 9 6 6 6-6" />,
  'chevron-right': <path d="m9 6 6 6-6 6" />,
  'chevron-left': <path d="m15 6-6 6 6 6" />,
  'arrow-left': <path d="M19 12H5M11 6l-6 6 6 6" />,
  'arrow-right': <path d="M5 12h14M13 6l6 6-6 6" />,
  camera: (
    <>
      <path d="M4 8h3l1.5-2h7L17 8h3v11H4V8Z" />
      <circle cx="12" cy="13" r="3.25" />
    </>
  ),
  file: (
    <>
      <path d="M7 3h7l4 4v14H7V3Z" />
      <path d="M14 3v4h4M9.5 12h5M9.5 16h5" />
    </>
  ),
  image: (
    <>
      <rect x="4" y="5" width="16" height="14" rx="1.5" />
      <circle cx="9" cy="10" r="1.5" />
      <path d="m20 16-4.5-4.5L8 19" />
    </>
  ),
  scanner: (
    <>
      <path d="M4 14h16M6 14V6h12v8" />
      <path d="M6 14v4h12v-4M9 9h6" />
    </>
  ),
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="1.5" />
      <path d="m3 7 9 6 9-6" />
    </>
  ),
  paperclip: <path d="m20.5 11.5-8.4 8.4a5 5 0 0 1-7-7l8.8-8.8a3.3 3.3 0 0 1 4.7 4.7L10 17.4a1.7 1.7 0 0 1-2.4-2.4l7.7-7.7" />,
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="1.5" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  calendar: (
    <>
      <rect x="4" y="5" width="16" height="15" rx="1.5" />
      <path d="M4 10h16M8 3v4M16 3v4" />
    </>
  ),
  euro: <path d="M17 6.5A6 6 0 0 0 7.3 9H14M17 17.5A6 6 0 0 1 7.3 15H14M5 11h9M5 13h9" />,
  edit: <path d="M4 20h4l10.5-10.5a1.5 1.5 0 0 0 0-2.1l-1.9-1.9a1.5 1.5 0 0 0-2.1 0L4 16v4ZM13 7l4 4" />,
  trash: <path d="M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />,
  more: (
    <>
      <circle cx="6" cy="12" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="18" cy="12" r="1.25" fill="currentColor" stroke="none" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1Z" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </>
  ),
  external: <path d="M14 4h6v6M20 4l-9 9M18 13v6H5V6h6" />,
  download: <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />,
  upload: <path d="M12 15V4M7 9l5-5 5 5M5 20h14" />,
  print: (
    <>
      <path d="M7 8V4h10v4M7 17H4v-6h16v6h-3" />
      <rect x="7" y="14" width="10" height="6" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  refresh: <path d="M20 12a8 8 0 0 1-14.2 5M4 12a8 8 0 0 1 14.2-5M18 3v4h-4M6 21v-4h4" />,
};

export const ICON_IDS = Object.keys(ICONS) as IconId[];

export interface IconProps {
  id: IconId;
  size?: IconSize;
  className?: string;
  /** Nur setzen, wenn das Icon allein steht und Bedeutung trägt. */
  label?: string;
}

export function Icon({ id, size = 'md', className = '', label }: IconProps) {
  return (
    <svg
      className={['ui-icon', `ui-icon--${size}`, className].filter(Boolean).join(' ')}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      data-icon={id}
    >
      {ICONS[id]}
    </svg>
  );
}

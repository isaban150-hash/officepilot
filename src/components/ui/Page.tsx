import type { ReactNode } from 'react';

/**
 * UIUX-FOUNDATION-01D — Seitencontainer.
 *
 * Ersetzt das freie `<div className="page">` nicht per Zwang, gibt aber
 * eine benannte Breite: `default` (Arbeitslisten/Details), `narrow`
 * (Hubs, Einstellungen, Formulare), `wide` (Tabellen mit vielen Spalten).
 * Bewusst klein: Header, Toolbar und Inhalt sind eigene Primitives.
 */
export type PageWidth = 'default' | 'narrow' | 'wide';

export interface PageProps {
  children: ReactNode;
  width?: PageWidth;
  className?: string;
  testId?: string;
}

export function Page({ children, width = 'default', className = '', testId }: PageProps) {
  return (
    <div className={['page', width !== 'default' ? `page--${width}` : '', className].filter(Boolean).join(' ')} data-testid={testId}>
      {children}
    </div>
  );
}

/**
 * Toolbar unter dem Seitenkopf: Suche links, Filter darunter/rechts.
 * Nur Layout — Suchlogik und Filterzustand bleiben in der Seite.
 */
export interface PageToolbarProps {
  search?: ReactNode;
  filters?: ReactNode;
  /** Ansichtsschalter/Sortierung — nur wenn fachlich nötig. */
  extra?: ReactNode;
  className?: string;
  testId?: string;
}

export function PageToolbar({ search, filters, extra, className = '', testId = 'page-toolbar' }: PageToolbarProps) {
  if (!search && !filters && !extra) return null;
  return (
    <div className={['page-toolbar', className].filter(Boolean).join(' ')} data-testid={testId}>
      {search || extra ? (
        <div className="page-toolbar__row">
          {search ? <div className="page-toolbar__search">{search}</div> : null}
          {extra ? <div className="page-toolbar__extra">{extra}</div> : null}
        </div>
      ) : null}
      {filters ? <div className="page-toolbar__filters">{filters}</div> : null}
    </div>
  );
}

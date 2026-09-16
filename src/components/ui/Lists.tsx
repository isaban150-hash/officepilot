import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Icon, type IconId } from './Icon';

/**
 * UIUX-FOUNDATION-01D — Listenmodell.
 *
 * A. `RowList` / `RowListItem`: einfache Zeilen (Icon, Titel, Beschreibung,
 *    Chevron) für Hubs, „Mehr“, Einstellungen, kompakte Ressourcenlisten.
 * B. `BusinessList` / `BusinessListItem`: fachliche Zeilen für Rechnungen,
 *    Vorgänge, Kunden, Dokumente, Ausgaben — Identität, Sekundärinfo,
 *    Status, Betrag/Datum, genau eine Zeilenaktion (klickbar oder Button).
 * C. `DataTable`: nur für echte Vergleiche (Positionen, Zahlungen); mobil
 *    werden Zeilen gestapelt (`data-label`), nie horizontal gequetscht.
 *
 * Keine Karten-in-Karten: Listen liefern ihre eigene Fläche (ein Rahmen,
 * Trennlinien), Zeilen sind keine `Card`.
 */

/* ------------------------------------------------------------------ A */
export function RowList({ children, className = '', testId, ariaLabel }: { children: ReactNode; className?: string; testId?: string; ariaLabel?: string }) {
  return (
    <ul className={['row-list', className].filter(Boolean).join(' ')} data-testid={testId} aria-label={ariaLabel}>
      {children}
    </ul>
  );
}

export interface RowListItemProps {
  title: ReactNode;
  description?: ReactNode;
  icon?: IconId | ReactNode;
  /** Link-Ziel (bevorzugt) … */
  to?: string;
  /** … oder Klick-Handler (Button). */
  onClick?: () => void;
  /** Rechte Seite: Status, Wert, Schalter. Standard bei Link: Chevron. */
  trailing?: ReactNode;
  testId?: string;
  className?: string;
}

function renderIcon(icon: RowListItemProps['icon']): ReactNode {
  if (!icon) return null;
  if (typeof icon === 'string') return <Icon id={icon as IconId} className="row-list__icon" />;
  return <span className="row-list__icon">{icon}</span>;
}

export function RowListItem({ title, description, icon, to, onClick, trailing, testId, className = '' }: RowListItemProps) {
  const body = (
    <>
      {renderIcon(icon)}
      <span className="row-list__text">
        <span className="row-list__title">{title}</span>
        {description ? <span className="row-list__description">{description}</span> : null}
      </span>
      {trailing !== undefined ? (
        <span className="row-list__trailing">{trailing}</span>
      ) : to || onClick ? (
        <Icon id="chevron-right" className="row-list__chevron" />
      ) : null}
    </>
  );
  const cls = ['row-list__item', to || onClick ? 'row-list__item--interactive' : '', className].filter(Boolean).join(' ');
  return (
    <li className="row-list__row">
      {to ? (
        <Link to={to} className={cls} data-testid={testId}>
          {body}
        </Link>
      ) : onClick ? (
        <button type="button" className={cls} onClick={onClick} data-testid={testId}>
          {body}
        </button>
      ) : (
        <div className={cls} data-testid={testId}>
          {body}
        </div>
      )}
    </li>
  );
}

/* ------------------------------------------------------------------ B */
export function BusinessList({ children, className = '', testId, ariaLabel }: { children: ReactNode; className?: string; testId?: string; ariaLabel?: string }) {
  return (
    <ul className={['business-list', className].filter(Boolean).join(' ')} data-testid={testId} aria-label={ariaLabel}>
      {children}
    </ul>
  );
}

export interface BusinessListItemProps {
  /** Vorschau/Icon links vor der Identität (z. B. Dokument-Thumbnail). */
  leading?: ReactNode;
  /** Identität: Titel (z. B. Rechnungsnummer, Kundenname, Belegtitel). */
  title: ReactNode;
  /** Sekundärinfo unter dem Titel (Kunde, Lieferant, Nummer). */
  subtitle?: ReactNode;
  /** Kleine Meta-Zeile (Datum, Kategorie). */
  meta?: ReactNode;
  /** Statusdarstellung — bevorzugt `StatusBadge`. */
  status?: ReactNode;
  /** Betrag rechts — bevorzugt `MoneyDisplay`. */
  amount?: ReactNode;
  /** Datum rechts — bevorzugt `DateDisplay`. */
  date?: ReactNode;
  /** Klickbare Zeile … */
  to?: string;
  onClick?: () => void;
  /** … oder genau eine explizite Aktion (Button) statt klickbarer Zeile. */
  action?: ReactNode;
  /** Untere Zeile über die volle Breite: Aktionsgruppe oder Kennzahlen (nur bei nicht klickbarer Zeile). */
  footer?: ReactNode;
  testId?: string;
  /** Testid direkt auf dem Link/Button (z. B. für href-Prüfungen). */
  linkTestId?: string;
  className?: string;
}

export function BusinessListItem({ leading, title, subtitle, meta, status, amount, date, to, onClick, action, footer, testId, linkTestId, className = '' }: BusinessListItemProps) {
  const identity = (
    <span className={['business-list__identity', leading ? 'business-list__identity--with-leading' : ''].filter(Boolean).join(' ')}>
      {leading ? <span className="business-list__leading">{leading}</span> : null}
      <span className="business-list__identity-text">
      <span className="business-list__title">{title}</span>
      {subtitle ? <span className="business-list__subtitle">{subtitle}</span> : null}
      {meta ? <span className="business-list__meta">{meta}</span> : null}
      </span>
    </span>
  );
  const facts = (
    <span className="business-list__facts">
      {status ? <span className="business-list__status">{status}</span> : null}
      {date ? <span className="business-list__date">{date}</span> : null}
      {amount ? <span className="business-list__amount">{amount}</span> : null}
    </span>
  );
  const interactive = Boolean(to || onClick);
  const cls = ['business-list__item', interactive ? 'business-list__item--interactive' : '', className].filter(Boolean).join(' ');
  return (
    <li className="business-list__row" data-testid={testId}>
      {to ? (
        <Link to={to} className={cls} data-testid={linkTestId}>
          {identity}
          {facts}
          <Icon id="chevron-right" className="business-list__chevron" />
        </Link>
      ) : onClick ? (
        <button type="button" className={cls} onClick={onClick} data-testid={linkTestId}>
          {identity}
          {facts}
          <Icon id="chevron-right" className="business-list__chevron" />
        </button>
      ) : (
        <div className={cls}>
          {identity}
          {facts}
          {action ? <span className="business-list__action">{action}</span> : null}
          {footer ? <div className="business-list__footer">{footer}</div> : null}
        </div>
      )}
    </li>
  );
}

/* ------------------------------------------------------------------ C */
export interface DataTableColumn<Row> {
  id: string;
  header: ReactNode;
  cell: (row: Row) => ReactNode;
  align?: 'start' | 'end';
  /** Mobil ausblenden, wenn nicht vergleichsrelevant. */
  hideOnMobile?: boolean;
}

export interface DataTableProps<Row> {
  columns: readonly DataTableColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  caption?: string;
  testId?: string;
  className?: string;
}

export function DataTable<Row>({ columns, rows, rowKey, caption, testId = 'data-table', className = '' }: DataTableProps<Row>) {
  return (
    <div className={['data-table-wrap', className].filter(Boolean).join(' ')} data-testid={testId}>
      <table className="data-table">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.id} scope="col" className={[column.align === 'end' ? 'data-table__cell--end' : '', column.hideOnMobile ? 'data-table__cell--desktop' : ''].filter(Boolean).join(' ') || undefined}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column) => (
                <td
                  key={column.id}
                  data-label={typeof column.header === 'string' ? column.header : undefined}
                  className={[column.align === 'end' ? 'data-table__cell--end' : '', column.hideOnMobile ? 'data-table__cell--desktop' : ''].filter(Boolean).join(' ') || undefined}
                >
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

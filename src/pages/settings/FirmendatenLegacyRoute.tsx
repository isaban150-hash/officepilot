import { Navigate, useLocation } from 'react-router-dom';
import {
  BACKUP_SECTION_ID,
  FIRMENDATEN_INVOICE_SECTION_IDS,
  LOGO_SECTION_ID,
} from '../../services/backupSectionNavigation';
import { COMPANY_SETTINGS_ROUTE } from './CompanySettingsPage';
import { DESIGN_SETTINGS_ROUTE } from './DesignSettingsPage';
import { INVOICE_SETTINGS_ROUTE } from './InvoiceSettingsPage';
import { OPERATING_SETTINGS_BACKUP_HREF } from './OperatingSettingsPage';

/**
 * SETTINGS-01B2…01B5 — `/firmendaten` ist nur noch ein Redirect.
 *
 *   * ohne Hash                       → `/einstellungen/firma`
 *   * `#logo`                         → `/einstellungen/design`
 *   * `#zahlungsbedingungen`, `#rechnungstexte` → `/einstellungen/rechnungen`
 *   * `#datensicherung`               → `/einstellungen/betrieb#datensicherung`
 *   * unbekannter Hash                → `/einstellungen/firma`
 *
 * Immer `replace`, und kein Ziel verweist zurück auf `/firmendaten` — eine
 * Endlosschleife ist ausgeschlossen. Die alte Firmendaten-Seite wird nicht
 * mehr gerendert (01B5).
 */
export function resolveFirmendatenLegacyTarget(hash: string): string {
  const section = hash.replace(/^#/, '');
  if (section === LOGO_SECTION_ID) return DESIGN_SETTINGS_ROUTE;
  if (FIRMENDATEN_INVOICE_SECTION_IDS.includes(section)) return INVOICE_SETTINGS_ROUTE;
  if (section === BACKUP_SECTION_ID) return OPERATING_SETTINGS_BACKUP_HREF;
  return COMPANY_SETTINGS_ROUTE;
}

export function FirmendatenLegacyRoute() {
  const { hash } = useLocation();
  return <Navigate to={resolveFirmendatenLegacyTarget(hash)} replace />;
}

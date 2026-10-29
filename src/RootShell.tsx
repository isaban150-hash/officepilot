import App from './App';
import { AuthProvider } from './context/AuthContext';
import { BusinessStateGate } from './components/system/BusinessStateGate';
import { LocalRecoveryPage } from './pages/LocalRecoveryPage';
import { LocalRecoveryImportPage } from './pages/LocalRecoveryImportPage';
import { REPLY_TO_CONFIRM_ROUTE, ReplyToConfirmPage } from './pages/ReplyToConfirmPage';

export const LOCAL_RECOVERY_PATH = '/local-recovery';
export const LOCAL_RECOVERY_IMPORT_PATH = '/local-recovery/import';

/** Ausschließlich abschließende Schrägstriche werden entfernt — sonst nichts. */
function normalizePath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

function currentPath(pathname?: string): string {
  return normalizePath(
    pathname ?? (typeof window !== 'undefined' ? window.location.pathname : ''),
  );
}

/**
 * OFFICEPILOT-LOCAL-SCOPE-RECOVERY-01B — die Notfalladresse wird anhand der
 * echten Adresszeile erkannt, nicht über den Router. Nur so steht die
 * Entscheidung fest, bevor AuthProvider und BusinessStateGate überhaupt
 * montiert werden — und damit vor Anmeldung, Workspace-Ermittlung,
 * bootstrapBusinessState, Cloud-Pull, Scope-Migration und persistAll.
 */
export function isLocalRecoveryPath(pathname?: string): boolean {
  return currentPath(pathname) === LOCAL_RECOVERY_PATH;
}

/**
 * OFFICEPILOT-COMPANY-IDENTITY-RECOVERY-02P3 — zweite Notfalladresse für die
 * Zielsicherung und die lokale Quarantäne.
 *
 * Bewusst ein EXAKTER Vergleich und kein startsWith: sonst würde jeder
 * ähnliche Pfad — `/local-recovery-x`, `/local-recovery/import-extra`, jeder
 * Tippfehler — still an Anmeldung, Gate, Bootstrap und Sync vorbeigeführt.
 */
export function isLocalRecoveryImportPath(pathname?: string): boolean {
  return currentPath(pathname) === LOCAL_RECOVERY_IMPORT_PATH;
}

/**
 * EINRICHTUNG-01 (AP6; E-03, K4) — die Bestätigungsseite der Antwortadresse steht vor Anmeldung und Gate: Wer den Link
 * öffnet, braucht kein Konto, und kein Zustand der App (Sperre, Einladung, Einrichtung) darf die Bestätigung verdecken.
 * Exakter Vergleich wie bei den Notfalladressen.
 */
export function isReplyToConfirmPath(pathname?: string): boolean {
  return currentPath(pathname) === REPLY_TO_CONFIRM_ROUTE;
}

export function RootShell() {
  if (isReplyToConfirmPath()) {
    return <ReplyToConfirmPage />;
  }
  if (isLocalRecoveryPath()) {
    return <LocalRecoveryPage />;
  }
  if (isLocalRecoveryImportPath()) {
    return <LocalRecoveryImportPage />;
  }

  return (
    <AuthProvider>
      <BusinessStateGate>
        <App />
      </BusinessStateGate>
    </AuthProvider>
  );
}

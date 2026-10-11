/**
 * GO-LIVE-SECURITY-01 — wann eine Rechnung verbindlich ausgegeben werden darf.
 *
 * Druck, PDF und ZUGFeRD verlangen einen bestätigten Leistungszeitraum. Für
 * Inhaber, Verwaltung und den lokalen Betrieb genügt dafür wie bisher der
 * lokale Stand, auch offline: Ihre Bestätigung ist zulässig, selbst wenn sie
 * noch nicht online gesichert ist.
 *
 * Ohne Schreibrecht (Mitglied, oder die Rolle steht noch nicht fest) kann eine
 * lokale Bestätigung dagegen aus einem älteren Stand stammen, den die Cloud nie
 * angenommen hat. Sie gibt die Ausgabe erst frei, wenn die Cloud sie
 * nachweislich trägt: durch den Einzelread der Rechnungsseite oder einen Abzug
 * auf diesem Gerät. Bis dahin wartet die Ausgabe.
 *
 * Die Cloud-Bestätigung ist endgültig — es gibt keinen Rückweg. Ein einmal
 * gesehener Nachweis bleibt deshalb gültig und trägt auch offline. Er wird je
 * Betrieb nur auf diesem Gerät gehalten und nie synchronisiert.
 */
import { getSyncClientSnapshot } from '../sync/syncClientService';
import { getWorkspaceStoreSnapshot } from '../workspace/workspaceStore';
import type { WorkspaceWriteAccess } from '../workspace/workspaceRoleService';

/**
 * `verifying`: Der Abgleich läuft noch. `unverified`: Es gibt keinen Nachweis —
 * offline, ohne Cloud-Zeile oder nach einem Fehler.
 */
export type InvoiceOutputHold = 'verifying' | 'unverified';

export function resolveInvoiceOutputHold(input: {
  access: Pick<WorkspaceWriteAccess, 'canWrite'>;
  /** `invoice.servicePeriodConfirmed === true` auf diesem Gerät. */
  localConfirmed: boolean;
  /** Die Cloud trägt die Bestätigung nachweislich. */
  proven: boolean;
  /** Der Einzelread für diese Rechnung ist beendet, mit welchem Ergebnis auch immer. */
  cloudCheckDone: boolean;
}): InvoiceOutputHold | null {
  if (input.access.canWrite) return null;
  // Ohne lokale Bestätigung sperrt bereits der PDF-Validator; hier gibt es nichts zu prüfen.
  if (!input.localConfirmed) return null;
  if (input.proven) return null;
  return input.cloudCheckDone ? 'unverified' : 'verifying';
}

const STORAGE_PREFIX = 'officepilot-service-period-proof';

/** Je Betrieb die Rechnungen, deren Bestätigung die Cloud nachweislich trägt. */
const proofs = new Map<string, Set<string>>();

function storageKey(workspaceId: string): string {
  return `${STORAGE_PREFIX}:${workspaceId}`;
}

function load(workspaceId: string): Set<string> {
  const cached = proofs.get(workspaceId);
  if (cached) return cached;
  const ids = new Set<string>();
  try {
    const raw = localStorage.getItem(storageKey(workspaceId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      for (const value of parsed) {
        if (typeof value === 'string' && value.trim()) ids.add(value.trim());
      }
    }
  } catch {
    // Unlesbar oder nicht verfügbar: kein Nachweis, nicht etwa ein falscher.
  }
  proofs.set(workspaceId, ids);
  return ids;
}

/** Der Betrieb, in dem diese Sitzung arbeitet — dieselbe Auflösung wie für die Cloud-Aufrufe. */
export function resolveActiveCloudWorkspaceId(): string {
  const client = getSyncClientSnapshot();
  return (client.serverWorkspaceId ?? getWorkspaceStoreSnapshot()?.id ?? client.workspaceId ?? '').trim();
}

export function recordServicePeriodCloudProofs(workspaceId: string, invoiceIds: Iterable<string>): void {
  const scope = workspaceId.trim();
  if (!scope) return;
  const known = load(scope);
  let changed = false;
  for (const id of invoiceIds) {
    const invoiceId = id.trim();
    if (!invoiceId || known.has(invoiceId)) continue;
    known.add(invoiceId);
    changed = true;
  }
  if (!changed) return;
  try {
    localStorage.setItem(storageKey(scope), JSON.stringify([...known]));
  } catch {
    // Kein Speicher: Der Nachweis gilt dann nur für diese Sitzung.
  }
}

export function hasServicePeriodCloudProof(workspaceId: string, invoiceId: string): boolean {
  const scope = workspaceId.trim();
  if (!scope || !invoiceId.trim()) return false;
  return load(scope).has(invoiceId.trim());
}

export function resetServicePeriodCloudProofsForTests(): void {
  proofs.clear();
}

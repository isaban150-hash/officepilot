/**
 * CONTRACT-CUSTOMER-ASSIGNMENT-RESUME-01D — der ungespeicherte Entwurf einer
 * Kundenzuordnung, gebunden an genau ein Dokument.
 *
 * Warum eine eigene Ablage und nicht die UI-Sitzung: Deren Schnappschuss
 * besitzt genau **einen** Speicherplatz. Verlässt der Nutzer die Detailseite,
 * schreibt der Tracker den Schnappschuss der Folgeseite — und überschreibt den
 * Entwurf. Auf dem iPhone war damit nach „zurück und wieder öffnen" alles weg,
 * obwohl 01B es gemeldet hatte. Eine Liste, die nur gescrollt wurde, genügt für
 * dieses Überschreiben.
 *
 * Gebaut nach dem Muster von `localRecoveryCheckpointService`: ein versionierter,
 * geprüfter Datensatz in `localStorage`, an Scope, Workspace und Dokument
 * gebunden, mit eigener Haltbarkeit.
 *
 * Ausdrücklich **kein** produktives Speichern. Hier entsteht kein Kunde, kein
 * Auftrag und keine Zuordnung — nur ein lokaler Eingabestand, den der Nutzer
 * jederzeit selbst verwirft, indem er den Vorgang abschliesst.
 */
import { getActiveStorageKey } from './storageScopeService';
import { getWorkspaceStoreSnapshot } from '../workspace/workspaceStore';

export const CUSTOMER_ASSIGNMENT_DRAFT_PREFIX = 'officepilot-customer-assignment-draft';
export const CUSTOMER_ASSIGNMENT_DRAFT_VERSION = 1 as const;
/** Dieselbe Haltbarkeit wie ein schmutziger Entwurf der UI-Sitzung. */
export const CUSTOMER_ASSIGNMENT_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

/** Genau die Modi der Oberflaeche — auch 'none' ist eine getroffene Entscheidung. */
export type CustomerAssignmentDraftMode = 'new' | 'existing' | 'none';

export interface CustomerAssignmentDraft {
  kind: typeof CUSTOMER_ASSIGNMENT_DRAFT_PREFIX;
  version: typeof CUSTOMER_ASSIGNMENT_DRAFT_VERSION;
  /** Der Ausgangsstand, auf dem der Entwurf begann. */
  contractDecisionKey: string;
  mode: CustomerAssignmentDraftMode;
  selectedCustomerId: string;
  name: string;
  contactPerson: string;
  street: string;
  zip: string;
  city: string;
  email: string;
  phone: string;
  savedAt: string;
}

export interface CustomerAssignmentDraftLocator {
  itemId: string;
}

/**
 * Scope, Workspace und Dokument stecken im Schlüssel — ein Entwurf kann damit
 * niemals bei einem anderen Benutzer, einem anderen Workspace oder einem
 * anderen Dokument auftauchen.
 */
export function buildCustomerAssignmentDraftKey(locator: CustomerAssignmentDraftLocator): string {
  const workspaceId = getWorkspaceStoreSnapshot()?.id ?? 'none';
  return `${CUSTOMER_ASSIGNMENT_DRAFT_PREFIX}:${getActiveStorageKey()}:${workspaceId}:${locator.itemId}`;
}

function isText(value: unknown): value is string {
  return typeof value === 'string';
}

export function isValidCustomerAssignmentDraft(
  value: unknown,
): value is CustomerAssignmentDraft {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CustomerAssignmentDraft>;
  if (candidate.kind !== CUSTOMER_ASSIGNMENT_DRAFT_PREFIX) return false;
  if (candidate.version !== CUSTOMER_ASSIGNMENT_DRAFT_VERSION) return false;
  if (candidate.mode !== 'new' && candidate.mode !== 'existing' && candidate.mode !== 'none') {
    return false;
  }
  if (!isText(candidate.contractDecisionKey)) return false;
  if (!isText(candidate.savedAt) || !candidate.savedAt.trim()) return false;
  for (const field of [
    'selectedCustomerId',
    'name',
    'contactPerson',
    'street',
    'zip',
    'city',
    'email',
    'phone',
  ] as const) {
    if (!isText(candidate[field])) return false;
  }
  return true;
}

export type WriteCustomerAssignmentDraftInput = Omit<
  CustomerAssignmentDraft,
  'kind' | 'version' | 'savedAt'
> & { now?: string };

/**
 * Schreibt genau einen Entwurf je Dokument. Ein ungültiger Eingang wird nicht
 * gespeichert; ein fehlender oder voller Speicher bleibt folgenlos.
 */
export function writeCustomerAssignmentDraft(
  locator: CustomerAssignmentDraftLocator,
  input: WriteCustomerAssignmentDraftInput,
): CustomerAssignmentDraft | null {
  const { now, ...rest } = input;
  const draft: CustomerAssignmentDraft = {
    kind: CUSTOMER_ASSIGNMENT_DRAFT_PREFIX,
    version: CUSTOMER_ASSIGNMENT_DRAFT_VERSION,
    ...rest,
    savedAt: now ?? new Date().toISOString(),
  };
  if (!isValidCustomerAssignmentDraft(draft)) return null;

  try {
    localStorage.setItem(buildCustomerAssignmentDraftKey(locator), JSON.stringify(draft));
  } catch {
    return null;
  }
  return draft;
}

export function readCustomerAssignmentDraft(
  locator: CustomerAssignmentDraftLocator,
): CustomerAssignmentDraft | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(buildCustomerAssignmentDraftKey(locator));
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isValidCustomerAssignmentDraft(parsed) ? parsed : null;
}

export function clearCustomerAssignmentDraft(locator: CustomerAssignmentDraftLocator): void {
  try {
    localStorage.removeItem(buildCustomerAssignmentDraftKey(locator));
  } catch {
    // Ohne Speicher gibt es nichts zu entfernen.
  }
}

export type CustomerAssignmentDraftMatch =
  | { ok: true; draft: CustomerAssignmentDraft }
  | { ok: false; reason: 'missing' | 'stale_decision' | 'expired' };

/**
 * Gehört der Entwurf noch zum aktuellen Stand des Dokuments?
 *
 * Weicht der Vertragsentscheidungsschlüssel ab — anderer Auftragsvorschlag,
 * neu erkannte Gegenpartei —, wird **nicht** zusammengeführt, sondern verworfen.
 * Lieber erneute Eingabe als eine falsche Kundenzuordnung.
 */
export function matchCustomerAssignmentDraft(input: {
  draft: CustomerAssignmentDraft | null;
  contractDecisionKey: string;
  nowMs?: number;
}): CustomerAssignmentDraftMatch {
  const { draft, contractDecisionKey } = input;
  if (!draft) return { ok: false, reason: 'missing' };
  if (draft.contractDecisionKey !== contractDecisionKey) {
    return { ok: false, reason: 'stale_decision' };
  }
  const savedAt = Date.parse(draft.savedAt);
  const now = input.nowMs ?? Date.now();
  if (!Number.isFinite(savedAt) || now - savedAt > CUSTOMER_ASSIGNMENT_DRAFT_TTL_MS) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, draft };
}

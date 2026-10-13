import { getVorgangInvoice, restoreInvoiceSentState, updateInvoiceSentFields } from './vorgangService';
import { getBusinessDay } from './businessDateService';
import { runAutomaticSyncWrite } from './sync/syncOutboxService';
import {
  readInvoiceSentSnapshot,
  sentSnapshotsEqual,
  type InvoiceSentSnapshot,
} from './invoice/invoiceSentSnapshot';
import {
  readInvoiceSentState,
  resolveMemberInvoiceSentTarget,
  type InvoiceSentState,
} from './invoice/invoiceMemberAlignment';
import {
  resolveWorkspaceWriteAccess,
  UNKNOWN_CLOUD_ACTOR,
  type WorkspaceActor,
} from './workspace/workspaceRoleService';
import type { InvoiceSentVia, VorgangInvoice } from '../types/models';
import type { TranslationKey } from '../i18n';

export const INVOICE_SENT_VIA_OPTIONS: readonly InvoiceSentVia[] = [
  'email',
  'post',
  'persoenlich',
  'portal',
  'sonstige',
] as const;

export interface InvoiceSentInput {
  sentAt: string;
  sentVia: InvoiceSentVia;
  sentNote?: string;
}

export type InvoiceSentMutationResult =
  | { ok: true; invoice: VorgangInvoice }
  | {
      ok: false;
      reason:
        | 'invoice_missing'
        | 'not_prepared'
        | 'already_sent'
        | 'not_sent'
        | 'invalid_date'
        | 'invalid_via'
        | 'update_failed'
        /** INVOICE-SENT-PERSIST-01C — im Speicher geändert, aber nicht dauerhaft. */
        | 'persist_failed'
        /** GO-LIVE-SECURITY-01 — nur Inhaber und Verwaltung; nichts wurde geändert. */
        | 'forbidden'
        /**
         * FINANZ-CORE-01A (STO-04/AUS-09) — eine stornierte Rechnung wird nicht mehr als
         * versendet vermerkt. Nach internem Storno entstünde sonst „versendet und storniert"
         * ohne Korrekturbeleg (§ 14c UStG); der Server weist es ab (`invoice_cancelled`).
         */
        | 'cancelled';
    };

/**
 * GO-LIVE-SECURITY-01 — den Versand vermerken ist verbindlich: nur Inhaber und
 * Verwaltung. Geprüft wird hier, vor jeder lokalen Änderung, und nicht nur in
 * der Oberfläche. Ohne Angabe gilt die strengste Annahme (Cloud, Rolle
 * unbekannt); im bewusst lokalen Betrieb ohne Cloud bleibt alles erlaubt.
 */
function mayRecordInvoiceSent(actor: WorkspaceActor | undefined): boolean {
  return resolveWorkspaceWriteAccess(actor ?? UNKNOWN_CLOUD_ACTOR).canWrite;
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return false;
  const time = Date.parse(`${value.trim()}T00:00:00.000Z`);
  return Number.isFinite(time);
}

export function isValidInvoiceSentVia(value: unknown): value is InvoiceSentVia {
  return (
    typeof value === 'string' &&
    (INVOICE_SENT_VIA_OPTIONS as readonly string[]).includes(value)
  );
}

function parseSentInput(
  input: InvoiceSentInput,
): { ok: true; value: InvoiceSentInput } | { ok: false; reason: 'invalid_date' | 'invalid_via' } {
  const sentAt = input.sentAt?.trim() ?? '';
  if (!sentAt || !isIsoDate(sentAt)) {
    return { ok: false, reason: 'invalid_date' };
  }
  // FINANZ-CORE-01A (SQL-15) — ein Versanddatum liegt nicht in der Zukunft (wie der Server).
  if (sentAt > getBusinessDay()) {
    return { ok: false, reason: 'invalid_date' };
  }
  if (!isValidInvoiceSentVia(input.sentVia)) {
    return { ok: false, reason: 'invalid_via' };
  }
  return {
    ok: true,
    value: {
      sentAt,
      sentVia: input.sentVia,
      sentNote: input.sentNote?.trim() || undefined,
    },
  };
}

/**
 * Mark a prepared invoice as sent. Does not send email/post — records user confirmation only.
 * Never called by PDF generation.
 */
export function markInvoiceAsSent(
  /** MANUAL-INVOICE-UI-01B2 — `null` ist die freie Rechnung ohne Auftrag. */
  vorgangId: string | null,
  invoiceId: string,
  input: InvoiceSentInput,
  actor?: WorkspaceActor,
): InvoiceSentMutationResult {
  if (!mayRecordInvoiceSent(actor)) {
    return { ok: false, reason: 'forbidden' };
  }
  const invoice = getVorgangInvoice(vorgangId, invoiceId);
  if (!invoice) {
    return { ok: false, reason: 'invoice_missing' };
  }
  if (invoice.status === 'entwurf') {
    return { ok: false, reason: 'not_prepared' };
  }
  if (invoice.status === 'versendet') {
    return { ok: false, reason: 'already_sent' };
  }
  if (invoice.status !== 'vorbereitet') {
    return { ok: false, reason: 'not_prepared' };
  }
  if (invoice.cancelledAt) {
    return { ok: false, reason: 'cancelled' };
  }

  const parsed = parseSentInput(input);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason };
  }

  const updated = updateInvoiceSentFields(vorgangId, invoiceId, {
    status: 'versendet',
    sentAt: parsed.value.sentAt,
    sentVia: parsed.value.sentVia,
    sentNote: parsed.value.sentNote,
  });
  if (!updated.ok) {
    return { ok: false, reason: updated.reason === 'persist_failed' ? 'persist_failed' : 'update_failed' };
  }
  return { ok: true, invoice: updated.invoice };
}

/**
 * Correct send metadata on an already-sent invoice. Does not create a second send event
 * and does not change status away from versendet.
 */
export function updateInvoiceSentDetails(
  vorgangId: string | null,
  invoiceId: string,
  input: InvoiceSentInput,
  actor?: WorkspaceActor,
): InvoiceSentMutationResult {
  if (!mayRecordInvoiceSent(actor)) {
    return { ok: false, reason: 'forbidden' };
  }
  const invoice = getVorgangInvoice(vorgangId, invoiceId);
  if (!invoice) {
    return { ok: false, reason: 'invoice_missing' };
  }
  if (invoice.status !== 'versendet') {
    return { ok: false, reason: 'not_sent' };
  }

  const parsed = parseSentInput(input);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason };
  }

  const updated = updateInvoiceSentFields(vorgangId, invoiceId, {
    status: 'versendet',
    sentAt: parsed.value.sentAt,
    sentVia: parsed.value.sentVia,
    sentNote: parsed.value.sentNote,
  });
  if (!updated.ok) {
    return { ok: false, reason: updated.reason === 'persist_failed' ? 'persist_failed' : 'update_failed' };
  }
  return { ok: true, invoice: updated.invoice };
}

/**
 * INVOICE-SENT-CLOUD-DURABILITY-04B1S — Ergebnis der geräteübergreifenden Sicherung.
 *
 * Der frühere Vertrag kannte nur `not_configured` und warf damit zwei sehr
 * verschiedene Lagen zusammen: „dieses OfficePilot läuft bewusst ohne Cloud"
 * und „die Cloud ist da, aber der Workspace war nicht auflösbar". Nur die erste
 * ist ein Normalfall; die zweite ist ein Sync-Fehler und darf nicht schweigen.
 *
 * `local_invoice_invalid` verhindert, dass eine unvollständige Versandwahrheit
 * überhaupt hochgeladen wird.
 */
export type InvoiceSentCloudSyncResult =
  | 'synced'
  | 'supabase_not_configured'
  | 'workspace_missing'
  | 'local_invoice_invalid'
  | 'failed'
  /**
   * GO-LIVE-SECURITY-01 — die Rolle reicht nicht: vor dem Aufruf erkannt oder
   * vom Server abgewiesen. Ein lokaler Vermerk ist dann nicht freigegeben.
   */
  | 'forbidden';

/** Nur diese beiden Ausgänge sind kein Grund zur Warnung. */
export function isInvoiceSentCloudSyncSilent(result: InvoiceSentCloudSyncResult): boolean {
  return result === 'synced' || result === 'supabase_not_configured';
}

/**
 * Schreibt die bereits lokal bestätigte Versandwahrheit in die Cloud.
 *
 * Bewusst ein eigener Schritt **nach** der fachlichen Mutation: Die lokale
 * Wahrheit steht dann bereits fest und wird bei einem Cloud-Fehler nicht
 * zurückgenommen — der Nutzer hat den Versand schließlich bestätigt. Gemeldet
 * wird nur, ob er auch geräteübergreifend gesichert ist.
 *
 * Kein Outbox-Eintrag: Die vorhandene Warteschlange kennt keinen Rechnungstyp
 * und fasst mehrere Mutationen derselben Entität zusammen. Sie hier
 * anzuschließen wäre mehr Schein als Sicherheit.
 */
export async function syncInvoiceSentToCloud(
  vorgangId: string | null,
  invoiceId: string,
  actor?: WorkspaceActor,
): Promise<InvoiceSentCloudSyncResult> {
  // GO-LIVE-SECURITY-01 — ohne Schreibrecht gibt es nichts zu sichern.
  if (!mayRecordInvoiceSent(actor)) return 'forbidden';
  /*
   * 04B1S — die Funktion ist total: jeder Pfad liefert kontrolliert ein
   * Ergebnis. Vorher lag der erste dynamische Import außerhalb des Schutzes;
   * ein Fehler dort verließ die Funktion als Rejection, die im Panel niemand
   * fing — kein Cloud-Write und kein Hinweis.
   */
  try {
    const invoice = getVorgangInvoice(vorgangId, invoiceId);
    if (!invoice || invoice.status !== 'versendet' || !invoice.sentAt || !invoice.sentVia) {
      // Eine unvollständige Versandwahrheit wird nicht hochgeladen.
      return 'local_invoice_invalid';
    }

    const { isSupabaseConfigured } = await import('../lib/supabase');
    if (!isSupabaseConfigured()) return 'supabase_not_configured';

    const [{ rpcUpdateWorkspaceInvoiceSent }, { resolveCloudWorkspaceId }, persistence] =
      await Promise.all([
        import('./invoice/workspaceInvoiceCloudService'),
        import('./workspace/workspaceSyncPayloadService'),
        import('./persistenceService'),
      ]);

    const workspaceId = resolveCloudWorkspaceId(persistence.buildPersistedStateSnapshot()).trim();
    if (!workspaceId) {
      // Cloud vorhanden, Workspace nicht auflösbar — das ist ein Fehler.
      return 'workspace_missing';
    }

    await rpcUpdateWorkspaceInvoiceSent({
      workspaceId,
      clientInvoiceId: invoice.id,
      sentAt: invoice.sentAt,
      sentVia: invoice.sentVia,
      sentNote: invoice.sentNote,
    });
    return 'synced';
  } catch (error) {
    // GO-LIVE-SECURITY-01 — die Rollenabweisung des Servers (42501) ist kein Netzfehler.
    return isRoleDenial(error) ? 'forbidden' : 'failed';
  }
}

/** Rollenabweisung des Servers, eingestuft von `classifyInvoiceCloudError`. */
function isRoleDenial(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'rls';
}

/**
 * GO-LIVE-SECURITY-01 — der Versandstand vor einer Aktion. Weist der Server die
 * Aktion wegen der Rolle ab, wird genau dieser Stand wiederhergestellt.
 */
export function captureInvoiceSentState(vorgangId: string | null, invoiceId: string): InvoiceSentState | null {
  const invoice = getVorgangInvoice(vorgangId, invoiceId);
  return invoice ? readInvoiceSentState(invoice) : null;
}

/**
 * GO-LIVE-SECURITY-01 — der Server hat den Vermerk wegen der Rolle abgewiesen.
 * Lokal gilt wieder der Stand vor der Aktion: Ein Versand, den es in der Cloud
 * nicht gibt, darf hier nicht als Erfolg stehen bleiben — er gäbe sonst auf
 * diesem Gerät Mahnung und Folgeaktionen frei.
 */
export function revertInvoiceSentAfterRoleDenial(
  vorgangId: string | null,
  invoiceId: string,
  previous: InvoiceSentState,
): InvoiceSentMutationResult {
  const restored = restoreInvoiceSentState(vorgangId, invoiceId, previous);
  if (!restored.ok) {
    return { ok: false, reason: restored.reason === 'persist_failed' ? 'persist_failed' : 'invoice_missing' };
  }
  return { ok: true, invoice: restored.invoice };
}

/**
 * GO-LIVE-SECURITY-01 — Gerät eines Mitglieds: Weicht der lokale Versandstand
 * von der Cloud ab, stammt er nicht aus einer zulässigen Aktion (siehe
 * `invoiceMemberAlignment`). Dann gilt der Stand der Cloud.
 *
 * Nur für eine bekannte Mitgliedsrolle und nur mit frisch gelesenem
 * Cloud-Stand. Ohne Antwort bleibt alles, wie es ist. Liefert die angeglichene
 * Rechnung oder `null`, wenn nichts zu tun war.
 */
export async function alignInvoiceSentWithCloudForMember(
  vorgangId: string | null,
  invoiceId: string,
  actor: WorkspaceActor,
): Promise<VorgangInvoice | null> {
  if (resolveWorkspaceWriteAccess(actor).reason !== 'member') return null;
  return adoptCloudInvoiceSentState(vorgangId, invoiceId);
}

/**
 * GO-LIVE-SECURITY-01 — „Jetzt sichern" oder „Lokalen Stand verwenden" kam als
 * Rollenabweisung zurück. Damit ist bewiesen, dass der lokale Stand nicht
 * freigegeben ist, auch wenn dieses Gerät die Rolle noch anders kennt: Es gilt
 * der Stand der Cloud.
 */
export async function adoptCloudInvoiceSentStateAfterRoleDenial(
  vorgangId: string | null,
  invoiceId: string,
): Promise<VorgangInvoice | null> {
  return adoptCloudInvoiceSentState(vorgangId, invoiceId);
}

async function adoptCloudInvoiceSentState(vorgangId: string | null, invoiceId: string): Promise<VorgangInvoice | null> {
  try {
    const invoice = getVorgangInvoice(vorgangId, invoiceId);
    if (!invoice) return null;

    const [{ rpcGetWorkspaceInvoiceSent }, { resolveCloudWorkspaceId }, persistence] = await Promise.all([
      import('./invoice/workspaceInvoiceCloudService'),
      import('./workspace/workspaceSyncPayloadService'),
      import('./persistenceService'),
    ]);
    const workspaceId = resolveCloudWorkspaceId(persistence.buildPersistedStateSnapshot()).trim();
    if (!workspaceId) return null;

    const cloud = await rpcGetWorkspaceInvoiceSent({ workspaceId, clientInvoiceId: invoice.id });
    if (!cloud.found) return null;
    const target = resolveMemberInvoiceSentTarget(invoice, { snapshot: cloud.snapshot, status: cloud.status });
    if (!target) return null;
    // KONTOSPERRE — automatischer Schreiber ohne Nutzeraktion: der Änderungsverfolger nimmt den gesperrten Weg.
    const restored = runAutomaticSyncWrite(() => restoreInvoiceSentState(vorgangId, invoiceId, target));
    return restored.ok ? restored.invoice : null;
  } catch {
    // Kein Beweis, keine Änderung.
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* INVOICE-SENT-CLOUD-DURABILITY-01B — Reconciliation                          */
/* -------------------------------------------------------------------------- */

/**
 * Der abgeleitete Cloud-Zustand des Versands.
 *
 * Rekonstruiert bei jedem Öffnen aus zwei persistierten Wahrheiten — lokalem
 * Versandsatz und Cloud-Einzelread. Deshalb braucht es keinen gespeicherten
 * Pending-Marker: Es gibt nichts, das ein Neustart verlieren könnte.
 */
export type InvoiceSentCloudState =
  /** Beide Seiten gleich — oder beide ohne Versand. Nichts zu tun. */
  | { kind: 'synced' }
  /** Lokal versendet, die Cloud weiss nichts davon. Sicher nachreichbar. */
  | { kind: 'pending' }
  /** Beide Seiten versendet, aber verschieden. Nur der Mensch kann entscheiden. */
  | { kind: 'conflict'; cloud: InvoiceSentSnapshot }
  /** Nur die Cloud kennt einen Versand — lokal übernehmbar. */
  | { kind: 'cloud_only'; cloud: InvoiceSentSnapshot }
  /** Die Cloud kennt diese Rechnung nicht. Nichts zu sichern. */
  | { kind: 'missing' }
  /** Kein Beweis in die eine oder andere Richtung. */
  | { kind: 'unknown' }
  /** Bewusst lokaler Betrieb. */
  | { kind: 'not_configured' };

/**
 * Die Konfliktmatrix, rein und ohne Seiteneffekte.
 *
 * ⚠️ Es gibt bewusst **keine** automatische Auflösung bei beidseitigen Werten.
 * `sentAt` ist das fachliche Versanddatum, das der Nutzer eintippt — kein
 * Schreibzeitpunkt. Der lokale Speicher kennt auch keine Cloud-`row_version`.
 * „Der neuere gewinnt" wäre damit geraten, nicht bestimmt, und könnte eine
 * legitime Korrektur eines anderen Geräts überschreiben.
 */
export function deriveInvoiceSentCloudState(
  local: InvoiceSentSnapshot | null,
  cloud: { found: boolean; snapshot: InvoiceSentSnapshot | null },
): InvoiceSentCloudState {
  if (!cloud.found) return { kind: 'missing' };
  if (sentSnapshotsEqual(local, cloud.snapshot)) return { kind: 'synced' };
  if (!local) {
    // Nur möglich, wenn die Cloud etwas hat — sonst wären beide null gewesen.
    return { kind: 'cloud_only', cloud: cloud.snapshot! };
  }
  if (!cloud.snapshot) return { kind: 'pending' };
  return { kind: 'conflict', cloud: cloud.snapshot };
}

/**
 * Liest den Cloud-Versandstand einer einzelnen Rechnung und leitet den Zustand
 * ab. Verändert die lokale Rechnung nicht.
 */
export async function readInvoiceSentStateFromCloud(
  /**
   * MANUAL-INVOICE-UI-01B2 — `null` ist die freie Rechnung ohne Auftrag. Der
   * Cloud-Vertrag (`get_workspace_invoice_sent`) adressiert ohnehin nur über
   * `client_invoice_id`; der Vorgang dient allein der lokalen Auflösung.
   */
  vorgangId: string | null,
  invoiceId: string,
): Promise<InvoiceSentCloudState> {
  try {
    const invoice = getVorgangInvoice(vorgangId, invoiceId);
    if (!invoice) return { kind: 'unknown' };

    const { isSupabaseConfigured } = await import('../lib/supabase');
    if (!isSupabaseConfigured()) return { kind: 'not_configured' };

    const [{ rpcGetWorkspaceInvoiceSent }, { resolveCloudWorkspaceId }, persistence] =
      await Promise.all([
        import('./invoice/workspaceInvoiceCloudService'),
        import('./workspace/workspaceSyncPayloadService'),
        import('./persistenceService'),
      ]);

    const workspaceId = resolveCloudWorkspaceId(persistence.buildPersistedStateSnapshot()).trim();
    if (!workspaceId) return { kind: 'unknown' };

    const cloud = await rpcGetWorkspaceInvoiceSent({ workspaceId, clientInvoiceId: invoice.id });
    return deriveInvoiceSentCloudState(readInvoiceSentSnapshot(invoice), cloud);
  } catch {
    // Kein Beweis, keine Aussage.
    return { kind: 'unknown' };
  }
}

export function formatInvoiceSentViaLabel(
  via: InvoiceSentVia | undefined,
  translate: (key: TranslationKey) => string,
): string {
  if (!via) return translate('invoice.sent.via.unknown');
  return translate(`invoice.sent.via.${via}` as TranslationKey);
}

/**
 * FINANZ-CORE-01A (Gesamtnacharbeit INV-01/02) — die Fristgrundlage einer freigegebenen Rechnung klären.
 *
 * WEISS-Gesamtmängelinventur (15.10.2026): Ein Altbeleg ohne Kundenverknüpfung blieb bei einem
 * ungeklärten Feiertag dauerhaft gesperrt (INV-01), und eine Auslandsfrist galt nach drei Werktagen als
 * verspätet, ohne dass jemand das Ende geprüft hatte (INV-02). Jetzt wird an der Rechnung selbst
 * festgehalten,
 *  - in welchem Bundesland der Sitz des Kunden lag (`art: 'inland'`), oder
 *  - welches wirksame Ende eine bestimmte Frist im Ausland hatte (`art: 'ausland'`).
 *
 * Der Beleg bleibt unverändert. Der Server (`clarify_workspace_invoice_frist`) prüft Rolle (nur Inhaber
 * und Verwaltung), Sperrfolge und Zustand, protokolliert Person, Zeit, Begründung sowie die Lage vorher und
 * nachher, und liefert die Zeile mit der neuen Fristgrundlage zurück. Ohne Cloud (lokaler Betrieb) hält
 * das Gerät die Klärung an der Rechnung fest.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient, isSupabaseConfigured } from '../../lib/supabase';
import { buildPersistedStateSnapshot } from '../persistenceService';
import { resolveCloudWorkspaceId } from '../workspace/workspaceSyncPayloadService';
import { resolveWorkspaceWriteAccess, type WorkspaceActor } from '../workspace/workspaceRoleService';
import { generateUuid } from '../sync/syncMetaService';
import { getVorgangInvoice, updateInvoiceFristBasis } from '../vorgangService';
import { isFinalizedInvoice } from '../invoiceArchiveService';
import { addCalendarDays, parseSkontoFromText } from '../invoiceTaxService';
import { addDays, isBundesland, isWeekend } from '../fristen/feiertage';
import { invoiceFristLage, parseInvoiceFristBasis, type FristLage } from '../fristen/fristende';
import { mapWorkspaceInvoicePullRowToVorgangInvoice, parseWorkspaceInvoicePullRow } from './workspaceInvoiceCloudService';
import { findFinalInvoiceBlockingPaymentReversal } from './invoiceCancelEligibility';
import { getClosuresForMonth } from '../accounting/accountingPeriodStore';
import type { InvoiceFristBasis, InvoiceFristKlaerung, VorgangInvoice } from '../../types/models';

export type FristKlaerungErrorKey =
  | 'invoice.frist.invalid'
  | 'invoice.frist.reasonRequired'
  | 'invoice.frist.notFound'
  | 'invoice.frist.notFinalized'
  | 'invoice.frist.cancelled'
  | 'invoice.frist.waived'
  | 'invoice.frist.finalInvoiceExists'
  | 'invoice.frist.forbidden'
  | 'invoice.frist.conflict'
  | 'invoice.frist.workspaceMissing'
  | 'invoice.frist.failed';

export type FristKlaerungResult =
  | { ok: true; invoice: VorgangInvoice }
  | { ok: false; errorKey: FristKlaerungErrorKey; detail?: string };

export interface FristKlaerungInput {
  vorgangId: string | null;
  invoiceId: string;
  klaerung: InvoiceFristKlaerung;
  begruendung: string;
  /** Wer klärt. Ohne Angabe wie bei Zahlungen: keine Rollenprüfung im Client (Server prüft immer). */
  actor?: WorkspaceActor;
  /** Wiederholung eines unterbrochenen Versuchs: dieselbe Kennung trifft dieselbe Klärung. */
  klaerungId?: string;
}

/** Die kalendarischen Fristenden dieser Rechnung: Skontofrist und Zahlungsziel (ISO). */
export function kalenderFristenden(invoice: VorgangInvoice): { skonto: string | null; zahlungsziel: string | null } {
  const skonto = (() => {
    const parsed = invoice.skontoText?.trim() ? parseSkontoFromText(invoice.skontoText) : null;
    const basis = (invoice.issueDate ?? invoice.date ?? '').slice(0, 10);
    if (!parsed || !/^\d{4}-\d{2}-\d{2}$/.test(basis)) return null;
    return addCalendarDays(basis, parsed.days).slice(0, 10);
  })();
  const ziel = invoice.paymentDueDate?.trim().slice(0, 10) ?? '';
  return { skonto, zahlungsziel: /^\d{4}-\d{2}-\d{2}$/.test(ziel) ? ziel : null };
}

function sonnabendSonntagEnde(kalenderEnde: string): string {
  let tag = kalenderEnde;
  for (let i = 0; i < 40 && isWeekend(tag); i += 1) tag = addDays(tag, 1);
  return tag;
}

/** Dieselbe Prüfung wie der Server, vor jeder Übertragung. */
export function validateFristKlaerung(
  invoice: VorgangInvoice,
  klaerung: InvoiceFristKlaerung,
  begruendung: string,
): FristKlaerungErrorKey | null {
  const grund = begruendung.trim();
  if (grund.length < 3 || grund.length > 500) return 'invoice.frist.reasonRequired';
  if (klaerung.art === 'inland') {
    return isBundesland(klaerung.region) ? null : 'invoice.frist.invalid';
  }
  if (klaerung.art === 'ausland') {
    const iso = /^\d{4}-\d{2}-\d{2}$/;
    if (!iso.test(klaerung.kalenderEnde) || !iso.test(klaerung.wirksamesEnde)) return 'invoice.frist.invalid';
    const enden = kalenderFristenden(invoice);
    if (klaerung.kalenderEnde !== enden.skonto && klaerung.kalenderEnde !== enden.zahlungsziel) return 'invoice.frist.invalid';
    if (klaerung.wirksamesEnde < sonnabendSonntagEnde(klaerung.kalenderEnde)) return 'invoice.frist.invalid';
    if (isWeekend(klaerung.wirksamesEnde)) return 'invoice.frist.invalid';
    if (klaerung.wirksamesEnde > addDays(klaerung.kalenderEnde, 60)) return 'invoice.frist.invalid';
    return null;
  }
  return 'invoice.frist.invalid';
}

/** Die Angabe in der Normalform des Servers (nur Gemeindeangaben, die für das Land etwas bedeuten). */
export function normalizeFristKlaerung(klaerung: InvoiceFristKlaerung): InvoiceFristKlaerung {
  if (klaerung.art === 'ausland') {
    return { art: 'ausland', kalenderEnde: klaerung.kalenderEnde, wirksamesEnde: klaerung.wirksamesEnde };
  }
  const out: Extract<InvoiceFristKlaerung, { art: 'inland' }> = { art: 'inland', region: klaerung.region };
  if ((klaerung.region === 'SN' || klaerung.region === 'TH') && typeof klaerung.fronleichnam === 'boolean') {
    out.fronleichnam = klaerung.fronleichnam;
  }
  if (klaerung.region === 'BY') {
    if (typeof klaerung.mariaeHimmelfahrt === 'boolean') out.mariaeHimmelfahrt = klaerung.mariaeHimmelfahrt;
    if (typeof klaerung.augsburgerFriedensfest === 'boolean') out.augsburgerFriedensfest = klaerung.augsburgerFriedensfest;
  }
  return out;
}

/** Die Lage nach der Klärung — wie `clarify_workspace_invoice_frist` sie bildet. */
export function lageNachKlaerung(vorher: FristLage, klaerung: InvoiceFristKlaerung): FristLage {
  const k = normalizeFristKlaerung(klaerung);
  if (k.art === 'inland') {
    const gemeinde: Record<string, boolean> = {};
    for (const key of ['fronleichnam', 'mariaeHimmelfahrt', 'augsburgerFriedensfest'] as const) {
      if (typeof k[key] === 'boolean') gemeinde[key] = k[key] as boolean;
    }
    return { art: 'inland', laender: [k.region], gemeinde, quelle: 'klaerung' };
  }
  const geprueft = vorher.art === 'ausland' ? { ...(vorher.geprueft ?? {}) } : {};
  geprueft[k.kalenderEnde] = k.wirksamesEnde;
  return {
    art: 'ausland',
    ohneFeiertagBestaetigt: vorher.art === 'ausland' ? vorher.ohneFeiertagBestaetigt : false,
    geprueft,
    quelle: 'klaerung',
  };
}

function errorKeyForServerMessage(message: string): FristKlaerungErrorKey {
  if (/finance_forbidden_role|finance_account|finance_license|Keine Schreibberechtigung|Kein Zugriff|account_blocked/.test(message)) {
    return 'invoice.frist.forbidden';
  }
  if (message.includes('invoice_frist_final_invoice_exists')) return 'invoice.frist.finalInvoiceExists';
  if (message.includes('invoice_frist_abbedungen')) return 'invoice.frist.waived';
  if (message.includes('invoice_frist_klaerung_conflict')) return 'invoice.frist.conflict';
  if (message.includes('invoice_frist_klaerung_invalid')) return 'invoice.frist.invalid';
  if (message.includes('Rechnung storniert')) return 'invoice.frist.cancelled';
  if (message.includes('Rechnung nicht finalisiert')) return 'invoice.frist.notFinalized';
  if (message.includes('Rechnung nicht gefunden')) return 'invoice.frist.notFound';
  return 'invoice.frist.failed';
}

/**
 * FINANZ-CORE-01A (Restnacharbeit END18-R2) — ob die Fristgrundlage dieser Rechnung (noch) berichtigt werden
 * darf; sonst der Grund. Dieselben Sperren wie beim Server: Entwurf, Storno, abbedungene Verschiebung und ein
 * durch eine wirksame Schlussrechnung abgerechneter Abschlag (dessen Aufteilung ist eingefroren).
 */
export function fristBerichtigungSperre(vorgangId: string | null, invoice: VorgangInvoice): FristKlaerungErrorKey | null {
  if (!isFinalizedInvoice(invoice)) return 'invoice.frist.notFinalized';
  if (invoice.cancelledAt || invoice.paymentStatus === 'storniert') return 'invoice.frist.cancelled';
  if (invoice.deadlineShiftWaived === true) return 'invoice.frist.waived';
  if (findFinalInvoiceBlockingPaymentReversal(vorgangId, invoice)) return 'invoice.frist.finalInvoiceExists';
  return null;
}

/**
 * END18-R2 — abgeschlossene (nicht wieder geöffnete) Monate, deren Übergabe eine Berichtigung verändern kann:
 * die Monate der Zahlungen dieser Rechnung (dort steht ihr Skonto). Die Berichtigung schreibt keinen Abschluss
 * um; er zeigt danach „Seit Abschluss geändert“ und muss bewusst neu geprüft werden.
 */
export function abgeschlosseneMonateDerRechnung(invoice: VorgangInvoice): string[] {
  const monate = new Set((invoice.payments ?? []).map((payment) => String(payment.date).slice(0, 7)));
  return [...monate].filter((monat) => getClosuresForMonth(monat).some((closure) => !closure.reopenedAt)).sort();
}

/** Ein bewusster Klärungsversuch: Kennung und der Inhalt, für den sie gilt. */
export interface FristKlaerungVersuch {
  id: string;
  inhalt: string;
}

/**
 * FINANZ-CORE-01A (Restnacharbeit END18-R1) — dieselbe Kennung für denselben **unveränderten** Versuch
 * (etwa nach einer verlorenen Antwort: der Server erkennt die Wiederholung und protokolliert nichts doppelt);
 * jede inhaltliche Änderung (Ort, Gemeindefeiertage, Fristende, Grundlage) ist ein neuer bewusster Versuch
 * mit neuer Kennung.
 */
export function naechsterKlaerungsVersuch(
  bisher: FristKlaerungVersuch | undefined,
  klaerung: InvoiceFristKlaerung,
  begruendung: string,
): FristKlaerungVersuch {
  const inhalt = JSON.stringify({ klaerung: normalizeFristKlaerung(klaerung), begruendung: begruendung.trim() });
  return bisher && bisher.inhalt === inhalt ? bisher : { id: `kl-${generateUuid()}`, inhalt };
}

export async function klaereRechnungsfrist(
  input: FristKlaerungInput,
  override?: { client?: SupabaseClient | null; workspaceId?: string },
): Promise<FristKlaerungResult> {
  if (input.actor && !resolveWorkspaceWriteAccess(input.actor).canWrite) {
    return { ok: false, errorKey: 'invoice.frist.forbidden' };
  }
  const invoice = getVorgangInvoice(input.vorgangId, input.invoiceId);
  if (!invoice) return { ok: false, errorKey: 'invoice.frist.notFound' };
  if (!isFinalizedInvoice(invoice)) return { ok: false, errorKey: 'invoice.frist.notFinalized' };
  if (invoice.cancelledAt || invoice.paymentStatus === 'storniert') return { ok: false, errorKey: 'invoice.frist.cancelled' };
  if (invoice.deadlineShiftWaived === true) return { ok: false, errorKey: 'invoice.frist.waived' };
  if (findFinalInvoiceBlockingPaymentReversal(input.vorgangId, invoice)) {
    return { ok: false, errorKey: 'invoice.frist.finalInvoiceExists' };
  }
  const invalid = validateFristKlaerung(invoice, input.klaerung, input.begruendung);
  if (invalid) return { ok: false, errorKey: invalid };

  const klaerung = normalizeFristKlaerung(input.klaerung);
  const begruendung = input.begruendung.trim();
  const klaerungId = input.klaerungId?.trim() || `kl-${generateUuid()}`;

  // Lokaler Betrieb ohne Cloud: das Gerät hält die Klärung an der Rechnung fest.
  if (!override?.client && !isSupabaseConfigured()) {
    /*
     * END18-R1 / Bericht 20 (END19-R3) — derselbe Vertrag wie der Server: dieselbe Kennung mit demselben
     * normierten Inhalt (Angabe und Grund) ist eine Wiederholung — nichts ändert sich ein zweites Mal; dieselbe
     * Kennung mit anderem Inhalt ist ein Konflikt, kein Erfolg.
     */
    const bisher = invoice.fristBasis?.klaerung;
    if (bisher?.id === klaerungId) {
      const bisherAngabe = bisher.angabe ? JSON.stringify(normalizeFristKlaerung(bisher.angabe as unknown as InvoiceFristKlaerung)) : null;
      const gleich = bisherAngabe === JSON.stringify(klaerung) && bisher.begruendung === begruendung;
      return gleich ? { ok: true, invoice } : { ok: false, errorKey: 'invoice.frist.conflict' };
    }
    const jetzt = new Date().toISOString();
    const basis: InvoiceFristBasis = {
      lage: lageNachKlaerung(invoiceFristLage(invoice), klaerung),
      quelle: 'klaerung',
      festgelegtAm: jetzt,
      klaerung: { id: klaerungId, begruendung, am: jetzt, angabe: { ...klaerung } },
    };
    const lokal = updateInvoiceFristBasis(input.vorgangId, input.invoiceId, basis);
    return lokal.ok ? { ok: true, invoice: lokal.invoice } : { ok: false, errorKey: 'invoice.frist.failed', detail: lokal.reason };
  }

  const client = override?.client ?? getSupabaseClient();
  if (!client) return { ok: false, errorKey: 'invoice.frist.failed', detail: 'client' };
  const workspaceId = (override?.workspaceId ?? resolveCloudWorkspaceId(buildPersistedStateSnapshot())).trim();
  if (!workspaceId) return { ok: false, errorKey: 'invoice.frist.workspaceMissing' };

  let data: unknown;
  try {
    const response = await client.rpc('clarify_workspace_invoice_frist', {
      p_workspace_id: workspaceId,
      p_client_invoice_id: input.invoiceId,
      p_client_klaerung_id: klaerungId,
      p_klaerung: klaerung,
      p_begruendung: begruendung,
    });
    if (response.error) {
      return { ok: false, errorKey: errorKeyForServerMessage(response.error.message ?? ''), detail: response.error.message };
    }
    data = response.data;
  } catch (error) {
    return { ok: false, errorKey: 'invoice.frist.failed', detail: error instanceof Error ? error.message : 'network' };
  }

  // Erfolg heißt: genau diese Rechnung mit einer lesbaren, geklärten Fristgrundlage.
  const rows = Array.isArray(data) ? data : [data];
  const parsed = rows.length === 1 ? parseWorkspaceInvoicePullRow(rows[0]) : null;
  if (!parsed || parsed.workspace_id !== workspaceId || parsed.client_invoice_id !== input.invoiceId) {
    return { ok: false, errorKey: 'invoice.frist.failed', detail: 'response' };
  }
  const fristBasis = parseInvoiceFristBasis(mapWorkspaceInvoicePullRowToVorgangInvoice(parsed).invoice.fristBasis);
  if (!fristBasis || fristBasis.quelle !== 'klaerung' || fristBasis.klaerung?.id !== klaerungId) {
    return { ok: false, errorKey: 'invoice.frist.failed', detail: 'response.frist_basis' };
  }
  const lokal = updateInvoiceFristBasis(input.vorgangId, input.invoiceId, fristBasis);
  return lokal.ok ? { ok: true, invoice: lokal.invoice } : { ok: false, errorKey: 'invoice.frist.failed', detail: lokal.reason };
}

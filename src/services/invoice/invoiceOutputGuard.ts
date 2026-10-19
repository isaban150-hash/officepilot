/**
 * GO-LIVE-SECURITY-01 — die gemeinsame Dienstgrenze für verbindliche Ausgaben einer Rechnung.
 *
 * Jeder Ausgabedienst fragt hier, bevor er Bytes herausgibt: das PDF (auch Korrektur und
 * die PDF/A-Hülle von ZUGFeRD), die XRechnung und die ZUGFeRD-Rechnung — neu erzeugt
 * ebenso wie eine bereits abgelegte Datei. Damit gilt dieselbe Regel auch dann, wenn die
 * Oberfläche umgangen und ein Dienst direkt aufgerufen wird.
 *
 * Zwei Prüfungen, in dieser Reihenfolge:
 *  1. Für jede Rolle: ohne gültigen, bestätigten Leistungszeitraum keine Ausgabe (die
 *     Codes des PDF-Validators, siehe `einvoiceOutputRule`).
 *  2. Für ein Mitglied — und ebenso bei unbekannter Sitzung oder Mitgliedschaft (SYS-04) — zusätzlich: Die Bestätigung muss nachweislich in der
 *     Cloud liegen — ein früherer Nachweis auf diesem Gerät oder ein Einzelread jetzt
 *     (siehe `invoiceOutputClearance`). Die Rolle stammt aus der Sitzung des Browsers und
 *     dem gezogenen Mitgliederstand, nicht aus einer Angabe des Aufrufers.
 *
 * Inhaber, Verwaltung und der lokale Betrieb bleiben beim lokalen Stand, auch offline.
 *
 * Grenze der Aussage: Das schützt die regulären Wege und direkte Dienstaufrufe auf einem
 * unveränderten Gerät, auch gegen einen veralteten lokalen Stand. Es ist **kein**
 * Manipulationsschutz: Wer Browser-Speicher oder Code verändert, umgeht jede Prüfung im
 * Browser. Eine verbindliche Garantie kann nur der Server geben.
 */
import type { VorgangInvoice } from '../../types/models';
import { findServicePeriodOutputBlockers, type ServicePeriodOutputCode } from '../einvoice/einvoiceOutputRule';
import {
  resolveWorkspaceWriteAccess,
  type WorkspaceActor,
  type WorkspaceWriteAccess,
} from '../workspace/workspaceRoleService';
import {
  hasServicePeriodCloudProof,
  recordServicePeriodCloudProofs,
  resolveActiveCloudWorkspaceId,
} from './invoiceOutputClearance';

export type InvoiceOutputDenial =
  /** Regel 1: Leistungszeitraum fehlt, ist ungültig oder unbestätigt. */
  | { reason: 'service_period_unconfirmed'; codes: ServicePeriodOutputCode[] }
  /** Regel 2: Mitglied ohne Cloud-Nachweis (offline, nicht bestätigt oder nicht lesbar). */
  | { reason: 'service_period_unverified' };

/** Wer gerade angemeldet ist — aus der Sitzung des Browsers. */
async function sitzungsAkteur(): Promise<WorkspaceActor> {
  const { getSupabaseClient, isSupabaseConfigured } = await import('../../lib/supabase');
  if (!isSupabaseConfigured()) return { userId: null, cloudConfigured: false };
  try {
    const { data } = (await getSupabaseClient()?.auth.getSession()) ?? { data: { session: null } };
    return { userId: data.session?.user?.id ?? null, cloudConfigured: true };
  } catch {
    return { userId: null, cloudConfigured: true };
  }
}

/**
 * GO-LIVE-SECURITY-01 / FINALISIERUNG — die Schreibberechtigung des angemeldeten Nutzers,
 * wie die Ausgabegrenze sie sieht: aus der Sitzung des Browsers und dem Mitgliederstand,
 * ohne Angabe des Aufrufers. Ungeklärte Rolle bei eingerichteter Cloud heißt: keine.
 */
export async function resolveOutputWriteAccess(): Promise<WorkspaceWriteAccess> {
  return resolveWorkspaceWriteAccess(await sitzungsAkteur());
}

/** `null` heißt freigegeben; sonst der Grund, warum nichts herausgegeben wird. */
export async function checkInvoiceOutput(invoice: VorgangInvoice): Promise<InvoiceOutputDenial | null> {
  const codes = findServicePeriodOutputBlockers(invoice);
  if (codes.length > 0) return { reason: 'service_period_unconfirmed', codes };

  const akteur = await sitzungsAkteur();
  /*
   * FINANZ-CORE-01A (SYS-04 / F39) — nur Inhaber, Verwaltung und der reine Lokalbetrieb bleiben beim lokalen Stand.
   * Eine unbekannte Sitzung oder Mitgliedschaft bei eingerichteter Cloud ist KEIN Inhaber: Sie braucht denselben
   * Cloud-Nachweis wie ein Mitglied (früher auf diesem Gerät belegt oder jetzt gelesen). Vorher fiel sie durch.
   */
  const zugang = resolveWorkspaceWriteAccess(akteur);
  if (zugang.reason === 'owner_or_admin' || zugang.reason === 'local_only') return null;

  const betrieb = resolveActiveCloudWorkspaceId();
  if (hasServicePeriodCloudProof(betrieb, invoice.id)) return null;
  // Ohne Sitzung gibt es keinen Abruf und damit keinen Nachweis.
  if (!akteur.userId) return { reason: 'service_period_unverified' };

  const { readInvoiceServicePeriodConfirmationFromCloud } = await import('./invoiceServicePeriodConfirmService');
  const stand = await readInvoiceServicePeriodConfirmationFromCloud(invoice.id);
  if (stand !== 'confirmed') return { reason: 'service_period_unverified' };
  recordServicePeriodCloudProofs(betrieb, [invoice.id]);
  return null;
}

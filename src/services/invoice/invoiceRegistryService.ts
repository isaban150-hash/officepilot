/**
 * INVOICE-REGISTRY-01B — eine Rechnung finden, ohne zu wissen, wo sie liegt.
 *
 * Lokal ist eine Rechnung heute ausschliesslich ein Element von
 * `vorgang.invoices[]`. Wer eine Rechnung sucht, ohne ihren Vorgang zu kennen,
 * muss deshalb selbst alle Vorgänge durchlaufen — und genau diese Kenntnis
 * („Rechnungen liegen in Vorgängen") steckt dadurch verstreut im Code.
 *
 * In der Cloud ist das längst anders: `workspace_invoices` ist eine eigene
 * Tabelle, und die jüngeren Rechnungsfunktionen — Zahlungen, Versandstatus —
 * adressieren bereits über `client_invoice_id` statt über den Vorgang. Die
 * lokale Seite hinkt dieser Richtung hinterher.
 *
 * Dieser Dienst schliesst die Lücke **ohne** neuen Speicher:
 *
 *   - **Die einzige lokale Wahrheit bleibt `vorgang.invoices[]`.**
 *   - Er hält keinen eigenen Zustand, schreibt nichts und kennt kein Write-API.
 *   - Jede Antwort wird bei jedem Aufruf frisch aus dem Vorgangsbestand
 *     projiziert; es gibt nichts, was veralten könnte.
 *
 * Der Gewinn ist die Adressierung: Aufrufer arbeiten über die `invoiceId` und
 * müssen die Ablage nicht mehr kennen. Wird die Ablage später ein
 * eigenständiger Rechnungsspeicher, ändert sich der Inhalt dieser Datei — nicht
 * der ihrer Aufrufer.
 */
import { getInvoiceStoreSnapshot } from './invoiceStore';
import type { VorgangInvoice } from '../../types/models';

/**
 * Eine Rechnung samt ihrem heutigen Ablageort.
 *
 * Bewusst **ohne** den vollständigen Vorgang: Sonst wäre die Ablage wieder Teil
 * des öffentlichen Vertrags, und genau davon soll dieser Dienst befreien.
 */
export interface InvoiceRegistryEntry {
  invoice: VorgangInvoice;
  vorgangId: string;
}

/**
 * Alle lokal bekannten Rechnungen mit ihrem Ablageort.
 *
 * Die Reihenfolge ist **exakt** die bisherige — Vorgänge in Speicherreihenfolge,
 * darin die Rechnungen in ihrer Reihenfolge. Der Nummernkreis leitet daraus
 * Höchstwerte ab; eine eigene Sortierung hier würde eine Entscheidung treffen,
 * die dieser Dienst nicht zu treffen hat.
 */
export function listInvoiceEntries(): InvoiceRegistryEntry[] {
  /*
   * FIRST-CLASS-LOCAL-INVOICE-STORE-01B — die Quelle ist gewechselt, der
   * Vertrag nicht.
   *
   * Bis hierher lief die Registry über alle Vorgänge und sammelte deren
   * Rechnungen ein. Jetzt liest sie den Rechnungsspeicher unmittelbar — dieselbe
   * Menge, dieselbe Reihenfolge, unveränderte öffentliche API. Genau dafür
   * wurde sie in `INVOICE-REGISTRY-01B` eingeführt: Ihr einziger Verbraucher,
   * der Nummernkreis, merkt vom Umbau nichts.
   */
  return getInvoiceStoreSnapshot()
    .filter((entry) => entry.vorgangId !== null)
    .map((entry) => ({ invoice: entry.invoice, vorgangId: entry.vorgangId as string }));
}

/** Alle lokal bekannten Rechnungen, ohne Ablageort. */
export function listInvoices(): VorgangInvoice[] {
  return listInvoiceEntries().map((entry) => entry.invoice);
}

/**
 * Die Rechnung zu einer Kennung — samt Ablageort.
 *
 * `undefined` heisst „nicht eindeutig auffindbar": entweder unbekannt oder
 * **mehrdeutig**. Der zweite Fall darf nicht vorkommen — die Cloud erzwingt ihn
 * über `unique (workspace_id, client_invoice_id)` —, aber lokal gibt es keine
 * solche Sperre. Träfen zwei Vorgänge dieselbe Kennung, wäre jede Auswahl
 * geraten; „erste gewinnt" würde beschädigte Daten unsichtbar machen, statt sie
 * zu zeigen. Wer den Fall untersuchen will, nutzt `findDuplicateInvoiceIds`.
 */
export function findInvoiceLocatorById(
  invoiceId: string,
): InvoiceRegistryEntry | undefined {
  if (typeof invoiceId !== 'string' || invoiceId.trim().length === 0) return undefined;

  let found: InvoiceRegistryEntry | undefined;
  for (const entry of listInvoiceEntries()) {
    if (entry.invoice.id !== invoiceId) continue;
    if (found) return undefined;
    found = entry;
  }
  return found;
}

/** Die Rechnung zu einer Kennung. Siehe `findInvoiceLocatorById`. */
export function findInvoiceById(invoiceId: string): VorgangInvoice | undefined {
  return findInvoiceLocatorById(invoiceId)?.invoice;
}

/**
 * Kennungen, die lokal mehr als einmal vorkommen.
 *
 * Reine Diagnose: Der Regelbetrieb ruft das nicht auf, und der Dienst meldet
 * von sich aus nichts. Er macht den Fall nur untersuchbar, statt ihn zu
 * verschweigen.
 */
export function findDuplicateInvoiceIds(): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const entry of listInvoiceEntries()) {
    const id = entry.invoice.id;
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates];
}

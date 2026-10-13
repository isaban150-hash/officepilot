/**
 * FINANZ-CORE-01A (AUS-10) — eine per E-Mail versandte Rechnung, deren Zustellung scheiterte.
 *
 * Der Versand gilt mit der Übergabe an den E-Mail-Dienst als „versendet" (auch ein späterer
 * Rücklauf ändert den Versandstand nicht). Kam die Mail aber nachweislich nicht an (`bounced`),
 * liefen Fälligkeit und Mahnempfehlung weiter, als hätte der Kunde die Rechnung — Verzug setzt
 * den Zugang voraus. Den Zustellausgang kennt nur die Versandhistorie, die der Versandbereich
 * der Rechnung lädt; dieses Register merkt ihn sich auf dem Gerät.
 *
 * Grenze: Ein anderes Gerät erfährt den Rücklauf, sobald dort die Rechnung geöffnet wird. Ein
 * später manuell vermerkter Versand (etwa per Post) hebt die Sperre auf.
 */
import { getActiveStorageKey } from '../storage/storageScopeService';
import { toBusinessDay } from '../businessDateService';
import { isDeliveryConsideredSent } from './documentDeliveryContract';
import { displayDeliveryStatus } from './providerDeliveryState';
import type { DocumentDelivery } from '../../types/documentDelivery';
import type { VorgangInvoice } from '../../types/models';

interface Eintrag {
  deliveryId: string;
  /** Tag des gescheiterten Versands (`YYYY-MM-DD`). */
  at: string;
}

function schluessel(): string {
  return `${getActiveStorageKey()}:invoice-delivery-bounces`;
}

function lesen(): Record<string, Eintrag> {
  try {
    const roh = localStorage.getItem(schluessel());
    const wert = roh ? (JSON.parse(roh) as unknown) : {};
    return wert && typeof wert === 'object' && !Array.isArray(wert) ? (wert as Record<string, Eintrag>) : {};
  } catch {
    return {};
  }
}

function schreiben(eintraege: Record<string, Eintrag>): void {
  try {
    localStorage.setItem(schluessel(), JSON.stringify(eintraege));
  } catch {
    /* Ohne Speicher gilt das Register nur in dieser Sitzung nicht — die Warnung kommt beim nächsten Laden. */
  }
}

/** Den Ausgang der jüngsten tatsächlich übergebenen Zustellung festhalten (neueste zuerst). */
export function recordInvoiceDeliveryOutcome(
  invoiceId: string,
  deliveries: ReadonlyArray<Pick<DocumentDelivery, 'id' | 'status' | 'deliveryState' | 'requestedAt'>>,
): void {
  const juengste = deliveries.find((delivery) => isDeliveryConsideredSent(delivery.status));
  const eintraege = lesen();
  const unzustellbar = juengste ? displayDeliveryStatus(juengste.status, juengste.deliveryState) === 'bounced' : false;
  if (unzustellbar && juengste) {
    if (eintraege[invoiceId]?.deliveryId === juengste.id) return;
    // Derselbe Geschäftstag (Europe/Berlin) wie das Versanddatum, mit dem verglichen wird.
    eintraege[invoiceId] = { deliveryId: juengste.id, at: toBusinessDay(juengste.requestedAt) };
  } else if (eintraege[invoiceId]) {
    delete eintraege[invoiceId];
  } else {
    return;
  }
  schreiben(eintraege);
}

/** Kam die Rechnung per E-Mail nicht an — und wurde seitdem nicht anders versendet? */
export function isInvoiceDeliveryBounced(invoice: Pick<VorgangInvoice, 'id' | 'sentSource' | 'sentAt'>): boolean {
  const eintrag = lesen()[invoice.id];
  if (!eintrag) return false;
  /*
   * Ein danach manuell vermerkter Versand (Post, persönlich) hebt die Sperre auf — auch am Tag des
   * Rücklaufs selbst: Ein abweichender Vermerk nach einem OfficeTakt-Versand ist seit AUS-19 „manuell".
   */
  if (invoice.sentSource === 'manual' && (invoice.sentAt ?? '').slice(0, 10) >= eintrag.at) return false;
  return true;
}

/** Nur für Tests. */
export function resetDeliveryBounceRegistryForTests(): void {
  try {
    localStorage.removeItem(schluessel());
  } catch {
    /* nichts */
  }
}

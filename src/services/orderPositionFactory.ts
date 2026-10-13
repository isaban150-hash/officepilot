import type { InboxItem, OrderPosition } from '../types/models';

/*
 * FINANZ-CORE-01A (ANG-04) — was rund um einen Betrag stehen darf: Währung,
 * „ca.", „netto"/„brutto", „zzgl./inkl. MwSt./USt.", „pauschal". Alles andere
 * ist kein lesbarer Betrag.
 */
const AMOUNT_PREFIX = /^(?:ca\.?|circa|rund|€|eur|euro|summe:?)\s*/i;
const AMOUNT_SUFFIX = /\s*(?:€|eur|euro|netto|brutto|pauschal|zzgl\.?\s*(?:mwst|ust)\.?|inkl\.?\s*(?:mwst|ust)\.?|zuzüglich\s+(?:mwst|ust)\.?|einschließlich\s+(?:mwst|ust)\.?)\.?$/i;

/**
 * Ein Betrag aus einem erkannten Dokumenttext, in Euro.
 *
 * FINANZ-CORE-01A (ANG-04) — streng statt tolerant. Bisher fiel alles
 * Unbekannte auf `parseFloat` zurück: „8.500,- €" ergab 8,5 und „8.500,00 €
 * netto" ebenfalls 8,5 — ein um den Faktor 1000 zu niedriger Auftragspreis,
 * ohne Hinweis „Preis fehlt" (der greift nur bei 0). Jetzt gilt nur, was
 * eindeutig deutsch oder eindeutig ganzzahlig geschrieben ist; alles andere
 * ergibt 0 und damit den sichtbaren Hinweis.
 */
export function parseOfferAmount(value: string | undefined): number {
  if (!value?.trim()) return 0;

  let normalized = value.trim();
  // Vorsätze und Nachsätze abtragen, bis nur der Betrag bleibt.
  for (let runde = 0; runde < 4; runde += 1) {
    const vorher = normalized;
    normalized = normalized.replace(AMOUNT_PREFIX, '').replace(AMOUNT_SUFFIX, '').trim();
    if (normalized === vorher) break;
  }
  normalized = normalized.replace(/\s+/g, '');

  // „8.500,-" / „8.500,--" — ganze Euro.
  const germanWholeDash = normalized.match(/^(\d{1,3}(?:\.\d{3})*|\d+),-{1,2}$/);
  if (germanWholeDash) return Number(germanWholeDash[1].replace(/\./g, ''));

  // „8.500,50" / „8500,5"
  const germanDecimal = normalized.match(/^(\d{1,3}(?:\.\d{3})*|\d+),(\d{1,2})$/);
  if (germanDecimal) return Number(`${germanDecimal[1].replace(/\./g, '')}.${germanDecimal[2]}`);

  // „8.500" / „1.250.000"
  if (/^\d{1,3}(?:\.\d{3})+$/.test(normalized)) return Number(normalized.replace(/\./g, ''));

  // „8500"
  if (/^\d+$/.test(normalized)) return Number(normalized);

  // „8500.50" — Punkt als Dezimaltrenner nur mit höchstens zwei Stellen.
  if (/^\d+\.\d{1,2}$/.test(normalized)) return Number(normalized);

  return 0;
}

function isAuftragInboxItem(item: InboxItem): boolean {
  return (
    item.documentType === 'kundenauftrag' ||
    item.recommendedAction === 'auftrag_annehmen'
  );
}

function resolvePositionDescription(item: InboxItem): string {
  const leistung = item.recognizedData.Leistung?.trim();
  if (leistung) return leistung;

  const title = item.title.replace(/^Gerade erfasst:\s*/i, '').trim();
  if (title) return title;

  return 'Auftrag pauschal';
}

export function buildOrderPositionsFromInbox(item: InboxItem): OrderPosition[] {
  if (!isAuftragInboxItem(item)) return [];

  const unitPrice = parseOfferAmount(item.recognizedData.Angebotssumme);

  return [
    {
      id: `op-inbox-${Date.now()}`,
      description: resolvePositionDescription(item),
      plannedQuantity: 1,
      unit: 'Pauschal',
      unitPrice,
      category: 'arbeit',
      billable: true,
    },
  ];
}

export function hasMissingOrderPrice(positions: OrderPosition[]): boolean {
  return positions.some((p) => p.unitPrice === 0);
}

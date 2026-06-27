import type { InboxItem, OrderPosition } from '../types/models';

export function parseOfferAmount(value: string | undefined): number {
  if (!value?.trim()) return 0;

  let normalized = value.trim().toLowerCase();
  normalized = normalized.replace(/\s*(€|eur|euro)\s*$/i, '');
  normalized = normalized.replace(/^ca\.?\s*/i, '');
  normalized = normalized.replace(/\s+/g, '');

  const germanDecimal = normalized.match(/^(\d{1,3}(?:\.\d{3})*),(\d+)$/);
  if (germanDecimal) {
    const whole = germanDecimal[1].replace(/\./g, '');
    return parseFloat(`${whole}.${germanDecimal[2]}`) || 0;
  }

  const germanThousands = normalized.match(/^(\d{1,3}(?:\.\d{3})+)$/);
  if (germanThousands) {
    return parseFloat(normalized.replace(/\./g, '')) || 0;
  }

  const simpleDecimal = normalized.replace(',', '.');
  const parsed = parseFloat(simpleDecimal);
  return Number.isFinite(parsed) ? parsed : 0;
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

import type { AmountCandidate, ExtractedContractField } from '../types/documentIntelligence';
import type { DocumentPageText } from '../types/documentIntelligence';

const AMOUNT_PATTERN = /(\d{1,3}(?:\.\d{3})*,\d{2})\s*(?:€|eur)?/gi;

const CONTRACT_TOTAL_LABELS =
  /gesamtsumme\s+netto|vertragssumme(?:\s+netto)?|gesamtpreis(?:\s+netto)?|summe\s+netto|auftragssumme\s+netto/i;

const INVOICE_TOTAL_LABELS =
  /rechnungssumme|rechnungsbetrag|bruttobetrag|endsumme|zu\s+zahlen/i;

const EXCLUDED_CONTEXT =
  /(?:%|prozent|skonto|vertragsstrafe|stunde|std\.?\/|€\/\s*std|mwst|umsatzsteuer|ust|einzelpreis|ep\b|gesamtpreis\s+position)/i;

export function parseGermanMoney(value: string): number {
  const cleaned = value.replace(/\./g, '').replace(',', '.').replace(/[^\d.]/g, '');
  const parsed = parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatGermanMoney(value: number): string {
  return `${value.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

function extractLineContext(text: string, index: number): string {
  const lineStart = text.lastIndexOf('\n', index) + 1;
  const lineEnd = text.indexOf('\n', index);
  return text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
}

export function findAmountCandidates(text: string, sourcePage?: number): AmountCandidate[] {
  const candidates: AmountCandidate[] = [];
  const regex = new RegExp(AMOUNT_PATTERN.source, 'gi');
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const formatted = match[1];
    const context = extractLineContext(text, match.index);
    if (EXCLUDED_CONTEXT.test(context) && !CONTRACT_TOTAL_LABELS.test(context) && !INVOICE_TOTAL_LABELS.test(context)) {
      continue;
    }

    candidates.push({
      value: parseGermanMoney(formatted),
      formatted,
      context,
      sourcePage,
    });
  }

  return candidates;
}

export function findAmountCandidatesFromPages(pageTexts: DocumentPageText[]): AmountCandidate[] {
  return pageTexts.flatMap((page) => findAmountCandidates(page.text, page.pageNumber));
}

export function resolveContractTotalNet(
  text: string,
  pageTexts: DocumentPageText[] = [],
): ExtractedContractField<number> {
  const sources = pageTexts.length > 0 ? pageTexts : [{ pageNumber: 1, text }];
  const candidates: AmountCandidate[] = [];

  for (const page of sources) {
    const lines = page.text.split(/\r?\n/);
    for (const line of lines) {
      if (!CONTRACT_TOTAL_LABELS.test(line)) continue;
      const match = line.match(AMOUNT_PATTERN);
      if (!match) continue;
      const formatted = match[match.length - 1];
      candidates.push({
        value: parseGermanMoney(formatted),
        formatted,
        context: line.trim(),
        label: 'contract_total',
        sourcePage: page.pageNumber,
      });
    }
  }

  if (candidates.length === 1) {
    const candidate = candidates[0];
    return {
      value: candidate.value,
      status: 'confirmed',
      confidence: 'high',
      sourcePage: candidate.sourcePage,
      sourceText: candidate.context,
    };
  }

  if (candidates.length > 1) {
    const uniqueValues = new Set(candidates.map((c) => c.value));
    if (uniqueValues.size === 1) {
      const candidate = candidates[0];
      return {
        value: candidate.value,
        status: 'confirmed',
        confidence: 'medium',
        sourcePage: candidate.sourcePage,
        sourceText: candidate.context,
      };
    }
    return { status: 'review_required', confidence: 'low', sourceText: candidates.map((c) => c.context).join(' | ') };
  }

  return { status: 'not_found', confidence: 'low' };
}

export function resolveInvoiceAmount(text: string): ExtractedContractField<number> {
  const lines = text.split(/\r?\n/);
  const candidates: AmountCandidate[] = [];

  for (const line of lines) {
    if (!INVOICE_TOTAL_LABELS.test(line) && !/rechnungssumme|brutto|netto.*ust/i.test(line)) continue;
    const match = line.match(AMOUNT_PATTERN);
    if (!match) continue;
    candidates.push({
      value: parseGermanMoney(match[match.length - 1]),
      formatted: match[match.length - 1],
      context: line.trim(),
      label: 'invoice_total',
    });
  }

  if (candidates.length === 1) {
    return {
      value: candidates[0].value,
      status: 'confirmed',
      confidence: 'high',
      sourceText: candidates[0].context,
    };
  }

  if (candidates.length > 1) {
    return { status: 'review_required', confidence: 'low', sourceText: candidates.map((c) => c.context).join(' | ') };
  }

  return { status: 'not_found', confidence: 'low' };
}

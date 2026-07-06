import type { InvoiceDocumentType } from '../types/models';

export function getInvoiceDocumentTitle(
  type: InvoiceDocumentType,
  abschlagNumber?: number,
): string {
  switch (type) {
    case 'rechnung':
      return 'Rechnung';
    case 'abschlag':
      return abschlagNumber ? `Abschlagsrechnung ${abschlagNumber}` : 'Abschlagsrechnung';
    case 'teilrechnung':
      return 'Teilrechnung';
    case 'schluss':
      return 'Schlussrechnung';
    case 'gutschrift':
      return 'Gutschrift';
    case 'storno':
      return 'Storno-Rechnung';
    default:
      return 'Rechnung';
  }
}

export const INVOICE_DOCUMENT_TYPES: InvoiceDocumentType[] = [
  'rechnung',
  'abschlag',
  'teilrechnung',
  'schluss',
  'gutschrift',
  'storno',
];

export function parseInvoiceDocumentType(value: string | null): InvoiceDocumentType {
  if (value && INVOICE_DOCUMENT_TYPES.includes(value as InvoiceDocumentType)) {
    return value as InvoiceDocumentType;
  }
  return 'rechnung';
}

export function usesAbschlagDeductions(type: InvoiceDocumentType): boolean {
  return type === 'schluss';
}

export function usesAbschlagNumber(type: InvoiceDocumentType): boolean {
  return type === 'abschlag';
}

export function prefillsOpenQuantity(type: InvoiceDocumentType): boolean {
  return type === 'rechnung' || type === 'teilrechnung' || type === 'schluss';
}

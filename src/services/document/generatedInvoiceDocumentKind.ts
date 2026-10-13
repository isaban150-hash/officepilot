/**
 * FINANZ-CORE-01A (STO-03) — ein von OfficeTakt aus einer Rechnung erzeugter
 * Beleg (Rechnung oder Rechnungskorrektur).
 *
 * Erkannt an der Rechnungsverknüpfung zusammen mit Kategorie **oder**
 * Belegart. Die Kategorie allein trägt nicht: Sie ist im Bearbeitungsformular
 * frei wählbar, und ein Wechsel hob bisher Lösch- und Hochladeschutz auf. Die
 * Belegart (`classifiedKind`) setzt nur die Erzeugung; das Formular ändert sie
 * nie. Rein und ohne Abhängigkeiten, damit Speicher, Push und Nachholen
 * dieselbe Regel lesen.
 */
import type { CompanyDocument } from '../../types/models';

export function isGeneratedInvoiceDocumentKind(
  document: Pick<CompanyDocument, 'category' | 'classifiedKind' | 'linkedInvoiceId'>,
): boolean {
  if (!document.linkedInvoiceId?.trim()) return false;
  return (
    document.category === 'ausgangsrechnung' ||
    document.classifiedKind === 'ausgangsrechnung' ||
    document.classifiedKind === 'rechnungskorrektur'
  );
}

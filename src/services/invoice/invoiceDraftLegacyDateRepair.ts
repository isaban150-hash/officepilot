/**
 * RECHNUNGSBEREICH-03D2 — die Brücke zwischen gespeichertem Entwurf und der
 * reinen Reparaturregel.
 *
 * Die Regel selbst (`repairLegacyUtcBusinessDates`) kennt weder Entwurf noch
 * Firmenprofil: Sie bekommt zwei Datumswerte, den Erzeugungszeitpunkt und das
 * Standardzahlungsziel. Hier wird sie an den tatsächlichen Entwurf gehängt —
 * bewusst an einer Stelle, damit jede Rechnungsart (Rechnung, Teilrechnung,
 * Abschlag, Schlussrechnung) und auch die Rechnung ohne Auftrag denselben Weg
 * nimmt.
 *
 * Angefasst werden ausschliesslich `issueDate` und ein nachweislich daraus
 * abgeleitetes `paymentDueDate`. Mengen, Leistungszeitraum, Steuerentscheidung,
 * Texte und jede andere Eingabe bleiben unberührt.
 */
import type { InvoiceDraft } from '../../types/models';
import { repairLegacyUtcBusinessDates } from '../businessDateService';
import { addCalendarDays } from '../invoiceTaxService';
import { getCompanyProfile } from '../companyProfileService';

export interface LegacyDraftDateRepairResult {
  draft: InvoiceDraft;
  repaired: boolean;
}

export function repairLegacyDraftBusinessDates(
  draft: InvoiceDraft,
  createdAt: string,
  defaultPaymentDays: number = getCompanyProfile().defaultPaymentDays,
): LegacyDraftDateRepairResult {
  const ergebnis = repairLegacyUtcBusinessDates(
    {
      issueDate: draft.issueDate ?? '',
      paymentDueDate: draft.paymentDueDate ?? '',
      createdAt,
      defaultPaymentDays,
    },
    addCalendarDays,
  );
  if (!ergebnis.repaired) return { draft, repaired: false };

  return {
    draft: { ...draft, issueDate: ergebnis.issueDate, paymentDueDate: ergebnis.paymentDueDate },
    repaired: true,
  };
}

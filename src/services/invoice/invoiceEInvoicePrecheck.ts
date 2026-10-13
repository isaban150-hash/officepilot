/**
 * FINANZ-CORE-01A (KUN-02) — die E-Rechnungs-Vorprüfung vor der Freigabe.
 *
 * Der Builder (`buildCanonicalEInvoice`) lief bisher nur für freigegebene
 * Belege. Fehlte etwa die Telefonnummer des Absenders oder die Käuferreferenz,
 * erfuhr der Betrieb das erst nach der Freigabe — und dann liess sich der
 * eingefrorene Beleg nicht mehr ergänzen; Abhilfe nur über Storno und
 * Neuausstellung.
 *
 * Hier läuft derselbe Builder über genau den Kandidaten, der bei der Freigabe
 * entstünde. Das Ergebnis ist ein Hinweis, keine Sperre: Eine PDF-Rechnung
 * ohne E-Rechnungs-Angaben bleibt zulässig (E-RECHNUNG-04B). Es wird nichts
 * gespeichert, keine Nummer reserviert und nichts aus Stammdaten ergänzt.
 */
import { buildCanonicalEInvoice } from '../einvoice/canonicalEInvoiceBuilder';
import { prepaymentSettlementsFor } from '../einvoice/einvoicePrepaymentSettlements';
import type { CanonicalEInvoiceIssue } from '../einvoice/canonicalEInvoice';
import { buildInvoiceFinalizationCandidate } from '../invoiceService';
import type { CompanySetup, InvoiceDraft } from '../../types/models';

/** Kennung des Prüfkandidaten — er verlässt diese Funktion nie. */
const PRECHECK_INVOICE_ID = 'einvoice-precheck';

export interface InvoiceEInvoicePrecheck {
  issues: CanonicalEInvoiceIssue[];
  /**
   * Der Empfänger trägt E-Rechnungs-Angaben (Käuferreferenz, Leitweg-ID oder
   * USt-IdNr.) — dann ist der Hinweis vordringlich, sonst eine Randnotiz.
   */
  eInvoiceExpected: boolean;
  /**
   * FINANZ-CORE-01A (AUS-18) — die Befunde betreffen nur die XRechnung; eine
   * ZUGFeRD-Rechnung (EN 16931) ließe sich so schon ausgeben.
   */
  onlyXRechnung?: boolean;
}

export function precheckInvoiceDraftForEInvoice(
  vorgangId: string | null,
  draft: InvoiceDraft,
  setup: CompanySetup,
): InvoiceEInvoicePrecheck {
  const billing = draft.customerBilling;
  const eInvoiceExpected = Boolean(
    billing?.buyerReference?.trim() || billing?.leitwegId?.trim() || billing?.vatId?.trim(),
  );
  /*
   * Die §13b-Bestätigung ist eine Freigabefrage, keine E-Rechnungsfrage; ohne
   * sie entstünde für einen §13b-Entwurf gar kein Kandidat. Blockiert der
   * Entwurf aus anderem Grund, gibt es noch nichts vorzuprüfen — die
   * Freigabeprüfung meldet ihn selbst.
   */
  const candidate = buildInvoiceFinalizationCandidate(vorgangId, draft, setup, PRECHECK_INVOICE_ID, {
    reverseCharge13bConfirmed: true,
  });
  if (!candidate.ok) return { issues: [], eInvoiceExpected };
  // Die strengere XRechnung zuerst; ihre Befunde umfassen die von EN 16931.
  // FINANZ-CORE-01A (N02) — derselbe Zahlungsstand der Abschläge wie beim Erzeugen.
  const prepaymentSettlements = prepaymentSettlementsFor(candidate.invoice);
  const result = buildCanonicalEInvoice(candidate.invoice, { profile: 'xrechnung', prepaymentSettlements });
  if (result.ok) return { issues: [], eInvoiceExpected };
  const en16931 = buildCanonicalEInvoice(candidate.invoice, { profile: 'en16931', prepaymentSettlements });
  return { issues: result.issues, eInvoiceExpected, ...(en16931.ok ? { onlyXRechnung: true } : {}) };
}

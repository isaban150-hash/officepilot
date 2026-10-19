import { isFixedAmountAbschlag } from './invoiceCalculationMode';
import {
  fromCents,
  billingLineTotalCents,
  isValidMoneyNumber,
  roundMoney,
  sumCents,
  taxCentsFromNet,
  toCents,
} from './invoiceMoney';
import { INVOICE_DRAFT_LABEL } from './invoiceNumberService';
import { isValidIban } from '../utils/iban';
import { getTaxRateForStatus } from './invoiceTaxService';
import { usesAbschlagDeductions } from './invoiceTypeService';
import { selectHistoricalInvoiceLogo } from './invoice/invoiceHistoricalLogo';
import { getAbschlagDeductionsTotal } from './invoiceDeductions';
import { getRemainingFixedAmountBillableNetCents, hasDeductibleAbschlag } from './orderBillingRules';
import { getBusinessDay } from './businessDateService';
import { findUnsettledAbschlagDeductions } from './invoice/abschlagSettlement';
import { reliableDeductionNetCents } from './invoice/abschlagSkontoSplit';
import { hasUnresolvedInvoiceNet } from './invoice/invoiceNetResolution';
import {
  isPlausibleEmail,
  isPlausibleLeitwegId,
  isPlausibleVatId,
  normalizeCountryCodeInput,
} from './customer/customerFieldFormat';
import type {
  CompanyProfile,
  CustomerBilling,
  InvoiceDraft,
  Vorgang,
  VorgangInvoice,
} from '../types/models';
import type { TranslationKey } from '../i18n';

function isFinalizedInvoiceStatus(invoice: VorgangInvoice): boolean {
  return invoice.status === 'vorbereitet' || invoice.status === 'versendet';
}

export interface InvoiceValidationIssue {
  code: string;
  messageKey: TranslationKey;
}

export interface InvoiceValidationResult {
  blockingErrors: InvoiceValidationIssue[];
  warnings: InvoiceValidationIssue[];
}

export interface InvoiceApprovalOptions {
  reverseCharge13bConfirmed?: boolean;
}

function hasUsableAddress(parts: { street?: string; zip?: string; city?: string }): boolean {
  return Boolean(parts.street?.trim() && parts.zip?.trim() && parts.city?.trim());
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return false;
  const time = Date.parse(`${value.trim()}T00:00:00.000Z`);
  return Number.isFinite(time);
}

function customerBlocks(billing: CustomerBilling, errors: InvoiceValidationIssue[]): void {
  if (!billing.name?.trim()) {
    errors.push({ code: 'customer_name', messageKey: 'invoice.validation.customerName' });
  }
  if (!hasUsableAddress(billing)) {
    errors.push({ code: 'customer_address', messageKey: 'invoice.validation.customerAddress' });
  }
}

/**
 * FINANZ-CORE-01A (KUN-09) — Schreibfehler in den Empfängerangaben vor der Freigabe zeigen. Sie
 * werden sonst mit dem Beleg eingefroren und brechen Versand oder E-Rechnung. Ein Hinweis, kein
 * Stopp: Die Angaben können aus Angebot, Auftrag oder älteren Kundendaten stammen.
 */
function customerWarnings(billing: CustomerBilling, warnings: InvoiceValidationIssue[]): void {
  if (billing.email?.trim() && !isPlausibleEmail(billing.email)) {
    warnings.push({ code: 'customer_email_format', messageKey: 'invoice.validation.warn.customerEmail' });
  }
  if (billing.vatId?.trim() && !isPlausibleVatId(billing.vatId)) {
    warnings.push({ code: 'customer_vat_id_format', messageKey: 'invoice.validation.warn.customerVatId' });
  }
  if (billing.countryCode?.trim() && !normalizeCountryCodeInput(billing.countryCode)) {
    warnings.push({ code: 'customer_country_format', messageKey: 'invoice.validation.warn.customerCountry' });
  }
  if (billing.leitwegId?.trim() && !isPlausibleLeitwegId(billing.leitwegId)) {
    warnings.push({ code: 'customer_leitweg_format', messageKey: 'invoice.validation.warn.customerLeitweg' });
  }
}

function companyBlocks(company: CompanyProfile, errors: InvoiceValidationIssue[]): void {
  if (!company.companyName?.trim()) {
    errors.push({ code: 'company_name', messageKey: 'invoice.validation.companyName' });
  }
  if (!hasUsableAddress(company)) {
    errors.push({ code: 'company_address', messageKey: 'invoice.validation.companyAddress' });
  }
  /*
   * FINANZ-CORE-01A (RE-09/EIN-04) — die Steuernummer oder USt-IdNr. des
   * Ausstellers ist Pflichtangabe jeder Rechnung (§ 14 Abs. 4 Nr. 2 UStG), auch
   * beim Kleinunternehmer. Bisher druckte das PDF sie nur, wenn vorhanden; ohne
   * sie entstand ein nummerierter Beleg ohne Pflichtangabe. Der Server weist
   * denselben Zustand jetzt ab (`invoice_company_tax_id_missing`).
   */
  if (!company.taxNumber?.trim() && !company.vatId?.trim()) {
    errors.push({ code: 'company_tax_id', messageKey: 'invoice.validation.companyTaxId' });
  }
}

function companyWarnings(company: CompanyProfile, warnings: InvoiceValidationIssue[]): void {
  if (!company.iban?.trim()) {
    warnings.push({ code: 'company_iban', messageKey: 'invoice.validation.warn.iban' });
  } else if (!isValidIban(company.iban)) {
    /*
     * BROWSER-ACCEPTANCE-FIX 01 / B2 — eine ungültige IBAN geht nicht mehr
     * kommentarlos auf die Rechnung. Ein Hinweis vor der Freigabe, kein Stopp:
     * Die Firmendaten sind der Ort der Korrektur, und bereits bestehende
     * Rechnungen bleiben, wie sie sind.
     */
    warnings.push({ code: 'company_iban_invalid', messageKey: 'invoice.validation.warn.ibanInvalid' });
  }
  if (!company.phone?.trim() && !company.email?.trim()) {
    warnings.push({ code: 'company_contact', messageKey: 'invoice.validation.warn.contact' });
  }
  /*
   * FINANZ-CORE-01A (RE-16) — „Skonto ist nicht eingerichtet" stand bei jeder Rechnung eines
   * Betriebs, der bewusst kein Skonto gewährt. Skonto ist eine Entscheidung, kein Mangel.
   */
}

/**
 * Central approval validation for invoice drafts.
 * Does not invent missing customer/company/tax data.
 */
/** FINANZ-CORE-01A (RE-17) — der Hinweis nennt eine Rechtsgrundlage (Paragraph, Gesetz, Artikel). */
function hasTaxExemptionBasis(notice: string | undefined): boolean {
  return /§|UStG|Art\.|Artikel|MwStSystRL|Richtlinie/i.test(notice ?? '');
}

export function validateInvoiceDraftForApproval(
  draft: InvoiceDraft,
  _companyProfile: CompanyProfile,
  vorgang: Vorgang | undefined,
  options: InvoiceApprovalOptions = {},
): InvoiceValidationResult {
  const blockingErrors: InvoiceValidationIssue[] = [];
  const warnings: InvoiceValidationIssue[] = [];

  // Prefer draft snapshots (what will be stored).
  customerBlocks(draft.customerBilling, blockingErrors);
  customerWarnings(draft.customerBilling, warnings);
  companyBlocks(draft.companySnapshot, blockingErrors);
  companyWarnings(draft.companySnapshot, warnings);
  /*
   * BRANDING-01F-3 — die Logowarnung fragt nach dem Logo **dieser Rechnung**,
   * nicht mehr nur nach dem Legacy-Feld. Seit 01E-2 kann ein Betrieb ein Logo
   * ausschliesslich als strukturierte Referenz besitzen; die alte Prüfung hätte
   * ihm dauerhaft „kein Logo" gemeldet.
   */
  if (selectHistoricalInvoiceLogo(draft).kind === 'none') {
    warnings.push({ code: 'company_logo', messageKey: 'invoice.validation.warn.logo' });
  }

  if (!draft.issueDate?.trim() || !isIsoDate(draft.issueDate)) {
    blockingErrors.push({ code: 'issue_date', messageKey: 'invoice.validation.issueDate' });
  } else if (draft.issueDate.trim() > getBusinessDay()) {
    /*
     * FINANZ-CORE-01A (RE-17/SQL-15) — das Rechnungsdatum ist das Datum der
     * Ausstellung (§ 14 Abs. 4 Nr. 3 UStG) und liegt nie in der Zukunft. Ein
     * künftiges Datum zog bisher sogar Nummern aus dem Kreis des nächsten
     * Jahres. Der Server weist es ebenso ab (`invoice_issue_date_in_future`).
     */
    blockingErrors.push({ code: 'issue_date_future', messageKey: 'invoice.validation.issueDateFuture' });
  }
  if (
    !draft.servicePeriodFrom?.trim() ||
    !draft.servicePeriodTo?.trim() ||
    !isIsoDate(draft.servicePeriodFrom) ||
    !isIsoDate(draft.servicePeriodTo)
  ) {
    blockingErrors.push({
      code: 'service_period',
      messageKey: 'invoice.validation.servicePeriod',
    });
  } else if (draft.servicePeriodFrom > draft.servicePeriodTo) {
    /*
     * INVOICE-SERVICE-PERIOD-01B — ISO-Daten sind lexikografisch vergleichbar.
     * Kein stilles Tauschen: Wer Beginn und Ende verwechselt, soll es sehen.
     */
    blockingErrors.push({
      code: 'service_period_order',
      messageKey: 'invoice.validation.servicePeriodOrder',
    });
  } else if (draft.servicePeriodConfirmed !== true) {
    /*
     * 01B2 — Präzedenz: Der Bestätigungsfehler ist erst sinnvoll, wenn ein
     * gültiger, plausibler Zeitraum dasteht. Bei fehlenden oder ungültigen
     * Daten sagt `service_period` bereits alles; zwei Meldungen nebeneinander
     * hätten den Nutzer nur auf die falsche Fährte geführt.
     *
     * Der tatsächliche Leistungszeitraum muss bestätigt sein. Bestandsentwürfe
     * tragen den früheren `issueDate`-Default und werden aus `draftRawJson`
     * verbatim wiederhergestellt; ihre Herkunft ist nicht rekonstruierbar.
     * `undefined` gilt deshalb als **nicht bestätigt** — fail-closed durch
     * Abwesenheit. Ein Rateversuch über die Werte wäre in beide Richtungen
     * falsch: Ein echter Tageseinsatz am Rechnungsdatum sieht genauso aus wie
     * der alte Automatismus.
     */
    blockingErrors.push({
      code: 'service_period_unconfirmed',
      messageKey: 'invoice.validation.servicePeriodUnconfirmed',
    });
  }
  if (!draft.paymentDueDate?.trim() || !isIsoDate(draft.paymentDueDate)) {
    blockingErrors.push({
      code: 'payment_due',
      messageKey: 'invoice.validation.paymentDueDate',
    });
  } else if (
    draft.issueDate &&
    isIsoDate(draft.issueDate) &&
    draft.paymentDueDate < draft.issueDate
  ) {
    blockingErrors.push({
      code: 'payment_due_before_issue',
      messageKey: 'invoice.validation.paymentDueBeforeIssue',
    });
  } else if (draft.paymentDueDate < getBusinessDay()) {
    // FINANZ-CORE-01A (ZAH-10) — ein alter Entwurf wäre mit der Freigabe sofort überfällig.
    warnings.push({ code: 'payment_due_past', messageKey: 'invoice.validation.warn.paymentDuePast' });
  }

  /*
   * FINANZ-CORE-01A (RE-04) — ein Pauschalabschlag verbraucht keine Menge; nur
   * die Schlussrechnung zieht ihn ab. Eine „Rechnung" über die offene Leistung
   * danach berechnete ihn ein zweites Mal, und eine spätere Schlussrechnung
   * scheiterte an `deductions_exceed_total`. Eine Teilrechnung bleibt möglich
   * (abgegrenzter Teil, Abzug in der Schlussrechnung) — mit Hinweis.
   */
  if (vorgang && hasDeductibleAbschlag(vorgang)) {
    if (draft.type === 'rechnung') {
      blockingErrors.push({
        code: 'fixed_abschlag_requires_schluss',
        messageKey: 'invoice.validation.fixedAbschlagRequiresSchluss',
      });
    } else if (draft.type === 'teilrechnung') {
      warnings.push({
        code: 'fixed_abschlag_deducted_in_schluss',
        messageKey: 'invoice.validation.warn.fixedAbschlagDeductedInSchluss',
      });
    }
  }

  const fixedAmount = isFixedAmountAbschlag(draft);

  if (draft.calculationMode === 'fixed_amount' && draft.type !== 'abschlag') {
    blockingErrors.push({
      code: 'fixed_amount_type',
      messageKey: 'invoice.validation.fixedAmountType',
    });
  }

  if (fixedAmount) {
    const net = draft.fixedAmountNet;
    if (net == null || !Number.isFinite(net) || net <= 0 || !isValidMoneyNumber(net)) {
      blockingErrors.push({
        code: 'fixed_amount_net',
        messageKey: 'invoice.validation.fixedAmountNet',
      });
    }
    if (draft.positions.some((p) => p.billable && p.quantity > 0)) {
      blockingErrors.push({
        code: 'fixed_amount_with_positions',
        messageKey: 'invoice.validation.fixedAmountWithPositions',
      });
    }
    /*
     * FIXED-AMOUNT-BILLING-INVARIANT-01B2 — die Vorwärtssperre.
     *
     * `quantity_based` ist über `getBillableOpenQuantity` mengenmässig
     * gedeckelt; ein Pauschalabschlag kannte bis hierher nur `net > 0`. Ein
     * Auftrag über 26.548 € nahm damit einen Abschlag über 30.000 € an, und
     * erst die Schlussrechnung schlug fehl — da war der Vorgang bereits in
     * der Sackgasse.
     *
     * Strikt `>`: Eine exakt ausgeschöpfte Abrechnungssumme ist zulässig, die
     * spätere 0-EUR-Schlussrechnung ist ein gültiger Beleg.
     *
     * Der Restwert wird bewusst ungeklammert gelesen — bei einem bereits
     * überzogenen Bestandsvorgang ist er negativ, und dann muss jeder weitere
     * positive Abschlag scheitern.
     */
    if (vorgang && net != null && Number.isFinite(net) && net > 0) {
      const remainingNetCents = getRemainingFixedAmountBillableNetCents(vorgang);
      if (toCents(roundMoney(net)) > remainingNetCents) {
        blockingErrors.push({
          code: 'abschlag_exceeds_order_value',
          messageKey: 'invoice.validation.abschlagExceedsOrderValue',
        });
      }
    }
  } else {
    if (draft.fixedAmountNet != null && Number.isFinite(draft.fixedAmountNet) && draft.fixedAmountNet !== 0) {
      blockingErrors.push({
        code: 'quantity_with_fixed_amount',
        messageKey: 'invoice.validation.quantityWithFixedAmount',
      });
    }
    const activePositions = draft.positions.filter((p) => p.billable && p.quantity > 0);
    if (activePositions.length === 0) {
      blockingErrors.push({ code: 'no_positions', messageKey: 'invoice.validation.noPositions' });
    } else {
      /*
       * Es gibt abrechenbare Positionen — aber tragen sie auch einen Wert?
       * Menge 1 zum Einzelpreis 0 kam bis hierher durch. Bewusst nur über
       * `activePositions` gerechnet: das Gesamt-Subtotal weiter unten filtert
       * nicht auf `billable` und könnte durch eine nicht abrechenbare Position
       * fälschlich positiv werden.
       *
       * Nur der Leistungswert zählt, nicht der Restzahlbetrag: eine
       * Schlussrechnung, die durch Abschlagsabzüge auf 0,00 € endet, ist ein
       * gültiger Beleg und bleibt hier unberührt.
       */
      const billableSubtotalCents = sumCents(
        activePositions
          .map((p) => billingLineTotalCents(p.quantity, p.unitPrice))
          .filter(Number.isFinite),
      );
      if (billableSubtotalCents <= 0) {
        blockingErrors.push({
          code: 'zero_billable_value',
          messageKey: 'invoice.validation.zeroBillableValue',
        });
      }
    }

    for (const position of draft.positions) {
      if (!position.billable || position.quantity <= 0) continue;
      if (!position.description?.trim()) {
        blockingErrors.push({
          code: 'position_description',
          messageKey: 'invoice.validation.positionDescription',
        });
      }
      if (!isValidMoneyNumber(position.quantity) || position.quantity <= 0) {
        blockingErrors.push({
          code: 'position_quantity',
          messageKey: 'invoice.validation.positionQuantity',
        });
      }
      if (!position.unit) {
        blockingErrors.push({
          code: 'position_unit',
          messageKey: 'invoice.validation.positionUnit',
        });
      }
      if (!isValidMoneyNumber(position.unitPrice) || position.unitPrice < 0) {
        blockingErrors.push({
          code: 'position_price',
          messageKey: 'invoice.validation.positionPrice',
        });
      } else {
        const lineCents = billingLineTotalCents(position.quantity, position.unitPrice);
        if (!Number.isFinite(lineCents)) {
          blockingErrors.push({
            code: 'position_line_total',
            messageKey: 'invoice.validation.positionPrice',
          });
        }
      }
    }
  }

  if (!draft.taxStatus || draft.taxStatus === 'unclear') {
    blockingErrors.push({ code: 'tax_status', messageKey: 'invoice.validation.taxStatus' });
  }

  const taxRate = getTaxRateForStatus(draft.taxStatus);
  if (
    (draft.taxStatus === 'standard_19' || draft.taxStatus === 'standard_7') &&
    taxRate <= 0
  ) {
    blockingErrors.push({ code: 'tax_rate', messageKey: 'invoice.validation.taxRate' });
  }

  if (draft.taxStatus === 'reverse_charge_13b' && !options.reverseCharge13bConfirmed) {
    blockingErrors.push({
      code: 'reverse_charge_unconfirmed',
      messageKey: 'invoice.validation.reverseChargeConfirmRequired',
    });
  }

  let subtotalCents: number;
  if (fixedAmount) {
    const net = draft.fixedAmountNet;
    subtotalCents =
      net != null && Number.isFinite(net) && net > 0 ? toCents(roundMoney(net)) : 0;
  } else {
    const positionCents = draft.positions
      .filter((p) => p.quantity > 0)
      .map((p) => billingLineTotalCents(p.quantity, p.unitPrice));
    subtotalCents = sumCents(positionCents.filter(Number.isFinite));
  }
  const taxCents = taxCentsFromNet(subtotalCents, taxRate);
  const grossCents = subtotalCents + taxCents;
  const deductionsCents = toCents(getAbschlagDeductionsTotal(draft.previousAbschlagDeductions));
  const amountDueCents = grossCents - (Number.isFinite(deductionsCents) ? deductionsCents : 0);
  const subtotal = fromCents(subtotalCents);
  const tax = fromCents(taxCents);
  const total = fromCents(amountDueCents);

  if (!isValidMoneyNumber(subtotal) || !isValidMoneyNumber(tax) || !isValidMoneyNumber(total)) {
    blockingErrors.push({ code: 'totals_invalid', messageKey: 'invoice.validation.totalsInvalid' });
  } else if (draft.type === 'rechnung' && amountDueCents < 0) {
    blockingErrors.push({ code: 'totals_negative', messageKey: 'invoice.validation.totalsNegative' });
  } else if (usesAbschlagDeductions(draft.type) && amountDueCents < 0) {
    /*
     * FINAL-INVOICE-OVERPAYMENT-INTEGRITY-01B — Überabrechnung darf nicht
     * still verschwinden.
     *
     * Übersteigen die bereits abgerechneten Abschläge den endgültigen
     * Leistungswert, ist die Differenz hier negativ. Bisher wurde sie an
     * dieser Stelle ignoriert und anschliessend in `calculateInvoiceTotals`
     * auf 0,00 € geklemmt: Die Schlussrechnung liess sich finalisieren, der
     * Vorgang galt danach über `hasSchlussrechnung` als vollständig
     * abgerechnet, und der Fehlbetrag existierte an keiner Stelle mehr.
     *
     * Ein eigener Code statt `totals_negative`: Das ist ein anderer
     * Sachverhalt als eine negative Rechnungssumme und braucht einen Text,
     * der die Abschläge benennt.
     *
     * `amountDueCents === 0` bleibt ausdrücklich zulässig — eine durch volle
     * Abschläge ausgeglichene Schlussrechnung ist ein gültiger Beleg.
     */
    blockingErrors.push({
      code: 'deductions_exceed_total',
      messageKey: 'invoice.validation.deductionsExceedTotal',
    });
  }

  /*
   * FINANZ-CORE-01A (WEISS-Nacharbeit N02/D1) — abgezogen wird nur ein beglichener
   * Abschlag (§ 14 Abs. 5 Satz 2 UStG: vereinnahmte Teilentgelte; BT-113 = bereits
   * gezahlt). Ein unbezahlter oder teilbezahlter Abschlag sperrt die Schlussrechnung,
   * bis er bezahlt oder — ohne Zahlung — storniert ist. Gelesen wird der Stand des
   * Abschlags im Vorgang; der Server prüft dasselbe (`invoice_abschlag_unpaid`).
   */
  const unsettledDeductions =
    usesAbschlagDeductions(draft.type) && vorgang
      ? findUnsettledAbschlagDeductions(draft.previousAbschlagDeductions, (invoiceId) =>
          (vorgang.invoices ?? []).find((invoice) => invoice.id === invoiceId),
        )
      : [];
  /*
   * FINANZ-CORE-01A (Feiertage) — hängt das Skonto eines Abschlags an einem ungeklärten Feiertag am
   * Sitz des Kunden, wird nicht „unbezahlt“ gemeldet, sondern die Klärung verlangt (Bundesland am
   * Kunden). Der Server weist ebenso ab (`invoice_skonto_deadline_unclear`).
   */
  if (unsettledDeductions.some((entry) => entry.skontoUnclear)) {
    blockingErrors.push({ code: 'abschlag_skonto_unclear', messageKey: 'invoice.validation.abschlagSkontoUnclear' });
  }
  if (unsettledDeductions.some((entry) => !entry.skontoUnclear)) {
    blockingErrors.push({ code: 'abschlag_unpaid', messageKey: 'invoice.validation.abschlagUnpaid' });
  }

  /*
   * FC01A-Nacharbeit (A3) — abgezogen werden nur Abschläge desselben Steuerfalls. Ein Abschlag
   * mit 19 % und eine Schlussrechnung nach § 13b (oder umgekehrt) ergäben einen falschen
   * Restbetrag und eine falsch ausgewiesene oder doppelt geschuldete Steuer; der Auftrag sperrt
   * den Steuerstatus nicht immer (Vorgang ohne Steuerstatus, etwa aus dem Eingang). Der Server
   * prüft dasselbe (`invoice_abschlag_tax_status_mismatch`). Ohne getroffene Steuerentscheidung
   * meldet das bereits die Steuerprüfung.
   */
  if (
    usesAbschlagDeductions(draft.type) &&
    vorgang &&
    draft.taxStatus &&
    draft.taxStatus !== 'unclear' &&
    hasAbschlagTaxStatusMismatch(draft.taxStatus, draft.previousAbschlagDeductions, (invoiceId) =>
      (vorgang.invoices ?? []).find((invoice) => invoice.id === invoiceId),
    )
  ) {
    blockingErrors.push({
      code: 'abschlag_tax_status_mismatch',
      messageKey: 'invoice.validation.abschlagTaxStatusMismatch',
    });
  }

  /*
   * FC01A-P1-Restkorrektur (#8, Altformat) — eine Schlussrechnung weist je abgezogenem Abschlag
   * Netto und Umsatzsteuer aus (§ 14 Abs. 5 Satz 2 UStG). Steht das nicht fest (Altabschlag mit
   * Umsatzsteuer ohne gespeichertes Netto, widersprüchliche Angaben), entsteht keine
   * Schlussrechnung — statt Brutto als Netto. Der Server prüft dasselbe
   * (`invoice_abschlag_net_unreliable`).
   */
  if (
    usesAbschlagDeductions(draft.type) &&
    vorgang &&
    draft.taxStatus &&
    draft.taxStatus !== 'unclear' &&
    hasUnreliableAbschlagNet(draft.taxStatus, draft.previousAbschlagDeductions, (invoiceId) =>
      (vorgang.invoices ?? []).find((invoice) => invoice.id === invoiceId),
    )
  ) {
    blockingErrors.push({
      code: 'abschlag_net_unreliable',
      messageKey: 'invoice.validation.abschlagNetUnreliable',
    });
  }

  // FINANZ-CORE-01A (RE-16) — nur mit Auftrag; eine freie Rechnung hat keine Auftragsbezeichnung.
  if (draft.type === 'rechnung' && vorgang && !vorgang.title?.trim()) {
    warnings.push({ code: 'vorgang_title', messageKey: 'invoice.validation.warn.project' });
  }

  /*
   * FINANZ-CORE-01A (RE-17) — § 14 Abs. 4 Nr. 8 UStG verlangt bei einer steuerfreien
   * Leistung einen Hinweis auf die Steuerbefreiung. Der Standardtext nennt keine
   * Rechtsgrundlage. Ein Hinweis vor der Freigabe, kein Stopp: Der Text gehört in die
   * Rechnungseinstellungen.
   */
  if (draft.taxStatus === 'tax_free' && !hasTaxExemptionBasis(draft.companySnapshot?.taxFreeNotice)) {
    warnings.push({ code: 'tax_free_basis', messageKey: 'invoice.validation.warn.taxFreeBasis' });
  }

  /*
   * FINANZ-CORE-01A (RE-17) — die Kleinunternehmerregelung gilt für den ganzen Betrieb. Weist
   * ein Kleinunternehmer Umsatzsteuer aus (oder umgekehrt), schuldet er sie nach § 14c UStG
   * bzw. fehlt sie. Ein Hinweis, weil der Steuerstatus der Rechnung bewusst änderbar ist.
   */
  const profileTaxStatus = draft.companySnapshot?.defaultTaxStatus;
  const kleinunternehmerMismatch =
    (profileTaxStatus === 'kleinunternehmer_19' &&
      (draft.taxStatus === 'standard_19' || draft.taxStatus === 'standard_7')) ||
    (draft.taxStatus === 'kleinunternehmer_19' &&
      (profileTaxStatus === 'standard_19' || profileTaxStatus === 'standard_7'));
  if (kleinunternehmerMismatch) {
    warnings.push({ code: 'tax_status_profile', messageKey: 'invoice.validation.warn.taxStatusProfile' });
  }

  // Deduplicate by code
  const dedupe = (items: InvoiceValidationIssue[]) => {
    const seen = new Set<string>();
    return items.filter((item) => {
      if (seen.has(item.code)) return false;
      seen.add(item.code);
      return true;
    });
  };

  return {
    blockingErrors: dedupe(blockingErrors),
    warnings: dedupe(warnings),
  };
}

/**
 * FINANZ-CORE-01A (Gesamtnacharbeit INV-06/07) — widerspricht der gespeicherte Positionsstand dem
 * Centvertrag (siehe `validateFinalizedInvoiceForPdf`)? Eine Rechnung ohne Positionen (Pauschalabschlag)
 * hat nichts nachzurechnen.
 */
export function hasInconsistentInvoicePositions(
  invoice: Pick<VorgangInvoice, 'positions' | 'subtotal'>,
): boolean {
  const positions = invoice.positions ?? [];
  if (positions.length === 0) return false;
  const zeilen: number[] = [];
  for (const position of positions) {
    const { quantity, unitPrice, lineTotal } = position;
    if (!isValidMoneyNumber(quantity) || !isValidMoneyNumber(unitPrice) || !isValidMoneyNumber(lineTotal)) return true;
    if (toCents(unitPrice) / 100 !== unitPrice) return true;
    if (toCents(lineTotal) !== billingLineTotalCents(quantity, unitPrice)) return true;
    zeilen.push(toCents(lineTotal));
  }
  const subtotal = invoice.subtotal;
  return typeof subtotal === 'number' && isValidMoneyNumber(subtotal) && sumCents(zeilen) !== toCents(subtotal);
}

/**
 * Reuses draft approval rules for PDF export of finalized invoices.
 * Draft / non-final invoices are rejected; nothing is invented.
 */
export function validateFinalizedInvoiceForPdf(
  invoice: VorgangInvoice,
): InvoiceValidationResult {
  if (!isFinalizedInvoiceStatus(invoice)) {
    return {
      blockingErrors: [
        { code: 'not_finalized', messageKey: 'invoice.pdf.notFinalized' },
      ],
      warnings: [],
    };
  }

  const number = invoice.number?.trim() ?? '';
  if (!number || number === INVOICE_DRAFT_LABEL || number === 'ENTWURF') {
    return {
      blockingErrors: [
        { code: 'draft_number', messageKey: 'invoice.pdf.draftNumber' },
      ],
      warnings: [],
    };
  }

  if (!invoice.companySnapshot || !invoice.customerSnapshot) {
    return {
      blockingErrors: [
        { code: 'snapshots_missing', messageKey: 'invoice.pdf.snapshotsMissing' },
      ],
      warnings: [],
    };
  }

  /*
   * FC01A-P1-Restkorrektur (lokaler Altbestand) — ohne verlässliches Netto kein Beleg. Dieselbe
   * Prüfung sperrt Druck, PDF, Korrektur-PDF, Versand, E-Rechnung (`einvoiceOutputRule`) und die
   * Export-Vorprüfung. Kein Freigabecode: Sie gilt gerade für festgeschriebene Belege.
   */
  if (hasUnresolvedInvoiceNet(invoice)) {
    return {
      blockingErrors: [{ code: 'net_unresolved', messageKey: 'invoice.pdf.netUnresolved' }],
      warnings: [],
    };
  }

  /*
   * FINANZ-CORE-01A (Gesamtnacharbeit INV-06/07) — der gespeicherte Positionsstand muss sich nach dem
   * Centvertrag nachrechnen lassen: Einzelpreis auf Cent, Zeilenbetrag gespeichert und gleich Menge ×
   * Einzelpreis (eine Rundung), Positionssumme gleich Netto. Sonst stünden auf Papier und in der
   * E-Rechnung Zahlen, die niemand nachrechnen kann (WEISS: „10 × 0,05 € = 0,45 €“). Der Beleg wird nicht
   * still geändert; er wird nicht ausgegeben (Weg: Storno mit Korrekturrechnung). Seit 20261121 nimmt der
   * Server so eine Rechnung gar nicht mehr an; der Bestand ist geprüft. Die Sperre kommt zu den
   * Freigaberegeln hinzu (unten), sie verdeckt keine spezifischere (etwa `fixed_amount_with_positions`).
   */
  const positionsInconsistent = hasInconsistentInvoicePositions(invoice);

  const draft = finalizedInvoiceToValidationDraft(invoice);
  const result = validateInvoiceDraftForApproval(draft, invoice.companySnapshot, undefined, {
    // Already approved — do not re-require interactive §13b checkbox.
    reverseCharge13bConfirmed: true,
  });
  /*
   * FINANZ-CORE-01A (RE-09, RE-17) — Freigaberegeln, die erst seit dieser Änderung
   * gelten, sperren keinen festgeschriebenen Beleg: Eine früher ohne Steuer-ID oder
   * mit künftigem Datum freigegebene Rechnung bleibt druck- und archivierbar
   * (Aufbewahrungspflicht). Neu ausgestellt wird so nichts mehr.
   */
  return {
    ...result,
    blockingErrors: [
      ...result.blockingErrors.filter((issue) => !APPROVAL_ONLY_CODES.has(issue.code)),
      ...(positionsInconsistent
        ? [{ code: 'positions_inconsistent', messageKey: 'invoice.pdf.positionsInconsistent' as const }]
        : []),
    ],
  };
}

/**
 * FINANZ-CORE-01A — gelten nur beim Ausstellen, nie beim Nachdruck eines festgeschriebenen Belegs.
 * `abschlag_unpaid` (WEISS N02): Der Nachdruck einer älteren Schlussrechnung bleibt möglich;
 * ihre E-Rechnung prüft den Zahlungsstand der Abschläge selbst (`prepayment_not_settled`).
 */
const APPROVAL_ONLY_CODES: ReadonlySet<string> = new Set([
  'company_tax_id',
  'issue_date_future',
  'abschlag_unpaid',
  // FINANZ-CORE-01A (Feiertage) — wie `abschlag_unpaid`: nur beim Ausstellen.
  'abschlag_skonto_unclear',
  // FC01A-Nacharbeit (A3) — der Nachdruck eines älteren Belegs bleibt möglich.
  'abschlag_tax_status_mismatch',
  // FC01A-P1-Restkorrektur — Nachdruck möglich, dann ohne Netto/USt des Abzugs (invoicePrintModel).
  'abschlag_net_unreliable',
]);

/** Ausdrücklich ohne Umsatzsteuer: nur hier ist das Netto eines Abzugs ohne gespeichertes Netto das Brutto. */
const TAX_FREE_STATUSES: ReadonlySet<string> = new Set(['kleinunternehmer_19', 'reverse_charge_13b', 'tax_free']);

/**
 * FC01A-P1-Restkorrektur (#8, Altformat) — fehlt einem Abzug ein verlässliches Netto? Ein
 * gespeichertes Netto muss zum Satz passen; ohne gespeichertes Netto zählt nur ein ausdrücklich
 * steuerfreier Abschlag (§ 19, § 13b, steuerfrei) — nicht „unklar" und nicht ein Altbestand ohne
 * Steuerstatus. Dieselbe Regel wie `reliableDeductionNetCents` und der Server.
 */
export function hasUnreliableAbschlagNet(
  taxStatus: InvoiceDraft['taxStatus'],
  deductions: InvoiceDraft['previousAbschlagDeductions'],
  findInvoice: (invoiceId: string) => VorgangInvoice | undefined,
): boolean {
  const rate = getTaxRateForStatus(taxStatus);
  return (deductions ?? []).some((deduction) => {
    if (reliableDeductionNetCents(deduction, rate) === null) return true;
    if (typeof deduction.subtotal === 'number' && Number.isFinite(deduction.subtotal)) return false;
    const status = findInvoice(deduction.invoiceId)?.taxStatus;
    return !status || !TAX_FREE_STATUSES.has(status);
  });
}

/**
 * FC01A-Nacharbeit (A3) — trägt ein abgezogener Abschlag einen anderen Steuerfall als die
 * Schlussrechnung? Ein Altbestand ohne Steuerstatus wird an Steuer ja/nein gemessen (wie der
 * Server). Ein im Vorgang unbekannter Abschlag entscheidet hier nichts; das prüft der Server.
 */
export function hasAbschlagTaxStatusMismatch(
  taxStatus: InvoiceDraft['taxStatus'],
  deductions: InvoiceDraft['previousAbschlagDeductions'],
  findInvoice: (invoiceId: string) => VorgangInvoice | undefined,
): boolean {
  const rate = getTaxRateForStatus(taxStatus);
  return (deductions ?? []).some((deduction) => {
    const abschlag = findInvoice(deduction.invoiceId);
    if (!abschlag) return false;
    if (abschlag.taxStatus && abschlag.taxStatus !== 'unclear') return abschlag.taxStatus !== taxStatus;
    const subtotal = abschlag.subtotal;
    if (subtotal === undefined || !isValidMoneyNumber(abschlag.amount) || !isValidMoneyNumber(subtotal)) return false;
    const hadTax = toCents(abschlag.amount) !== toCents(subtotal);
    return hadTax !== rate > 0;
  });
}

function finalizedInvoiceToValidationDraft(invoice: VorgangInvoice): InvoiceDraft {
  const company = invoice.companySnapshot!;
  const customer = invoice.customerSnapshot!;
  return {
    id: invoice.id,
    vorgangId: '',
    vorgangTitle: invoice.vorgangTitle ?? '',
    customer: customer.name,
    baustelle: invoice.baustelle ?? '',
    type: invoice.type,
    abschlagNumber: invoice.abschlagNumber,
    /*
     * E-RECHNUNG-04E2 — die Abrechnungsart muss mitkommen.
     *
     * Ohne diese beiden Felder hielt die Revalidierung jeden pauschalen
     * Abschlag für mengenbasiert. Da ein Pauschalabschlag fachlich **keine**
     * Positionen führt, meldete sie `no_positions` — und ein finalisierter
     * Pauschalabschlag liess sich überhaupt nicht als PDF ausgeben. Aufgefallen
     * ist das bei der PDF/XML-Gleichheitsprüfung von 04E2, die genau diesen
     * Belegtyp erzeugen wollte.
     *
     * Die Entwurfsvalidierung vor der Freigabe liest dieselben Felder und liess
     * denselben Beleg anstandslos durch; erst die Rückwandlung verlor sie. Es
     * ist also keine neue Erlaubnis, sondern die Wiederherstellung der Aussage,
     * die vor der Freigabe bereits galt.
     */
    calculationMode: invoice.calculationMode,
    fixedAmountNet: invoice.fixedAmountNet,
    taxStatus: invoice.taxStatus,
    materialSource: 'betrieb',
    positions: invoice.positions.map((position) => ({
      id: position.id,
      orderPositionId: position.orderPositionId,
      description: position.description,
      plannedQuantity: position.quantity,
      billedQuantity: 0,
      openQuantity: position.quantity,
      quantity: position.quantity,
      unit: position.unit,
      unitLabel: position.unitLabel,
      unitPrice: position.unitPrice,
      category: 'arbeit' as const,
      billable: true,
    })),
    issueDate: invoice.issueDate ?? invoice.date,
    servicePeriodFrom: invoice.servicePeriodFrom ?? invoice.issueDate ?? invoice.date,
    servicePeriodTo: invoice.servicePeriodTo ?? invoice.issueDate ?? invoice.date,
    /*
     * FINALIZED-INVOICE-PDF-SERVICE-PERIOD-01B — der gespeicherte Wert, roh.
     *
     * Ausdrücklich **ohne** `?? true` und ohne Rückschluss aus dem Vorhandensein
     * eines Zeitraums: Eine historische Rechnung ohne dieses Feld bleibt
     * unbestätigt und damit im PDF-Pfad blockiert. Anders als bei §13B, das
     * sich aus `taxStatus` ablesen lässt, hinterlässt diese Bestätigung keine
     * Spur auf dem Beleg — es gibt nichts zu belegen, also wird nichts geraten.
     */
    servicePeriodConfirmed: invoice.servicePeriodConfirmed,
    paymentDueDate: invoice.paymentDueDate ?? '',
    paymentTermsText: invoice.paymentTermsText ?? '',
    skontoText: invoice.skontoText ?? '',
    customerBilling: { ...customer },
    companySnapshot: { ...company },
    legalNotices: [...(invoice.legalNotices ?? [])],
    previousAbschlagDeductions: [...(invoice.previousAbschlagDeductions ?? [])],
    invoiceNumberPreview: invoice.number,
    introText: invoice.introText ?? '',
    closingText: invoice.closingText ?? '',
  };
}

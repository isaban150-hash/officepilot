import { addInvoiceToVorgang, getVorgangById } from './vorgangService';
import { archiveOutgoingInvoice } from './invoiceArchiveService';
import { createCompanyProfileSnapshot } from './companyProfileService';
import {
  getNextAbschlagNumber,
  getBilledQuantity,
  getBillableOpenQuantity,
  getExecutedRemainingQuantity,
  isBillingEffective,
  isPositionBillable,
} from './orderBillingRules';
import {
  getNextInvoiceNumberPreview,
  INVOICE_DRAFT_LABEL,
  reserveNextInvoiceNumber,
} from './invoiceNumberService';
import type {
  AbschlagDeduction,
  CompanyProfile,
  CompanySetup,
  CustomerBilling,
  InvoiceCalculationMode,
  InvoiceDocumentType,
  InvoiceDraft,
  InvoiceDraftMetadataChanges,
  InvoiceDraftPosition,
  InvoiceTotals,
  OrderPosition,
  OrderUnit,
  TaxStatus,
  Vorgang,
  VorgangInvoice,
  VorgangInvoiceLine,
} from '../types/models';
import type { BrandingSnapshot } from '../types/branding';
import { BRANDING_SNAPSHOT_VERSION } from '../types/branding';
import { buildBrandingSnapshot } from './branding/brandingSnapshotService';
import {
  isFixedAmountAbschlag,
  resolveInvoiceCalculationMode,
} from './invoiceCalculationMode';
import {
  addCalendarDays,
  buildLegalNotices,
  buildSkontoText,
  getTaxRateForStatus,
} from './invoiceTaxService';
import {
  prefillsOpenQuantity,
  usesAbschlagDeductions,
  usesAbschlagNumber,
} from './invoiceTypeService';
import { getAbschlagDeductionsTotal } from './invoiceDeductions';
import {
  fromCents,
  lineTotalCents,
  lineTotalMoney,
  roundMoney,
  sumCents,
  taxCentsFromNet,
  toCents,
} from './invoiceMoney';
import {
  validateInvoiceDraftForApproval,
  type InvoiceApprovalOptions,
  type InvoiceValidationResult,
} from './invoiceValidationService';

export { buildLegalNotices, getTaxRateForStatus } from './invoiceTaxService';
export { getAbschlagDeductionsTotal } from './invoiceDeductions';
export { validateInvoiceDraftForApproval } from './invoiceValidationService';
export { INVOICE_DRAFT_LABEL } from './invoiceNumberService';
export {
  isFixedAmountAbschlag,
  resolveInvoiceCalculationMode,
  FIXED_AMOUNT_ABSCHLAG_PRINT_DESCRIPTION,
} from './invoiceCalculationMode';

export function getVorgangCustomerBilling(vorgang: Vorgang): CustomerBilling {
  if (vorgang.customerBilling) {
    return { ...vorgang.customerBilling };
  }
  return {
    name: vorgang.customer,
    contactPerson: '',
    street: '',
    zip: '',
    city: '',
    email: '',
    phone: '',
  };
}

/**
 * INVOICE-PAYMENT-TERMS-DAYS-DRIFT-01A — dieselbe Fristrechnung wie beim
 * Skonto. Vorher rechnete diese Stelle lokal und verlor über die
 * Sommerzeitumstellung einen Tag; das Fälligkeitsdatum widersprach dann dem
 * Zahlungsziel auf demselben Beleg.
 */
const addDays = addCalendarDays;

/**
 * INVOICE-SKONTO-PAYMENT-TERMS-CONSISTENCY-01B — der Basissatz kennt jetzt das
 * Skonto.
 *
 * Realbefund: Auf einer Rechnung standen nebeneinander „Zahlbar innerhalb von
 * 14 Tagen **ohne Abzug**." und „Bei Zahlung innerhalb von 10 Tagen gewähren
 * wir 7 % Skonto." Der erste Satz verneint wörtlich, was der zweite gewährt.
 *
 * Ursache waren zwei Textbauer, die nichts voneinander wussten: Diese Funktion
 * las nur `defaultPaymentTerms`/`defaultPaymentDays`, `buildSkontoText` nur die
 * Skontofelder. Beide landen im selben Entwurf — nebeneinander, ungeprüft.
 *
 * Angepasst wird ausschliesslich der **von OfficePilot erzeugte** Standardsatz.
 * Ein selbst formulierter Text bleibt wortgleich stehen, auch wenn er „ohne
 * Abzug" enthält: An fremder Prosa wird nicht herumgeschnitten, und eine
 * Heuristik über beliebige deutsche Sätze wäre in beide Richtungen falsch.
 */
function standardPaymentTerms(days: number, withoutDeduction: boolean): string {
  return withoutDeduction
    ? `Zahlbar innerhalb von ${days} Tagen ohne Abzug.`
    : `Zahlbar innerhalb von ${days} Tagen.`;
}

/**
 * INVOICE-SKONTO-PAYMENT-TERMS-CONSISTENCY-01B2 — hält Basissatz und Skonto
 * zusammen, wenn sich der Skontotext ändert.
 *
 * Angefasst werden **ausschliesslich** die beiden bekannten Standardsätze. Ein
 * selbst formulierter Zahlungstext fällt durch beide Vergleiche und bleibt
 * wortgleich — es wird nicht an fremder Prosa herumgeschnitten und kein „ohne
 * Abzug" irgendwo herausgesucht.
 *
 * Die Regel ist symmetrisch: Kommt Skonto hinzu, verschwindet „ohne Abzug";
 * fällt es weg, kehrt es zurück. Ohne die zweite Richtung bliebe eine Rechnung
 * nach dem Ablehnen eines Vertragsangebots stumm darüber, dass sie abzugsfrei
 * ist.
 */
export function reconcilePaymentTermsWithSkonto(
  paymentTermsText: string,
  skontoText: string,
  defaultPaymentDays: number,
): string {
  const grantsSkonto = skontoText.trim().length > 0;
  const current = paymentTermsText.trim();

  if (grantsSkonto && current === standardPaymentTerms(defaultPaymentDays, true)) {
    return standardPaymentTerms(defaultPaymentDays, false);
  }
  if (!grantsSkonto && current === standardPaymentTerms(defaultPaymentDays, false)) {
    return standardPaymentTerms(defaultPaymentDays, true);
  }
  return paymentTermsText;
}

function buildDefaultPaymentTerms(profile: CompanyProfile): string {
  const days = profile.defaultPaymentDays;
  const configured = profile.defaultPaymentTerms.trim();

  /*
   * Nicht `skontoEnabled` allein: Erst wenn `buildSkontoText` tatsächlich einen
   * Satz liefert, steht auch einer auf der Rechnung. Ein eingeschalteter
   * Schalter ohne gültige Prozent-/Tageswerte ergibt keinen Skontosatz — dann
   * darf der Basissatz sein „ohne Abzug" behalten, sonst verspräche die
   * Rechnung stillschweigend einen Nachlass, den sie nirgends beziffert.
   */
  const grantsSkonto = buildSkontoText(profile).trim().length > 0;

  /*
   * Herkunftserkennung über den bekannten Standardwortlaut. Der Wert entsteht
   * an zwei Stellen genau so — als Vorgabe in `companyProfileDefaults` und im
   * `FirstRunWizard`, der ihn bei geändertem Zahlungsziel neu bildet.
   *
   * Bewusst kein Herkunftsfeld im `CompanyProfile`: Das wäre eine
   * Modellerweiterung für einen Textvergleich. Das Restrisiko ist benannt —
   * wer den Vorgabesatz bewusst wortgleich selbst eingetippt hat, wird wie der
   * Standard behandelt. Die Anpassung ist dann trotzdem die fachlich richtige.
   */
  if (configured && configured !== standardPaymentTerms(days, true)) {
    return configured;
  }

  return standardPaymentTerms(days, !grantsSkonto);
}

/**
 * FINAL-INVOICE-CANCELLATION-REBILLING-01A — ein stornierter Abschlag wird
 * nicht mehr abgezogen. Sonst hielte die Schlussrechnung einen Abzug fest, den
 * `hasAbschlagsrechnung` und die Mengenprojektion längst nicht mehr kennen.
 */
export function getPreviousAbschlagDeductions(vorgang: Vorgang): AbschlagDeduction[] {
  return vorgang.invoices
    .filter((inv) => inv.type === 'abschlag' && isBillingEffective(inv))
    .map((inv) => ({
      invoiceId: inv.id,
      invoiceNumber: inv.number,
      abschlagNumber: inv.abschlagNumber,
      date: inv.issueDate ?? inv.date,
      subtotal: inv.subtotal,
      amount: inv.amount,
    }));
}

/**
 * BRANDING-01F-1 — das aktuelle Branding für genau diese Rechnung einfrieren.
 *
 * `buildBrandingSnapshot` prüft streng und **wirft** bei ungültigen Werten. Das
 * ist für den Snapshot-Vertrag richtig, darf aber nicht dazu führen, dass ein
 * beschädigter Branding-Block aus Alt- oder Importdaten das Erstellen einer
 * Rechnung unmöglich macht: Eine Rechnung ohne Logo ist ein gültiges Dokument,
 * eine nicht erstellbare Rechnung ist ein Betriebsausfall.
 *
 * Deshalb der leere Snapshot als Rückfallebene — und ausdrücklich **keine**
 * stille Reparatur am `CompanyProfile`. Was dort kaputt ist, bleibt kaputt und
 * sichtbar; nur dieses eine Dokument verzichtet auf das Branding.
 */
function freezeBrandingForInvoice(branding: CompanyProfile['branding']): BrandingSnapshot {
  try {
    return buildBrandingSnapshot(branding ?? {});
  } catch {
    return { version: BRANDING_SNAPSHOT_VERSION };
  }
}

function buildDraftMetadata(
  vorgang: Vorgang,
  setup: CompanySetup,
  type: InvoiceDraft['type'],
): Pick<
  InvoiceDraft,
  | 'issueDate'
  | 'servicePeriodFrom'
  | 'servicePeriodTo'
  | 'servicePeriodConfirmed'
  | 'paymentDueDate'
  | 'paymentTermsText'
  | 'skontoText'
  | 'customerBilling'
  | 'companySnapshot'
  | 'brandingSnapshot'
  | 'legalNotices'
  | 'previousAbschlagDeductions'
  | 'invoiceNumberPreview'
> {
  const profile = createCompanyProfileSnapshot();
  const issueDate = new Date().toISOString().slice(0, 10);

  return {
    issueDate,
    /*
     * INVOICE-SERVICE-PERIOD-01B — kein erfundener Leistungszeitraum.
     *
     * Bisher stand hier zweimal `issueDate`. Damit behauptete jede neue
     * Rechnung, die Leistung sei am Tag der Rechnungsstellung erbracht worden —
     * von–bis derselbe Tag, ungefragt und im Regelweg nur als Anzeigezeile
     * sichtbar. In der Praxis wird abgerechnet, **nachdem** gearbeitet wurde.
     *
     * Leer statt `undefined`: Die Felder bleiben Pflicht-Strings, damit
     * Eingabefelder kontrolliert bleiben und der Typradius klein.
     */
    servicePeriodFrom: '',
    servicePeriodTo: '',
    servicePeriodConfirmed: false,
    paymentDueDate: addDays(issueDate, profile.defaultPaymentDays),
    paymentTermsText: buildDefaultPaymentTerms(profile),
    /*
     * SKONTO-INVOICE-TEXT-01B — der Firmenstandard kommt genau hier hinein.
     *
     * Zahlungsziel und Zahlungsbedingungen wurden schon immer aus dem Profil
     * abgeleitet, Skonto als einziges nicht — ein Betrieb konnte 2 % / 10 Tage
     * einrichten und bekam trotzdem eine Rechnung ohne Skontosatz.
     *
     * Der Wert wird **einmal** beim Aufbau des Entwurfs bestimmt und ist danach
     * dessen eigener Stand. Es gibt bewusst keinen Effekt, der ihn bei einer
     * späteren Profiländerung nachzieht: Der Entwurf gehört dem Zeitpunkt
     * seiner Entstehung, und was der Nutzer hier ändert, bleibt geändert.
     */
    skontoText: buildSkontoText(profile),
    customerBilling: getVorgangCustomerBilling(vorgang),
    companySnapshot: profile,
    brandingSnapshot: freezeBrandingForInvoice(profile.branding),
    legalNotices: buildLegalNotices(setup.taxStatus, profile),
    previousAbschlagDeductions:
      usesAbschlagDeductions(type) ? getPreviousAbschlagDeductions(vorgang) : [],
    invoiceNumberPreview: INVOICE_DRAFT_LABEL,
  };
}

/**
 * MANUAL-INVOICE-01B1 — der Entwurf einer Rechnung ohne Auftrag.
 *
 * Ein Handwerksbetrieb schreibt nicht jede Rechnung zu einem erfassten Auftrag:
 * Eine Anfahrt, eine kleine Reparatur, eine Nachberechnung entstehen ohne
 * vorherigen Vertrag und ohne Leistungsverzeichnis.
 *
 * Bewusst eine **eigene** Funktion statt eines weiteren Falls in
 * `buildInvoiceDraftForType`: Dieser Weg kennt keinen Vorgang, keine
 * Auftragspositionen, keine Abschlagshistorie und keine Planmengen. Ihn in den
 * auftragsgebundenen Bauer zu falten hiesse, in jeder Zeile zu fragen, ob es
 * den Auftrag gibt — und genau daraus entstehen die stillen Annahmen, die
 * dieser Block vermeiden soll.
 *
 * Geteilt wird alles, was ohnehin nicht vom Auftrag kommt: Firmenstammdaten,
 * Zahlungsbedingungen, Skonto, Rechtshinweise, Branding, Steuerstatus. Die
 * Rechnungsnummer entsteht wie immer erst bei der Freigabe.
 *
 * Nur `type: 'rechnung'`: Ein Abschlag rechnet auf einen Auftragswert an, eine
 * Schlussrechnung schliesst ihn ab — beide sind ohne Auftrag fachlich nicht
 * definiert.
 */
export function buildManualInvoiceDraft(
  customerBilling: CustomerBilling,
  setup: CompanySetup,
): InvoiceDraft {
  const profile = createCompanyProfileSnapshot();
  const issueDate = new Date().toISOString().slice(0, 10);

  return {
    id: `draft-${Date.now()}`,
    vorgangId: null,
    customer: customerBilling.name,
    baustelle: '',
    type: 'rechnung',
    taxStatus: setup.taxStatus,
    materialSource: 'betrieb',
    positions: [],
    introText: '',
    closingText: '',
    issueDate,
    // Wie im Auftragsweg: kein erfundener Leistungszeitraum.
    servicePeriodFrom: '',
    servicePeriodTo: '',
    servicePeriodConfirmed: false,
    paymentDueDate: addDays(issueDate, profile.defaultPaymentDays),
    paymentTermsText: buildDefaultPaymentTerms(profile),
    skontoText: buildSkontoText(profile),
    customerBilling,
    companySnapshot: profile,
    brandingSnapshot: freezeBrandingForInvoice(profile.branding),
    legalNotices: buildLegalNotices(setup.taxStatus, profile),
    previousAbschlagDeductions: [],
    invoiceNumberPreview: INVOICE_DRAFT_LABEL,
  };
}

/**
 * MANUAL-INVOICE-01B1 — eine frei erfasste Rechnungsposition.
 *
 * Trägt ausschliesslich, was eine Rechnungszeile fachlich ausmacht. Auftragsfelder
 * (`orderPositionId`, `plannedQuantity`, `billedQuantity`, `openQuantity`) bleiben
 * **abwesend** statt mit `0` erfunden zu werden.
 */
export function buildManualInvoicePosition(input: {
  description: string;
  quantity: number;
  unit: OrderUnit;
  unitPrice: number;
  unitLabel?: string;
}): InvoiceDraftPosition {
  return {
    id: `manual-pos-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    description: input.description,
    quantity: input.quantity,
    unit: input.unit,
    unitLabel: input.unitLabel,
    unitPrice: input.unitPrice,
    billable: true,
  };
}

export function enrichDraftWithPreviewNumber(draft: InvoiceDraft): InvoiceDraft {
  return {
    ...draft,
    invoiceNumberPreview: getNextInvoiceNumberPreview(),
  };
}

export {
  canAddOrderPosition,
  canDeleteOrderPosition,
  canEditOrderPositionField,
  getBilledQuantity,
  getBillableOpenQuantity,
  getExecutedRemainingQuantity,
  getNextAbschlagNumber,
  getOpenQuantity,
  getPositionBillingStatus,
  hasFinalSchlussrechnung,
  hasAbschlagsrechnung,
  hasSchlussrechnung,
  isPositionBillable,
  isPositionStillOpen,
} from './orderBillingRules';

function buildDraftPosition(
  vorgang: Vorgang,
  orderPosition: OrderPosition,
  initialQuantity: number,
): InvoiceDraftPosition {
  const billedQuantity = getBilledQuantity(vorgang, orderPosition.id);
  const openQuantity = getBillableOpenQuantity(vorgang, orderPosition.id);
  const billable = isPositionBillable(orderPosition, vorgang.materialSource);

  return {
    id: `draft-pos-${orderPosition.id}`,
    orderPositionId: orderPosition.id,
    description: orderPosition.description,
    plannedQuantity: orderPosition.plannedQuantity,
    executedQuantity: orderPosition.executedQuantity,
    billedQuantity,
    openQuantity,
    quantity: billable ? initialQuantity : 0,
    unit: orderPosition.unit,
    unitLabel: orderPosition.unitLabel,
    unitPrice: orderPosition.unitPrice,
    category: orderPosition.category,
    billable,
  };
}

function buildBaseDraft(
  vorgang: Vorgang,
  setup: CompanySetup,
  type: InvoiceDraft['type'],
  positions: InvoiceDraftPosition[],
  abschlagNumber?: number,
): InvoiceDraft {
  const draft: InvoiceDraft = {
    id: `draft-${Date.now()}`,
    vorgangId: vorgang.id,
    vorgangTitle: vorgang.title,
    customer: vorgang.customer,
    baustelle: vorgang.baustelle,
    type,
    abschlagNumber,
    taxStatus: setup.taxStatus,
    materialSource: vorgang.materialSource,
    positions,
    calculationMode: type === 'abschlag' ? 'quantity_based' : undefined,
    introText: '',
    closingText: '',
    ...buildDraftMetadata(vorgang, setup, type),
  };
  // Freeze amendment revision at Schluss preparation time (ORDER-AMENDMENT-01B2).
  if (type === 'schluss') {
    const sequences = (vorgang.confirmedOrderAmendments ?? []).map((item) => item.sequenceNo);
    draft.expectedAmendmentSequence =
      sequences.length > 0 ? Math.max(...sequences) : 0;
  }
  return draft;
}

function initialQuantityForType(
  vorgang: Vorgang,
  orderPosition: OrderPosition,
  type: InvoiceDocumentType,
): number {
  if (!prefillsOpenQuantity(type)) return 0;
  /*
   * INVOICE-ACTUAL-QUANTITY-01B — die Planmenge ist kein Aufmass. Vorbelegt
   * wird nur, was tatsächlich erfasst wurde; ohne Ausführungsstand bleibt das
   * Feld bei 0, statt eine Leistung zu behaupten.
   *
   * INVOICE-ACTUAL-MEASURE-VS-PLAN-01B — und der erfasste Stand wird nicht
   * mehr am Plan gekappt. Bis hierher lieferte `getBillableOpenQuantity` bei
   * Plan 50.000 / erfasst 51.200 / abgerechnet 40.000 einen Vorschlag von
   * 10.000 statt der realen 11.200. Der Vorschlag ist eine Hilfe, keine
   * Entscheidung: Der Nutzer kann ihn jederzeit ändern.
   */
  return getExecutedRemainingQuantity(vorgang, orderPosition.id) ?? 0;
}

function buildPositionsForType(
  vorgang: Vorgang,
  type: InvoiceDocumentType,
): InvoiceDraftPosition[] {
  return vorgang.orderPositions.map((op) =>
    buildDraftPosition(vorgang, op, initialQuantityForType(vorgang, op, type)),
  );
}

export function buildInvoiceDraftForType(
  vorgangId: string,
  setup: CompanySetup,
  type: InvoiceDocumentType,
): InvoiceDraft | null {
  const vorgang = getVorgangById(vorgangId);
  if (!vorgang || vorgang.orderPositions.length === 0) return null;

  if (type === 'abschlag') {
    return buildBaseDraft(
      vorgang,
      setup,
      'abschlag',
      buildPositionsForType(vorgang, 'abschlag'),
      getNextAbschlagNumber(vorgang),
    );
  }

  if (type === 'schluss') {
    return buildBaseDraft(
      vorgang,
      setup,
      'schluss',
      buildPositionsForType(vorgang, 'schluss'),
    );
  }

  return buildBaseDraft(vorgang, setup, type, buildPositionsForType(vorgang, type));
}

export function buildRechnungDraft(vorgangId: string, setup: CompanySetup): InvoiceDraft | null {
  return buildInvoiceDraftForType(vorgangId, setup, 'rechnung');
}

export function buildAbschlagDraft(vorgangId: string, setup: CompanySetup): InvoiceDraft | null {
  return buildInvoiceDraftForType(vorgangId, setup, 'abschlag');
}

export function buildSchlussrechnungDraft(vorgangId: string, setup: CompanySetup): InvoiceDraft | null {
  return buildInvoiceDraftForType(vorgangId, setup, 'schluss');
}

/**
 * Switch Abschlag draft between quantity_based and fixed_amount.
 * Clears the inactive calculation basis so totals never double-count.
 */
export function setAbschlagDraftCalculationMode(
  draft: InvoiceDraft,
  mode: InvoiceCalculationMode,
  setup: CompanySetup,
): InvoiceDraft {
  if (draft.type !== 'abschlag') return draft;

  if (mode === 'fixed_amount') {
    return {
      ...draft,
      calculationMode: 'fixed_amount',
      positions: [],
      fixedAmountNet:
        draft.calculationMode === 'fixed_amount' && draft.fixedAmountNet != null
          ? draft.fixedAmountNet
          : undefined,
    };
  }

  /*
   * MANUAL-INVOICE-01B1 — Abschläge bleiben auftragsgebunden: Sie rechnen auf
   * einen Auftragswert an. Ohne Vorgang gibt es nichts neu aufzubauen.
   */
  const rebuilt = draft.vorgangId ? buildAbschlagDraft(draft.vorgangId, setup) : null;
  if (!rebuilt) {
    return {
      ...draft,
      calculationMode: 'quantity_based',
      fixedAmountNet: undefined,
    };
  }

  return {
    ...rebuilt,
    id: draft.id,
    calculationMode: 'quantity_based',
    fixedAmountNet: undefined,
    issueDate: draft.issueDate,
    servicePeriodFrom: draft.servicePeriodFrom,
    servicePeriodTo: draft.servicePeriodTo,
    /*
     * INVOICE-SERVICE-PERIOD-01B2 — die Bestätigung reist mit den Daten.
     *
     * Der Moduswechsel baut den Entwurf neu auf und übernimmt die Metadaten
     * ausdrücklich. Ohne diese Zeile blieben Beginn und Ende stehen, während
     * der Zustand auf „unbestätigt" zurückfiel — der Nutzer hätte einen
     * scheinbar bestätigten Zeitraum vor sich gehabt.
     */
    servicePeriodConfirmed: draft.servicePeriodConfirmed,
    paymentDueDate: draft.paymentDueDate,
    paymentTermsText: draft.paymentTermsText,
    skontoText: draft.skontoText,
    introText: draft.introText,
    closingText: draft.closingText,
    vorgangTitle: draft.vorgangTitle,
    baustelle: draft.baustelle,
    customerBilling: draft.customerBilling,
    companySnapshot: draft.companySnapshot,
    taxStatus: draft.taxStatus,
    legalNotices: draft.legalNotices,
    invoiceNumberPreview: draft.invoiceNumberPreview,
    previousAbschlagDeductions: draft.previousAbschlagDeductions,
  };
}

export function updateInvoiceDraftFixedAmountNet(
  draft: InvoiceDraft,
  fixedAmountNet: number,
): InvoiceDraft {
  if (!isFixedAmountAbschlag(draft)) return draft;
  return {
    ...draft,
    fixedAmountNet,
  };
}

export function updateInvoiceDraftTaxStatus(
  draft: InvoiceDraft,
  taxStatus: TaxStatus,
): InvoiceDraft {
  return {
    ...draft,
    taxStatus,
    legalNotices: buildLegalNotices(taxStatus, draft.companySnapshot),
  };
}
/**
 * INVOICE-ACTUAL-MEASURE-VS-PLAN-01B — der bekannte Ist-Rest einer
 * Entwurfsposition, aus deren eigenen eingefrorenen Feldern.
 *
 * Dasselbe wie `getExecutedRemainingQuantity`, nur ohne Rückgriff auf den
 * Vorgang: Ein Entwurf trägt `executedQuantity` und `billedQuantity` bereits
 * bei sich und muss auch nach einem Neuaufbau ohne Vorgangskontext rechnen
 * können. `undefined` heisst weiterhin **„unbekannt"**, nicht `0`.
 */
export function getDraftPositionExecutedRemaining(
  position: InvoiceDraftPosition,
): number | undefined {
  if (position.executedQuantity === undefined) return undefined;
  // MANUAL-INVOICE-01B1 — ohne Auftrag gibt es keine Abrechnungshistorie.
  return Math.max(0, position.executedQuantity - (position.billedQuantity ?? 0));
}

/**
 * INVOICE-ACTUAL-MEASURE-VS-PLAN-01B — die Vergleichsgrundlage der
 * Überschreitungswarnung.
 *
 * Kennt OfficePilot ein Aufmass, ist **es** der Maßstab; sonst bleibt der
 * Planrest die beste vorhandene Referenz. Damit warnt eine Rechnung über
 * 11.200 m² bei erfassten 11.200 m² Ist-Rest nicht mehr nur deshalb, weil der
 * Planrest 10.000 m² beträgt — gewarnt wird über das, was OfficePilot
 * tatsächlich weiß.
 *
 * Beide Werte sind Referenzen, keine Grenzen: Die Warnung sagt „über dem
 * derzeit dokumentierten Rest", nicht „unzulässig".
 *
 * MANUAL-INVOICE-01B1 — der oben vorausgesagte Fall ist eingetreten: Eine frei
 * erfasste Position hat weder Aufmass noch Planrest, also **keine**
 * Vergleichsgrundlage. `undefined` sagt genau das; gewarnt wird dann nicht.
 * Ein Ersatzwert wie `0` würde jede freie Position als Überschreitung melden.
 */
export function getOverbillingReference(position: InvoiceDraftPosition): number | undefined {
  return getDraftPositionExecutedRemaining(position) ?? position.openQuantity;
}

/**
 * INVOICE-DRAFT-ORDER-PROJECTION-REFRESH-01B — die Auftragsfakten eines
 * wiederaufgenommenen Entwurfs nachholen.
 *
 * Ein dauerhafter Entwurf wird beim Wiederaufnehmen unverändert
 * wiederhergestellt; `buildInvoiceDraftForType` läuft dann nicht mehr. Auf dem
 * iPhone hiess das: Wer die Rechnung öffnete, bevor eine Ausführung erfasst
 * war, sah danach dauerhaft „noch nicht erfasst" — obwohl der Auftrag längst
 * 20 Stunden trug und diese auch einen Reload überlebten.
 *
 * Aufgefrischt werden ausschliesslich die **Ableitungen** aus dem Auftrag:
 * Planmenge, Ausführungsstand, bereits abgerechnete Menge und Planrest. Sie
 * sind Projektionen, keine Eingaben — ihr alter Stand ist schlicht falsch.
 *
 * 🔒 **`quantity` bleibt unangetastet.** Der Entwurf trägt keine Herkunft der
 * Menge; ob eine 0 bewusst gewählt oder nur nie berührt wurde, ist nicht
 * unterscheidbar. Jede Heuristik („sieht unbearbeitet aus") würde früher oder
 * später eine bewusste Entscheidung überschreiben — und das wäre schlimmer als
 * ein Vorschlag, der ausbleibt. Der Nutzer sieht nach dem Auffrischen die
 * richtigen Zahlen und kann die Menge selbst setzen; „Alle Positionen
 * übernehmen" rechnet dann mit dem aktuellen Stand.
 *
 * Eine Entwurfsposition ohne passende Auftragsposition bleibt **unverändert**
 * erhalten: Sie zu entfernen wäre stiller Datenverlust, sie neu zuzuordnen
 * geraten. Neue Auftragspositionen wandern **nicht** von selbst in den
 * Entwurf — Positionen kommen nur auf ausdrückliche Entscheidung hinzu.
 */
export function refreshDraftOrderProjection(
  draft: InvoiceDraft,
  vorgang: Vorgang,
): { draft: InvoiceDraft; changed: boolean } {
  let changed = false;

  const positions = draft.positions.map((position) => {
    const orderPosition = vorgang.orderPositions?.find((p) => p.id === position.orderPositionId);
    if (!orderPosition) return position;

    const next: InvoiceDraftPosition = {
      ...position,
      plannedQuantity: orderPosition.plannedQuantity,
      billedQuantity: getBilledQuantity(vorgang, orderPosition.id),
      openQuantity: getBillableOpenQuantity(vorgang, orderPosition.id),
    };
    /*
     * `executedQuantity` ist optional und `undefined` heisst „nicht erfasst".
     * Ein `?? plannedQuantity` wäre genau die stille Behauptung, die
     * INVOICE-ACTUAL-QUANTITY-01B beseitigt hat — der Wert wird deshalb
     * gesetzt **oder entfernt**, nie ersetzt.
     */
    if (orderPosition.executedQuantity === undefined) {
      delete next.executedQuantity;
    } else {
      next.executedQuantity = orderPosition.executedQuantity;
    }

    if (
      next.plannedQuantity === position.plannedQuantity &&
      next.billedQuantity === position.billedQuantity &&
      next.openQuantity === position.openQuantity &&
      next.executedQuantity === position.executedQuantity
    ) {
      return position;
    }

    changed = true;
    return next;
  });

  return changed ? { draft: { ...draft, positions }, changed } : { draft, changed };
}

export function updateDraftPositionQuantity(
  draft: InvoiceDraft,
  positionId: string,
  quantity: number,
): InvoiceDraft {
  return {
    ...draft,
    positions: draft.positions.map((p) => {
      if (p.id !== positionId) return p;
      if (!p.billable) return p;
      /*
       * INVOICE-ACTUAL-MEASURE-VS-PLAN-01B — hier stand bis zuletzt
       * `quantity > p.openQuantity`, und das machte die Planmenge zur harten
       * Obergrenze der Rechnung. Sie ist die Vertragsmenge, nicht das
       * Aufmass: Ein Auftrag über 420 m² kann 1.420 m² abzurechnende Leistung
       * hervorbringen, und eine bereits vollständig abgerechnete Position kann
       * durch zusätzliche Ausführung erneut abrechenbar werden.
       *
       * Übrig bleiben die Bedingungen, die keine fachliche Grenze behaupten,
       * sondern eine Zahl überhaupt erst zu einer machen. Eine bewusste
       * Überschreitung ist kein Fehler, sondern ein Fall für den bestehenden
       * Bestätigungspfad (`getOverbillingWarnings` → „Trotzdem freigeben").
       */
      if (!Number.isFinite(quantity) || quantity < 0) {
        return p;
      }
      return { ...p, quantity };
    }),
  };
}

export function applyAllOpenPositionsToDraft(draft: InvoiceDraft): InvoiceDraft {
  return {
    ...draft,
    positions: draft.positions.map((position) => ({
      ...position,
      /*
       * INVOICE-ACTUAL-QUANTITY-01B — dieselbe Regel wie bei der Vorbelegung:
       * ohne erfasste Ausführung übernimmt der Sammelbutton nichts, statt die
       * Planmenge als abzurechnende Leistung zu behaupten.
       *
       * INVOICE-ACTUAL-MEASURE-VS-PLAN-01B — mit erfasster Ausführung
       * übernimmt er den vollen bekannten Ist-Rest, nicht den am Plan
       * gekappten. Position und `billable` bleiben unangetastet.
       */
      quantity: position.billable ? (getDraftPositionExecutedRemaining(position) ?? 0) : 0,
    })),
  };
}

export function updateInvoiceDraftMetadata(
  draft: InvoiceDraft,
  changes: InvoiceDraftMetadataChanges,
): InvoiceDraft {
  const next: InvoiceDraft = { ...draft };

  if (changes.issueDate !== undefined) next.issueDate = changes.issueDate;
  if (changes.servicePeriodFrom !== undefined) {
    next.servicePeriodFrom = changes.servicePeriodFrom;
  }
  if (changes.servicePeriodTo !== undefined) next.servicePeriodTo = changes.servicePeriodTo;
  /*
   * INVOICE-SERVICE-PERIOD-01B — nur ein ausdrücklich übergebener Wert zählt.
   *
   * Der Setter darf aus einer Datumsänderung **nicht** auf Bestätigung
   * schliessen: Ein späterer Systemvorschlag würde denselben Pfad nutzen und
   * sich damit selbst bestätigen. Die Zustimmung kommt aus der bewussten
   * Oberflächenaktion.
   */
  if (changes.servicePeriodConfirmed !== undefined) {
    next.servicePeriodConfirmed = changes.servicePeriodConfirmed;
  }
  if (changes.paymentDueDate !== undefined) next.paymentDueDate = changes.paymentDueDate;
  if (changes.paymentTermsText !== undefined) next.paymentTermsText = changes.paymentTermsText;
  if (changes.skontoText !== undefined) {
    next.skontoText = changes.skontoText;
    /*
     * INVOICE-SKONTO-PAYMENT-TERMS-CONSISTENCY-01B2 — der Basissatz folgt dem
     * Skonto auch dann, wenn es erst später dazukommt.
     *
     * 01B hat den Widerspruch beim **Aufbau** des Entwurfs behoben. Das reicht
     * für den Firmenstandard, nicht aber für das Vertragsskonto: Der Nutzer
     * nimmt das Angebot des Werkvertrags erst auf der Rechnungsseite an, und
     * `skontoText` wird hier nachgetragen — der Basissatz stand da längst.
     *
     * Deshalb wird er genau dann mitgeführt, wenn sich der Skontotext ändert.
     * Symmetrisch in beide Richtungen: Wer das Angebot wieder ablehnt, bekommt
     * seinen abzugsfreien Satz zurück. Alles andere bleibt unberührt —
     * insbesondere ein selbst formulierter Zahlungstext.
     */
    next.paymentTermsText = reconcilePaymentTermsWithSkonto(
      next.paymentTermsText,
      next.skontoText,
      next.companySnapshot.defaultPaymentDays,
    );
  }
  if (changes.introText !== undefined) next.introText = changes.introText;
  if (changes.closingText !== undefined) next.closingText = changes.closingText;
  if (changes.projectTitle !== undefined) next.vorgangTitle = changes.projectTitle;
  if (changes.projectSite !== undefined) next.baustelle = changes.projectSite;
  if (changes.customerBilling) {
    next.customerBilling = { ...next.customerBilling, ...changes.customerBilling };
  }

  return next;
}

export function calculateInvoiceTotals(draft: InvoiceDraft, setup: CompanySetup): InvoiceTotals {
  const taxRate = getTaxRateForStatus(draft.taxStatus ?? setup.taxStatus);
  let subtotalCents: number;

  if (isFixedAmountAbschlag(draft)) {
    const net = draft.fixedAmountNet;
    subtotalCents =
      net != null && Number.isFinite(net) && net > 0 ? toCents(roundMoney(net)) : 0;
  } else {
    const lineCents = draft.positions
      .filter((p) => p.quantity > 0)
      .map((p) => lineTotalCents(p.quantity, p.unitPrice))
      .filter((cents) => Number.isFinite(cents));
    subtotalCents = sumCents(lineCents);
  }

  const taxCents = taxCentsFromNet(subtotalCents, taxRate);
  const grossCents = subtotalCents + taxCents;
  const deductionsCents = toCents(getAbschlagDeductionsTotal(draft.previousAbschlagDeductions));
  const safeDeductions = Number.isFinite(deductionsCents) ? deductionsCents : 0;
  // Schluss/Abschlag: keep prior clamp so over-deduction does not go negative.
  const amountDueCents = usesAbschlagDeductions(draft.type)
    ? Math.max(0, grossCents - safeDeductions)
    : grossCents - safeDeductions;

  return {
    subtotal: fromCents(subtotalCents),
    taxRate,
    tax: fromCents(taxCents),
    total: fromCents(amountDueCents),
  };
}

export type FinalizeInvoiceResult =
  | { ok: true; invoice: VorgangInvoice }
  | {
      ok: false;
      reason: 'validation_failed' | 'vorgang_missing' | 'save_failed';
      validation?: InvoiceValidationResult;
    };

export type BuildInvoiceFinalizationCandidateResult =
  | { ok: true; invoice: VorgangInvoice }
  | {
      ok: false;
      reason: 'validation_failed' | 'vorgang_missing';
      validation?: InvoiceValidationResult;
    };

function validateDraftForFinalize(
  vorgangId: string,
  draft: InvoiceDraft,
  options: InvoiceApprovalOptions = {},
):
  | { ok: true; vorgang: Vorgang }
  | {
      ok: false;
      reason: 'validation_failed' | 'vorgang_missing';
      validation?: InvoiceValidationResult;
    } {
  const vorgang = getVorgangById(vorgangId);
  if (!vorgang) {
    return { ok: false, reason: 'vorgang_missing' };
  }

  // Full approval validation for Rechnung and fixed-amount Abschlag.
  // Quantity-based Abschlag/Schluss keep prior finalize gate (reverse_charge only),
  // matching historical offline/test finalize behaviour.
  const fixedAbschlag = isFixedAmountAbschlag(draft);
  /*
   * FINAL-INVOICE-OVERPAYMENT-INTEGRITY-01B2 — der Überabrechnungsschutz muss
   * auch dort greifen, wo bisher gar nicht validiert wurde.
   *
   * Eine mengenbasierte Schlussrechnung lief an dieser Prüfung vollständig
   * vorbei. Der neue `deductions_exceed_total` entstand damit zwar in der
   * Validierung — die Oberfläche zeigte ihn auch —, aber `finalizeInvoiceDraft`
   * und `buildInvoiceFinalizationCandidate` sahen ihn nie. Ein Aufruf an der
   * Oberfläche vorbei hätte die 0-EUR-Schlussrechnung weiterhin angelegt.
   *
   * Bewusst **nur dieser eine Code** wird in den historischen Pfad gezogen.
   * Die Baseline zeigt dort andere blockierende Fehler — etwa
   * `company_address` —, die die Finalisierung noch nie verhindert haben. Sie
   * jetzt pauschal scharf zu schalten wäre ein weit grösserer, hier nicht
   * beauftragter Verhaltenswechsel.
   */
  /*
   * INVOICE-SERVICE-PERIOD-01B — die Prüfung läuft jetzt für **jeden**
   * Rechnungstyp, weil der Leistungszeitraum bei allen auf dem Beleg steht.
   * Die frühere Eintrittsbedingung liess mengenbasierte Abschläge und
   * Teilrechnungen ganz an der Prüfung vorbei.
   *
   * Das verbreitert die Fachlogik nicht: Ausserhalb von `rechnung` und
   * pauschalem Abschlag lässt der Filter unten weiterhin nur
   * `reverse_charge_unconfirmed`, `deductions_exceed_total` und die drei
   * Leistungszeitraum-Codes durch. Für die beiden bisher ausgenommenen Typen
   * kommen damit exakt die drei neuen Blocker hinzu — sonst nichts.
   */
  {
    const validation = validateInvoiceDraftForApproval(
      draft,
      draft.companySnapshot,
      vorgang,
      options,
    );
    const blockers =
      draft.type === 'rechnung' || fixedAbschlag
        ? validation.blockingErrors
        : validation.blockingErrors.filter(
            (e) =>
              e.code === 'reverse_charge_unconfirmed' ||
              e.code === 'deductions_exceed_total' ||
              /*
               * INVOICE-SERVICE-PERIOD-01B — der Leistungszeitraum ist eine
               * Tatsachenbehauptung auf dem Beleg und muss auch dort greifen,
               * wo historisch nicht voll validiert wird. Nur diese drei Codes
               * kommen hinzu; die übrigen Approval-Regeln bleiben im
               * mengenbasierten Pfad unverändert wirkungslos.
               */
              e.code === 'service_period' ||
              e.code === 'service_period_unconfirmed' ||
              e.code === 'service_period_order',
          );
    if (blockers.length > 0) {
      return {
        ok: false,
        reason: 'validation_failed',
        validation: { ...validation, blockingErrors: blockers },
      };
    }
  }

  return { ok: true, vorgang };
}

/**
 * Builds a finalized invoice candidate without reserving a local number
 * and without persisting. Used by cloud finalize orchestrator.
 */
export function buildInvoiceFinalizationCandidate(
  vorgangId: string,
  draft: InvoiceDraft,
  setup: CompanySetup,
  clientInvoiceId: string,
  options: InvoiceApprovalOptions = {},
): BuildInvoiceFinalizationCandidateResult {
  const validated = validateDraftForFinalize(vorgangId, draft, options);
  if (!validated.ok) {
    return validated;
  }

  const totals = calculateInvoiceTotals(draft, setup);
  const now = new Date().toISOString();
  const issueDate = draft.issueDate || now.slice(0, 10);
  const fixedAmount = isFixedAmountAbschlag(draft);

  const positions: VorgangInvoiceLine[] = fixedAmount
    ? []
    : draft.positions
        .filter((p) => p.quantity > 0)
        .map((p) => ({
          id: `inv-line-${clientInvoiceId}-${p.orderPositionId}`,
          orderPositionId: p.orderPositionId,
          description: p.description,
          quantity: p.quantity,
          unit: p.unit,
          unitLabel: p.unitLabel,
          unitPrice: roundMoney(p.unitPrice),
          lineTotal: lineTotalMoney(p.quantity, p.unitPrice),
        }));

  const invoice: VorgangInvoice = {
    id: clientInvoiceId,
    number: INVOICE_DRAFT_LABEL,
    type: draft.type,
    abschlagNumber: usesAbschlagNumber(draft.type) ? draft.abschlagNumber : undefined,
    positions,
    calculationMode: fixedAmount
      ? 'fixed_amount'
      : draft.type === 'abschlag'
        ? 'quantity_based'
        : undefined,
    fixedAmountNet: fixedAmount ? roundMoney(draft.fixedAmountNet ?? 0) : undefined,
    subtotal: totals.subtotal,
    taxStatus: draft.taxStatus ?? setup.taxStatus,
    amount: totals.total,
    status: 'vorbereitet',
    paymentStatus: 'offen',
    payments: [],
    date: issueDate,
    createdAt: now,
    issueDate,
    servicePeriodFrom: draft.servicePeriodFrom,
    servicePeriodTo: draft.servicePeriodTo,
    /*
     * FINALIZED-INVOICE-PDF-SERVICE-PERIOD-01B — die Bestätigung wird exakt
     * übernommen, nie abgeleitet. Der Freigabe-Gate oben hat sie bereits
     * erzwungen; hier wird sie nur haltbar gemacht, damit der PDF-Pfad die
     * Entscheidung später nicht erneut erfragen muss. Ein Rückschluss aus
     * `servicePeriodFrom/To`, `issueDate`, Typ oder Status wäre geraten.
     */
    servicePeriodConfirmed: draft.servicePeriodConfirmed,
    paymentDueDate: draft.paymentDueDate,
    paymentTermsText: draft.paymentTermsText,
    skontoText: draft.skontoText,
    customerSnapshot: cloneCustomerBilling(draft.customerBilling),
    companySnapshot: cloneCompanySnapshot(draft.companySnapshot),
    // BRANDING-01F-1: durchreichen, nicht neu bilden — siehe cloneBrandingSnapshot.
    brandingSnapshot: cloneBrandingSnapshot(draft.brandingSnapshot),
    legalNotices: [...draft.legalNotices],
    previousAbschlagDeductions: draft.previousAbschlagDeductions.map((item) => ({ ...item })),
    introText: draft.introText,
    closingText: draft.closingText,
    baustelle: draft.baustelle,
    vorgangTitle: draft.vorgangTitle,
    // Frozen at draft creation for Schluss — never recomputed here (01B2).
    expectedAmendmentSequence:
      draft.type === 'schluss'
        ? draft.expectedAmendmentSequence ?? 0
        : undefined,
  };

  return { ok: true, invoice };
}

/** Stable fingerprint of finalizeable content (excludes number / client id / timestamps). */
export function buildInvoiceFinalizationContentFingerprint(
  draft: InvoiceDraft,
  setup: CompanySetup,
): string {
  const totals = calculateInvoiceTotals(draft, setup);
  return buildInvoiceContentFingerprintPayload({
    type: draft.type,
    abschlagNumber: draft.abschlagNumber ?? null,
    taxStatus: draft.taxStatus ?? setup.taxStatus,
    issueDate: draft.issueDate ?? null,
    servicePeriodFrom: draft.servicePeriodFrom ?? null,
    servicePeriodTo: draft.servicePeriodTo ?? null,
    paymentDueDate: draft.paymentDueDate ?? null,
    paymentTermsText: draft.paymentTermsText ?? '',
    skontoText: draft.skontoText ?? '',
    introText: draft.introText ?? '',
    closingText: draft.closingText ?? '',
    baustelle: draft.baustelle ?? '',
    vorgangTitle: draft.vorgangTitle ?? '',
    customerBilling: draft.customerBilling,
    subtotal: totals.subtotal,
    amount: totals.total,
    calculationMode: resolveInvoiceCalculationMode(draft),
    fixedAmountNet: isFixedAmountAbschlag(draft)
      ? roundMoney(draft.fixedAmountNet ?? 0)
      : null,
    positions: isFixedAmountAbschlag(draft)
      ? []
      : draft.positions
          .filter((p) => p.quantity > 0)
          .map((p) => ({
            // MANUAL-INVOICE-01B1 — dieselbe Kanonisierung wie im Inhalts-Fingerprint.
            orderPositionId: p.orderPositionId ?? null,
            description: p.description,
            quantity: p.quantity,
            unit: p.unit,
            unitLabel: p.unitLabel ?? null,
            unitPrice: roundMoney(p.unitPrice),
            lineTotal: lineTotalMoney(p.quantity, p.unitPrice),
            billable: p.billable,
          })),
  });
}

/**
 * Content fingerprint from a finalized VorgangInvoice (for intent reconciliation on pull).
 * Shape matches buildInvoiceFinalizationContentFingerprint (billable assumed true for lines).
 */
export function buildInvoiceContentFingerprintFromInvoice(invoice: VorgangInvoice): string {
  return buildInvoiceContentFingerprintPayload({
    type: invoice.type,
    abschlagNumber: invoice.abschlagNumber ?? null,
    taxStatus: invoice.taxStatus,
    issueDate: invoice.issueDate ?? null,
    servicePeriodFrom: invoice.servicePeriodFrom ?? null,
    servicePeriodTo: invoice.servicePeriodTo ?? null,
    paymentDueDate: invoice.paymentDueDate ?? null,
    paymentTermsText: invoice.paymentTermsText ?? '',
    skontoText: invoice.skontoText ?? '',
    introText: invoice.introText ?? '',
    closingText: invoice.closingText ?? '',
    baustelle: invoice.baustelle ?? '',
    vorgangTitle: invoice.vorgangTitle ?? '',
    customerBilling: invoice.customerSnapshot ?? {
      name: '',
      contactPerson: '',
      street: '',
      zip: '',
      city: '',
      email: '',
      phone: '',
    },
    subtotal: invoice.subtotal,
    amount: invoice.amount,
    calculationMode: resolveInvoiceCalculationMode(invoice),
    fixedAmountNet: isFixedAmountAbschlag(invoice)
      ? roundMoney(invoice.fixedAmountNet ?? 0)
      : null,
    positions: isFixedAmountAbschlag(invoice)
      ? []
      : (invoice.positions ?? []).map((p) => ({
          // MANUAL-INVOICE-01B1 — siehe `immutableInvoiceFingerprint`: fehlender
          // Auftragsbezug wird ausdrücklich `null`, nie ein fehlender Schlüssel.
          orderPositionId: p.orderPositionId ?? null,
          description: p.description,
          quantity: p.quantity,
          unit: p.unit,
          unitLabel: p.unitLabel ?? null,
          unitPrice: roundMoney(p.unitPrice),
          lineTotal: roundMoney(p.lineTotal),
          billable: true,
        })),
  });
}

function buildInvoiceContentFingerprintPayload(payload: {
  type: InvoiceDocumentType;
  abschlagNumber: number | null;
  taxStatus: TaxStatus;
  issueDate: string | null;
  servicePeriodFrom: string | null;
  servicePeriodTo: string | null;
  paymentDueDate: string | null;
  paymentTermsText: string;
  skontoText: string;
  introText: string;
  closingText: string;
  baustelle: string;
  vorgangTitle: string;
  customerBilling: CustomerBilling;
  subtotal: number;
  amount: number;
  calculationMode: InvoiceCalculationMode;
  fixedAmountNet: number | null;
  positions: Array<{
    /** MANUAL-INVOICE-01B1 — `null` heisst „freie Position", nie fehlender Schlüssel. */
    orderPositionId: string | null;
    description: string;
    quantity: number;
    unit: string;
    unitLabel: string | null;
    unitPrice: number;
    lineTotal: number;
    billable: boolean;
  }>;
}): string {
  return JSON.stringify(payload);
}

/**
 * CONTENT-FINGERPRINT-PARITY-01C — Rückwärtskompatibilität ohne Rekonstruktion.
 *
 * Vor diesem Stand trug der Inhalts-Fingerabdruck `expectedAmendmentSequence`
 * — bei `schluss` als nichtnegative Ganzzahl, sonst als `null`. Der Wert ist
 * ein Concurrency-Guard der Finalisierung; der Server entfernt ihn ausdrücklich
 * aus der gespeicherten Rechnung. Eine aus der Cloud gezogene Schlussrechnung
 * trägt ihn deshalb nie, und dieselbe Rechnung bekam lokal und aus der Cloud
 * zwei verschiedene Abdrücke.
 *
 * Ein zweiter, „alter" Erzeuger könnte das nicht heilen: Aus einer Rechnung
 * ohne das Feld ließe sich nur `0` bilden, nie die tatsächlich gespeicherte
 * `3`. **Die persistierte Zeichenkette ist die einzige Legacy-Quelle** — und
 * weil der Abdruck roher JSON-Text ist, lässt sie sich lesen.
 *
 * Der Ablauf ist bewusst eng:
 *
 *   1. Exakte Gleichheit — der Normalfall, kostet nichts.
 *   2. Sonst parsen; alles, was kein einfaches Objekt ist, gilt als ungültig.
 *   3. Der Legacy-Schlüssel muss als **eigene** Eigenschaft vorhanden sein.
 *      Sonst wäre dies ein Parse-Stringify-Rückfall, der jede beliebige
 *      Formatabweichung tolerieren würde.
 *   4. Der alte Wert muss zu einer Form passen, die der frühere Erzeuger
 *      tatsächlich schreiben konnte — sonst ist der Abdruck nicht von ihm.
 *   5. Genau diesen einen Schlüssel streichen, sonst nichts, und bitgenau
 *      vergleichen.
 *
 * Nichts wird repariert, sortiert, ergänzt oder umgeschrieben; die Funktion ist
 * rein lesend. Bei jedem Zweifel: `false`.
 */
const LEGACY_FINGERPRINT_AMENDMENT_KEY = 'expectedAmendmentSequence';

/** Genau die Rechnungsarten, die der frühere Erzeuger kannte. */
const LEGACY_FINGERPRINT_NULL_AMENDMENT_TYPES = new Set(['rechnung', 'abschlag', 'teilrechnung']);

function isPlainFingerprintObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** War dieser Altwert für diesen Rechnungstyp überhaupt erzeugbar? */
function isProducibleLegacyAmendmentValue(type: unknown, value: unknown): boolean {
  if (type === 'schluss') {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
  }
  if (typeof type === 'string' && LEGACY_FINGERPRINT_NULL_AMENDMENT_TYPES.has(type)) {
    return value === null;
  }
  return false;
}

export function matchesPersistedInvoiceContentFingerprint(
  persisted: string,
  current: string,
): boolean {
  if (persisted === current) return true;

  let parsed: unknown;
  try {
    parsed = JSON.parse(persisted);
  } catch {
    return false;
  }
  if (!isPlainFingerprintObject(parsed)) return false;

  if (!Object.prototype.hasOwnProperty.call(parsed, LEGACY_FINGERPRINT_AMENDMENT_KEY)) {
    return false;
  }
  if (!isProducibleLegacyAmendmentValue(parsed.type, parsed[LEGACY_FINGERPRINT_AMENDMENT_KEY])) {
    return false;
  }

  delete parsed[LEGACY_FINGERPRINT_AMENDMENT_KEY];
  return JSON.stringify(parsed) === current;
}

/**
 * Die Positionen, deren Menge über dem derzeit dokumentierten Rest liegt.
 *
 * INVOICE-ACTUAL-MEASURE-VS-PLAN-01B — eine Stelle für beide Ableitungen,
 * damit der Warntext und der kanonische Nachweis im Freigabepfad nicht
 * auseinanderlaufen können.
 */
function getOverbilledPositions(draft: InvoiceDraft): InvoiceDraftPosition[] {
  return draft.positions.filter((p) => {
    if (!p.billable) return false;
    const reference = getOverbillingReference(p);
    // MANUAL-INVOICE-01B1 — ohne Vergleichsgrundlage gibt es nichts zu warnen.
    if (reference === undefined) return false;
    return p.quantity > reference;
  });
}

export function getOverbillingWarnings(draft: InvoiceDraft): string[] {
  return getOverbilledPositions(draft).map(
    (p) =>
      `${p.description}: ${p.quantity} eingegeben, dokumentierter Rest ${getOverbillingReference(p)} ${p.unit}.`,
  );
}

/**
 * Der kanonische Nachweis derselben Überschreitungen — Rohfelder statt
 * übersetzter Fließtexte, damit der Freigabepfad prüfen kann, dass die
 * Bestätigung genau zu dem gehört, was gewarnt wurde.
 */
export function getOverbillingEvidenceKeys(draft: InvoiceDraft): string[] {
  return getOverbilledPositions(draft).map(
    (position) =>
      `overbilling:${position.id}:${position.orderPositionId}:${position.quantity}:${getOverbillingReference(position)}`,
  );
}

function cloneCustomerBilling(billing: CustomerBilling): CustomerBilling {
  return { ...billing };
}

/**
 * Der eingefrorene Firmenblock der fertigen Rechnung.
 *
 * INVOICE-FINALIZE-BRANDING-CANDIDATE-01B — `branding` wird hier entfernt.
 *
 * Seit BRANDING-01E-2 trägt das `CompanyProfile` einen `branding`-Block, und
 * der Entwurf kopiert das Profil vollständig. Damit geriet das Feld in den
 * Finalisierungskandidaten — und der strenge Request-Validator lehnte ihn mit
 * `request.invoice.companySnapshot.branding:unknown_field` ab, noch bevor
 * überhaupt ein Serveraufruf stattfand.
 *
 * Der Schnitt gehört genau hierher und nicht in den Cloud-Payload: Hier
 * entsteht die **eine** eingefrorene Fassung, die lokal gespeichert **und**
 * übertragen wird. Würde nur der Payload bereinigt, trüge die lokale Rechnung
 * ein Feld, das die Cloudfassung nicht hat — und weil
 * `immutableInvoiceFingerprint` zwar `logoDataUrl`, nicht aber `branding`
 * ausschneidet, entstünde beim nächsten Pull ein `id_content_conflict`.
 *
 * Das historische Branding der Rechnung liegt seit BRANDING-01F-1 in
 * `brandingSnapshot` — versioniert, geprüft und unveränderlich. `branding` im
 * Firmenblock war der Übergangseffekt, den es ablöst.
 *
 * `logoDataUrl` bleibt unangetastet: Es ist die historische Logoquelle aller
 * Rechnungen aus der Zeit davor.
 */
function cloneCompanySnapshot(profile: CompanyProfile): CompanyProfile {
  const { branding: _branding, ...rest } = profile;
  return { ...rest, logoDataUrl: profile.logoDataUrl };
}

/**
 * BRANDING-01F-1 — den bereits eingefrorenen Snapshot durchreichen, ohne
 * Objektreferenzen mit dem Entwurf zu teilen.
 *
 * Ausdrücklich **kein** Neuaufbau aus dem aktuellen Firmenprofil: Ein Entwurf
 * kann Tage vor der Finalisierung entstanden sein. Würde hier neu gebaut, trüge
 * die Rechnung das Branding des Freigabetags statt des Erstellungstags — und
 * ein Entwurf, der zwischenzeitlich mehrfach geladen wurde, könnte sein
 * Aussehen unbemerkt wechseln.
 */
function cloneBrandingSnapshot(snapshot: BrandingSnapshot | undefined): BrandingSnapshot | undefined {
  if (!snapshot) return undefined;
  return {
    version: snapshot.version,
    ...(snapshot.logo
      ? { logo: { assetId: snapshot.logo.assetId, mimeType: snapshot.logo.mimeType } }
      : {}),
    ...(snapshot.primaryColor !== undefined ? { primaryColor: snapshot.primaryColor } : {}),
  };
}

export function finalizeInvoiceDraft(
  vorgangId: string,
  draft: InvoiceDraft,
  setup: CompanySetup,
  options: InvoiceApprovalOptions = {},
): FinalizeInvoiceResult {
  // Legacy local finalize path (tests / offline fallback). UI cloud path must not use this.
  const candidate = buildInvoiceFinalizationCandidate(
    vorgangId,
    draft,
    setup,
    `inv-${Date.now()}`,
    options,
  );
  if (!candidate.ok) {
    return candidate;
  }

  const reservation = reserveNextInvoiceNumber();
  const invoice: VorgangInvoice = {
    ...candidate.invoice,
    number: reservation.formatted,
    invoiceSequenceNumber: reservation.sequenceNumber,
  };

  const saved = addInvoiceToVorgang(vorgangId, invoice);
  if (!saved) {
    return { ok: false, reason: 'save_failed' };
  }

  const archiveResult = archiveOutgoingInvoice(vorgangId, saved, setup.companyName);
  if (archiveResult.success) {
    return { ok: true, invoice: archiveResult.invoice };
  }

  return { ok: true, invoice: saved };
}

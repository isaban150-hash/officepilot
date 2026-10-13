import { lineTotalCents, sumCents, toCents } from './invoiceMoney';
import type {
  MaterialStandard,
  OrderPosition,
  OrderPositionEditableField,
  PositionBillingStatus,
  Vorgang,
  VorgangInvoice,
} from '../types/models';

const COUNTED_STATUSES: VorgangInvoice['status'][] = ['vorbereitet', 'versendet'];

/**
 * FINAL-INVOICE-CANCELLATION-REBILLING-01A — rechnet dieser Beleg noch ab?
 *
 * `status` beschreibt den Weg zum Kunden (Entwurf → vorbereitet → versendet)
 * und wird durch ein Storno ausdrücklich **nicht** verändert; `cancelledAt`
 * kommt als eigenes Feld aus der Cloud zurück und ist dort als
 * „projektionsrelevant" erhalten. Gelesen hat es hier bisher niemand: Eine
 * stornierte Schlussrechnung galt weiterhin als abgerechnet, ihre Mengen
 * blieben verbraucht, und der Vorgang liess keine Ersatzrechnung mehr zu.
 *
 * Dieselbe Stornodefinition wie in `isInvoiceCancelled` des Zahlungsdienstes —
 * bewusst hier wiederholt statt importiert: `invoicePaymentService` hängt über
 * `vorgangService` an diesem Modul, ein Import zurück wäre ein Zyklus.
 *
 * Storniert heisst **nicht** gelöscht. Der Beleg bleibt im Vorgang stehen und
 * nachvollziehbar; er wirkt nur nicht mehr abrechnend.
 */
export function isBillingEffective(invoice: VorgangInvoice): boolean {
  if (invoice.paymentStatus === 'storniert' || invoice.cancelledAt) return false;
  return COUNTED_STATUSES.includes(invoice.status);
}

export function getBilledQuantity(vorgang: Vorgang, orderPositionId: string): number {
  return vorgang.invoices
    .filter(isBillingEffective)
    .flatMap((inv) => inv.positions ?? [])
    .filter((p) => p.orderPositionId === orderPositionId)
    .reduce((sum, p) => sum + p.quantity, 0);
}

/**
 * INVOICE-ACTUAL-MEASURE-VS-PLAN-01B — der **Planrest**: was laut Auftrag noch
 * nicht abgerechnet ist.
 *
 * `max(0, plannedQuantity − billedQuantity)`. Bewusst **ohne** jeden Bezug auf
 * `executedQuantity`: Bis hierher stand hier `Math.min(planned, executed ??
 * planned)`, und diese eine Zeile beantwortete drei verschiedene Fragen
 * gleichzeitig — „was ist laut Auftrag offen?", „was ist nachweislich erbracht
 * und noch nicht berechnet?" und „was darf eingegeben werden?". Sobald das
 * dokumentierte Aufmass über der Planmenge lag, war die zweite Antwort falsch:
 * Ein Auftrag über 50.000 m² mit 51.200 m² erfasster Ausführung liess nach
 * 40.000 m² Teilabrechnung nur noch 10.000 m² zu — die realen 11.200 m² waren
 * nicht abrechenbar.
 *
 * **Dieser Wert ist eine Referenz, keine Obergrenze.** Die Planmenge ist die
 * Vertragsmenge; eine bewusste Rechnungsmenge darf darüber wie darunter
 * liegen, auch erheblich. Für den dokumentierten Ist-Stand gibt es
 * `getExecutedRemainingQuantity`; für die abzurechnende Menge entscheidet
 * allein der Nutzer.
 */
export function getBillableOpenQuantity(vorgang: Vorgang, orderPositionId: string): number {
  const orderPosition = vorgang.orderPositions.find((p) => p.id === orderPositionId);
  if (!orderPosition) return 0;

  return Math.max(0, orderPosition.plannedQuantity - getBilledQuantity(vorgang, orderPositionId));
}

/** Planrest — siehe `getBillableOpenQuantity`. */
export function getOpenQuantity(vorgang: Vorgang, orderPositionId: string): number {
  return getBillableOpenQuantity(vorgang, orderPositionId);
}

/**
 * INVOICE-ACTUAL-MEASURE-VS-PLAN-01B — der **bekannte Ist-Rest**: was
 * nachweislich ausgeführt und noch nicht abgerechnet ist.
 *
 * `undefined` heisst **„Ist-Menge unbekannt"** und ist ausdrücklich nicht
 * dasselbe wie `0`. Nur so bleibt die Regel aus `db2651c` erhalten — ohne
 * erfasste Ausführung wird nichts vorbelegt, statt die Planmenge als Aufmass
 * zu behaupten. Der Rückgabetyp zwingt jeden Aufrufer, diesen Fall zu
 * entscheiden, statt ihn zu übersehen.
 *
 * **Kein Plan-Cap.** Liegt das erfasste Aufmass über der Planmenge, ist genau
 * das die Wahrheit, die abgerechnet werden soll. Auch dieser Wert ist eine
 * Vorschlagsgrundlage und keine Obergrenze: `executedQuantity` ist ein
 * dokumentierter Fortschrittsstand, der veraltet sein kann.
 */
export function getExecutedRemainingQuantity(
  vorgang: Vorgang,
  orderPositionId: string,
): number | undefined {
  const orderPosition = vorgang.orderPositions.find((p) => p.id === orderPositionId);
  if (!orderPosition || orderPosition.executedQuantity === undefined) return undefined;

  return Math.max(0, orderPosition.executedQuantity - getBilledQuantity(vorgang, orderPositionId));
}

export function hasSchlussrechnung(vorgang: Vorgang): boolean {
  return vorgang.invoices.some((inv) => inv.type === 'schluss' && isBillingEffective(inv));
}

export function hasAbschlagsrechnung(vorgang: Vorgang): boolean {
  return vorgang.invoices.some((inv) => inv.type === 'abschlag' && isBillingEffective(inv));
}

/**
 * RECHNUNGSINTEGRITAET-03B2 — ein Abschlag verbraucht **entweder** Menge
 * **oder** Geld, nie beides.
 *
 * Realbefund aus der unabhängigen Abnahme: Ein mengenbasierter Abschlag über
 * eine von zwei Einheiten reduzierte korrekt die offene Menge — und wurde in
 * der Schlussrechnung **zusätzlich** monetär abgezogen. Die Schlussrechnung
 * rechnete danach nur noch die verbleibende Einheit (5 €) ab und zog dieselben
 * 5 € nochmals ab: Restbetrag 0 €, obwohl nur die Hälfte bezahlt war.
 *
 * Die Regel folgt dem bestehenden Hybrid des Modells:
 *   • fixed_amount (und jeder Abschlag ohne Positionsmenge) nimmt keine
 *     Auftragsmenge weg — sein Betrag muss abgezogen werden.
 *   • ein mengenbasierter Abschlag hat seine Leistung bereits über
 *     `billedQuantity` verbraucht; sie fehlt in den Positionen der
 *     Schlussrechnung und darf nicht ein zweites Mal als Geld verschwinden.
 *
 * Geprüft wird die tatsächlich verbrauchte Menge, nicht allein der Modus:
 * Altbestand ohne `calculationMode` ist dadurch richtig eingeordnet.
 *
 * FINANZ-CORE-01A (RE-04) — hierher verschoben, damit auch die Validierung die
 * Regel lesen kann; `invoiceService` exportiert sie unverändert weiter.
 */
export function abschlagConsumesOrderQuantity(invoice: VorgangInvoice): boolean {
  if (invoice.calculationMode === 'fixed_amount') return false;
  return (invoice.positions ?? []).some(
    (position) => Number.isFinite(position.quantity) && position.quantity > 0,
  );
}

/**
 * FINANZ-CORE-01A (RE-04) — steht ein wirksamer Abschlag offen, den erst die
 * Schlussrechnung abzieht? Pauschal oder ohne Positionsmenge — dieselbe
 * Abgrenzung wie `getPreviousAbschlagDeductions` und der Server
 * (`workspace_invoice_abschlag_deductions`).
 */
export function hasDeductibleAbschlag(vorgang: Vorgang): boolean {
  return (vorgang.invoices ?? []).some(
    (invoice) =>
      invoice.type === 'abschlag' && isBillingEffective(invoice) && !abschlagConsumesOrderQuantity(invoice),
  );
}

export function hasFinalSchlussrechnung(vorgang: Vorgang): boolean {
  return hasSchlussrechnung(vorgang);
}

/**
 * INVOICE-ACTUAL-MEASURE-VS-PLAN-01B4 — ist an dieser Position noch etwas
 * abzurechnen?
 *
 * **Planrest ODER bekannter Ist-Rest.** Die beiden Größen beantworten
 * verschiedene Teile derselben Frage, und keine ersetzt die andere: Der
 * Planrest kennt den Vertrag, aber nicht die Baustelle; der Ist-Rest kennt die
 * Baustelle, aber nicht den Vertrag.
 *
 * Eine frühere Fassung schrieb `executedRemaining ?? plannedRemaining`. Das
 * `??` prüft auf `undefined`, nicht auf Aussagekraft — sobald ein Aufmass
 * erfasst war, **auch die 0**, verschwand der Vertrag aus der Rechnung. Ein
 * Auftrag über 50.000 mit 10.000 erfassten und 10.000 abgerechneten Einheiten
 * galt damit als erledigt, und OfficePilot riet bei 20 % Baufortschritt zur
 * Schlussrechnung.
 */
export function isPositionStillOpen(vorgang: Vorgang, orderPositionId: string): boolean {
  const plannedRemaining = getBillableOpenQuantity(vorgang, orderPositionId);
  const executedRemaining = getExecutedRemainingQuantity(vorgang, orderPositionId);

  return plannedRemaining > 0 || (executedRemaining ?? 0) > 0;
}

export function getPositionBillingStatus(
  vorgang: Vorgang,
  orderPositionId: string,
): PositionBillingStatus | null {
  const orderPosition = vorgang.orderPositions.find((p) => p.id === orderPositionId);
  if (!orderPosition) return null;

  const billedQuantity = getBilledQuantity(vorgang, orderPositionId);
  const openQuantity = getBillableOpenQuantity(vorgang, orderPositionId);

  return {
    orderPositionId,
    billedQuantity,
    openQuantity,
    plannedQuantity: orderPosition.plannedQuantity,
    hasBilling: billedQuantity > 0,
    /*
     * INVOICE-ACTUAL-MEASURE-VS-PLAN-01B4 — „vollständig abgerechnet" ist eine
     * Aussage über die Position, nicht über den Vertrag. Die Aufrufer
     * (Brain-Hinweise, Workflow-Abschlusslogik) lesen dieses Feld als „hier ist
     * nichts mehr zu tun" und raten daraufhin zur Schlussrechnung.
     *
     * Zwei einfachere Fassungen sind daran gescheitert:
     *
     *   - `billed >= planned` hielt Plan 50.000 / erfasst 51.200 / abgerechnet
     *     50.000 für erledigt und unterschlug 1.200 dokumentierte Einheiten.
     *   - `billed >= (executed ?? planned)` hielt Plan 50.000 / erfasst 10.000 /
     *     abgerechnet 10.000 für erledigt — also jede laufende Baustelle, deren
     *     Fortschritt gepflegt und fakturiert wird.
     *
     * Erledigt ist deshalb nur, was **nach beiden Maßstäben** erledigt ist.
     * Das ist die exakte Negation von `isPositionStillOpen`, damit die
     * Statusaussage und die Offen-Frage nicht wieder auseinanderlaufen.
     *
     * Bewusst konservativ: Ist laut Plan noch etwas offen, gilt die Position
     * auch dann nicht als abgeschlossen, wenn der erfasste Stand vollständig
     * fakturiert ist — es gibt kein Feld, das ein Aufmass als **endgültig**
     * ausweist, und `executedQuantity` ist ein Fortschrittsstand. Der Nutzer
     * kann die Schlussrechnung jederzeit selbst erstellen; OfficePilot
     * behauptet den Abschluss nur nicht von sich aus.
     */
    isFullyBilled: !isPositionStillOpen(vorgang, orderPositionId),
  };
}

/**
 * FIXED-AMOUNT-BILLING-INVARIANT-01B2 — der aktuell abrechenbare
 * Netto-Auftragswert in Cent.
 *
 * **Nicht dasselbe wie der sichtbare Vertrags-/Auftragswert.** Stellt der
 * Auftraggeber das Material, ist diese Position nicht abrechenbar und zählt
 * hier nicht mit (`isPositionBillable`). Gemessener Beispielfall: 10.010,00 €
 * Vertragswert, davon 2.400,00 € AG-Material — abrechenbar sind 7.610,00 €.
 * Die bestehenden Auftragsanzeigen bleiben deshalb bewusst unverändert.
 *
 * `plannedQuantity`, **nicht** `executedQuantity`: Ein Abschlag darf sich nur
 * an der zum Erstellungszeitpunkt gültigen Planbasis orientieren. Spätere
 * Minderleistung ist Sache des Schlussrechnungs-Guards `deductions_exceed_total`.
 *
 * Bestätigte Nachträge verändern `orderPositions` selbst und erhöhen den Wert
 * damit ohne Sonderfall.
 */
export function getCurrentBillableOrderNetCents(vorgang: Vorgang): number {
  return sumCents(
    /*
     * `?? []` folgt der Konvention desselben Finalisierungsbereichs
     * (`invoiceFinalizationCoordinator`, `intakeWorkflowService` u. a.):
     * Alt-, Import- und Cloud-Daten können die Arrays verlieren, obwohl der
     * Typ sie fordert. Ohne diesen Schutz brach die Finalisierung mit einem
     * TypeError ab, statt fachlich zu entscheiden — und ein fehlender
     * Auftragsbestand ergibt hier 0, sperrt also **strenger**, statt einen
     * Pauschalabschlag durchzulassen.
     */
    (vorgang.orderPositions ?? [])
      .filter((position) => isPositionBillable(position, vorgang.materialSource))
      .map((position) => lineTotalCents(position.plannedQuantity, position.unitPrice))
      .filter((cents) => Number.isFinite(cents)),
  );
}

/**
 * FINANZ-CORE-01A (RE-04) — Belegarten, die vor der Schlussrechnung Leistung
 * abrechnen. Die Schlussrechnung selbst fehlt bewusst: Nach ihr entsteht kein
 * weiterer Beleg mehr (SQL-04).
 */
const PRE_FINAL_BILLING_TYPES: VorgangInvoice['type'][] = ['abschlag', 'rechnung', 'teilrechnung'];

/**
 * FINANZ-CORE-01A (RE-04) — Netto-Summe aller wirksam abrechnenden Belege vor
 * der Schlussrechnung, in Cent: Abschläge, Rechnungen und Teilrechnungen.
 * Server: dieselbe Summe in `assert_workspace_invoice_integrity`.
 */
export function getPreFinalBilledNetCents(vorgang: Vorgang): number {
  return sumCents(
    (vorgang.invoices ?? [])
      .filter((invoice) => PRE_FINAL_BILLING_TYPES.includes(invoice.type) && isBillingEffective(invoice))
      .map((invoice) => toCents(invoice.subtotal))
      .filter((cents) => Number.isFinite(cents)),
  );
}

/** Netto-Summe der bereits gezählten Abschlagsrechnungen, in Cent. */
export function getCountedAbschlagNetCents(vorgang: Vorgang): number {
  return sumCents(
    // `?? []` wie oben. Fehlen die Rechnungen, sind 0 € abgezogen — die
    // Auftragsbasis bleibt davon unberührt und begrenzt weiterhin allein.
    (vorgang.invoices ?? [])
      .filter((invoice) => invoice.type === 'abschlag' && isBillingEffective(invoice))
      // `subtotal` ist netto. `amount` wäre brutto und würde den Maßstab brechen.
      .map((invoice) => toCents(invoice.subtotal))
      .filter((cents) => Number.isFinite(cents)),
  );
}

/**
 * Noch pauschal abrechenbarer Nettobetrag in Cent.
 *
 * **Bewusst ohne `Math.max(0, …)`**: Ist ein Vorgang bereits überzogen, muss
 * die Validierung den negativen Zustand sehen — sonst liesse ein Clamp jeden
 * weiteren Abschlag als „passend" durch. Für die Anzeige darf der Aufrufer
 * selbst bei 0 abschneiden.
 */
export function getRemainingFixedAmountBillableNetCents(vorgang: Vorgang): number {
  /*
   * FINANZ-CORE-01A (RE-04) — gegen alles bereits Abgerechnete, nicht nur
   * gegen Abschläge. Nach einer Teilrechnung über 8.000 € eines 10.000-€-
   * Auftrags liess die alte Grenze noch einen Pauschalabschlag über 10.000 €
   * zu; die Schlussrechnung scheiterte danach an `deductions_exceed_total`.
   */
  return getCurrentBillableOrderNetCents(vorgang) - getPreFinalBilledNetCents(vorgang);
}

export function canAddOrderPosition(vorgang: Vorgang): boolean {
  return !hasFinalSchlussrechnung(vorgang);
}

export function canDeleteOrderPosition(vorgang: Vorgang, orderPositionId: string): boolean {
  if (hasFinalSchlussrechnung(vorgang)) return false;
  return getBilledQuantity(vorgang, orderPositionId) === 0;
}

export function canEditOrderPositionField(
  vorgang: Vorgang,
  orderPositionId: string,
  field: OrderPositionEditableField,
): boolean {
  if (hasFinalSchlussrechnung(vorgang)) return false;

  const billedQuantity = getBilledQuantity(vorgang, orderPositionId);

  if (billedQuantity === 0) {
    return true;
  }

  if (field === 'description' || field === 'plannedQuantity') {
    return true;
  }

  return false;
}

/**
 * FINAL-INVOICE-CANCELLATION-REBILLING-01A — hier bleibt es bewusst beim reinen
 * Status: Eine stornierte Abschlagsrechnung hat ihre Nummer verbraucht. Sie
 * wieder freizugeben hiesse, zwei Belege mit derselben Abschlagsnummer zu
 * führen. Storniert wirkt nicht mehr abrechnend — vergeben bleibt vergeben.
 */
export function getNextAbschlagNumber(vorgang: Vorgang): number {
  const numbers = vorgang.invoices
    .filter(
      (inv) =>
        inv.type === 'abschlag' &&
        COUNTED_STATUSES.includes(inv.status) &&
        typeof inv.abschlagNumber === 'number',
    )
    .map((inv) => inv.abschlagNumber as number);

  return numbers.length === 0 ? 1 : Math.max(...numbers) + 1;
}

export function isPositionBillable(
  position: OrderPosition,
  materialSource: MaterialStandard,
): boolean {
  if (position.category !== 'material') return true;

  switch (materialSource) {
    case 'auftraggeber':
      return false;
    case 'betrieb':
      return true;
    case 'gemischt':
      return position.billable ?? true;
    case 'unclear':
    default:
      return true;
  }
}

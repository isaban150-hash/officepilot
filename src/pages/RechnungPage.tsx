import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { InvoiceDocumentView } from '../components/invoice/InvoiceDocumentView';
import { InvoiceDraftEditForm } from '../components/invoice/InvoiceDraftEditForm';
import { Button } from '../components/ui/Button';
import { Card, DataRow, PageHeader } from '../components/ui/Card';
import { EmptyStateBlock } from '../components/ui/EmptyStateBlock';
import { NumericInput } from '../components/ui/NumericInput';
import { useApp } from '../context/AppContext';
import {
  applyAllOpenPositionsToDraft,
  buildInvoiceDraftForType,
  calculateInvoiceTotals,
  getOverbillingWarnings,
  isFixedAmountAbschlag,
  resolveInvoiceCalculationMode,
  setAbschlagDraftCalculationMode,
  updateDraftPositionQuantity,
  updateInvoiceDraftFixedAmountNet,
  updateInvoiceDraftMetadata,
  updateInvoiceDraftTaxStatus,
  validateInvoiceDraftForApproval,
} from '../services/invoiceService';
import { getCompanyProfile } from '../services/companyProfileService';
import { loadInvoiceDraftRecordByLocator } from '../services/invoice/invoiceDraftDurabilityService';
import {
  applyCriticalCompanyProfileFields,
  buildCriticalCompanyFingerprint,
  findCriticalCompanyProfileDrift,
  type CriticalCompanyField,
} from '../services/invoice/companySnapshotDriftService';
import { getRemainingFixedAmountBillableNetCents } from '../services/orderBillingRules';
import {
  useInvoiceDraftDurabilitySession,
  type InvoiceDraftSessionStatus,
} from '../services/invoice/useInvoiceDraftDurabilitySession';
import {
  resumeInvoiceDraftFinalization,
  startInvoiceDraftFinalization,
} from '../services/invoice/invoiceFinalizationCoordinator';
import { buildDocumentBlobScopeKey } from '../services/storage/documentBlobScopeService';
import { getActiveStorageScope } from '../services/storage/storageScopeService';
import { buildPersistedStateSnapshot } from '../services/persistenceService';
import { resolveCloudWorkspaceId } from '../services/workspace/workspaceSyncPayloadService';
import { buildInvoicePrintModel } from '../services/invoicePrintModel';
import { buildSkontoText } from '../services/invoiceTaxService';
/* INVOICE-WIZARD-FULL-SAFE-RESUME-01B — sichere Bedienzustände nach Neuaufbau. */
import { useUiSessionRestore } from '../hooks/useUiSessionRestore';
import { useReportUiSession } from '../hooks/useReportUiSession';
import { applyMainScrollTop } from '../services/uiSession/uiSessionCapture';
import {
  buildInvoiceWizardResumeValues,
  readInvoiceWizardContractSkontoChoice,
} from '../services/uiSession/invoiceWizardResume';
import {
  CONTRACT_ORDER_INVOICE_TYPES,
  getInvoiceDocumentTitle,
  parseInvoiceDocumentType,
} from '../services/invoiceTypeService';
import {
  analyzeContractIntelligenceFromInbox,
  getContractSkontoOfferForVorgang,
} from '../services/contractIntelligenceService';
import { getInboxItemById } from '../services/inboxService';
import { billingFromCustomer } from '../services/customerService';
import { getCustomerById } from '../services/customerStoreService';
import { getVorgangById } from '../services/vorgangService';
import type {
  CompanyProfile,
  InvoiceCalculationMode,
  InvoiceDraft,
  InvoiceDraftMetadataChanges,
  InvoiceDocumentType,
  TaxStatus,
} from '../types/models';
import type {
  InvoiceDraftLocator,
  InvoiceDraftRecord,
} from '../types/invoiceDraftDurability';
import { selectHistoricalInvoiceLogo } from '../services/invoice/invoiceHistoricalLogo';
import {
  clearReverseChargeConfirmation,
  hasValidReverseChargeConfirmation,
  writeReverseChargeConfirmation,
  type ReverseChargeConfirmationContext,
} from '../services/invoice/reverseChargeConfirmationService';
import type { InvoiceFinalizationRecovery } from '../services/invoice/invoiceFinalizationCoordinator';
import type { TranslationKey } from '../i18n';

type RechnungStep = 'positions' | 'preview' | 'edit';

/**
 * MOBILE-RESUME-STATE-01B — der Rechnungsschritt lebt in der Adresse.
 *
 * Auf dem Telefon verwirft das Betriebssystem den Safari-Tab, sobald der
 * Nutzer die App wechselt. Der Entwurf überlebt das (IndexedDB), der Schritt
 * lag bis hierher ausschliesslich in `useState` — wer aus der Vorschau
 * zurückkam, landete wieder bei den Positionen.
 *
 * Der Schritt steht deshalb jetzt als Suchparameter in der Route: nichts
 * zusätzlich zu speichern, nichts, das veralten kann, und er wirkt bei einem
 * echten Neuaufbau ebenso wie bei einer Rückkehr aus dem Seitencache.
 *
 * Er ist **niemals eine Berechtigung**. Was aus der Adresse kommt, wird
 * geprüft, nicht geglaubt — siehe `resolveResumableStep`.
 */
const STEP_PARAM = 'step';

function isRechnungStep(value: string | null): value is RechnungStep {
  return value === 'positions' || value === 'preview' || value === 'edit';
}

/**
 * CONTRACT-SKONTO-DUE-DATE-CONSISTENCY-01B — Kalendertage zwischen zwei reinen
 * Datumsangaben.
 *
 * Bewusst über `Date.UTC`: Beide Werte sind Datumsangaben ohne Uhrzeit. Würde
 * man sie lokal parsen und mit `getDate`/`setDate` rechnen, hinge das Ergebnis
 * an Zeitzone und Sommerzeit — westlich von UTC käme ein Tag zu wenig heraus.
 * Zwei UTC-Mitternachten lassen sich dagegen exakt subtrahieren.
 *
 * `null` heisst „nicht bestimmbar". Der Aufrufer rät dann **nicht**, sondern
 * unterlässt die Übernahme; die Prüfung ungültiger Rechnungsdaten bleibt Sache
 * der bestehenden Freigabevalidierung.
 */
export function calendarDaysBetween(fromIso: string, toIso: string): number | null {
  const from = parseIsoDateUtc(fromIso);
  const to = parseIsoDateUtc(toIso);
  if (from === null || to === null) return null;
  return Math.round((to - from) / 86_400_000);
}

function parseIsoDateUtc(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value?.trim() ?? '');
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const stamp = Date.UTC(year, month - 1, day);
  return Number.isFinite(stamp) ? stamp : null;
}

/**
 * INVOICE-TAX-FLOW-01B/01D — die eine Steuerregel, jetzt an einer Stelle.
 *
 * Sie entscheidet, ob die Steuerentscheidung abgeschlossen ist: `unclear` ist
 * es nie, §13b erst nach ausdrücklicher Bestätigung. Dieselbe Funktion sperrt
 * den Weg zur Vorschau und entscheidet über eine Wiederaufnahme — es gibt
 * bewusst keine zweite, abweichende Regel.
 */
function taxDecisionBlocker(
  taxStatus: TaxStatus,
  reverseCharge13bConfirmed: boolean,
): TranslationKey | null {
  if (taxStatus === 'unclear') return 'invoice.validation.taxStatus';
  if (taxStatus === 'reverse_charge_13b' && !reverseCharge13bConfirmed) {
    return 'invoice.validation.reverseChargeConfirmRequired';
  }
  return null;
}

/**
 * Der Ladezustand der dauerhaften Sitzung ist belastbar entschieden.
 *
 * Der Entwurf kommt asynchron aus IndexedDB. Solange das läuft, darf ein
 * `step=preview` aus der Adresse **nicht** verworfen werden — sonst würde
 * jede Wiederaufnahme am ersten Render scheitern. Gewartet wird auf einen
 * Zustand, nicht auf eine Zeitspanne.
 */
function isHydrationSettled(status: InvoiceDraftSessionStatus): boolean {
  return status !== 'idle' && status !== 'loading' && status !== 'creating';
}

/**
 * Welcher Schritt darf nach einem Neuaufbau tatsächlich wiederhergestellt werden?
 *
 * Ohne geladenen Entwurf gar keiner. `preview` nur, wenn die Steuerentscheidung
 * abgeschlossen ist — nach einem Neuaufbau ist `reverseCharge13bConfirmed`
 * wieder `false`, eine §13b-Rechnung fällt damit zwingend auf `positions`
 * zurück und muss erneut bestätigt werden. `edit` nur, solange keine
 * Finalisierung läuft oder abgeschlossen ist.
 */
function resolveResumableStep(input: {
  requested: RechnungStep | null;
  hasDraft: boolean;
  taxDecisionSettled: boolean;
  finalizationLocked: boolean;
}): RechnungStep {
  const { requested, hasDraft, taxDecisionSettled, finalizationLocked } = input;
  if (!requested || requested === 'positions' || !hasDraft) return 'positions';
  if (requested === 'preview') return taxDecisionSettled ? 'preview' : 'positions';
  return taxDecisionSettled && !finalizationLocked ? 'edit' : 'positions';
}

/*
 * Beide Werte müssen exakt so entstehen wie im Preflight des Coordinators —
 * eine abweichende Ableitung führte dort zu `scope_mismatch`.
 */
function resolveActiveScopeKey(): string {
  try {
    return buildDocumentBlobScopeKey(getActiveStorageScope());
  } catch {
    return '';
  }
}

function resolveActiveWorkspaceId(): string {
  try {
    return resolveCloudWorkspaceId(buildPersistedStateSnapshot()).trim();
  } catch {
    return '';
  }
}

/*
 * INVOICE-TAX-FLOW-01B — eine einzige Optionsliste für beide Schritte.
 *
 * `unclear` steht jetzt mit in der Liste: Der Ersteinrichtungs-Assistent kann
 * diesen Wert setzen, und ohne Eintrag liesse sich der Zustand in der Rechnung
 * weder erkennen noch bewusst wieder herstellen. Er führt nicht weiter — siehe
 * `taxDecisionBlockKey`.
 */
const TAX_OPTIONS: TaxStatus[] = [
  'standard_19',
  'standard_7',
  'kleinunternehmer_19',
  'reverse_charge_13b',
  'tax_free',
  'unclear',
];

export function RechnungPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { translate, showToast, setup } = useApp();
  const navigate = useNavigate();
  const invoiceType = parseInvoiceDocumentType(searchParams.get('type'));

  const [step, setStep] = useState<RechnungStep>('positions');
  const [showOverbillingConfirm, setShowOverbillingConfirm] = useState(false);
  /* COMPANY-PROFILE-DRAFT-DRIFT-01E — Rückfrage und der bestätigte Profilstand. */
  const [showCompanyDriftConfirm, setShowCompanyDriftConfirm] = useState(false);
  const [companyDriftFields, setCompanyDriftFields] = useState<CriticalCompanyField[]>([]);
  /*
   * COMPANY-PROFILE-DRAFT-DRIFT-01F — der Stand, den die Rückfrage zeigt, ist
   * genau der, den „Übernehmen" schreibt. Deshalb wird er beim Öffnen der
   * Karte festgehalten und nicht später erneut gelesen.
   */
  const [companyDriftProfile, setCompanyDriftProfile] = useState<CompanyProfile | null>(null);
  const [acknowledgedCompanyFingerprint, setAcknowledgedCompanyFingerprint] = useState<string | null>(
    null,
  );
  const [applyContractSkonto, setApplyContractSkonto] = useState(false);
  /*
   * Reiner Darstellungszustand: „Der Nutzer hat die Übernahme versucht."
   * Nichts davon geht in den Entwurf, in die Cloud oder in die Wiederaufnahme.
   */
  const [contractSkontoAttemptBlocked, setContractSkontoAttemptBlocked] = useState(false);
  const [reverseCharge13bConfirmed, setReverseCharge13bConfirmed] = useState(false);
  /**
   * INVOICE-MOBILE-RESUME-01B2 — der Entwurfsstand, **für den** §13b bestätigt
   * wurde.
   *
   * Ohne ihn galt die Bindung an `draftSha256` nur über einen Neuaufbau
   * hinweg: Wer bestätigte, danach eine Menge änderte und ohne Zwischenschritt
   * freigab, trug eine Bestätigung weiter, die zu einem anderen Rechnungsstand
   * gehörte. Der Freigabe-Validator sieht nur `true`, nicht wofür.
   */
  const [confirmedDraftSha256, setConfirmedDraftSha256] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [customerMasterConfirm, setCustomerMasterConfirm] = useState(false);
  const [customerMasterError, setCustomerMasterError] = useState<string | null>(null);
  /**
   * INVOICE-QUANTITY-INPUT-UX-01B — je Position, adressiert nach `pos.id`.
   *
   * INVOICE-ACTUAL-MEASURE-VS-PLAN-01B — nur noch `'incomplete'`: Eine
   * Planüberschreitung ist keine ungültige Eingabe mehr, sondern ein Fall für
   * den Bestätigungspfad.
   */
  const [quantityBlocked, setQuantityBlocked] = useState<Record<string, 'incomplete'>>({});
  const [validationErrors, setValidationErrors] = useState<TranslationKey[]>([]);
  const [validationWarnings, setValidationWarnings] = useState<TranslationKey[]>([]);
  /*
   * INVOICE-WIZARD-FULL-SAFE-RESUME-01B — der Schnappschuss der letzten Sitzung.
   *
   * Er wird genau einmal beim Mount entnommen; der Wiederaufnahme-Host hat ihn
   * bereits während seines Renderns bereitgestellt. Die Scrollposition wendet
   * diese Seite selbst an — erst wenn der Entwurf steht, sonst träfe sie eine
   * noch kurze Seite.
   */
  const restoredSession = useUiSessionRestore({ deferScroll: true });
  /*
   * Der Wächter gegen Schreiben-vor-Wiederherstellen: Solange dieser Wert
   * `false` ist, darf kein Effekt aus `applyContractSkonto` Entwurfswerte
   * ableiten. Ohne ihn deutete der Ausgangswert `false` beim Neuaufbau als
   * frische Ablehnung und überschrieb den gespeicherten Skontotext.
   */
  const [contractChoiceRestored, setContractChoiceRestored] = useState(false);
  const approveLockRef = useRef(false);

  const vorgang = id ? getVorgangById(id) : undefined;
  const contractSkontoOffer = useMemo(
    () => (vorgang ? getContractSkontoOfferForVorgang(vorgang) : null),
    [vorgang],
  );
  const progressBillingAllowed = useMemo(() => {
    if (!vorgang?.createdFromInboxId) return false;
    const item = getInboxItemById(vorgang.createdFromInboxId);
    if (!item) return false;
    const intelligence = analyzeContractIntelligenceFromInbox(item);
    return intelligence?.progressBillingAllowed ?? false;
  }, [vorgang]);

  /*
   * INVOICE-DURABILITY-PRODUCTION-WIRING-01B — der Entwurf lebt nicht mehr im
   * React-Zustand, sondern in der dauerhaften Sitzung. Der Locator entsteht
   * aus aktivem Scope, Workspace, Vorgang und Rechnungsart; fehlt eines davon,
   * meldet die Sitzung `blocked_no_identity` und es wird nichts gespeichert.
   */
  const locator = useMemo<InvoiceDraftLocator | null>(() => {
    if (!id) return null;
    const sourceScopeKey = resolveActiveScopeKey();
    const workspaceId = resolveActiveWorkspaceId();
    if (!sourceScopeKey || !workspaceId) return null;
    return { sourceScopeKey, workspaceId, vorgangId: id, invoiceType };
  }, [id, invoiceType]);

  /*
   * Der Aufbau hängt bewusst **nicht** am Setup: ein Profilwechsel darf einen
   * bereits gespeicherten Entwurf nicht still neu erzeugen. `createDraft` wird
   * nur aufgerufen, wenn noch kein Datensatz existiert.
   */
  const setupRef = useRef(setup);
  setupRef.current = setup;
  const createDraft = useCallback(
    () => (id ? buildInvoiceDraftForType(id, setupRef.current, invoiceType) : null),
    [id, invoiceType],
  );

  const session = useInvoiceDraftDurabilitySession({ locator, createDraft });
  const draft = session.draft;
  const sessionStatus = session.status;
  const mutateDraft = session.mutateDraft;

  /*
   * MOBILE-RESUME-STATE-01B — echter Wechsel, nicht Neuaufbau.
   *
   * Beim Wechsel von Vorgang oder Rechnungsart muss alles zurückgesetzt werden:
   * Eine andere Rechnung darf keine Bestätigung und kein Prüfergebnis der
   * vorherigen erben. Beim **ersten** Lauf — also bei Neuaufbau derselben
   * Route nach einem verworfenen Tab — darf derselbe Effekt den Schritt aus der
   * Adresse nicht überschreiben.
   *
   * Unterschieden wird an der zuletzt gesehenen Identität, nicht an einem
   * Zeitfenster.
   */
  const seenIdentityRef = useRef<string | null>(null);
  /*
   * Bewusst Zustand und kein Ref: Das Anwenden der Wiederaufnahme muss einen
   * Renderdurchlauf auslösen, sonst läuft die Normalisierung der Adresse nie an
   * — etwa wenn der geprüfte Schritt derselbe ist wie der Ausgangsschritt und
   * `setStep` deshalb nichts ändert.
   */
  const [resumeApplied, setResumeApplied] = useState(false);
  useEffect(() => {
    const identity = `${id ?? ''}#${invoiceType}`;
    const isInitialMount = seenIdentityRef.current === null;
    seenIdentityRef.current = identity;
    if (isInitialMount) return;

    // Die neue Rechnung entscheidet ihre Wiederaufnahme selbst.
    setResumeApplied(false);
    setStep('positions');
    setApplyContractSkonto(false);
    setReverseCharge13bConfirmed(false);
    setConfirmedDraftSha256(null);
    setValidationErrors([]);
    setValidationWarnings([]);
    // INVOICE-QUANTITY-INPUT-UX-01B — kein Mengenfehler der alten Rechnung
    // darf die neue blockieren.
    setQuantityBlocked({});
    approveLockRef.current = false;
    setApproving(false);
    setCustomerMasterConfirm(false);
    setCustomerMasterError(null);
  }, [id, invoiceType]);

  /*
   * SKONTO-INVOICE-TEXT-01B — die Vertragsauswahl schreibt nur noch, wenn sie
   * sich tatsächlich ändert.
   *
   * Bis hierher lief dieser Effekt bei **jeder** Entwurfsänderung und setzte
   * `skontoText` auf den Vertragstext oder auf den Leerstring. Zwei Folgen:
   * Ein von Hand eingetragener Satz wurde beim nächsten Render gelöscht, und
   * mit dem neuen Firmenstandard aus der Entwurfserzeugung wäre dieser sofort
   * wieder verschwunden.
   *
   * Jetzt gilt: Ohne Vertragsangebot fasst der Effekt den Entwurf überhaupt
   * nicht an. Mit Angebot wirkt er genau beim Umschalten — angenommen ergibt
   * den Vertragstext, abgelehnt den Firmenstandard **dieses** Entwurfs, nicht
   * den Leerstring.
   *
   * Der Firmenstandard stammt dabei aus `draft.companySnapshot`, also aus dem
   * beim Aufbau eingefrorenen Profil. Eine spätere Änderung der Firmendaten
   * verschiebt den Rückfallwert deshalb nicht — dafür braucht es kein neues
   * Feld und keinen Herkunftsvermerk.
   */
  const lastContractChoiceRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (!draft || session.readOnly || !contractSkontoOffer) return;
    // FULL-SAFE-RESUME-01B — erst wiederherstellen, dann schreiben.
    if (!contractChoiceRestored) return;
    if (lastContractChoiceRef.current === applyContractSkonto) return;

    /*
     * CONTRACT-SKONTO-DUE-DATE-CONSISTENCY-01B — ein Vertragsskonto, das länger
     * läuft als das Zahlungsziel dieser Rechnung, wird nicht übernommen.
     *
     * Verglichen wird gegen das **tatsächliche** Ziel des Entwurfs, also gegen
     * `paymentDueDate` minus `issueDate` — nicht gegen den eingefrorenen
     * Firmenwert. Wer das Fälligkeitsdatum bereits geändert hat, soll an seiner
     * eigenen Rechnung gemessen werden, nicht an einer Einstellung.
     *
     * Blockiert wird nur der Übernahmeversuch. Zahlungsziel, Angebot und ein
     * bereits vorhandener Skontotext bleiben unangetastet; OfficePilot
     * entscheidet nicht, welche der beiden Konditionen gewinnt.
     */
    if (applyContractSkonto) {
      const dueDays = calendarDaysBetween(draft.issueDate, draft.paymentDueDate);
      if (dueDays === null || contractSkontoOffer.days > dueDays) {
        /*
         * Der Wächter wird auf `false` gesetzt, **bevor** die Auswahl
         * zurückgenommen wird. Dadurch steigt der folgende Effektlauf gleich am
         * Identitätsvergleich aus und schreibt nichts — der vorhandene Text
         * überlebt den gescheiterten Versuch unverändert.
         */
        lastContractChoiceRef.current = false;
        setApplyContractSkonto(false);
        setContractSkontoAttemptBlocked(true);
        return;
      }
    }

    lastContractChoiceRef.current = applyContractSkonto;
    setContractSkontoAttemptBlocked(false);

    const skontoText = applyContractSkonto
      ? contractSkontoOffer.text
      : draft.companySnapshot
        ? buildSkontoText(draft.companySnapshot)
        : '';
    if (draft.skontoText === skontoText) return;
    mutateDraft((prev) =>
      prev.skontoText === skontoText ? prev : updateInvoiceDraftMetadata(prev, { skontoText }),
    );
  }, [
    applyContractSkonto,
    contractChoiceRestored,
    contractSkontoOffer,
    draft,
    mutateDraft,
    session.readOnly,
  ]);

  /*
   * INVOICE-WIZARD-FULL-SAFE-RESUME-01B — die Bedienentscheidung kommt zurück,
   * die Wahrheit bleibt der Entwurf.
   *
   * Wiederhergestellt wird ausschliesslich „Vertragsskonto ja/nein" — der
   * einzige sichere Zustand dieser Seite, der nicht ohnehin im `InvoiceDraft`
   * liegt. Mengen, Steuerart, Datumswerte und Skontotext kommen unverändert von
   * dort; sie werden hier weder gelesen noch geschrieben.
   *
   * Die Auswahl wird **nicht** aus `draft.skontoText` erraten. Ein Freitext ist
   * keine Entscheidung: Wer denselben Satz von Hand tippt, hat nichts gewählt.
   *
   * Ein gespeichertes „Ja" gilt nur weiter, wenn der Vertrag derselbe ist und
   * das aktuelle Zahlungsziel es heute noch trägt. Der Guard aus
   * CONTRACT-SKONTO-DUE-DATE-CONSISTENCY-01B bleibt massgeblich und wird hier
   * nur gelesen — Fälligkeit, Angebot und vorhandener Text bleiben unangetastet.
   */
  const draftIdentity = locator
    ? `${locator.sourceScopeKey}#${locator.workspaceId}#${locator.vorgangId}#${locator.invoiceType}`
    : '';

  useEffect(() => {
    if (contractChoiceRestored) return;
    if (!isHydrationSettled(sessionStatus) || !draft) return;

    const restored = readInvoiceWizardContractSkontoChoice(restoredSession, {
      draftIdentity,
      offer: contractSkontoOffer,
    });

    if (restored === 'yes' && contractSkontoOffer) {
      const dueDays = calendarDaysBetween(draft.issueDate, draft.paymentDueDate);
      if (dueDays !== null && contractSkontoOffer.days <= dueDays) {
        /*
         * Der Wächter wird mitgesetzt: Der Vertragstext steht bereits im
         * Entwurf, es gibt nichts zu schreiben.
         */
        lastContractChoiceRef.current = true;
        setApplyContractSkonto(true);
        setContractChoiceRestored(true);
        return;
      }
    }

    /*
     * Alles andere — keine Sitzung, „Nein", ein anderer Vertrag oder ein heute
     * zu kurzes Zahlungsziel — bleibt beim Ausgangszustand. Entscheidend ist,
     * dass der Wächter dabei den **tatsächlichen** Stand übernimmt: Sonst
     * verstünde der Skonto-Effekt den Ausgangswert als frische Ablehnung und
     * ersetzte den gespeicherten Text durch den Firmenstandard.
     */
    lastContractChoiceRef.current = applyContractSkonto;
    setContractChoiceRestored(true);
  }, [
    applyContractSkonto,
    contractChoiceRestored,
    contractSkontoOffer,
    draft,
    draftIdentity,
    restoredSession,
    sessionStatus,
  ]);

  /*
   * Gemeldet wird nur die Bedienentscheidung samt ihrer Identität — kein
   * fachlicher Rechnungswert und ausdrücklich keine Bestätigung. Die
   * §13b-Bestätigung bleibt flüchtig.
   */
  useReportUiSession({
    workspaceType: 'invoice',
    activeSection: step,
    drafts: {
      values: buildInvoiceWizardResumeValues({
        draftIdentity,
        offer: contractSkontoOffer,
        choice: applyContractSkonto ? 'yes' : 'no',
      }),
      dirty: false,
    },
  });

  /*
   * Die Scrollposition zuletzt: erst wenn Entwurf und Auswahl stehen, hat die
   * Seite ihre endgültige Höhe. Früher angewandt würde sie am Seitenende
   * geklemmt — genau der Sprung, über den Nutzer klagen.
   */
  const scrollAppliedRef = useRef(false);
  useEffect(() => {
    if (scrollAppliedRef.current || !restoredSession) return;
    if (!contractChoiceRestored || !isHydrationSettled(sessionStatus)) return;
    scrollAppliedRef.current = true;
    applyMainScrollTop(restoredSession.scroll.mainTop);
  }, [contractChoiceRestored, restoredSession, sessionStatus]);

  /*
   * Eine unterbrochene Finalisierung wird genau **einmal** wiederaufgenommen —
   * auch unter StrictMode, weil der Wächter an der Datensatzidentität hängt
   * und nicht am Effektlauf.
   */
  const resumedKeyRef = useRef<string | null>(null);
  const retryLockRef = useRef(false);
  const [resumeRecovery, setResumeRecovery] = useState<InvoiceFinalizationRecovery | null>(null);

  /**
   * Einziger Wiederaufnahmeweg. Er ruft **ausschließlich**
   * `resumeInvoiceDraftFinalization` — niemals `startInvoiceDraftFinalization`,
   * damit nach einer begonnenen Finalisierung keine zweite Rechnung entsteht.
   */
  const runResume = useCallback(
    async (record: InvoiceDraftRecord): Promise<void> => {
      if (retryLockRef.current) return;
      retryLockRef.current = true;
      try {
        const result = await resumeInvoiceDraftFinalization({
          identity: {
            sourceScopeKey: record.sourceScopeKey,
            workspaceId: record.workspaceId,
            vorgangId: record.vorgangId,
            invoiceType: record.invoiceType,
            draftId: record.draftId,
          },
        });
        if (result.ok) {
          setResumeRecovery(null);
          showToast(translate('invoice.approved'));
          // Nur mit belegter Rechnung navigieren — sonst bleibt die Seite stehen.
          if (result.invoice) {
            navigate(`/vorgaenge/${record.vorgangId}/rechnungen/${result.invoice.id}`);
          }
          return;
        }
        /*
         * Der Recovery-Zustand wird verständlich abgebildet und steuert die
         * angebotene Aktion. Es wird nie selbsttätig erneut versucht.
         */
        setResumeRecovery(result.recovery);
        showToast(
          translate(
            result.recovery === 'reload_required'
              ? 'invoice.resume.reloadRequired'
              : result.recovery === 'retry_allowed'
                ? 'invoice.resume.retry'
                : 'invoice.resume.blocked',
          ),
        );
      } finally {
        retryLockRef.current = false;
      }
    },
    [navigate, showToast, translate],
  );

  useEffect(() => {
    if (sessionStatus !== 'finalization_pending') return;
    const record = session.record;
    if (!record) return;
    const key = `${record.recordKey}#${record.revision}`;
    if (resumedKeyRef.current === key) return;
    resumedKeyRef.current = key;
    void runResume(record);
  }, [sessionStatus, session.record, runResume]);

  /** Ausdrückliche Nutzeraktion — dieselbe Sperre wie der automatische Lauf. */
  const handleResumeRetry = () => {
    const record = session.record;
    if (!record) return;
    void runResume(record);
  };

  const finalizedInvoiceId = session.record?.finalization?.finalizedInvoiceId ?? null;

  const totals = draft ? calculateInvoiceTotals(draft, setup) : null;
  const printModel = useMemo(
    () => (draft ? buildInvoicePrintModel(draft, setup) : null),
    [draft, setup],
  );
  const overbillingWarnings = draft ? getOverbillingWarnings(draft) : [];

  const taxKey = `tax.${draft?.taxStatus ?? setup.taxStatus}` as TranslationKey;

  /*
   * INVOICE-TAX-FLOW-01B — die Steuerentscheidung sperrt den Weg zur Vorschau.
   *
   * Bis hierher zeigte die Vorschau `0 %` und den §13b-Rechtshinweis, bevor der
   * Nutzer bestätigt hatte, dass §13b überhaupt gelten soll — die Vorschau
   * behauptete also eine Rechtsangabe, die noch offen war. Ebenso gelangte
   * `unclear` bis in die fertige Vorschau und scheiterte erst an der Freigabe.
   *
   * Beides wird jetzt vorne abgefangen. Die bestehenden Freigabe- und
   * Finalize-Prüfungen bleiben unverändert bestehen; sie sind die zweite Linie.
   */
  /*
   * CONTRACT-SKONTO-DUE-DATE-CONSISTENCY-01B — der Hinweis wird abgeleitet,
   * nicht gemerkt.
   *
   * Er erscheint nur, solange der Nutzer die Übernahme versucht hat **und** der
   * Widerspruch noch besteht. Verlängert er anschliessend das Zahlungsziel,
   * verschwindet der Hinweis von selbst — ohne zusätzlichen Effekt und ohne
   * Sackgasse.
   */
  const contractSkontoDueDays =
    draft && contractSkontoOffer
      ? calendarDaysBetween(draft.issueDate, draft.paymentDueDate)
      : null;
  const contractSkontoConflict =
    contractSkontoAttemptBlocked &&
    contractSkontoOffer != null &&
    (contractSkontoDueDays === null || contractSkontoOffer.days > contractSkontoDueDays)
      ? { dueDays: contractSkontoDueDays ?? 0 }
      : null;

  const taxDecisionBlockKey: TranslationKey | null =
    draft == null ? null : taxDecisionBlocker(draft.taxStatus, reverseCharge13bConfirmed);
  const taxDecisionSettled = taxDecisionBlockKey === null;

  /*
   * INVOICE-MOBILE-RESUME-01B — die Identität, an der die §13b-Bestätigung
   * hängt.
   *
   * Alles davon stammt aus dem **gespeicherten Datensatz**, nicht aus der
   * Adresse: Scope und Workspace, Vorgang, Rechnungsart, `draftId` und der
   * Inhaltshash des Entwurfs. Fehlt der Datensatz noch, gibt es keinen
   * Kontext — und ohne Kontext wird weder geschrieben noch wiederhergestellt.
   */
  const draftRecord = session.record;
  const reverseChargeContext = useMemo<ReverseChargeConfirmationContext | null>(() => {
    if (!draftRecord) return null;
    return {
      sourceScopeKey: draftRecord.sourceScopeKey,
      workspaceId: draftRecord.workspaceId,
      vorgangId: draftRecord.vorgangId,
      invoiceType: draftRecord.invoiceType,
      draftId: draftRecord.draftId,
      draftSha256: draftRecord.draftSha256,
    };
  }, [draftRecord]);

  /*
   * INVOICE-MOBILE-RESUME-01B2 — die Bestätigung gilt für genau einen
   * Entwurfsstand, auch ohne Neuaufbau.
   *
   * Zwei Aufgaben in einem Effekt, weil beide dieselbe Frage beantworten
   * („gehört die Bestätigung noch zum aktuellen Stand?") und getrennt
   * auseinanderlaufen könnten:
   *
   *   1. **Binden** — nach dem ausdrücklichen Anhaken wird der dann gültige
   *      Hash festgehalten und der Wiederaufnahmepunkt geschrieben.
   *   2. **Entwerten** — weicht der Hash später ab, ist eine fachliche
   *      Eigenschaft der Rechnung geändert worden; die Bestätigung fällt und
   *      der gespeicherte Punkt verschwindet.
   *
   * `draftPersisted` hält einen laufenden Speicherlauf heraus: Während
   * `saving` gehört der Hash des Datensatzes noch zum vorherigen Stand, und
   * ein Vergleich damit würde eine gerade gegebene Bestätigung sofort wieder
   * entwerten.
   *
   * Kein Kreis: Hier wird nur Oberflächenzustand gesetzt, der Entwurf selbst
   * nie angefasst — reine UI-Vorgänge (Schritt, Dialoge, Scroll, offene
   * Tastatureingaben) verändern `draftSha256` nicht und lösen deshalb nichts
   * aus.
   */
  const draftPersisted = sessionStatus !== 'saving';
  useEffect(() => {
    if (!reverseCharge13bConfirmed || !draftPersisted) return;
    if (!reverseChargeContext) return;

    if (confirmedDraftSha256 === null) {
      setConfirmedDraftSha256(reverseChargeContext.draftSha256);
      writeReverseChargeConfirmation(reverseChargeContext);
      return;
    }
    if (confirmedDraftSha256 === reverseChargeContext.draftSha256) return;

    setReverseCharge13bConfirmed(false);
    setConfirmedDraftSha256(null);
    clearReverseChargeConfirmation(reverseChargeContext);
  }, [reverseCharge13bConfirmed, draftPersisted, reverseChargeContext, confirmedDraftSha256]);

  /*
   * Eine laufende oder bereits abgeschlossene Finalisierung sperrt Bearbeitung
   * und Freigabe gleichermaßen. Sie stammt ausschliesslich aus dem gespeicherten
   * Datensatz — niemals aus der Adresse.
   */
  const finalizationLocked =
    sessionStatus === 'finalization_pending' || sessionStatus === 'already_finalized';

  /*
   * MOBILE-RESUME-STATE-01B — Wiederaufnahme genau einmal, nach der Hydration.
   *
   * Vorher wird nichts entschieden und nichts verworfen: Der Entwurf kommt
   * asynchron, und ein `step=preview` aus der Adresse soll den ersten Render
   * überleben.
   */
  const requestedStep = isRechnungStep(searchParams.get(STEP_PARAM))
    ? (searchParams.get(STEP_PARAM) as RechnungStep)
    : null;
  const hydrationSettled = isHydrationSettled(sessionStatus);

  useEffect(() => {
    if (resumeApplied || !hydrationSettled) return;

    /*
     * INVOICE-MOBILE-RESUME-01B — die Bestätigung wird **vor** der
     * Schrittentscheidung wiederhergestellt, im selben Durchlauf.
     *
     * Genau hier lag der Fehler: `reverseCharge13bConfirmed` stammte aus dem
     * gerade erst erzeugten React-Zustand und war `false`, also stufte
     * `resolveResumableStep` ein `step=preview` auf `positions` zurück — und
     * der Effekt darunter schrieb diesen Rückfall in die Adresse. Danach war
     * nicht mehr feststellbar, dass der Nutzer schon weiter war.
     *
     * Der Speicherzugriff ist synchron, die Prüfung erfolgt deshalb im selben
     * Effekt und beide `setState` landen im selben Renderdurchlauf: Es gibt
     * kein Zwischenfenster, in dem die Adresse normalisiert werden könnte.
     * `taxDecisionSettled` aus dem Render wäre hier veraltet — die Regel wird
     * mit dem wiederhergestellten Wert neu ausgewertet, nicht nachgelesen.
     */
    const restoredConfirmation =
      draft?.taxStatus === 'reverse_charge_13b' &&
      reverseChargeContext !== null &&
      hasValidReverseChargeConfirmation(reverseChargeContext);

    if (restoredConfirmation) {
      setReverseCharge13bConfirmed(true);
      /*
       * INVOICE-MOBILE-RESUME-01B2 — die Bindung wird mitgeführt. Ohne sie
       * fände der Entwertungseffekt eine Bestätigung ohne Referenzstand,
       * bände sie neu an den aktuellen Hash und schriebe den Punkt erneut —
       * er wäre dann gültig, ohne je geprüft worden zu sein.
       */
      setConfirmedDraftSha256(reverseChargeContext!.draftSha256);
    }

    const resumedTaxDecisionSettled =
      draft == null
        ? taxDecisionSettled
        : taxDecisionBlocker(
            draft.taxStatus,
            reverseCharge13bConfirmed || restoredConfirmation,
          ) === null;

    setResumeApplied(true);
    setStep(
      resolveResumableStep({
        requested: requestedStep,
        hasDraft: draft != null,
        taxDecisionSettled: resumedTaxDecisionSettled,
        finalizationLocked,
      }),
    );
    // Bewusst nur an der Hydration: die Wiederaufnahme ist ein einmaliger Vorgang.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrationSettled]);

  /*
   * Die Adresse folgt dem Schritt, nicht umgekehrt.
   *
   * `replace`, damit kein zusätzlicher Verlaufseintrag je Assistentenschritt
   * entsteht — das Verhalten der Zurück-Taste bleibt in diesem Block unverändert.
   * Vorhandene Parameter wie `type` bleiben erhalten, weil der bestehende
   * Suchstring kopiert und nur ein Schlüssel gesetzt wird.
   */
  useEffect(() => {
    if (!resumeApplied) return;
    if (searchParams.get(STEP_PARAM) === step) return;
    const next = new URLSearchParams(searchParams);
    next.set(STEP_PARAM, step);
    setSearchParams(next, { replace: true });
  }, [resumeApplied, step, searchParams, setSearchParams]);
  const materialKey = draft ? (`material.${draft.materialSource}` as TranslationKey) : null;

  if (!id || !vorgang) {
    return (
      <div className="page">
        <EmptyStateBlock
          title={translate('vorgang.notFound')}
          description=""
          testId="rechnung-not-found"
        />
        <Button variant="outline" onClick={() => navigate('/vorgaenge')}>
          {translate('common.back')}
        </Button>
      </div>
    );
  }

  if (vorgang.orderPositions.length === 0) {
    return (
      <div className="page">
        <button type="button" className="back-link" onClick={() => navigate(`/vorgaenge/${id}`)}>
          ← {translate('common.back')}
        </button>
        <p className="empty-state">{translate('vorgang.noOrderPositions')}</p>
      </div>
    );
  }

  /*
   * INVOICE-DURABILITY-PRODUCTION-WIRING-01B1 — Pilotentscheidung: das
   * Rechnungsmodul setzt einen angemeldeten Firmen-Workspace voraus. Ohne
   * gültigen Workspace-Scope entsteht **kein** Locator, also auch kein
   * Entwurf, kein Datenbankzugriff, kein Autosave und keine Freigabe. Das wird
   * ausdrücklich als Sperre angezeigt — nie als dauerhaftes „Laden…".
   */
  if (!locator || sessionStatus === 'blocked_no_identity') {
    return (
      <div className="page" data-testid="rechnung-blocked-no-workspace">
        <button type="button" className="back-link" onClick={() => navigate(`/vorgaenge/${id}`)}>
          ← {translate('common.back')}
        </button>
        <EmptyStateBlock
          title={translate('invoice.session.noWorkspaceTitle')}
          description={translate('invoice.session.noWorkspace')}
          testId="invoice-no-workspace"
        />
      </div>
    );
  }

  if (sessionStatus === 'blocked_conflict' || sessionStatus === 'blocked_storage') {
    const conflict = sessionStatus === 'blocked_conflict';
    return (
      <div className="page" data-testid="rechnung-blocked-session">
        <button type="button" className="back-link" onClick={() => navigate(`/vorgaenge/${id}`)}>
          ← {translate('common.back')}
        </button>
        <EmptyStateBlock
          title={translate('invoice.title')}
          description={translate(
            conflict ? 'invoice.session.conflict' : 'invoice.session.storage',
          )}
          testId={conflict ? 'invoice-session-conflict' : 'invoice-session-storage'}
        />
      </div>
    );
  }

  if (!draft || !printModel) {
    return (
      <div className="page">
        <p className="empty-state">{translate('common.loading')}</p>
      </div>
    );
  }

  const pageTitle = draft
    ? getInvoiceDocumentTitle(draft.type, draft.abschlagNumber)
    : translate('invoice.title');

  const handleApplyAllPositions = () => {
    // INVOICE-QUANTITY-INPUT-UX-01B — die programmgesteuerte Übernahme setzt
    // gültige Mengen; offene Eingabefehler sind damit gegenstandslos.
    setQuantityBlocked({});
    mutateDraft((prev) => applyAllOpenPositionsToDraft(prev));
  };

  const handleTypeChange = (type: InvoiceDocumentType) => {
    navigate(`/vorgaenge/${id}/rechnung?type=${type}`);
  };

  /*
   * INVOICE-MOBILE-RESUME-01B — die Bestätigung ist eine Aussage des Nutzers
   * über genau diesen Entwurf, und sie wird hier zugleich in der Sitzung und
   * für die Wiederaufnahme festgehalten.
   *
   * Das Anhaken ist die einzige Quelle — es gibt keinen Pfad, auf dem
   * OfficePilot §13b von sich aus bestätigt. Geschrieben wird der
   * Wiederaufnahmepunkt aber nicht hier, sondern im Bindungseffekt oben: Er
   * kennt den Entwurfsstand, der beim Anhaken tatsächlich gespeichert ist.
   * Beim Abwählen verschwindet der Eintrag sofort; eine stille
   * Wiederbestätigung darf nicht entstehen.
   */
  const handleReverseCharge13bConfirm = (confirmed: boolean) => {
    setReverseCharge13bConfirmed(confirmed);
    if (confirmed) return;

    setConfirmedDraftSha256(null);
    if (reverseChargeContext) clearReverseChargeConfirmation(reverseChargeContext);
  };

  const handleTaxChange = (taxStatus: TaxStatus) => {
    if (taxStatus !== 'reverse_charge_13b') {
      setReverseCharge13bConfirmed(false);
      setConfirmedDraftSha256(null);
      /*
       * Der Entwurf verlässt §13b — die alte Bestätigung wird ungültig und
       * darf nach einer späteren Rückkehr zu `reverse_charge_13b` nicht
       * ungeprüft wieder auftauchen. Der Hash allein genügt dafür nicht: Ein
       * Hin- und Herschalten kann denselben Inhalt wiederherstellen.
       */
      if (reverseChargeContext) clearReverseChargeConfirmation(reverseChargeContext);
    }
    mutateDraft((prev) => updateInvoiceDraftTaxStatus(prev, taxStatus));
  };

  /*
   * INVOICE-TAX-FLOW-01B — ein Baustein, zwei Einsatzorte.
   *
   * Derselbe Abschnitt erscheint im Positionsschritt (dort wird entschieden) und
   * im Bearbeitungsschritt (dort wird korrigiert). Bewusst als lokale
   * Renderfunktion und nicht als eigene Komponente: Es geht um denselben State
   * derselben Seite, eine Extraktion würde Props durchreichen, ohne etwas zu
   * klären.
   *
   * Die §13b-Bestätigung sitzt unmittelbar unter der Auswahl — sie gehört zur
   * Entscheidung, nicht ans Ende einer langen Vorschau.
   */
  const renderTaxDecision = (currentDraft: InvoiceDraft) => (
    <Card className="invoice-tax-decision" data-testid="invoice-tax-decision">
      <fieldset className="invoice-edit__section">
        <legend>{translate('invoice.taxStatus')}</legend>
        <div className="chip-group">
          {TAX_OPTIONS.map((status) => (
            <button
              key={status}
              type="button"
              className={`chip ${currentDraft.taxStatus === status ? 'chip--active' : ''}`}
              data-testid={`invoice-tax-${status}`}
              onClick={() => handleTaxChange(status)}
            >
              {translate(`tax.${status}` as TranslationKey)}
            </button>
          ))}
        </div>
      </fieldset>

      {/*
        * INVOICE-TAX-FLOW-01D — die getroffene Wahl im Klartext.
        *
        * Bewusst der übersetzte Name und niemals der technische Wert: Der
        * Nutzer soll „§19 Kleinunternehmer" lesen, nicht `kleinunternehmer_19`.
        */}
      <p className="invoice-tax-decision__selected" data-testid="invoice-tax-selected">
        {translate('invoice.taxStatusSelected')}:{' '}
        <strong>{translate(`tax.${currentDraft.taxStatus}` as TranslationKey)}</strong>
      </p>

      {currentDraft.taxStatus === 'reverse_charge_13b' ? (
        <div className="invoice-13b-confirm" data-testid="invoice-13b-confirm">
          <label className="invoice-13b-confirm__label">
            <input
              type="checkbox"
              checked={reverseCharge13bConfirmed}
              onChange={(event) => handleReverseCharge13bConfirm(event.target.checked)}
              data-testid="invoice-13b-confirm-checkbox"
            />
            <span>{translate('invoice.reverseCharge.confirmLabel')}</span>
          </label>
          <p className="hint-text">{translate('invoice.reverseCharge.confirmHelp')}</p>
        </div>
      ) : null}

      {taxDecisionBlockKey ? (
        <p className="hint-text" data-testid="invoice-tax-decision-blocked">
          {translate(taxDecisionBlockKey)}
        </p>
      ) : null}
    </Card>
  );

  /*
   * INVOICE-QUANTITY-INPUT-UX-01B — die Mengeneingabe trägt eine Geldforderung.
   *
   * `NumericInput` im strengen Modus liefert nur vollständige Zahlen; alles
   * Ungültige erreicht diesen Handler gar nicht.
   *
   * INVOICE-ACTUAL-MEASURE-VS-PLAN-01B — eine Menge über dem Planrest wird
   * hier **nicht mehr abgelehnt**. Die Planmenge ist die Vertragsmenge, nicht
   * das Aufmass; eine bewusste Überschreitung ist kein Eingabefehler, sondern
   * ein Fall für den bestehenden Bestätigungspfad („Trotzdem freigeben").
   *
   * `quantityBlocked` hält deshalb nur noch den einen Grund, der wirklich
   * keine Zahl ist: `'incomplete'` für einen offenen Zwischenstand wie `1,`.
   * Er wird ausschliesslich durch eine gültige Eingabe aufgelöst — niemals
   * durch einen Fokuswechsel.
   */
  const handleQuantityChange = (positionId: string, quantity: number) => {
    setQuantityBlocked((prev) => {
      if (!prev[positionId]) return prev;
      const next = { ...prev };
      delete next[positionId];
      return next;
    });
    mutateDraft((prev) => updateDraftPositionQuantity(prev, positionId, quantity));
  };

  const handleQuantityEditingValidity = (positionId: string, isComplete: boolean) => {
    setQuantityBlocked((prev) => {
      if (isComplete) {
        if (prev[positionId] !== 'incomplete') return prev;
        const next = { ...prev };
        delete next[positionId];
        return next;
      }
      if (prev[positionId]) return prev;
      return { ...prev, [positionId]: 'incomplete' };
    });
  };

  /*
   * INVOICE-SERVICE-PERIOD-01B — bewusste Eingabe **ist** die Bestätigung.
   * Sind beide Felder gefüllt, gilt der Zeitraum als gesetzt; wird eines
   * geleert, fällt die Bestätigung zurück. Die Entscheidung fällt hier im
   * Oberflächenpfad und nicht im generischen Setter.
   */
  const handleServicePeriodChange = (changes: InvoiceDraftMetadataChanges) => {
    mutateDraft((prev) => {
      const from = changes.servicePeriodFrom ?? prev.servicePeriodFrom;
      const to = changes.servicePeriodTo ?? prev.servicePeriodTo;
      return updateInvoiceDraftMetadata(prev, {
        ...changes,
        servicePeriodConfirmed: Boolean(from.trim() && to.trim()),
      });
    });
  };

  const handleMetadataChange = (changes: InvoiceDraftMetadataChanges) => {
    mutateDraft((prev) => updateInvoiceDraftMetadata(prev, changes));
  };

  /**
   * CUSTOMER-FACHOBJEKT-05B — explicit takeover of the current customer master
   * data into this draft only. Strictly id-based: no name lookup, no fallback.
   */
  const customerIdOfVorgang = vorgang?.customerId?.trim() ?? '';
  const masterCustomer = customerIdOfVorgang ? getCustomerById(customerIdOfVorgang) : undefined;
  const masterBilling = masterCustomer ? billingFromCustomer(masterCustomer) : null;
  const masterAddressComplete = Boolean(
    masterCustomer?.street.trim() && masterCustomer.zip.trim() && masterCustomer.city.trim(),
  );
  const masterMatchesDraft = Boolean(
    masterBilling &&
      draft &&
      (Object.keys(masterBilling) as Array<keyof typeof masterBilling>).every(
        (field) => masterBilling[field] === draft.customerBilling[field],
      ),
  );

  const applyMasterBilling = () => {
    if (!vorgang) return;
    // Read the source again — the store may have changed since rendering.
    const current = customerIdOfVorgang ? getCustomerById(customerIdOfVorgang) : undefined;
    if (!current) {
      setCustomerMasterConfirm(false);
      setCustomerMasterError(translate('invoice.customerMaster.missing'));
      return;
    }
    mutateDraft((prev) =>
      updateInvoiceDraftMetadata(prev, { customerBilling: billingFromCustomer(current) }),
    );
    setCustomerMasterConfirm(false);
    setCustomerMasterError(null);
    showToast(translate('invoice.customerMaster.applied'));
  };

  const handleAbschlagModeChange = (mode: InvoiceCalculationMode) => {
    mutateDraft((prev) => setAbschlagDraftCalculationMode(prev, mode, setup));
    setValidationErrors([]);
  };

  const handleFixedAmountChange = (value: string) => {
    const parsed = Number(String(value).replace(',', '.'));
    mutateDraft((prev) =>
      updateInvoiceDraftFixedAmountNet(prev, Number.isFinite(parsed) ? parsed : 0),
    );
  };

  const runApproval = async () => {
    if (!id || !draft || approveLockRef.current || approving) return;
    /*
     * Gesperrte Sitzungszustände — `finalization_pending`, `already_finalized`,
     * Speicherfehler, Konflikt und fehlende Identität — erlauben keine
     * Finalisierung. Der Schreibschutz der Sitzung ist hier maßgeblich.
     */
    if (session.readOnly || session.blocked || !session.record) return;
    approveLockRef.current = true;
    setApproving(true);

    /*
     * INVOICE-FINALIZE-HANG-01B — ab hier ist der Serverzustand ungewiss.
     *
     * Vor diesem Punkt kann ein unerwarteter Fehler nichts angerichtet haben;
     * danach könnte eine Finalisierung bereits begonnen haben. Der Unterschied
     * entscheidet, ob ein zweiter Versuch erlaubt sein darf.
     */
    let finalizationStarted = false;

    try {
      await runApprovalSteps(() => {
        finalizationStarted = true;
      });
    } catch (error) {
      console.warn('[OfficePilot] Freigabe unerwartet fehlgeschlagen:', error);
      /*
       * Der Ladezustand endet in jedem Fall — eine dauerhaft stehende Anzeige
       * „wird freigegeben…" ist das, was dieser Block behebt.
       *
       * Die Sperre folgt dagegen dem Serverzustand: Vor dem Start gibt es
       * nichts zu schützen, danach könnte ein zweiter Versuch eine zweite
       * Rechnung erzeugen. Deshalb bleibt sie dort bewusst bestehen, und der
       * Nutzer wird zum Neuladen geführt — der Entwurf überlebt das.
       */
      setApproving(false);
      if (finalizationStarted) {
        showToast(translate('invoice.approve.unexpectedReload'));
      } else {
        approveLockRef.current = false;
        showToast(translate('invoice.approve.failed'));
      }
    }
  };

  const runApprovalSteps = async (markFinalizationStarted: () => void) => {
    if (!id || !draft) return;

    const validation = validateInvoiceDraftForApproval(
      draft,
      draft.companySnapshot,
      vorgang,
      { reverseCharge13bConfirmed },
    );

    const blockers = validation.blockingErrors;

    setValidationWarnings(validation.warnings.map((w) => w.messageKey));
    if (blockers.length > 0) {
      setValidationErrors(blockers.map((e) => e.messageKey));
      approveLockRef.current = false;
      setApproving(false);
      showToast(translate('invoice.approve.blocked'));
      return;
    }

    setValidationErrors([]);

    /*
     * Der zuletzt bearbeitete Stand muss dauerhaft gespeichert sein, bevor die
     * Finalisierung beginnt — der Coordinator arbeitet ausschließlich auf dem
     * gespeicherten Datensatz.
     */
    const flushed = await session.flush();
    if (!flushed.ok) {
      /*
       * INVOICE-FINALIZE-HANG-01B — `timeout` ist hier ein sicherer Ausgang:
       * Der Serverkontakt beginnt erst danach, es kann also weder eine halbe
       * noch eine doppelte Rechnung entstanden sein. Der Entwurf bleibt
       * unangetastet, und ein erneuter Versuch ist ausdrücklich erlaubt.
       */
      showToast(
        flushed.outcome === 'conflict'
          ? translate('invoice.approve.conflict')
          : translate('invoice.approve.localPersistPending'),
      );
      approveLockRef.current = false;
      setApproving(false);
      return;
    }

    /*
     * COMPANY-PROFILE-DRAFT-DRIFT-01E2 — nach dem Flush ist der **gespeicherte**
     * Datensatz die Wahrheit, nicht der Stand dieses Renderdurchlaufs.
     *
     * `session.record` stammt aus dem Render, in dem dieser Ablauf entstanden
     * ist. Schreibt derselbe Klick vorher noch in den Entwurf — wie die
     * Übernahme geänderter Firmendaten —, steigt die Revision im Speicher,
     * während die Closure die alte behält. Der Coordinator prüft
     * `expectedRevision` gegen den gespeicherten Stand und hätte die Freigabe
     * mit `conflict` abgewiesen: gemessen 4 gegen 5.
     *
     * Deshalb wird die Identität hier einmal frisch geladen. Fail-closed:
     * Ohne lesbaren Datensatz wird nicht finalisiert.
     */
    const reloaded = locator ? await loadInvoiceDraftRecordByLocator(locator) : null;
    const record = reloaded?.ok ? reloaded.record : null;
    if (!record) {
      approveLockRef.current = false;
      setApproving(false);
      showToast(translate('invoice.approve.failed'));
      return;
    }

    markFinalizationStarted();
    const result = await startInvoiceDraftFinalization({
      identity: {
        sourceScopeKey: record.sourceScopeKey,
        workspaceId: record.workspaceId,
        vorgangId: record.vorgangId,
        invoiceType: record.invoiceType,
        draftId: record.draftId,
      },
      expectedRevision: record.revision,
      approvalOptions: { reverseCharge13bConfirmed },
      overbillingAcknowledged: overbillingWarnings.length > 0,
    });

    if (!result.ok) {
      if (result.reason === 'offline_or_unconfigured') {
        showToast(translate('invoice.approve.offline'));
      } else if (result.reason === 'auth_missing') {
        showToast(translate('invoice.approve.auth'));
      } else if (
        result.reason === 'workspace_missing' ||
        result.reason === 'workspace_changed' ||
        result.reason === 'scope_mismatch'
      ) {
        showToast(translate('invoice.approve.workspace'));
      } else if (
        result.reason === 'conflict' ||
        result.reason === 'idempotency_conflict' ||
        result.reason === 'possible_existing_invoice'
      ) {
        showToast(translate('invoice.approve.conflict'));
      } else if (
        result.reason === 'local_persist_failed' ||
        result.reason === 'persist_failed'
      ) {
        showToast(translate('invoice.approve.localPersistPending'));
      } else {
        showToast(translate('invoice.approve.failed'));
      }
      /*
       * Die Freigabe wird wieder geöffnet, wenn einer von zwei Nachweisen
       * vorliegt — und nur dann.
       *
       * 1. `retry_allowed`: der Coordinator erklärt den Ausgang ausdrücklich
       *    für wiederholbar.
       * 2. INVOICE-FINALIZE-HANG-01C — `cloudState === 'not_committed'`: es ist
       *    nachweislich **nichts** übertragen worden. Fast jeder Fehlschlag vor
       *    `begin` trägt diesen Zustand, bekommt von `failBeforeBegin` aber die
       *    Vorgabe `recovery: 'blocked'`. Wer nur auf `recovery` sieht, sperrt
       *    damit einen völlig sicheren Zustand dauerhaft — im Realtest blieb
       *    die Oberfläche deshalb auf „Rechnung wird freigegeben…" stehen,
       *    obwohl gar kein Serverkontakt stattgefunden hatte.
       *
       * Alles andere — `confirmed`, `conflict` und vor allem `unknown` — bleibt
       * gesperrt. Dort könnte serverseitig bereits eine Rechnung liegen, und
       * ein zweiter Versuch würde eine zweite erzeugen.
       */
      if (result.recovery === 'retry_allowed' || result.cloudState === 'not_committed') {
        approveLockRef.current = false;
        setApproving(false);
      }
      return;
    }

    showToast(
      result.archiveWarning
        ? translate('invoice.approve.archiveWarning')
        : translate('invoice.approved'),
    );
    navigate(`/vorgaenge/${id}/rechnungen/${result.invoice.id}`);
  };

  /**
   * COMPANY-PROFILE-DRAFT-DRIFT-01E — die Rückfrage sitzt **vor** dem
   * bestehenden Übermengen-Gate, nicht statt seiner.
   *
   * Beide Gates führen anschliessend in denselben Trichter: Wer die
   * Firmendaten geklärt hat, bekommt danach — falls nötig — weiterhin die
   * Übermengenfrage. So entsteht keine Reihenfolge, in der ein Gate das andere
   * verschluckt.
   */
  const continueAfterCompanyDrift = () => {
    if (overbillingWarnings.length > 0) {
      setShowOverbillingConfirm(true);
      return;
    }
    runApproval();
  };

  /**
   * Die Prüfung liest das Profil **im Augenblick des Klicks**, nicht beim
   * letzten Render.
   *
   * Das ist keine Feinheit: Ein Betrieb ändert seine Bankverbindung in den
   * Einstellungen und kehrt zur offenen Rechnung zurück. Würde die Abweichung
   * aus einem älteren Renderdurchlauf stammen, entschiede die Rückfrage über
   * einen Stand, den es nicht mehr gibt. Der Freigabeklick ist der einzige
   * Zeitpunkt, an dem die Frage überhaupt zählt — also wird sie dort gestellt.
   */
  const handleApprove = () => {
    const profile = getCompanyProfile();
    const fingerprint = buildCriticalCompanyFingerprint(profile);
    if (draft && acknowledgedCompanyFingerprint !== fingerprint) {
      const drift = findCriticalCompanyProfileDrift(draft.companySnapshot, profile);
      if (drift.length > 0) {
        setCompanyDriftFields(drift);
        setCompanyDriftProfile(profile);
        setShowCompanyDriftConfirm(true);
        return;
      }
      /* Keine kritische Abweichung — der Stand gilt als geklärt. */
      setAcknowledgedCompanyFingerprint(fingerprint);
    }
    continueAfterCompanyDrift();
  };

  /**
   * „Aktuelle Firmendaten übernehmen" — ausschliesslich die kritischen Felder.
   *
   * Geschrieben wird über `mutateDraft`, also über den **einzigen** dauerhaften
   * Änderungsweg des Entwurfs. Die anschliessende Finalisierung wartet in
   * `runApprovalSteps` ohnehin auf `session.flush()` und bricht ab, wenn der
   * Speicherlauf nicht bestätigt — der Fall „übernommen, aber nicht
   * gespeichert" kann damit nicht entstehen, ohne dass eine neue Persistenz
   * nötig wäre.
   */
  const handleApplyCompanyDrift = () => {
    /* Genau der Stand, den die Karte gezeigt hat — nicht ein inzwischen anderer. */
    const current = companyDriftProfile ?? getCompanyProfile();
    mutateDraft((prev) => ({
      ...prev,
      companySnapshot: applyCriticalCompanyProfileFields(prev.companySnapshot, current),
    }));
    setAcknowledgedCompanyFingerprint(buildCriticalCompanyFingerprint(current));
    setShowCompanyDriftConfirm(false);
    showToast(translate('invoice.companyDrift.applied'));
    continueAfterCompanyDrift();
  };

  /**
   * „Bisherigen Stand behalten" — der Entwurf wird nicht angefasst.
   *
   * Gemerkt wird nicht „bestätigt", sondern **wogegen** bestätigt wurde.
   * Ändert der Betrieb danach erneut etwas, entsteht ein anderes Kennzeichen
   * und die Rückfrage erscheint wieder. Eine Zusage auf ewig wäre hier genau
   * das Gefährliche.
   */
  const handleKeepCompanySnapshot = () => {
    setAcknowledgedCompanyFingerprint(buildCriticalCompanyFingerprint(getCompanyProfile()));
    setShowCompanyDriftConfirm(false);
    continueAfterCompanyDrift();
  };

  const handleConfirmOverbilling = () => {
    setShowOverbillingConfirm(false);
    runApproval();
  };

  const showMaterialHint =
    draft.materialSource === 'auftraggeber' &&
    draft.positions.some((p) => p.category === 'material' && !p.billable);

  const showMissingPriceWarning =
    !isFixedAmountAbschlag(draft) && draft.positions.some((p) => p.unitPrice === 0);

  const isFixedAbschlag = isFixedAmountAbschlag(draft);
  const abschlagMode = resolveInvoiceCalculationMode(draft);
  /*
   * Anzeigewert: hier darf bei 0 abgeschnitten werden — ein negativer
   * Restbetrag ist für den Nutzer keine Information. Die Validierung liest
   * denselben Helper ungeklammert und blockiert den überzogenen Vorgang
   * weiterhin.
   */
  /** Werte vorhanden, aber nie bestätigt — typischer Bestandsentwurf. */
  const needsServicePeriodConfirmation =
    Boolean(draft.servicePeriodFrom.trim() && draft.servicePeriodTo.trim()) &&
    draft.servicePeriodConfirmed !== true;

  const remainingFixedAmountBillableNet = vorgang
    ? Math.max(0, getRemainingFixedAmountBillableNetCents(vorgang)) / 100
    : 0;

  const backTarget =
    step === 'positions'
      ? `/vorgaenge/${id}`
      : step === 'edit'
        ? 'preview'
        : 'positions';

  const handleBack = () => {
    if (backTarget === 'preview') {
      setStep('preview');
      return;
    }
    if (backTarget === 'positions') {
      setStep('positions');
      return;
    }
    navigate(backTarget);
  };

  return (
    <div className="page" data-testid="rechnung-page">
      <button type="button" className="back-link" onClick={handleBack}>
        ← {translate('common.back')}
      </button>

      <PageHeader
        title={pageTitle}
        subtitle={
          step === 'positions'
            ? translate('invoice.subtitle')
            : step === 'preview'
              ? translate('invoice.previewReady')
              : translate('invoice.editSubtitle')
        }
      />

      {step === 'positions' && (
        <>
          <Card className="invoice-type-picker" data-testid="invoice-type-picker">
            <p className="invoice-type-picker__label">{translate('invoice.typeLabel')}</p>
            <div className="chip-group">
              {CONTRACT_ORDER_INVOICE_TYPES.map((type) => (
                <button
                  key={type}
                  type="button"
                  className={`chip ${draft.type === type ? 'chip--active' : ''}`}
                  data-testid={`invoice-type-${type}`}
                  onClick={() => handleTypeChange(type)}
                >
                  {translate(`invoice.type.${type}` as TranslationKey)}
                </button>
              ))}
            </div>
          </Card>

          {draft.type === 'abschlag' && (
            <Card className="invoice-type-picker" data-testid="invoice-abschlag-mode-picker">
              <p className="invoice-type-picker__label">
                {translate('invoice.calculationModeLabel')}
              </p>
              <div className="chip-group">
                <button
                  type="button"
                  className={`chip ${abschlagMode === 'quantity_based' ? 'chip--active' : ''}`}
                  data-testid="invoice-abschlag-mode-quantity"
                  onClick={() => handleAbschlagModeChange('quantity_based')}
                >
                  {translate('invoice.calculationMode.quantity')}
                </button>
                <button
                  type="button"
                  className={`chip ${abschlagMode === 'fixed_amount' ? 'chip--active' : ''}`}
                  data-testid="invoice-abschlag-mode-fixed"
                  onClick={() => handleAbschlagModeChange('fixed_amount')}
                >
                  {translate('invoice.calculationMode.fixed')}
                </button>
              </div>
            </Card>
          )}

          {progressBillingAllowed && (
            <p className="invoice-hint" data-testid="invoice-progress-billing-hint">
              {translate('invoice.progressBillingContractHint')}
            </p>
          )}

          {contractSkontoOffer && (
            <Card className="invoice-skonto-choice" data-testid="invoice-skonto-choice">
              <p className="invoice-type-picker__label">{translate('invoice.skontoFromContractTitle')}</p>
              <div className="chip-group">
                <button
                  type="button"
                  className={`chip ${!applyContractSkonto ? 'chip--active' : ''}`}
                  data-testid="invoice-skonto-no"
                  onClick={() => setApplyContractSkonto(false)}
                >
                  {translate('invoice.skontoFromContractNo')}
                </button>
                <button
                  type="button"
                  className={`chip ${applyContractSkonto ? 'chip--active' : ''}`}
                  data-testid="invoice-skonto-yes"
                  onClick={() => setApplyContractSkonto(true)}
                >
                  {translate('invoice.skontoFromContractYes')
                    .replace('{percent}', String(contractSkontoOffer.percent))
                    .replace('{days}', String(contractSkontoOffer.days))}
                </button>
              </div>
              {contractSkontoConflict ? (
                <p className="hint-text" data-testid="invoice-skonto-due-conflict">
                  {translate('invoice.skontoFromContractTooLong')
                    .replace('{days}', String(contractSkontoOffer.days))
                    .replace('{dueDays}', String(contractSkontoConflict.dueDays))}
                </p>
              ) : null}
            </Card>
          )}

          {/* BRANDING-01F-3 — dieselbe historische Logoerkennung wie Ansicht und PDF. */}
          {selectHistoricalInvoiceLogo(draft).kind !== 'none' && (
            <p className="hint-text invoice-brand-hint" data-testid="invoice-brand-logo-hint">
              {translate('invoice.logoFromProfile')}
            </p>
          )}

          {showMaterialHint && (
            <p className="invoice-hint invoice-hint--warning">
              {translate('invoice.materialAuftraggeberHint')}
            </p>
          )}

          {showMissingPriceWarning && (
            <p className="invoice-hint invoice-hint--warning">
              {translate('invoice.missingPriceWarning')}
            </p>
          )}

          {overbillingWarnings.length > 0 && (
            <div className="invoice-hint invoice-hint--warning">
              <strong>{translate('invoice.overbillingTitle')}</strong>
              <ul className="invoice-warn-list">
                {overbillingWarnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {isFixedAbschlag ? (
            <section className="section" data-testid="invoice-fixed-amount-section">
              <h2 className="section__title">{translate('invoice.fixedAmountNet')}</h2>
              <Card>
                <label className="invoice-edit__field">
                  <span className="invoice-edit__label">{translate('invoice.fixedAmountNet')}</span>
                  <input
                    type="number"
                    className="input"
                    min={0}
                    step="0.01"
                    value={draft.fixedAmountNet ?? ''}
                    data-testid="invoice-fixed-amount-net"
                    onChange={(event) => handleFixedAmountChange(event.target.value)}
                  />
                </label>
                {/*
                 * FIXED-AMOUNT-BILLING-INVARIANT-01B2 — die blockierende Grenze
                 * sichtbar machen. Sie ist der **abrechenbare** Auftragswert
                 * abzüglich der bisherigen Abschläge und kann deshalb unter dem
                 * Vertragswert liegen, den die Auftragsansicht zeigt. Ohne
                 * diese Zeile stünde der Nutzer vor einer Sperre gegen eine
                 * Zahl, die nirgends steht. Derselbe SSOT wie die Validierung.
                 */}
                <p className="invoice-edit__hint" data-testid="invoice-fixed-amount-remaining">
                  {translate('invoice.remainingFixedAmountBillable')}:{' '}
                  {remainingFixedAmountBillableNet.toLocaleString('de-DE', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}{' '}
                  € netto
                </p>
                <DataRow
                  label={translate('invoice.nextNumberPreview')}
                  value={draft.invoiceNumberPreview}
                />
                <DataRow label={translate('invoice.issueDate')} value={draft.issueDate} />
                <DataRow
                  label={translate('invoice.servicePeriod')}
                  value={`${draft.servicePeriodFrom} – ${draft.servicePeriodTo}`}
                />
                <DataRow label={translate('invoice.paymentDueDate')} value={draft.paymentDueDate} />
                {draft.baustelle ? (
                  <DataRow label={translate('confirmation.baustelle')} value={draft.baustelle} />
                ) : null}
              </Card>
            </section>
          ) : (
            <section className="section">
              <div className="section__header-row">
                <h2 className="section__title">{translate('invoice.positions')}</h2>
                <Button
                  variant="outline"
                  onClick={handleApplyAllPositions}
                  data-testid="invoice-apply-all-positions"
                >
                  {translate('invoice.applyAllPositions')}
                </Button>
              </div>
              {draft.positions.map((pos) => (
                <Card key={pos.id} className={!pos.billable ? 'invoice-pos--disabled' : ''}>
                  <p className="position-desc">{pos.description}</p>
                  <div className="invoice-leistungsstand">
                    <DataRow
                      label={translate('invoice.planned')}
                      value={`${pos.plannedQuantity} ${pos.unit}`}
                    />
                    {/*
                      * INVOICE-ACTUAL-QUANTITY-01B — die fehlende Ausführung
                      * ist eine Aussage, keine Leerstelle. Vorher verschwand
                      * die Zeile ganz, und der Nutzer sah nur „Geplant 420"
                      * neben einer vorbelegten 420 — ohne zu erkennen, dass
                      * noch nichts erfasst war.
                      */}
                    <DataRow
                      label={translate('invoice.executed')}
                      value={
                        pos.executedQuantity === undefined
                          ? translate('invoice.executedNotRecorded')
                          : `${pos.executedQuantity} ${pos.unit}`
                      }
                    />
                    <DataRow
                      label={translate('invoice.alreadyBilled')}
                      value={`${pos.billedQuantity} ${pos.unit}`}
                    />
                    <DataRow
                      label={translate('invoice.stillOpen')}
                      value={`${pos.openQuantity} ${pos.unit}`}
                    />
                  </div>
                  <div className="position-row">
                    <label className="position-field" htmlFor={`invoice-qty-${pos.id}`}>
                      {translate('invoice.quantityThisInvoice')}
                      <NumericInput
                        id={`invoice-qty-${pos.id}`}
                        mode="decimal"
                        strict
                        className="input input--small"
                        min={0}
                        /*
                         * INVOICE-ACTUAL-MEASURE-VS-PLAN-01B — bewusst **kein**
                         * `max`: Der Planrest ist eine Referenz, und ein
                         * `aria-valuemax` daraus würde der Oberfläche eine
                         * Obergrenze zuschreiben, die es fachlich nicht gibt.
                         * Gesperrt wird nur, was wirklich nicht abrechenbar
                         * ist — ein ausgeschöpfter Planrest gehört nicht dazu.
                         */
                        value={pos.quantity}
                        disabled={!pos.billable}
                        data-testid={`invoice-qty-${pos.orderPositionId}`}
                        onChange={(next) => handleQuantityChange(pos.id, next)}
                        onEditingValidityChange={(isComplete) =>
                          handleQuantityEditingValidity(pos.id, isComplete)
                        }
                      />
                    </label>
                    <span className="position-meta">
                      {translate('invoice.unitPrice')}: {pos.unitPrice.toLocaleString('de-DE')} € /{' '}
                      {pos.unit}
                    </span>
                    <span className="position-price">
                      {(pos.quantity * pos.unitPrice).toLocaleString('de-DE')} €
                    </span>
                  </div>
                  {quantityBlocked[pos.id] === 'incomplete' && (
                    <p className="invoice-pos-hint" data-testid={`invoice-qty-incomplete-${pos.orderPositionId}`}>
                      {translate('invoice.quantityIncomplete')}
                    </p>
                  )}
                  {!pos.billable && pos.category === 'material' && (
                    <p className="invoice-pos-hint">{translate('invoice.materialNotBillable')}</p>
                  )}
                </Card>
              ))}
            </section>
          )}

          {/*
            * INVOICE-TAX-FLOW-01D — die Steuerentscheidung steht **vor** der
            * Summenkarte.
            *
            * Die Summenkarte blendet bei einem Steuersatz > 0 eine zusätzliche
            * Zeile ein. Stand sie oberhalb, verschob sie im Moment der Auswahl
            * genau die Schaltflächen, die gerade angetippt wurden. Die
            * Berechnung selbst ist unverändert — nur die Reihenfolge.
            */}
          {renderTaxDecision(draft)}

          {totals && (
            <Card>
              <DataRow
                label={translate('invoice.subtotal')}
                value={`${totals.subtotal.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`}
              />
              <DataRow label={translate('invoice.taxStatus')} value={translate(taxKey)} />
              {totals.taxRate > 0 && (
                <DataRow
                  label={`${translate('invoice.tax')} (${totals.taxRate} %)`}
                  value={`${totals.tax.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`}
                />
              )}
              <DataRow
                label={translate('invoice.total')}
                value={
                  <strong>
                    {totals.total.toLocaleString('de-DE', {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}{' '}
                    €
                  </strong>
                }
              />
              {materialKey && (
                <DataRow
                  label={translate('vorgang.materialSource')}
                  value={translate(materialKey)}
                />
              )}
            </Card>
          )}

          {/*
            * INVOICE-SERVICE-PERIOD-01B — der tatsächliche Leistungszeitraum
            * gehört in den Hauptablauf. Vorher stand er nur als Anzeigezeile in
            * der Vorschau, und geändert werden konnte er ausschliesslich über
            * den Umweg „Rechnung bearbeiten" — bei einem Wert, den das System
            * ungefragt gesetzt hatte.
            */}
          <section className="section" data-testid="invoice-service-period-section">
            <h2 className="section__title">{translate('invoice.servicePeriod')}</h2>
            <Card>
              <div className="form-row">
                <label className="invoice-edit__field">
                  <span className="invoice-edit__label">{translate('invoice.servicePeriodFrom')}</span>
                  <input
                    type="date"
                    className="input"
                    value={draft.servicePeriodFrom}
                    data-testid="invoice-service-period-from"
                    onChange={(event) =>
                      handleServicePeriodChange({ servicePeriodFrom: event.target.value })
                    }
                  />
                </label>
                <label className="invoice-edit__field">
                  <span className="invoice-edit__label">{translate('invoice.servicePeriodTo')}</span>
                  <input
                    type="date"
                    className="input"
                    value={draft.servicePeriodTo}
                    data-testid="invoice-service-period-to"
                    onChange={(event) =>
                      handleServicePeriodChange({ servicePeriodTo: event.target.value })
                    }
                  />
                </label>
              </div>
              {/*
                * Bestandsentwurf: Werte stehen da, wurden aber nie bestätigt.
                * Der Nutzer soll sie nicht künstlich verändern müssen — eine
                * bewusste Zustimmung genügt.
                */}
              {needsServicePeriodConfirmation ? (
                <Button
                  variant="outline"
                  fullWidth
                  onClick={() => handleMetadataChange({ servicePeriodConfirmed: true })}
                  data-testid="invoice-confirm-service-period"
                >
                  {translate('invoice.confirmServicePeriod')}
                </Button>
              ) : null}
            </Card>
          </section>

          <div className="action-stack">
            {/*
              * INVOICE-QUANTITY-INPUT-UX-01B — die Sperre sitzt in `disabled`,
              * nicht im Klick-Handler. Auf dem Telefon feuert `blur` vor
              * `click`; ein deaktivierter Knopf löst gar kein `click` aus und
              * kann eine gerade abgewiesene Eingabe deshalb nicht im selben Tap
              * überspringen.
              */}
            <Button
              fullWidth
              disabled={!taxDecisionSettled || Object.keys(quantityBlocked).length > 0}
              onClick={() => setStep('preview')}
              data-testid="invoice-continue-preview"
            >
              {translate('invoice.continueToPreview')}
            </Button>
            <Button variant="outline" fullWidth onClick={() => navigate(`/vorgaenge/${id}`)}>
              {translate('common.cancel')}
            </Button>
          </div>
        </>
      )}

      {step === 'preview' && (
        <>
          <InvoiceDocumentView model={printModel} />
          <p className="hint-text" data-testid="invoice-preview-hint">
            {translate('invoice.previewHint')}
          </p>

          {/*
            * INVOICE-TAX-FLOW-01B — die §13b-Bestätigung stand bis hierher an
            * dieser Stelle, also unterhalb der vollständigen Vorschau. Sie ist
            * jetzt Teil der Steuerentscheidung im Positionsschritt. Derselbe
            * State, keine zweite Variable; die Freigabe- und Finalize-Prüfungen
            * lesen ihn unverändert.
            */}
          {validationErrors.length > 0 ? (
            <Card className="invoice-validation invoice-validation--errors" data-testid="invoice-validation-errors">
              <strong>{translate('invoice.validation.blockingTitle')}</strong>
              <ul>
                {validationErrors.map((key) => (
                  <li key={key}>{translate(key)}</li>
                ))}
              </ul>
            </Card>
          ) : null}

          {validationWarnings.length > 0 ? (
            <Card className="invoice-validation invoice-validation--warnings" data-testid="invoice-validation-warnings">
              <strong>{translate('invoice.validation.warningTitle')}</strong>
              <ul>
                {validationWarnings.map((key) => (
                  <li key={key}>{translate(key)}</li>
                ))}
              </ul>
            </Card>
          ) : null}

          {showCompanyDriftConfirm && (
            <Card className="invoice-confirm" data-testid="invoice-company-drift-confirm">
              <strong>{translate('invoice.companyDrift.title')}</strong>
              <p>{translate('invoice.companyDrift.message')}</p>
              {/*
                * COMPANY-PROFILE-DRAFT-DRIFT-01F — Feldnamen allein tragen die
                * Entscheidung nicht.
                *
                * „IBAN geändert" sagt einem Betrieb nicht, ob die Rechnung auf
                * das alte oder das neue Konto zeigt. Deshalb steht hier der
                * bisherige neben dem aktuellen Wert — nur für die tatsächlich
                * abweichenden Felder, unveränderlich und ohne Eingabefelder.
                */}
              <dl className="invoice-drift-list" data-testid="invoice-company-drift-fields">
                {companyDriftFields.map((field) => (
                  <div className="invoice-drift-list__item" key={field}>
                    <dt>{translate(`invoice.companyDrift.field.${field}` as TranslationKey)}</dt>
                    <dd>
                      <span className="invoice-drift-list__label">
                        {translate('invoice.companyDrift.before')}
                      </span>
                      <span className="invoice-drift-list__value">
                        {draft.companySnapshot[field]?.trim() ||
                          translate('invoice.companyDrift.empty')}
                      </span>
                    </dd>
                    <dd>
                      <span className="invoice-drift-list__label">
                        {translate('invoice.companyDrift.after')}
                      </span>
                      <span className="invoice-drift-list__value invoice-drift-list__value--next">
                        {companyDriftProfile?.[field]?.trim() ||
                          translate('invoice.companyDrift.empty')}
                      </span>
                    </dd>
                  </div>
                ))}
              </dl>
              <div className="invoice-confirm__actions">
                <Button
                  variant="outline"
                  onClick={handleKeepCompanySnapshot}
                  data-testid="invoice-company-drift-keep"
                >
                  {translate('invoice.companyDrift.keep')}
                </Button>
                <Button onClick={handleApplyCompanyDrift} data-testid="invoice-company-drift-apply">
                  {translate('invoice.companyDrift.apply')}
                </Button>
              </div>
            </Card>
          )}

          {showOverbillingConfirm && (
            <Card className="invoice-confirm">
              <p>{translate('invoice.overbillingConfirm')}</p>
              <div className="invoice-confirm__actions">
                <Button variant="outline" onClick={() => setShowOverbillingConfirm(false)}>
                  {translate('common.cancel')}
                </Button>
                <Button onClick={handleConfirmOverbilling} data-testid="invoice-approve-anyway">
                  {translate('invoice.saveAnyway')}
                </Button>
              </div>
            </Card>
          )}

          {finalizationLocked ? (
            <Card className="invoice-validation" data-testid="invoice-session-locked">
              <p>
                {translate(
                  sessionStatus === 'already_finalized'
                    ? 'invoice.session.alreadyFinalized'
                    : 'invoice.session.finalizationPending',
                )}
              </p>
              {sessionStatus === 'already_finalized' && finalizedInvoiceId ? (
                <Button
                  onClick={() =>
                    navigate(`/vorgaenge/${id}/rechnungen/${finalizedInvoiceId}`)
                  }
                  data-testid="invoice-open-finalized"
                >
                  {translate('invoice.session.openFinalized')}
                </Button>
              ) : null}
              {sessionStatus === 'finalization_pending' && resumeRecovery === 'retry_allowed' ? (
                <Button onClick={handleResumeRetry} data-testid="invoice-resume-retry">
                  {translate('invoice.resume.retryAction')}
                </Button>
              ) : null}
              {sessionStatus === 'finalization_pending' && resumeRecovery === 'reload_required' ? (
                <Button
                  variant="outline"
                  onClick={() => window.location.reload()}
                  data-testid="invoice-resume-reload"
                >
                  {translate('invoice.resume.reloadAction')}
                </Button>
              ) : null}
            </Card>
          ) : null}

          <div className="action-stack">
            <Button
              fullWidth
              onClick={() => setStep('edit')}
              disabled={finalizationLocked}
              data-testid="invoice-edit"
            >
              {translate('invoice.edit')}
            </Button>
            {finalizationLocked ? null : (
              <Button
                fullWidth
                onClick={handleApprove}
                disabled={approving}
                data-testid="invoice-approve"
              >
                {approving ? translate('invoice.approve.working') : translate('invoice.approve')}
              </Button>
            )}
            <Button
              variant="outline"
              fullWidth
              onClick={() => setStep('positions')}
              data-testid="invoice-back-positions"
            >
              {translate('invoice.backToPositions')}
            </Button>
          </div>
        </>
      )}

      {step === 'edit' && (
        <>
          {renderTaxDecision(draft)}
          <Card>
            <InvoiceDraftEditForm
              draft={draft}
              onChange={handleMetadataChange}
              customerMaster={
                masterCustomer && masterBilling ? (
                  <div className="invoice-customer-master" data-testid="invoice-customer-master">
                    <p className="hint-text" data-testid="invoice-customer-master-source">
                      {translate('invoice.customerMaster.source')}: {masterCustomer.name},{' '}
                      {`${masterCustomer.street}, ${masterCustomer.zip} ${masterCustomer.city}`.trim()}
                    </p>
                    <p className="hint-text">{translate('invoice.customerMaster.scope')}</p>

                    {customerMasterConfirm ? (
                      <Card data-testid="invoice-customer-master-confirm">
                        <p>{translate('invoice.customerMaster.confirmText')}</p>
                        <p className="hint-text">{translate('invoice.customerMaster.scope')}</p>
                        <div className="form-actions">
                          <Button
                            type="button"
                            data-testid="invoice-customer-master-apply"
                            onClick={applyMasterBilling}
                          >
                            {translate('invoice.customerMaster.confirmAction')}
                          </Button>
                          <Button
                            variant="secondary"
                            type="button"
                            data-testid="invoice-customer-master-cancel"
                            onClick={() => {
                              setCustomerMasterConfirm(false);
                              setCustomerMasterError(null);
                            }}
                          >
                            {translate('common.cancel')}
                          </Button>
                        </div>
                      </Card>
                    ) : (
                      <Button
                        variant="secondary"
                        type="button"
                        data-testid="invoice-customer-master-action"
                        disabled={!masterAddressComplete || masterMatchesDraft}
                        onClick={() => {
                          setCustomerMasterError(null);
                          if (masterMatchesDraft) return;
                          setCustomerMasterConfirm(true);
                        }}
                      >
                        {translate('invoice.customerMaster.action')}
                      </Button>
                    )}

                    {!masterAddressComplete && (
                      <p className="hint-text" data-testid="invoice-customer-master-incomplete">
                        {translate('invoice.customerMaster.incomplete')}
                      </p>
                    )}
                    {masterAddressComplete && masterMatchesDraft && (
                      <p className="hint-text" data-testid="invoice-customer-master-identical">
                        {translate('invoice.customerMaster.identical')}
                      </p>
                    )}
                    {customerMasterError && (
                      <p className="form-error" data-testid="invoice-customer-master-error">
                        {customerMasterError}
                      </p>
                    )}
                  </div>
                ) : customerMasterError ? (
                  // Source gone after the click: neither action nor source, but the
                  // reason stays visible until the draft is rebuilt.
                  <div
                    className="invoice-customer-master"
                    data-testid="invoice-customer-master-failed"
                  >
                    <p className="form-error" data-testid="invoice-customer-master-error">
                      {customerMasterError}
                    </p>
                  </div>
                ) : null
              }
            />
          </Card>
          <div className="action-stack">
            {/* Dieselbe Sperre wie im Positionsschritt: Wer hier §13b wählt,
                kommt ohne erneute Bestätigung nicht in die Vorschau zurück. */}
            <Button
              fullWidth
              disabled={!taxDecisionSettled}
              onClick={() => setStep('preview')}
              data-testid="invoice-back-preview"
            >
              {translate('invoice.backToPreview')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

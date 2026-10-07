/**
 * AUFTRAG-02C — einen Auftrag ohne vorheriges Angebot erfassen.
 *
 * Solange hier gearbeitet wird, existiert nur ein Entwurf auf diesem Gerät:
 * kein Vorgang, keine Auftragsnummer, nichts in der Cloud. Das steht auch so
 * auf der Seite, damit niemand einen halbfertigen Entwurf für einen Auftrag
 * hält.
 *
 * Die Anlage ist ein bewusster, bestätigter Schritt (confirm-first): Erst
 * danach vergibt der Server die Nummer, friert den kaufmännischen Stand ein
 * und der Auftrag ist ein Vorgang wie jeder andere — mit Rechnungen,
 * Abschlägen und dem bestehenden Nachtragsweg.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { buildCustomerOptionLabels } from '../services/customer/customerOptionLabels';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { PageHeader } from '../components/ui/Card';
import { Page } from '../components/ui/Page';
import { DetailSection } from '../components/ui/Section';
import { SimpleConfirmDialog } from '../components/ui/SimpleConfirmDialog';
import { InlineNotice } from '../components/ui/States';
import { DraftCloudConflictNotice, type DraftCloudConflictAction } from '../components/order/DraftCloudConflictNotice';
import { useDraftCloudTick } from '../services/order/useDraftCloudTick';
import { useApp } from '../context/AppContext';
import { useOptionalAuth } from '../context/AuthContext';
import { isSupabaseConfigured } from '../lib/supabase';
import { resolveWorkspaceWriteAccess } from '../services/workspace/workspaceRoleService';
import { getCustomerById, getCustomerStoreSnapshot } from '../services/customerStoreService';
import { getCompanyProfileStoreSnapshot } from '../services/companyProfileService';
import { buildDefaultPaymentTerms, resolveDefaultTaxStatus } from '../services/invoice/invoiceDefaults';
import { getTaxStatusLabel } from '../services/invoiceTaxService';
import { formatInvoiceCurrency } from '../services/invoicePrintModel';
import { calculateLineItemTotals } from '../services/invoiceService';
import { buildPersistedStateSnapshot } from '../services/persistenceService';
import { resolveCloudWorkspaceId } from '../services/workspace/workspaceSyncPayloadService';
import { generateEntityId } from '../services/sync/syncMetaService';
import {
  acceptOrderDraftCloudEnd,
  continueOrderDraftAsNew,
  createOrderDraft,
  deleteOrderDraft,
  discardOrderDraftAgain,
  emptyOrderDraftCustomerBilling,
  getOrderDraftBlockers,
  getOrderDraftById,
  isOrderDraftCloudSyncAllowed,
  keepLocalOrderDraftVersion,
  keepOrderDraftAfterRejectedDiscard,
  resolveOrderDraftRoute,
  takeCloudOrderDraftVersion,
  updateOrderDraft,
  type OrderDraftCloudDecisionResult,
} from '../services/order/orderDraftService';
import { createOrderFromDraftWithCloud } from '../services/order/createOrderCloudService';
import type { CustomerBilling, OrderUnit, TaxStatus } from '../types/models';
import type { OrderDraft, OrderDraftPosition } from '../types/orderDraft';
import type { TranslationKey } from '../i18n';
import { DEFAULT_SETUP } from '../data/mockData';

const ORDER_UNITS: OrderUnit[] = ['Stück', 'Stunden', 'Meter', 'm²', 'Pauschal'];
const TAX_STATUSES: TaxStatus[] = ['standard_19', 'standard_7', 'kleinunternehmer_19', 'reverse_charge_13b', 'tax_free'];

function Field({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`invoice-edit__field${wide ? ' offer-editor__field--wide' : ''}`}>
      <span className="invoice-edit__label">{label}</span>
      {children}
    </label>
  );
}

function neuePosition(): OrderDraftPosition {
  return { id: generateEntityId('op'), description: '', plannedQuantity: 1, unit: 'Stunden', unitPrice: 0 };
}

interface EditorWerte {
  customerId?: string;
  customerBilling: CustomerBilling;
  title: string;
  baustelle: string;
  positions: OrderDraftPosition[];
  taxStatus: TaxStatus;
  paymentTermsText: string;
  introText?: string;
  closingText?: string;
}

/**
 * CLOUD-SYNC S6 — ein Vergleichsschlüssel der bearbeitbaren Inhalte, in fester
 * Reihenfolge (die Rechnungsanschrift nach Feldnamen sortiert): Er dient nur
 * dazu, ungespeicherte Eingaben und eine Änderung darunter zu erkennen.
 */
function werteSchluessel(werte: EditorWerte): string {
  const billing = werte.customerBilling as unknown as Record<string, unknown>;
  return JSON.stringify([
    werte.customerId || null,
    Object.keys(billing).sort().map((key) => [key, billing[key] ?? null]),
    werte.title,
    werte.baustelle,
    werte.positions.map((p) => [p.id, p.description, p.plannedQuantity, p.unit, p.unitPrice]),
    werte.taxStatus,
    werte.paymentTermsText,
    werte.introText || null,
    werte.closingText || null,
  ]);
}

function werteAusEntwurf(entwurf: OrderDraft, ersatzPosition: () => OrderDraftPosition): EditorWerte {
  return {
    customerId: entwurf.customerId,
    customerBilling: { ...entwurf.customerBilling },
    title: entwurf.title,
    baustelle: entwurf.baustelle,
    positions: entwurf.positions.length ? entwurf.positions.map((p) => ({ ...p })) : [ersatzPosition()],
    taxStatus: entwurf.taxStatus,
    paymentTermsText: entwurf.paymentTermsText,
    introText: entwurf.introText,
    closingText: entwurf.closingText,
  };
}

function billingOf(customer: Partial<CustomerBilling>): CustomerBilling {
  return {
    name: customer.name ?? '',
    contactPerson: customer.contactPerson ?? '',
    street: customer.street ?? '',
    zip: customer.zip ?? '',
    city: customer.city ?? '',
    email: customer.email ?? '',
    phone: customer.phone ?? '',
  };
}

export function AuftragEditorPage() {
  const { translate, showToast } = useApp();
  const navigate = useNavigate();
  const { draftId } = useParams<{ draftId: string }>();
  const [params] = useSearchParams();
  const route = resolveOrderDraftRoute(draftId);
  const vorhandener = route.kind === 'draft' ? route.draft : null;

  /*
   * AUFTRAG-02C2 — eine konkrete Entwurfsadresse erzeugt nie stillschweigend
   * einen neuen Auftrag.
   *
   * Die Entwurfskennung ist zugleich die Vorgangskennung. Ein Lesezeichen oder
   * ein offener Tab auf `/auftraege/entwurf/<id>` zeigte nach der Bestätigung
   * deshalb einen leeren „Neuer Auftrag"-Editor — und wer dort weitertippte,
   * begann versehentlich einen zweiten Auftrag. Gibt es zu dieser Kennung
   * bereits einen Auftrag, führt die Adresse jetzt dorthin; ist weder Entwurf
   * noch Auftrag vorhanden, sagt die Seite das und bietet den bewussten
   * Neuanfang an.
   */
  const bestaetigterAuftrag = route.kind === 'order' ? route.vorgangId : undefined;

  const user = useOptionalAuth()?.user ?? null;
  const writeAccess = resolveWorkspaceWriteAccess({ userId: user?.id, cloudConfigured: isSupabaseConfigured() });
  const profile = getCompanyProfileStoreSnapshot();
  const kunden = useMemo(() => getCustomerStoreSnapshot(), []);
  // E-MAIL-HALBZEIT-FIX B5 — gleichnamige Kunden unterscheidbar (nur Anzeige).
  const kundenLabels = useMemo(
    () => buildCustomerOptionLabels(kunden, { created: translate('customer.option.created'), id: translate('customer.option.id') }),
    [kunden, translate],
  );
  const startKundeId = vorhandener?.customerId ?? params.get('customerId') ?? '';
  const startKunde = startKundeId ? getCustomerById(startKundeId) : null;

  const [kundeId, setKundeId] = useState(startKundeId);
  const [kunde, setKunde] = useState<CustomerBilling>(
    vorhandener?.customerBilling ??
      (startKunde ? billingOf(startKunde as unknown as CustomerBilling) : emptyOrderDraftCustomerBilling()),
  );
  const [titel, setTitel] = useState(vorhandener?.title ?? '');
  const [baustelle, setBaustelle] = useState(vorhandener?.baustelle ?? '');
  const [taxStatus, setTaxStatus] = useState<TaxStatus>(
    vorhandener?.taxStatus ?? resolveDefaultTaxStatus(profile, DEFAULT_SETUP),
  );
  const [positionen, setPositionen] = useState<OrderDraftPosition[]>(
    vorhandener?.positions?.length ? vorhandener.positions : [neuePosition()],
  );
  const [konditionen, setKonditionen] = useState(
    vorhandener?.paymentTermsText ?? buildDefaultPaymentTerms(profile),
  );
  const [einleitung, setEinleitung] = useState(vorhandener?.introText ?? '');
  const [schluss, setSchluss] = useState(vorhandener?.closingText ?? '');
  const [gespeicherteId, setGespeicherteId] = useState<string | null>(vorhandener?.id ?? null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [anlegenOffen, setAnlegenOffen] = useState(false);
  const [verwerfenOffen, setVerwerfenOffen] = useState(false);
  const [laeuft, setLaeuft] = useState(false);

  /*
   * CLOUD-SYNC S6 — der Editor und sein gespeicherter Entwurf.
   *
   * Der Editor hält seine Eingaben lokal und speichert ausdrücklich. Ein Abzug
   * kann den gespeicherten Entwurf darunter ändern; dann gilt:
   *  - ohne ungespeicherte Eingaben wird die neuere Fassung geladen;
   *  - mit ungespeicherten Eingaben erscheint ein Hinweis, und gespeichert wird
   *    erst nach einer Entscheidung — nie ein stilles Überschreiben.
   * Ein Konflikt am gespeicherten Entwurf sperrt den Editor bis zur
   * Entscheidung. Ohne freigegebenen Entwurfs-Sync ändert sich nichts.
   */
  useDraftCloudTick();
  const cloudAktiv = isOrderDraftCloudSyncAllowed();
  const gespeichert = gespeicherteId ? getOrderDraftById(gespeicherteId) : null;
  const konflikt = gespeichert?.conflict ?? null;
  const gesperrt = Boolean(konflikt);
  const [basis, setBasis] = useState<{ stored: string | null; editor: string } | null>(null);
  const [bereitsAngelegt, setBereitsAngelegt] = useState<{ vorgangId: string; orderNumber?: string } | null>(null);
  const [entscheidungLaeuft, setEntscheidungLaeuft] = useState(false);

  const totals = calculateLineItemTotals(
    positionen.map((p) => ({ quantity: p.plannedQuantity, unitPrice: p.unitPrice })),
    taxStatus,
  );

  const eingaben = () => ({
    customerId: kundeId || undefined,
    customerBilling: kunde,
    title: titel,
    baustelle,
    positions: positionen,
    taxStatus,
    paymentTermsText: konditionen,
    introText: einleitung || undefined,
    closingText: schluss || undefined,
  });

  const blocker = getOrderDraftBlockers({ customerBilling: kunde, title: titel, positions: positionen });

  const editorSchluessel = werteSchluessel(eingaben());
  const gespeichertSchluessel = gespeichert ? werteSchluessel(gespeichert) : null;
  const ungespeichert = basis !== null && editorSchluessel !== basis.editor;
  const fremdGeaendert = Boolean(
    cloudAktiv && basis && gespeichert && !konflikt && gespeichertSchluessel !== basis.stored,
  );

  /** Lädt einen gespeicherten Stand in den Editor und macht ihn zur neuen Basis. */
  const ladeGespeichert = (entwurf: OrderDraft) => {
    const werte = werteAusEntwurf(entwurf, neuePosition);
    setKundeId(werte.customerId ?? '');
    setKunde(werte.customerBilling);
    setTitel(werte.title);
    setBaustelle(werte.baustelle);
    setTaxStatus(werte.taxStatus);
    setPositionen(werte.positions);
    setKonditionen(werte.paymentTermsText);
    setEinleitung(werte.introText ?? '');
    setSchluss(werte.closingText ?? '');
    setGespeicherteId(entwurf.id);
    setBasis({ stored: werteSchluessel(entwurf), editor: werteSchluessel(werte) });
  };

  // Die Basis entsteht mit dem ersten Stand des Editors.
  useEffect(() => {
    if (basis === null) setBasis({ stored: gespeichertSchluessel, editor: editorSchluessel });
  }, [basis, gespeichertSchluessel, editorSchluessel]);

  // Neuere Fassung aus der Cloud, hier nichts Ungespeichertes: übernehmen.
  useEffect(() => {
    if (fremdGeaendert && !ungespeichert && gespeichert) ladeGespeichert(gespeichert);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fremdGeaendert, ungespeichert, gespeichertSchluessel]);

  const entscheide = async (action: DraftCloudConflictAction): Promise<boolean> => {
    if (!gespeicherteId) return false;
    setEntscheidungLaeuft(true);
    try {
      let result: OrderDraftCloudDecisionResult;
      switch (action) {
        case 'takeCloud':
          result = takeCloudOrderDraftVersion(gespeicherteId);
          break;
        case 'keepMine':
          result = keepLocalOrderDraftVersion(gespeicherteId);
          break;
        case 'acceptEnd':
          result = acceptOrderDraftCloudEnd(gespeicherteId);
          break;
        case 'continueAsNew':
          result = continueOrderDraftAsNew(gespeicherteId);
          break;
        case 'keepDraft':
          result = keepOrderDraftAfterRejectedDiscard(gespeicherteId);
          break;
        default:
          result = discardOrderDraftAgain(gespeicherteId);
      }
      if (!result.ok) return false;
      if (action === 'acceptEnd' || action === 'discardAgain') {
        navigate('/vorgaenge');
        return true;
      }
      const naechsteId = result.draftId ?? gespeicherteId;
      const frisch = getOrderDraftById(naechsteId);
      if (frisch) ladeGespeichert(frisch);
      if (result.draftId) navigate(`/auftraege/entwurf/${result.draftId}`, { replace: true });
      return true;
    } finally {
      setEntscheidungLaeuft(false);
    }
  };

  /** Der Entwurf wurde anderswo beendet, hier stehen noch Eingaben: als neuen Entwurf sichern. */
  const sichereAlsNeu = () => {
    setFehler(null);
    const workspaceId = resolveCloudWorkspaceId(buildPersistedStateSnapshot());
    const r = createOrderDraft(workspaceId, eingaben());
    if (!r.success) {
      setFehler(translate(r.errorKey as TranslationKey));
      return;
    }
    ladeGespeichert(r.draft);
    navigate(`/auftraege/entwurf/${r.draft.id}`, { replace: true });
  };

  const wechsleKunde = (id: string) => {
    setKundeId(id);
    const gewaehlt = id ? getCustomerById(id) : null;
    if (gewaehlt) setKunde(billingOf(gewaehlt as unknown as CustomerBilling));
  };

  const setPos = (index: number, changes: Partial<OrderDraftPosition>) => {
    setPositionen((prev) => prev.map((p, i) => (i === index ? { ...p, ...changes } : p)));
  };

  /** Speichert den Entwurf und gibt seine Kennung zurück (sie bleibt stabil). */
  const speichern = (): string | null => {
    setFehler(null);
    if (gesperrt) {
      setFehler(translate('order.draft.conflictOpen'));
      return null;
    }
    if (fremdGeaendert && ungespeichert) {
      setFehler(translate('orderDraftCloud.remoteChanged.saveBlocked'));
      return null;
    }
    if (gespeicherteId) {
      const r = updateOrderDraft(gespeicherteId, eingaben());
      if (!r.success) {
        setFehler(translate(r.errorKey as TranslationKey));
        return null;
      }
      setBasis({ stored: werteSchluessel(r.draft), editor: editorSchluessel });
      return r.draft.id;
    }
    const workspaceId = resolveCloudWorkspaceId(buildPersistedStateSnapshot());
    const r = createOrderDraft(workspaceId, eingaben());
    if (!r.success) {
      setFehler(translate(r.errorKey as TranslationKey));
      return null;
    }
    setGespeicherteId(r.draft.id);
    setBasis({ stored: werteSchluessel(r.draft), editor: editorSchluessel });
    return r.draft.id;
  };

  const handleSpeichern = () => {
    const id = speichern();
    if (!id) return;
    showToast(translate('order.draft.saved'));
    navigate(`/auftraege/entwurf/${id}`, { replace: true });
  };

  const handleAnlegen = async (): Promise<boolean> => {
    setAnlegenOffen(false);
    setFehler(null);
    setLaeuft(true);
    try {
      const id = speichern();
      if (!id) return true;
      const r = await createOrderFromDraftWithCloud(id);
      if (!r.ok) {
        // CLOUD-SYNC S6 — „bereits als Auftrag angelegt" ist kein Erfolg und kein stiller Fehler.
        if (r.reason === 'already_created') {
          setBereitsAngelegt({ vorgangId: r.vorgangId, orderNumber: r.orderNumber });
          return true;
        }
        const key: TranslationKey =
          r.reason === 'cloud_required'
            ? 'order.confirm.cloudRequired'
            : r.reason === 'network'
              ? 'order.confirm.network'
              : r.reason === 'server_rejected'
                ? 'order.confirm.serverRejected'
                : r.reason === 'blocked'
                  ? 'order.blocked.position_invalid'
                  : r.reason === 'draft_not_synced'
                    ? 'orderDraftCloud.create.notSynced'
                    : r.reason === 'draft_conflict'
                      ? 'orderDraftCloud.create.conflict'
                      : r.reason === 'draft_ended'
                        ? 'orderDraftCloud.create.ended'
                        : 'order.draft.notFound';
        // CLOUD-SYNC S6 — bei fehlender Verbindung reicht der Satz; kein technischer Fehlertext für den Nutzer.
        setFehler(`${translate(key)}${'message' in r && r.reason !== 'network' ? ` (${r.message})` : ''}`);
        return true;
      }
      showToast(translate('order.confirm.success').replace('{number}', r.vorgang.orderNumber ?? ''));
      navigate(`/vorgaenge/${r.vorgang.id}`);
      return true;
    } finally {
      setLaeuft(false);
    }
  };

  const handleVerwerfen = (): boolean => {
    if (gespeicherteId) {
      const r = deleteOrderDraft(gespeicherteId);
      if (!r.success) {
        // Der Entwurf ist unverändert erhalten; der Dialog bleibt mit dem Hinweis offen.
        setFehler(translate(r.errorKey as TranslationKey));
        return false;
      }
    }
    setVerwerfenOffen(false);
    navigate('/vorgaenge');
    return true;
  };

  /*
   * CLOUD-SYNC S6 — der Entwurf ist anderswo beendet worden (verworfen oder
   * zum Auftrag geworden), während hier ungespeicherte Eingaben stehen: Der
   * Editor bleibt mit einem Hinweis stehen, statt die Eingaben wegzuleiten.
   */
  const verwaist = Boolean(draftId && !vorhandener && ungespeichert);

  /*
   * CLOUD-SYNC S6 — „bereits als Auftrag angelegt" bleibt stehen, bis der
   * Nutzer zum Auftrag geht: Der Abgleich während und nach der Anlage entfernt
   * den verbrauchten Entwurf, und ohne diesen Halt leitete die Seite still
   * weiter. Solange die Anlage läuft, entscheidet erst ihr Ergebnis.
   */
  const beendet = Boolean(bereitsAngelegt);

  if (draftId && !vorhandener && !verwaist && !beendet && !laeuft) {
    if (bestaetigterAuftrag) return <Navigate to={`/vorgaenge/${bestaetigterAuftrag}`} replace />;
    return (
      <Page className="offer-editor" testId="order-editor-missing">
        <PageHeader
          title={translate('order.new.title')}
          backLabel={translate('nav.vorgaenge')}
          backHref="/vorgaenge"
          backTestId="order-editor-back"
        />
        <p className="form-hint" data-testid="order-draft-missing">{translate('order.draft.notFound')}</p>
        <div className="form-actions">
          <Button type="button" onClick={() => navigate('/auftraege/neu')} data-testid="order-draft-missing-new">
            {translate('order.new.action')}
          </Button>
        </div>
      </Page>
    );
  }

  return (
    <Page className="offer-editor" testId="order-editor-page">
      <PageHeader
        title={translate('order.new.title')}
        subtitle={translate('order.new.subtitle')}
        backLabel={translate('nav.vorgaenge')}
        backHref="/vorgaenge"
        backTestId="order-editor-back"
      />

      {/* Bis zur Bestätigung gibt es keinen Auftrag — das soll man sehen. */}
      <p className="form-hint" data-testid="order-draft-badge">
        <strong>{translate('order.draft.badge')}</strong> {translate('order.draft.hint')}
      </p>

      {fehler ? (
        <p className="form-error" role="alert" data-testid="order-editor-error">
          {fehler}
        </p>
      ) : null}

      {konflikt ? (
        <DraftCloudConflictNotice
          kind={konflikt.kind}
          textPrefix="orderDraftCloud"
          translate={translate}
          busy={entscheidungLaeuft}
          onDecide={entscheide}
          orderLink={
            gespeicherteId
              ? { label: translate('orderDraftCloud.action.openOrder'), onOpen: () => navigate(`/vorgaenge/${gespeicherteId}`) }
              : undefined
          }
          testIdPrefix="order-draft-cloud"
        />
      ) : null}

      {fremdGeaendert && ungespeichert ? (
        <InlineNotice
          tone="warning"
          testId="order-draft-remote-changed"
          title={translate('orderDraftCloud.remoteChanged.title')}
          action={
            <div className="form-actions">
              <Button
                type="button"
                size="sm"
                variant="primary"
                onClick={() => {
                  if (gespeichert) ladeGespeichert(gespeichert);
                }}
                data-testid="order-draft-remote-load"
              >
                {translate('orderDraftCloud.remoteChanged.load')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => setBasis((prev) => (prev ? { ...prev, stored: gespeichertSchluessel } : prev))}
                data-testid="order-draft-remote-keep"
              >
                {translate('orderDraftCloud.remoteChanged.keep')}
              </Button>
            </div>
          }
        >
          {translate('orderDraftCloud.remoteChanged.body')}
        </InlineNotice>
      ) : null}

      {verwaist ? (
        <InlineNotice
          tone="warning"
          testId="order-draft-gone"
          title={translate('orderDraftCloud.gone.title')}
          action={
            <div className="form-actions">
              <Button type="button" size="sm" variant="primary" onClick={sichereAlsNeu} data-testid="order-draft-gone-save-as-new">
                {translate('orderDraftCloud.gone.saveAsNew')}
              </Button>
              {bestaetigterAuftrag ? (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => navigate(`/vorgaenge/${bestaetigterAuftrag}`)}
                  data-testid="order-draft-gone-open-order"
                >
                  {translate('orderDraftCloud.action.openOrder')}
                </Button>
              ) : null}
            </div>
          }
        >
          {translate('orderDraftCloud.gone.body')}
        </InlineNotice>
      ) : null}

      {bereitsAngelegt ? (
        <InlineNotice
          tone="info"
          testId="order-draft-already-created"
          title={translate('orderDraftCloud.create.alreadyCreated')}
          action={
            <Button
              type="button"
              size="sm"
              variant="primary"
              onClick={() => navigate(`/vorgaenge/${bereitsAngelegt.vorgangId}`)}
              data-testid="order-draft-already-created-open"
            >
              {translate('orderDraftCloud.action.openOrder')}
              {bereitsAngelegt.orderNumber ? ` ${bereitsAngelegt.orderNumber}` : ''}
            </Button>
          }
        >
          {translate('orderDraftCloud.create.alreadyCreatedBody')}
        </InlineNotice>
      ) : null}

      <fieldset
        className="order-editor__fields"
        disabled={gesperrt || verwaist || beendet}
        data-testid="order-editor-fields"
        style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
      >

      <DetailSection title={translate('order.editor.customerSection')}>
        <Field label={translate('order.editor.customerPick')}>
          <select className="input" value={kundeId} onChange={(e) => wechsleKunde(e.target.value)} data-testid="order-customer">
            <option value="">{translate('order.editor.customerNone')}</option>
            {kunden.map((k) => (
              <option key={k.id} value={k.id}>
                {kundenLabels.get(k.id) ?? k.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="offer-editor__grid">
          <Field label={translate('order.editor.customer')} wide>
            <input className="input" value={kunde.name} onChange={(e) => setKunde({ ...kunde, name: e.target.value })} data-testid="order-customer-name" />
          </Field>
          <Field label={translate('order.editor.contactPerson')}>
            <input className="input" value={kunde.contactPerson} onChange={(e) => setKunde({ ...kunde, contactPerson: e.target.value })} data-testid="order-customer-contact" />
          </Field>
          <Field label={translate('order.editor.street')}>
            <input className="input" value={kunde.street} onChange={(e) => setKunde({ ...kunde, street: e.target.value })} data-testid="order-customer-street" />
          </Field>
          <Field label={translate('order.editor.zip')}>
            <input className="input" value={kunde.zip} onChange={(e) => setKunde({ ...kunde, zip: e.target.value })} data-testid="order-customer-zip" />
          </Field>
          <Field label={translate('order.editor.city')}>
            <input className="input" value={kunde.city} onChange={(e) => setKunde({ ...kunde, city: e.target.value })} data-testid="order-customer-city" />
          </Field>
          <Field label={translate('order.editor.email')}>
            <input className="input" type="email" value={kunde.email} onChange={(e) => setKunde({ ...kunde, email: e.target.value })} data-testid="order-customer-email" />
          </Field>
          <Field label={translate('order.editor.phone')}>
            <input className="input" value={kunde.phone} onChange={(e) => setKunde({ ...kunde, phone: e.target.value })} data-testid="order-customer-phone" />
          </Field>
        </div>
        <p className="form-hint">{translate('order.editor.billingHint')}</p>
      </DetailSection>

      <DetailSection title={translate('order.editor.orderSection')}>
        <div className="offer-editor__grid">
          <Field label={translate('order.editor.title')} wide>
            <input className="input" value={titel} onChange={(e) => setTitel(e.target.value)} data-testid="order-title" />
          </Field>
          <Field label={translate('order.editor.baustelle')} wide>
            <input className="input" value={baustelle} onChange={(e) => setBaustelle(e.target.value)} data-testid="order-baustelle" />
          </Field>
          <Field label={translate('order.editor.taxStatus')} wide>
            <select className="input" value={taxStatus} onChange={(e) => setTaxStatus(e.target.value as TaxStatus)} data-testid="order-tax-status">
              {TAX_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {getTaxStatusLabel(s)}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </DetailSection>

      <DetailSection title={translate('order.editor.positionsSection')}>
        {positionen.length === 0 ? (
          <p className="form-hint" data-testid="order-positions-empty">{translate('order.editor.positionsEmpty')}</p>
        ) : null}
        <ol className="offer-editor__positions" data-testid="order-positions">
          {positionen.map((p, i) => (
            <li key={p.id} className="offer-editor__position" data-testid={`order-position-${i}`}>
              <span className="offer-editor__position-index">{i + 1}</span>
              <Field label={translate('order.editor.positionDescription')} wide>
                <input className="input" value={p.description} onChange={(e) => setPos(i, { description: e.target.value })} data-testid={`order-position-${i}-description`} />
              </Field>
              <Field label={translate('order.editor.positionQuantity')}>
                <input className="input" type="number" inputMode="decimal" min={0} step="0.01" value={p.plannedQuantity} onChange={(e) => setPos(i, { plannedQuantity: Number(e.target.value) })} data-testid={`order-position-${i}-quantity`} />
              </Field>
              <Field label={translate('order.editor.positionUnit')}>
                <select className="input" value={p.unit} onChange={(e) => setPos(i, { unit: e.target.value as OrderUnit })} data-testid={`order-position-${i}-unit`}>
                  {ORDER_UNITS.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={translate('order.editor.positionPrice')}>
                <input className="input" type="number" inputMode="decimal" min={0} step="0.01" value={p.unitPrice} onChange={(e) => setPos(i, { unitPrice: Number(e.target.value) })} data-testid={`order-position-${i}-unit-price`} />
              </Field>
              <button type="button" className="btn btn--ghost offer-editor__position-remove" onClick={() => setPositionen((prev) => prev.filter((_, j) => j !== i))} data-testid={`order-position-${i}-remove`}>
                {translate('order.editor.positionRemove')}
              </button>
            </li>
          ))}
        </ol>
        <Button type="button" variant="secondary" onClick={() => setPositionen((prev) => [...prev, neuePosition()])} data-testid="order-position-add">
          {translate('order.editor.positionAdd')}
        </Button>

        <dl className="offer-editor__totals" data-testid="order-totals">
          <div>
            <dt>{translate('order.editor.subtotal')}</dt>
            <dd data-testid="order-total-net">{formatInvoiceCurrency(totals.subtotal)}</dd>
          </div>
          {totals.taxRate > 0 ? (
            <div>
              <dt>
                {translate('order.editor.tax')} ({totals.taxRate} %)
              </dt>
              <dd data-testid="order-total-tax">{formatInvoiceCurrency(totals.tax)}</dd>
            </div>
          ) : null}
          <div className="offer-editor__totals-gross">
            <dt>{translate('order.editor.total')}</dt>
            <dd data-testid="order-total-gross">{formatInvoiceCurrency(totals.total)}</dd>
          </div>
        </dl>
      </DetailSection>

      <DetailSection title={translate('order.editor.paymentTerms')}>
        <Field label={translate('order.editor.paymentTerms')}>
          <textarea className="input" rows={2} value={konditionen} onChange={(e) => setKonditionen(e.target.value)} data-testid="order-terms" />
        </Field>
        <Field label={translate('order.editor.intro')}>
          <textarea className="input" rows={2} value={einleitung} onChange={(e) => setEinleitung(e.target.value)} data-testid="order-intro" />
        </Field>
        <Field label={translate('order.editor.closing')}>
          <textarea className="input" rows={2} value={schluss} onChange={(e) => setSchluss(e.target.value)} data-testid="order-closing" />
        </Field>
      </DetailSection>
      </fieldset>

      {blocker.length > 0 ? (
        <ul className="form-hint" data-testid="order-blockers">
          {blocker.map((b) => (
            <li key={b}>{translate(`order.blocked.${b}` as TranslationKey)}</li>
          ))}
        </ul>
      ) : null}
      {!writeAccess.canWrite ? (
        <p className="form-hint" data-testid="order-role-hint">{translate('order.confirm.roleHint')}</p>
      ) : null}

      <div className="form-actions offer-editor__actions">
        <Button
          type="button"
          variant="secondary"
          onClick={handleSpeichern}
          data-testid="order-save-draft"
          disabled={laeuft || gesperrt || verwaist || beendet}
        >
          {translate('order.draft.save')}
        </Button>
        <Button
          type="button"
          onClick={() => setAnlegenOffen(true)}
          data-testid="order-confirm"
          disabled={laeuft || blocker.length > 0 || !writeAccess.canWrite || gesperrt || verwaist || Boolean(bereitsAngelegt)}
        >
          {translate('order.confirm.action')}
        </Button>
        {gespeicherteId && !gesperrt && !verwaist && !beendet ? (
          <Button type="button" variant="ghost" onClick={() => setVerwerfenOffen(true)} data-testid="order-delete-draft">
            {translate('order.draft.discard')}
          </Button>
        ) : null}
      </div>
      <p className="form-hint">{translate('order.confirm.note')}</p>

      <SimpleConfirmDialog
        open={anlegenOffen}
        title={translate('order.confirm.title')}
        message={`${translate('order.confirm.text')
          .replace('{title}', titel)
          .replace('{customer}', kunde.name)
          .replace('{total}', formatInvoiceCurrency(totals.total))
          .replace('{tax}', getTaxStatusLabel(taxStatus))} ${translate('order.confirm.note')}`}
        confirmLabel={translate('order.confirm.confirm')}
        cancelLabel={translate('common.cancel')}
        dialogTestId="order-confirm-dialog"
        confirmTestId="order-confirm-confirm"
        cancelTestId="order-confirm-cancel"
        onConfirm={handleAnlegen}
        onCancel={() => setAnlegenOffen(false)}
      />
      <SimpleConfirmDialog
        open={verwerfenOffen}
        title={translate('order.draft.discardTitle')}
        message={translate(cloudAktiv ? 'orderDraftCloud.discardText' : 'order.draft.discardText')}
        confirmLabel={translate('order.draft.discard')}
        cancelLabel={translate('common.cancel')}
        confirmVariant="danger"
        failureMessage={translate('order.draft.discardFailed')}
        dialogTestId="order-delete-dialog"
        confirmTestId="order-delete-confirm"
        cancelTestId="order-delete-cancel"
        onConfirm={handleVerwerfen}
        onCancel={() => setVerwerfenOffen(false)}
      />
    </Page>
  );
}

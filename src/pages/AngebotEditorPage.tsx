/**
 * ANGEBOT-01B — ein Angebot erstellen und als Entwurf bearbeiten.
 *
 * Ein zusammenhängender Arbeitsbereich: oben der Kunde, dann Betreff und
 * Gültigkeit, die Positionen, die Texte. Wer aus der Kundenakte kommt, findet
 * den Kunden vorbelegt und kann die Anschrift trotzdem anpassen — sie gehört
 * ab hier zum Angebot, nicht mehr zum Kundenstamm.
 *
 * Die Freigabe ist ein bewusster, bestätigter Schritt (confirm-first): Erst
 * danach vergibt der Server die Nummer, und das Angebot ist eingefroren.
 * Freigegebene Angebote öffnen nicht diesen Editor, sondern die Detailseite.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { buildCustomerOptionLabels } from '../services/customer/customerOptionLabels';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { InlineNotice } from '../components/ui/States';
import { useDraftCloudTick } from '../services/order/useDraftCloudTick';
import { PageHeader } from '../components/ui/Card';
import { Page } from '../components/ui/Page';
import { DetailSection } from '../components/ui/Section';
import { NumericInput } from '../components/ui/NumericInput';
import { copyCustomerBilling } from '../services/customer/customerBillingCopy';
import { SimpleConfirmDialog } from '../components/ui/SimpleConfirmDialog';
import { OfferDocumentView } from '../components/offer/OfferDocumentView';
import { useApp } from '../context/AppContext';
import { getCustomerById, getCustomerStoreSnapshot } from '../services/customerStoreService';
import { createCustomer } from '../services/customerService';
import { getCompanyProfileStoreSnapshot } from '../services/companyProfileService';
import { resolveProfileOfferValidityDays } from '../services/company/companyProfileSettingsContract';
import { buildDefaultPaymentTerms, resolveDefaultTaxStatus } from '../services/invoice/invoiceDefaults';
import { getTaxStatusLabel } from '../services/invoiceTaxService';
import { getBusinessDay } from '../services/businessDateService';
import { billingLineTotalMoney } from '../services/invoiceMoney';
import { formatInvoiceCurrency } from '../services/invoicePrintModel';
import { buildPersistedStateSnapshot } from '../services/persistenceService';
import { resolveCloudWorkspaceId } from '../services/workspace/workspaceSyncPayloadService';
import {
  addOfferDraft,
  computeOfferTotals,
  deleteOfferDraft,
  emptyCustomerBilling,
  getOfferById,
  normalizeOfferPosition,
  updateOfferDraft,
} from '../services/offer/offerService';
import { finalizeOfferWithCloud } from '../services/offer/offerFinalizeCloudService';
import { useOptionalAuth } from '../context/AuthContext';
import { isSupabaseConfigured } from '../lib/supabase';
import { resolveWorkspaceWriteAccess } from '../services/workspace/workspaceRoleService';
import { ensureOfferArchived } from '../services/offer/offerArchiveService';
import { offerServerRejectionKey } from '../services/offer/offerServerRejection';
import { buildOfferPrintModel } from '../services/offer/offerPrintModel';
import type { CustomerBilling, OrderUnit, TaxStatus } from '../types/models';
import type { Offer, OfferDraftInput, OfferPosition } from '../types/offer';
import type { TranslationKey } from '../i18n';

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

function inDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  // FINANZ-CORE-01A (ZAH-16) — Angebotsdatum und Gültigkeit als Geschäftstag, nicht als UTC-Tag.
  return getBusinessDay(d);
}

/**
 * FINANZ-CORE-01A (ANG-02) — Vergleichsschlüssel der bearbeitbaren Inhalte, wie
 * im Auftragseditor (`werteSchluessel`). Er erkennt ungespeicherte Eingaben
 * und eine Änderung des gespeicherten Entwurfs darunter, etwa durch den Abzug
 * einer Korrektur von einem anderen Gerät. Ohne ihn schrieben „Speichern" und
 * „Freigeben" den alten Editorstand still über die neuere Fassung — und die
 * Freigabe fror ihn ein.
 */
function angebotSchluessel(werte: OfferDraftInput): string {
  const billing = werte.customer as unknown as Record<string, unknown>;
  return JSON.stringify([
    werte.customerId || null,
    Object.keys(billing).sort().map((key) => [key, billing[key] ?? null]),
    werte.title,
    werte.baustelle ?? '',
    werte.positions.map((p) => [p.id, p.description, p.quantity, p.unit, p.unitLabel ?? null, p.unitPrice, p.category ?? null]),
    werte.taxStatus,
    werte.offerDate ?? '',
    werte.validUntil,
    werte.introText ?? '',
    werte.closingText ?? '',
    werte.paymentTermsText ?? '',
  ]);
}

function werteAusAngebot(angebot: Offer): OfferDraftInput {
  return {
    customerId: angebot.customerId,
    customer: { ...angebot.customer },
    title: angebot.title,
    baustelle: angebot.baustelle,
    positions: angebot.positions.map((p) => ({ ...p })),
    taxStatus: angebot.taxStatus,
    offerDate: angebot.offerDate,
    validUntil: angebot.validUntil,
    introText: angebot.introText,
    closingText: angebot.closingText,
    paymentTermsText: angebot.paymentTermsText,
  };
}

function neuePosition(): OfferPosition {
  return normalizeOfferPosition({ description: '', quantity: 1, unit: 'Stück', unitPrice: 0 });
}

export function AngebotEditorPage() {
  const { translate, setup, showToast } = useApp();
  const navigate = useNavigate();
  /*
   * GO-LIVE-SECURITY-01 — Mitglieder bereiten Angebote vor; freigeben und damit
   * die Angebotsnummer vergeben dürfen nur Inhaber und Admin. Der Server prüft
   * das verbindlich; die Seite bietet nur nichts an, was er ablehnen würde.
   */
  const authUser = useOptionalAuth()?.user ?? null;
  const darfFreigeben = resolveWorkspaceWriteAccess({ userId: authUser?.id, cloudConfigured: isSupabaseConfigured() }).canWrite;
  const { offerId } = useParams<{ offerId: string }>();
  const [params] = useSearchParams();

  const vorhandenes: Offer | null = offerId ? getOfferById(offerId) : null;
  // FINANZ-CORE-01A (ANG-10) — nach dem Anlegen aus dem Editor neu gelesen.
  const [kundenStand, setKundenStand] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const kunden = useMemo(() => getCustomerStoreSnapshot(), [kundenStand]);
  // E-MAIL-HALBZEIT-FIX B5 — gleichnamige Kunden unterscheidbar (nur Anzeige).
  const kundenLabels = useMemo(
    () => buildCustomerOptionLabels(kunden, { created: translate('customer.option.created'), id: translate('customer.option.id') }),
    [kunden, translate],
  );
  const profile = useMemo(() => getCompanyProfileStoreSnapshot(), []);

  const startKundeId = vorhandenes?.customerId ?? params.get('customerId') ?? '';
  const startKunde = startKundeId ? getCustomerById(startKundeId) : undefined;

  const [kundeId, setKundeId] = useState(startKundeId);
  const [kunde, setKunde] = useState<CustomerBilling>(
    vorhandenes?.customer ?? (startKunde ? billingOf(startKunde) : emptyCustomerBilling()),
  );
  const [titel, setTitel] = useState(vorhandenes?.title ?? '');
  const [baustelle, setBaustelle] = useState(vorhandenes?.baustelle ?? '');
  const [angebotsdatum, setAngebotsdatum] = useState(vorhandenes?.offerDate ?? inDays(0));
  // EINRICHTUNG-01 (AP6; V-01.1) — neue Angebote: Gültigkeit, Einleitung und Schluss aus den Vorgaben des Betriebs.
  const [gueltigBis, setGueltigBis] = useState(vorhandenes?.validUntil ?? inDays(resolveProfileOfferValidityDays(profile)));
  const [taxStatus, setTaxStatus] = useState<TaxStatus>(
    vorhandenes?.taxStatus ?? resolveDefaultTaxStatus(profile, setup),
  );
  const [positionen, setPositionen] = useState<OfferPosition[]>(
    vorhandenes?.positions.length ? vorhandenes.positions : [neuePosition()],
  );
  const [einleitung, setEinleitung] = useState(vorhandenes?.introText ?? (profile.offerIntroText ?? '').trim());
  const [schluss, setSchluss] = useState(vorhandenes?.closingText ?? (profile.offerClosingText ?? '').trim());
  const [konditionen, setKonditionen] = useState(
    vorhandenes?.paymentTermsText ?? buildDefaultPaymentTerms(profile),
  );
  const [gespeicherteId, setGespeicherteId] = useState<string | null>(vorhandenes?.id ?? null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [freigabeOffen, setFreigabeOffen] = useState(false);
  const [verwerfenOffen, setVerwerfenOffen] = useState(false);
  const [vorschau, setVorschau] = useState(false);
  const [laeuft, setLaeuft] = useState(false);

  /*
   * FINANZ-CORE-01A (ANG-02) — der Editor und sein gespeicherter Entwurf, wie im
   * Auftragseditor (CLOUD-SYNC S6): Ein Abzug kann den gespeicherten Entwurf
   * darunter ändern. Ohne ungespeicherte Eingaben wird die neuere Fassung
   * geladen; mit ungespeicherten Eingaben erscheint ein Hinweis, und
   * gespeichert oder freigegeben wird erst nach einer Entscheidung.
   */
  useDraftCloudTick();
  const gespeichert = gespeicherteId ? getOfferById(gespeicherteId) : null;
  const [basis, setBasis] = useState<{ stored: string | null; editor: string } | null>(null);

  const eingaben = (): OfferDraftInput => ({
    /*
     * FINANZ-CORE-01A (ANG-05) — eine leere Auswahl entfernt den Kundenbezug
     * ausdrücklich. „undefined" hiess „unverändert", und das Angebot blieb am alten
     * Kunden — die Annahme trug die falsche Kennung in Auftrag und Rechnungen.
     */
    customerId: kundeId,
    customer: kunde,
    title: titel,
    baustelle,
    positions: positionen.map(normalizeOfferPosition),
    taxStatus,
    offerDate: angebotsdatum,
    validUntil: gueltigBis,
    introText: einleitung,
    closingText: schluss,
    paymentTermsText: konditionen,
  });

  const editorSchluessel = angebotSchluessel(eingaben());
  const gespeichertSchluessel =
    gespeichert && gespeichert.status === 'entwurf' ? angebotSchluessel(werteAusAngebot(gespeichert)) : null;
  const ungespeichert = basis !== null && editorSchluessel !== basis.editor;
  const fremdGeaendert = Boolean(basis && gespeichertSchluessel !== null && gespeichertSchluessel !== basis.stored);

  /** Lädt einen gespeicherten Stand in den Editor und macht ihn zur neuen Basis. */
  const ladeGespeichert = (angebot: Offer) => {
    // Die Entscheidung ist gefallen — ein Hinweis „erst entscheiden" wäre jetzt falsch.
    setFehler(null);
    const werte = werteAusAngebot(angebot);
    const editorWerte: OfferDraftInput = {
      ...werte,
      baustelle: werte.baustelle ?? '',
      offerDate: werte.offerDate || inDays(0),
      positions: werte.positions.length ? werte.positions : [neuePosition()],
      introText: werte.introText ?? '',
      closingText: werte.closingText ?? '',
      paymentTermsText: werte.paymentTermsText ?? '',
    };
    setKundeId(editorWerte.customerId ?? '');
    setKunde(editorWerte.customer);
    setTitel(editorWerte.title);
    setBaustelle(editorWerte.baustelle ?? '');
    setAngebotsdatum(editorWerte.offerDate ?? inDays(0));
    setGueltigBis(editorWerte.validUntil);
    setTaxStatus(editorWerte.taxStatus);
    setPositionen(editorWerte.positions);
    setEinleitung(editorWerte.introText ?? '');
    setSchluss(editorWerte.closingText ?? '');
    setKonditionen(editorWerte.paymentTermsText ?? '');
    setBasis({
      stored: angebotSchluessel(werte),
      editor: angebotSchluessel({ ...editorWerte, positions: editorWerte.positions.map(normalizeOfferPosition) }),
    });
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

  // Ein freigegebenes Angebot hat hier nichts zu suchen.
  if (vorhandenes && vorhandenes.status !== 'entwurf') {
    return <Navigate to={`/angebote/${vorhandenes.id}`} replace />;
  }
  if (offerId && !vorhandenes) {
    return <Navigate to="/angebote" replace />;
  }

  const totals = computeOfferTotals(positionen, taxStatus);

  const wechsleKunde = (id: string) => {
    setKundeId(id);
    const c = id ? getCustomerById(id) : undefined;
    if (c) setKunde(billingOf(c));
  };

  /*
   * FINANZ-CORE-01A (ANG-10) — der neue Kunde entsteht aus genau den hier eingegebenen
   * Daten, ohne die Seite zu verlassen. Bisher führte ein Link auf die Kundenliste: voller
   * Seitenwechsel, Eingaben weg, und ein Freitext-Kunde blieb ohne Kundenstamm (Auftrag
   * und Rechnungen ohne Kundenakte). Ein wahrscheinlich doppelter Kunde wird nicht
   * angelegt, sondern zur Auswahl genannt.
   */
  const legeKundenAn = () => {
    setFehler(null);
    const r = createCustomer({
      name: kunde.name,
      contactPerson: kunde.contactPerson,
      street: kunde.street,
      zip: kunde.zip,
      city: kunde.city,
      email: kunde.email,
      phone: kunde.phone,
      ...(kunde.countryCode ? { countryCode: kunde.countryCode } : {}),
      ...(kunde.vatId ? { vatId: kunde.vatId } : {}),
      ...(kunde.leitwegId ? { leitwegId: kunde.leitwegId } : {}),
      ...(kunde.buyerReference ? { buyerReferenceDefault: kunde.buyerReference } : {}),
    });
    if (!r.success) {
      if (r.duplicates?.length) {
        setFehler(
          translate('offer.editor.customerDuplicate').replace(
            '{name}',
            r.duplicates.map((d) => d.customer?.name ?? '').filter(Boolean).join(', '),
          ),
        );
      } else {
        melde(r.errorKey);
      }
      return;
    }
    setKundenStand((n) => n + 1);
    setKundeId(r.customer.id);
  };

  const setPos = (index: number, changes: Partial<OfferPosition>) => {
    setPositionen((prev) => prev.map((p, i) => (i === index ? { ...p, ...changes } : p)));
  };

  const melde = (errorKey: string) => setFehler(translate(errorKey as TranslationKey));

  /** Legt beim ersten Speichern an und aktualisiert danach. */
  const sichere = (): string | null => {
    setFehler(null);
    // FINANZ-CORE-01A (ANG-02) — nie still über eine neuere Fassung schreiben.
    if (fremdGeaendert && ungespeichert) {
      setFehler(translate('orderDraftCloud.remoteChanged.saveBlocked'));
      return null;
    }
    if (gespeicherteId) {
      const r = updateOfferDraft(gespeicherteId, eingaben());
      if (!r.success) {
        melde(r.errorKey);
        return null;
      }
      setBasis({ stored: angebotSchluessel(werteAusAngebot(r.offer)), editor: editorSchluessel });
      return r.offer.id;
    }
    const workspaceId = resolveCloudWorkspaceId(buildPersistedStateSnapshot()).trim();
    const r = addOfferDraft(workspaceId, eingaben());
    if (!r.success) {
      melde(r.errorKey);
      return null;
    }
    setGespeicherteId(r.offer.id);
    setBasis({ stored: angebotSchluessel(werteAusAngebot(r.offer)), editor: editorSchluessel });
    return r.offer.id;
  };

  const handleSpeichern = () => {
    const id = sichere();
    if (!id) return;
    showToast(translate('offer.editor.saved'));
    navigate(`/angebote/${id}`);
  };

  const handleFreigeben = async (): Promise<boolean> => {
    if (!darfFreigeben) {
      setFehler(translate('offer.finalize.forbidden'));
      return true;
    }
    const id = sichere();
    if (!id) return true;
    setLaeuft(true);
    try {
      const r = await finalizeOfferWithCloud(id);
      if (!r.ok) {
        if (r.reason === 'blocked') {
          setFehler(r.blockers.map((b) => translate(`offer.finalize.blocked.${b}` as TranslationKey)).join(' '));
        } else if (r.reason === 'server_rejected') {
          // FINANZ-CORE-01A (ANG-14) — nur übersetzte Texte; der rohe Servertext bleibt draußen.
          setFehler(translate(offerServerRejectionKey(r.message, 'finalize') ?? 'offer.finalize.server_rejected'));
        } else {
          setFehler(translate(`offer.finalize.${r.reason}` as TranslationKey));
        }
        return true;
      }
      // Ablage direkt nach der Freigabe — idempotent, ein zweiter Versuch schadet nicht.
      await ensureOfferArchived(id).catch(() => null);
      showToast(translate('offer.finalize.success'));
      navigate(`/angebote/${id}`);
      return true;
    } finally {
      setLaeuft(false);
    }
  };

  const handleVerwerfen = (): boolean => {
    if (gespeicherteId) {
      const r = deleteOfferDraft(gespeicherteId);
      if (!r.success) {
        melde(r.errorKey);
        return true;
      }
    }
    navigate('/angebote');
    return true;
  };

  const vorschauModell = vorschau
    ? buildOfferPrintModel(
        {
          id: gespeicherteId ?? 'vorschau',
          workspaceId: '',
          status: 'entwurf',
          createdAt: new Date().toISOString(),
          ...eingaben(),
          offerDate: angebotsdatum,
          baustelle,
          introText: einleitung,
          closingText: schluss,
          paymentTermsText: konditionen,
        },
        profile,
      )
    : null;

  return (
    <Page className="offer-editor" testId="offer-editor-page">
      <PageHeader
        title={translate(vorhandenes ? 'offer.editor.editTitle' : 'offer.editor.newTitle')}
        backLabel={translate('offer.editor.back')}
        backHref={gespeicherteId ? `/angebote/${gespeicherteId}` : '/angebote'}
        backTestId="offer-editor-back"
      />

      {fehler ? (
        <p className="form-error" role="alert" data-testid="offer-editor-error">
          {fehler}
        </p>
      ) : null}

      {fremdGeaendert && ungespeichert ? (
        <InlineNotice
          tone="warning"
          testId="offer-editor-remote-changed"
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
                data-testid="offer-editor-remote-load"
              >
                {translate('orderDraftCloud.remoteChanged.load')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => {
                  setFehler(null);
                  setBasis((prev) => (prev ? { ...prev, stored: gespeichertSchluessel } : prev));
                }}
                data-testid="offer-editor-remote-keep"
              >
                {translate('orderDraftCloud.remoteChanged.keep')}
              </Button>
            </div>
          }
        >
          {translate('orderDraftCloud.remoteChanged.body')}
        </InlineNotice>
      ) : null}

      <DetailSection title={translate('offer.editor.customerSection')}>
        <Field label={translate('offer.editor.customer')}>
          <select className="input" value={kundeId} onChange={(e) => wechsleKunde(e.target.value)} data-testid="offer-customer">
            <option value="">{translate('offer.editor.customerPlaceholder')}</option>
            {kunden.map((k) => (
              <option key={k.id} value={k.id}>
                {kundenLabels.get(k.id) ?? k.name}
              </option>
            ))}
          </select>
        </Field>
        <p className="form-hint">{translate('offer.editor.customerHint')}</p>
        {!kundeId && darfFreigeben ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!kunde.name.trim()}
            onClick={legeKundenAn}
            data-testid="offer-customer-new"
          >
            {translate('offer.editor.customerNew')}
          </Button>
        ) : null}
        <div className="offer-editor__grid">
          <Field label={translate('offer.editor.customerName')} wide>
            <input className="input" value={kunde.name} onChange={(e) => setKunde({ ...kunde, name: e.target.value })} data-testid="offer-customer-name" />
          </Field>
          <Field label={translate('offer.editor.contactPerson')}>
            <input className="input" value={kunde.contactPerson} onChange={(e) => setKunde({ ...kunde, contactPerson: e.target.value })} data-testid="offer-customer-contact" />
          </Field>
          <Field label={translate('offer.editor.street')}>
            <input className="input" value={kunde.street} onChange={(e) => setKunde({ ...kunde, street: e.target.value })} data-testid="offer-customer-street" />
          </Field>
          <Field label={translate('offer.editor.zip')}>
            <input className="input" value={kunde.zip} onChange={(e) => setKunde({ ...kunde, zip: e.target.value })} data-testid="offer-customer-zip" />
          </Field>
          <Field label={translate('offer.editor.city')}>
            <input className="input" value={kunde.city} onChange={(e) => setKunde({ ...kunde, city: e.target.value })} data-testid="offer-customer-city" />
          </Field>
          <Field label={translate('offer.editor.email')}>
            <input className="input" type="email" value={kunde.email} onChange={(e) => setKunde({ ...kunde, email: e.target.value })} data-testid="offer-customer-email" />
          </Field>
          <Field label={translate('offer.editor.phone')}>
            <input className="input" value={kunde.phone} onChange={(e) => setKunde({ ...kunde, phone: e.target.value })} data-testid="offer-customer-phone" />
          </Field>
        </div>
      </DetailSection>

      <DetailSection title={translate('offer.editor.detailsSection')}>
        <div className="offer-editor__grid">
          <Field label={translate('offer.editor.title')} wide>
            <input className="input" value={titel} onChange={(e) => setTitel(e.target.value)} placeholder={translate('offer.editor.titlePlaceholder')} data-testid="offer-title" />
          </Field>
          <Field label={translate('offer.editor.baustelle')} wide>
            <input className="input" value={baustelle} onChange={(e) => setBaustelle(e.target.value)} placeholder={translate('offer.editor.baustellePlaceholder')} data-testid="offer-baustelle" />
          </Field>
          <Field label={translate('offer.editor.offerDate')}>
            <input className="input" type="date" value={angebotsdatum} onChange={(e) => setAngebotsdatum(e.target.value)} data-testid="offer-date" />
          </Field>
          <Field label={translate('offer.editor.validUntil')}>
            <input className="input" type="date" value={gueltigBis} onChange={(e) => setGueltigBis(e.target.value)} data-testid="offer-valid-until" />
          </Field>
          <Field label={translate('offer.editor.taxStatus')} wide>
            <select className="input" value={taxStatus} onChange={(e) => setTaxStatus(e.target.value as TaxStatus)} data-testid="offer-tax-status">
              {/*
                * FINANZ-CORE-01A (EIN-05) — „noch unklar" stand nicht in der Liste; der Browser
                * zeigte deshalb 19 %, gerechnet wurde mit 0 %. Jetzt steht dort ehrlich „Bitte wählen".
                */}
              {taxStatus === 'unclear' && (
                <option value="unclear" disabled>
                  {translate('offer.editor.taxStatusChoose')}
                </option>
              )}
              {TAX_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {getTaxStatusLabel(s)}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </DetailSection>

      <DetailSection title={translate('offer.editor.positionsSection')}>
        {positionen.length === 0 ? (
          <p className="form-hint" data-testid="offer-positions-empty">{translate('offer.editor.positionsEmpty')}</p>
        ) : null}
        <ol className="offer-editor__positions" data-testid="offer-positions">
          {positionen.map((p, i) => (
            <li key={p.id} className="offer-editor__position" data-testid={`offer-position-${i}`}>
              <span className="offer-editor__position-index">{i + 1}</span>
              <Field label={translate('offer.editor.positionDescription')} wide>
                <input className="input" value={p.description} onChange={(e) => setPos(i, { description: e.target.value })} data-testid={`offer-position-${i}-description`} />
              </Field>
              <Field label={translate('offer.editor.positionQuantity')}>
                {/* FINANZ-CORE-01A (RE-10) — deutsche Zahlen („1.200,50"), kein stilles Umdeuten, die 0 lässt sich löschen. */}
                <NumericInput id={`offer-position-${i}-quantity`} className="input" mode="decimal" strict min={0} value={p.quantity} onChange={(value) => setPos(i, { quantity: value })} data-testid={`offer-position-${i}-quantity`} />
              </Field>
              <Field label={translate('offer.editor.positionUnit')}>
                <select className="input" value={p.unit} onChange={(e) => setPos(i, { unit: e.target.value as OrderUnit })} data-testid={`offer-position-${i}-unit`}>
                  {ORDER_UNITS.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={translate('offer.editor.positionUnitPrice')}>
                {/* FINANZ-CORE-01A (ANG-16) — Preise auf Cent: gedruckt und gerechnet wird mit zwei Nachkommastellen. */}
                <NumericInput id={`offer-position-${i}-unit-price`} className="input" mode="decimal" strict min={0} maxFractionDigits={2} value={p.unitPrice} onChange={(value) => setPos(i, { unitPrice: value })} data-testid={`offer-position-${i}-unit-price`} />
              </Field>
              <div className="offer-editor__position-total">
                <span className="invoice-edit__label">{translate('offer.editor.positionTotal')}</span>
                <strong data-testid={`offer-position-${i}-total`}>{formatInvoiceCurrency(billingLineTotalMoney(p.quantity, p.unitPrice))}</strong>
              </div>
              {/* FINANZ-CORE-01A (ANG-17) — Menge 0 fällt aus PDF, Summe und Auftrag; das sagt der Editor jetzt. */}
              {p.quantity === 0 ? (
                <p className="form-hint offer-editor__position-hint" data-testid={`offer-position-${i}-zero-hint`}>
                  {translate('offer.editor.positionZeroHint')}
                </p>
              ) : null}
              <button type="button" className="btn btn--ghost offer-editor__position-remove" onClick={() => setPositionen((prev) => prev.filter((_, j) => j !== i))} data-testid={`offer-position-${i}-remove`}>
                {translate('offer.editor.positionRemove')}
              </button>
            </li>
          ))}
        </ol>
        <Button type="button" variant="secondary" onClick={() => setPositionen((prev) => [...prev, neuePosition()])} data-testid="offer-position-add">
          {translate('offer.editor.positionAdd')}
        </Button>

        <dl className="offer-editor__totals" data-testid="offer-totals">
          <div>
            <dt>{translate('offer.net')}</dt>
            <dd data-testid="offer-total-net">{formatInvoiceCurrency(totals.subtotal)}</dd>
          </div>
          {totals.taxRate > 0 ? (
            <div>
              <dt>
                {translate('offer.tax')} ({totals.taxRate} %)
              </dt>
              <dd data-testid="offer-total-tax">{formatInvoiceCurrency(totals.tax)}</dd>
            </div>
          ) : null}
          <div className="offer-editor__totals-gross">
            <dt>{translate('offer.gross')}</dt>
            <dd data-testid="offer-total-gross">{formatInvoiceCurrency(totals.total)}</dd>
          </div>
        </dl>
      </DetailSection>

      <DetailSection title={translate('offer.editor.textsSection')}>
        <Field label={translate('offer.editor.introText')}>
          <textarea className="input" rows={3} value={einleitung} onChange={(e) => setEinleitung(e.target.value)} placeholder={translate('offer.editor.introPlaceholder')} data-testid="offer-intro" />
        </Field>
        <Field label={translate('offer.editor.paymentTerms')}>
          <textarea className="input" rows={2} value={konditionen} onChange={(e) => setKonditionen(e.target.value)} placeholder={translate('offer.editor.paymentTermsPlaceholder')} data-testid="offer-terms" />
        </Field>
        <Field label={translate('offer.editor.closingText')}>
          <textarea className="input" rows={3} value={schluss} onChange={(e) => setSchluss(e.target.value)} placeholder={translate('offer.editor.closingPlaceholder')} data-testid="offer-closing" />
        </Field>
      </DetailSection>

      <div className="form-actions offer-editor__actions">
        <Button type="button" onClick={handleSpeichern} data-testid="offer-save" disabled={laeuft}>
          {translate('offer.editor.saveDraft')}
        </Button>
        {darfFreigeben ? (
          <Button type="button" variant="secondary" onClick={() => setFreigabeOffen(true)} data-testid="offer-finalize" disabled={laeuft}>
            {translate('offer.editor.finalize')}
          </Button>
        ) : null}
        <Button type="button" variant="ghost" onClick={() => setVorschau((v) => !v)} data-testid="offer-preview-toggle">
          {translate('offer.editor.preview')}
        </Button>
        {gespeicherteId ? (
          <Button type="button" variant="ghost" onClick={() => setVerwerfenOffen(true)} data-testid="offer-delete-draft">
            {translate('offer.editor.deleteDraft')}
          </Button>
        ) : null}
      </div>
      {darfFreigeben ? (
        <p className="form-hint">{translate('offer.editor.finalizeHint')}</p>
      ) : (
        <p className="form-hint" data-testid="offer-finalize-role-hint">{translate('offer.finalize.roleHint')}</p>
      )}

      {vorschauModell ? (
        <DetailSection title={translate('offer.editor.preview')} testId="offer-preview">
          <OfferDocumentView model={vorschauModell} />
        </DetailSection>
      ) : null}

      <SimpleConfirmDialog
        open={freigabeOffen}
        title={translate('offer.editor.finalizeConfirmTitle')}
        message={translate('offer.editor.finalizeConfirmText')}
        confirmLabel={translate('offer.editor.finalizeConfirm')}
        cancelLabel={translate('common.cancel')}
        dialogTestId="offer-finalize-dialog"
        confirmTestId="offer-finalize-confirm"
        cancelTestId="offer-finalize-cancel"
        onConfirm={async () => {
          setFreigabeOffen(false);
          await handleFreigeben();
          return true;
        }}
        onCancel={() => setFreigabeOffen(false)}
      />
      <SimpleConfirmDialog
        open={verwerfenOffen}
        title={translate('offer.editor.deleteDraft')}
        message={translate('offer.editor.deleteDraftConfirm')}
        confirmLabel={translate('offer.editor.deleteDraft')}
        cancelLabel={translate('common.cancel')}
        confirmVariant="danger"
        dialogTestId="offer-delete-dialog"
        confirmTestId="offer-delete-confirm"
        cancelTestId="offer-delete-cancel"
        onConfirm={() => {
          setVerwerfenOffen(false);
          return handleVerwerfen();
        }}
        onCancel={() => setVerwerfenOffen(false)}
      />
    </Page>
  );
}

// FINANZ-CORE-01A (KUN-01) — mit Land, USt-IdNr., Käuferreferenz und Leitweg-ID.
function billingOf(customer: CustomerBilling): CustomerBilling {
  return copyCustomerBilling(customer);
}

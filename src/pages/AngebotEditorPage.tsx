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
import { useMemo, useState, type ReactNode } from 'react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { PageHeader } from '../components/ui/Card';
import { Page } from '../components/ui/Page';
import { DetailSection } from '../components/ui/Section';
import { SimpleConfirmDialog } from '../components/ui/SimpleConfirmDialog';
import { OfferDocumentView } from '../components/offer/OfferDocumentView';
import { useApp } from '../context/AppContext';
import { getCustomerById, getCustomerStoreSnapshot } from '../services/customerStoreService';
import { getCompanyProfileStoreSnapshot } from '../services/companyProfileService';
import { buildDefaultPaymentTerms, resolveDefaultTaxStatus } from '../services/invoice/invoiceDefaults';
import { getTaxStatusLabel } from '../services/invoiceTaxService';
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
import { ensureOfferArchived } from '../services/offer/offerArchiveService';
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
  return d.toISOString().slice(0, 10);
}

function neuePosition(): OfferPosition {
  return normalizeOfferPosition({ description: '', quantity: 1, unit: 'Stück', unitPrice: 0 });
}

export function AngebotEditorPage() {
  const { translate, setup, showToast } = useApp();
  const navigate = useNavigate();
  const { offerId } = useParams<{ offerId: string }>();
  const [params] = useSearchParams();

  const vorhandenes: Offer | null = offerId ? getOfferById(offerId) : null;
  const kunden = useMemo(() => getCustomerStoreSnapshot(), []);
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
  const [gueltigBis, setGueltigBis] = useState(vorhandenes?.validUntil ?? inDays(30));
  const [taxStatus, setTaxStatus] = useState<TaxStatus>(
    vorhandenes?.taxStatus ?? resolveDefaultTaxStatus(profile, setup),
  );
  const [positionen, setPositionen] = useState<OfferPosition[]>(
    vorhandenes?.positions.length ? vorhandenes.positions : [neuePosition()],
  );
  const [einleitung, setEinleitung] = useState(vorhandenes?.introText ?? '');
  const [schluss, setSchluss] = useState(vorhandenes?.closingText ?? '');
  const [konditionen, setKonditionen] = useState(
    vorhandenes?.paymentTermsText ?? buildDefaultPaymentTerms(profile),
  );
  const [gespeicherteId, setGespeicherteId] = useState<string | null>(vorhandenes?.id ?? null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [freigabeOffen, setFreigabeOffen] = useState(false);
  const [verwerfenOffen, setVerwerfenOffen] = useState(false);
  const [vorschau, setVorschau] = useState(false);
  const [laeuft, setLaeuft] = useState(false);

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

  const setPos = (index: number, changes: Partial<OfferPosition>) => {
    setPositionen((prev) => prev.map((p, i) => (i === index ? { ...p, ...changes } : p)));
  };

  const eingaben = (): OfferDraftInput => ({
    customerId: kundeId || undefined,
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

  const melde = (errorKey: string) => setFehler(translate(errorKey as TranslationKey));

  /** Legt beim ersten Speichern an und aktualisiert danach. */
  const sichere = (): string | null => {
    setFehler(null);
    if (gespeicherteId) {
      const r = updateOfferDraft(gespeicherteId, eingaben());
      if (!r.success) {
        melde(r.errorKey);
        return null;
      }
      return r.offer.id;
    }
    const workspaceId = resolveCloudWorkspaceId(buildPersistedStateSnapshot()).trim();
    const r = addOfferDraft(workspaceId, eingaben());
    if (!r.success) {
      melde(r.errorKey);
      return null;
    }
    setGespeicherteId(r.offer.id);
    return r.offer.id;
  };

  const handleSpeichern = () => {
    const id = sichere();
    if (!id) return;
    showToast(translate('offer.editor.saved'));
    navigate(`/angebote/${id}`);
  };

  const handleFreigeben = async (): Promise<boolean> => {
    const id = sichere();
    if (!id) return true;
    setLaeuft(true);
    try {
      const r = await finalizeOfferWithCloud(id);
      if (!r.ok) {
        if (r.reason === 'blocked') {
          setFehler(r.blockers.map((b) => translate(`offer.finalize.blocked.${b}` as TranslationKey)).join(' '));
        } else if (r.reason === 'server_rejected' || r.reason === 'network') {
          setFehler(`${translate(`offer.finalize.${r.reason}` as TranslationKey)} (${r.message})`);
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

      <DetailSection title={translate('offer.editor.customerSection')}>
        <Field label={translate('offer.editor.customer')}>
          <select className="input" value={kundeId} onChange={(e) => wechsleKunde(e.target.value)} data-testid="offer-customer">
            <option value="">{translate('offer.editor.customerPlaceholder')}</option>
            {kunden.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
              </option>
            ))}
          </select>
        </Field>
        <p className="form-hint">
          {translate('offer.editor.customerHint')}{' '}
          <a href="/kunden" data-testid="offer-customer-new">
            {translate('offer.editor.customerNew')}
          </a>
        </p>
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
                <input className="input" type="number" inputMode="decimal" min={0} step="0.01" value={p.quantity} onChange={(e) => setPos(i, { quantity: Number(e.target.value) })} data-testid={`offer-position-${i}-quantity`} />
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
                <input className="input" type="number" inputMode="decimal" min={0} step="0.01" value={p.unitPrice} onChange={(e) => setPos(i, { unitPrice: Number(e.target.value) })} data-testid={`offer-position-${i}-unit-price`} />
              </Field>
              <div className="offer-editor__position-total">
                <span className="invoice-edit__label">{translate('offer.editor.positionTotal')}</span>
                <strong data-testid={`offer-position-${i}-total`}>{formatInvoiceCurrency(Math.round(p.quantity * p.unitPrice * 100) / 100)}</strong>
              </div>
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
        <Button type="button" variant="secondary" onClick={() => setFreigabeOffen(true)} data-testid="offer-finalize" disabled={laeuft}>
          {translate('offer.editor.finalize')}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setVorschau((v) => !v)} data-testid="offer-preview-toggle">
          {translate('offer.editor.preview')}
        </Button>
        {gespeicherteId ? (
          <Button type="button" variant="ghost" onClick={() => setVerwerfenOffen(true)} data-testid="offer-delete-draft">
            {translate('offer.editor.deleteDraft')}
          </Button>
        ) : null}
      </div>
      <p className="form-hint">{translate('offer.editor.finalizeHint')}</p>

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

function billingOf(customer: CustomerBilling): CustomerBilling {
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

import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { Badge, PageHeader } from '../components/ui/Card';
import { BusinessList, BusinessListItem } from '../components/ui/Lists';
import { Page } from '../components/ui/Page';
import { DetailSection } from '../components/ui/Section';
import { EmptyStateBlock } from '../components/ui/EmptyStateBlock';
import { useApp } from '../context/AppContext';
import { buildCustomerDistinguisher, buildCustomerSubline } from '../components/customer/CustomerDecisionChoice';
import { CustomerDuplicateDecision } from '../components/customer/CustomerDuplicateDecision';
import { CUSTOMER_DUPLICATE_ERROR_KEY } from '../services/customerService';
import {
  findCustomerDuplicateCandidates,
  type CustomerDuplicateCandidate,
} from '../services/customer/customerDuplicateService';
import { CustomerEditForm } from '../components/customer/CustomerEditForm';
import { createCustomer } from '../services/customerService';
import { getCustomerById, getCustomerStoreSnapshot } from '../services/customerStoreService';
import { getKundenOverview, type KundeOverviewEntry } from '../services/kundenOverviewService';
import { buildKundenDetailPath } from '../services/kundenWorkspaceService';
import type { Customer, CustomerBilling } from '../types/models';
import type { TranslationKey } from '../i18n';

/**
 * CUSTOMER-FACHOBJEKT-06A — UI-only start values for the create form.
 * Frozen, never stored, never passed to createCustomer as an entity and never
 * rendered: the empty id exists solely because the shared form takes a Customer.
 */
const NEW_CUSTOMER_DRAFT: Customer = Object.freeze({
  id: '',
  name: '',
  contactPerson: '',
  street: '',
  zip: '',
  city: '',
  email: '',
  phone: '',
  createdAt: '',
  updatedAt: '',
});

export function KundenPage() {
  const { translate, showToast, language } = useApp();
  const navigate = useNavigate();
  const [kunden, setKunden] = useState(() => getKundenOverview());
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  /** Synchronous lock — a second submit in the same event turn must not create again. */
  const savingRef = useRef(false);

  /**
   * CUSTOMER-FACHOBJEKT-04E5 — an id-customer always shows its current master
   * record via the existing subline helper; legacy and orphan keep the
   * snapshot-derived address of the overview. The id itself stays invisible.
   */
  const sublineFor = (kunde: KundeOverviewEntry): string => {
    if (kunde.kind !== 'customer') return kunde.addressLine;
    const customer = getCustomerById(kunde.key);
    if (!customer) return kunde.addressLine;
    return buildCustomerSubline(customer, translate('customerDecision.noAddress'));
  };

  /*
   * 01D — gleiche Namen bleiben getrennte Einträge (kein Merge). Damit sie
   * unterscheidbar sind, bekommt ein Kunde mit Namensvetter seine vorhandenen
   * Merkmale (Ansprechpartner, E-Mail, Anlagedatum) über den bestehenden
   * Helfer; Altbestand und fehlender Kundenstamm erklären ihre Sonderstellung.
   */
  const normalizedName = (value: string) => value.trim().toLocaleLowerCase('de-DE').replace(/s+/g, ' ');
  const nameCount = new Map<string, number>();
  for (const entry of kunden) nameCount.set(normalizedName(entry.name), (nameCount.get(normalizedName(entry.name)) ?? 0) + 1);
  const hasNamesake = (kunde: KundeOverviewEntry) => (nameCount.get(normalizedName(kunde.name)) ?? 0) > 1;
  const detailFor = (kunde: KundeOverviewEntry): string => {
    if (kunde.kind === 'legacy') return translate('kunden.legacyHint');
    if (kunde.kind === 'orphan') return translate('kunden.orphanHint');
    const customer = getCustomerById(kunde.key);
    if (!customer) return '';
    const distinguisher = buildCustomerDistinguisher(
      customer,
      getCustomerStoreSnapshot(),
      (date) => translate('customerDecision.createdAt').replace('{date}', date),
      language,
    );
    if (distinguisher) return distinguisher;
    return hasNamesake(kunde) ? translate('kunden.customerRecordHint') : '';
  };

  const openCreateForm = () => {
    savingRef.current = false;
    setSaving(false);
    setCreateError(null);
    setCreating(true);
  };

  const closeCreateForm = () => {
    savingRef.current = false;
    setSaving(false);
    setCreateError(null);
    setDuplicateDecision(null);
    setCreating(false);
  };

  /** CUSTOMER-IDENTITY-DUPLICATE-01A — wahrscheinliche Dubletten samt den Eingaben, die sie ausgelöst haben. */
  const [duplicateDecision, setDuplicateDecision] = useState<{ candidates: CustomerDuplicateCandidate[]; values: CustomerBilling } | null>(null);

  const handleCreate = (values: CustomerBilling, options?: { allowDuplicate?: boolean }) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);

    const release = () => {
      savingRef.current = false;
      setSaving(false);
    };

    // Confirm-first: auch unsichere Kandidaten (gleicher Name ohne belastbare Anschrift) fragen nach.
    if (!options?.allowDuplicate) {
      const duplicates = findCustomerDuplicateCandidates(values);
      if (duplicates.length > 0) {
        setDuplicateDecision({ candidates: duplicates, values });
        setCreateError(null);
        queueMicrotask(release);
        return;
      }
    }
    // Only the form values reach the service — never the UI draft object.
    const result = createCustomer(values, { allowDuplicate: options?.allowDuplicate });
    if (!result.success) {
      // Confirm-first: wahrscheinliche Dublette → Entscheidung statt Fehlermeldung.
      if (result.errorKey === CUSTOMER_DUPLICATE_ERROR_KEY && result.duplicates?.length) {
        setDuplicateDecision({ candidates: result.duplicates, values });
        setCreateError(null);
        queueMicrotask(release);
        return;
      }
      // Inputs stay untouched so the user can correct them.
      setCreateError(translate(result.errorKey as TranslationKey));
      queueMicrotask(release);
      return;
    }
    setDuplicateDecision(null);
    setCreateError(null);
    setCreating(false);
    setKunden(getKundenOverview());
    showToast(translate('kunden.create.success'));
    queueMicrotask(release);
  };

  const createAction = (
    <Button variant="secondary" data-testid="kunden-create-action" onClick={openCreateForm}>
      {translate('kunden.create.action')}
    </Button>
  );

  /* UIUX-FOUNDATION-01F — Header mit einer Hauptaktion, Kunden als Business-Liste. */
  return (
    <Page className="kunden-page" testId="kunden-page">
      <PageHeader
        title={translate('kunden.title')}
        subtitle={translate('kunden.subtitle')}
        primaryAction={creating ? undefined : createAction}
      />

      {creating ? (
        <DetailSection title={translate('kunden.create.title')} surface testId="kunden-create-section">
          <CustomerEditForm
            customer={NEW_CUSTOMER_DRAFT}
            busy={saving}
            error={createError}
            onSave={(values) => handleCreate(values)}
            onCancel={closeCreateForm}
          />
          {duplicateDecision ? (
            <CustomerDuplicateDecision
              candidates={duplicateDecision.candidates}
              busy={saving}
              onUseExisting={(id) => {
                // Kein neuer Datensatz: Formular schließen, vorhandenen Kunden öffnen.
                closeCreateForm();
                navigate(`/kunden/customer/${id}`);
              }}
              onCreateAnyway={() => {
                const values = duplicateDecision.values;
                setDuplicateDecision(null);
                handleCreate(values, { allowDuplicate: true });
              }}
            />
          ) : null}
        </DetailSection>
      ) : null}

      {kunden.length === 0 ? (
        <EmptyStateBlock
          title={translate('kunden.empty.title')}
          description={translate('kunden.empty.desc')}
          testId="kunden-empty-state"
          actions={
            <Link to="/vorgaenge">
              <Button fullWidth>{translate('kunden.empty.action')}</Button>
            </Link>
          }
        />
      ) : (
        <BusinessList testId="kunden-list" ariaLabel={translate('kunden.title')}>
          {kunden.map((kunde) => (
            <BusinessListItem
              key={`${kunde.kind}:${kunde.key}`}
              to={buildKundenDetailPath(kunde)}
              linkTestId={`kunde-${kunde.kind}-${kunde.key}`}
              /* A nameless orphan keeps a readable title — never its customerId. */
              title={kunde.name || (kunde.kind === 'orphan' ? translate('kunden.orphanBadge') : kunde.name)}
              subtitle={
                sublineFor(kunde) || detailFor(kunde) ? (
                  <>
                    {sublineFor(kunde) ? <span data-testid="kunde-address">{sublineFor(kunde)}</span> : null}
                    {detailFor(kunde) ? (
                      <>
                        {sublineFor(kunde) ? ' · ' : ''}
                        <span data-testid="kunde-identity-hint">{detailFor(kunde)}</span>
                      </>
                    ) : null}
                  </>
                ) : undefined
              }
              meta={`${translate('kunden.meta.orders').replace('{count}', String(kunde.orderCount))}${
                kunde.openInvoiceCount > 0
                  ? ` · ${translate('kunden.meta.openInvoices').replace('{count}', String(kunde.openInvoiceCount))}`
                  : ''
              }`}
              status={
                kunde.kind === 'legacy' ? (
                  <Badge tone="neutral">{translate('kunden.legacyBadge')}</Badge>
                ) : kunde.kind === 'orphan' ? (
                  <Badge tone="warning">{translate('kunden.orphanBadge')}</Badge>
                ) : undefined
              }
            />
          ))}
        </BusinessList>
      )}
    </Page>
  );
}

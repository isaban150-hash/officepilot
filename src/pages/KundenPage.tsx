import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { Card, CardMeta, CardTitle, PageHeader } from '../components/ui/Card';
import { EmptyStateBlock } from '../components/ui/EmptyStateBlock';
import { useApp } from '../context/AppContext';
import { buildCustomerSubline } from '../components/customer/CustomerDecisionChoice';
import { CustomerEditForm } from '../components/customer/CustomerEditForm';
import { createCustomer } from '../services/customerService';
import { getCustomerById } from '../services/customerStoreService';
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
  const { translate, showToast } = useApp();
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
    setCreating(false);
  };

  const handleCreate = (values: CustomerBilling) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);

    const release = () => {
      savingRef.current = false;
      setSaving(false);
    };

    // Only the form values reach the service — never the UI draft object.
    const result = createCustomer(values);
    if (!result.success) {
      // Inputs stay untouched so the user can correct them.
      setCreateError(translate(result.errorKey as TranslationKey));
      queueMicrotask(release);
      return;
    }
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

  return (
    <div className="page kunden-page" data-testid="kunden-page">
      <PageHeader
        title={translate('kunden.title')}
        subtitle={translate('kunden.subtitle')}
      />

      {creating ? (
        <section className="kunden-detail-section" data-testid="kunden-create-section">
          <h2 className="kunden-detail-section__title">{translate('kunden.create.title')}</h2>
          <CustomerEditForm
            customer={NEW_CUSTOMER_DRAFT}
            busy={saving}
            error={createError}
            onSave={handleCreate}
            onCancel={closeCreateForm}
          />
        </section>
      ) : (
        createAction
      )}

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
        <div className="card-list">
          {kunden.map((kunde) => (
            <Link
              key={`${kunde.kind}:${kunde.key}`}
              to={buildKundenDetailPath(kunde)}
              className="card-link"
              data-testid={`kunde-${kunde.kind}-${kunde.key}`}
            >
              <Card>
                {/* A nameless orphan keeps a readable title — never its customerId. */}
                <CardTitle>
                  {kunde.name ||
                    (kunde.kind === 'orphan' ? translate('kunden.orphanBadge') : kunde.name)}
                </CardTitle>
                {sublineFor(kunde) && (
                  <p className="card__meta" data-testid="kunde-address">
                    {sublineFor(kunde)}
                  </p>
                )}
                <CardMeta>
                  {kunde.kind === 'legacy' ? `${translate('kunden.legacyBadge')} · ` : ''}
                  {kunde.kind === 'orphan' ? `${translate('kunden.orphanBadge')} · ` : ''}
                  {translate('kunden.meta.orders').replace('{count}', String(kunde.orderCount))}
                  {kunde.openInvoiceCount > 0
                    ? ` · ${translate('kunden.meta.openInvoices').replace('{count}', String(kunde.openInvoiceCount))}`
                    : ''}
                </CardMeta>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

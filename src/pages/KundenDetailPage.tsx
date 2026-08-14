import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { CustomerEditForm } from '../components/customer/CustomerEditForm';
import { updateCustomer } from '../services/customerService';
import { getCustomerById } from '../services/customerStoreService';
import type { CustomerBilling } from '../types/models';
import { Badge, Card, CardMeta, CardTitle, DataRow, PageHeader } from '../components/ui/Card';
import { EmptyStateBlock } from '../components/ui/EmptyStateBlock';
import { useApp } from '../context/AppContext';
import {
  getKundenWorkspace,
  resolveKundenLinkTargets,
} from '../services/kundenWorkspaceService';
import type { KundenIdentityKind } from '../services/kundenOverviewService';
import type { TranslationKey } from '../i18n';

/**
 * CUSTOMER-FACHOBJEKT-04E3 — old /kunden/:name links.
 * Redirects only when exactly one real target exists; never picks one of several.
 */
export function KundenLegacyLinkResolver() {
  const { translate } = useApp();
  const navigate = useNavigate();
  const { name: rawName } = useParams<{ name: string }>();
  const targets = resolveKundenLinkTargets(rawName ?? '');

  if (targets.length === 1) {
    return <Navigate to={targets[0]!.route} replace />;
  }

  return (
    <div className="page kunden-detail-page" data-testid="kunden-legacy-link">
      <PageHeader
        title={
          targets.length === 0
            ? translate('kunden.detail.notFoundTitle')
            : translate('kunden.link.ambiguousTitle')
        }
        subtitle={
          targets.length === 0
            ? translate('kunden.detail.notFoundSubtitle')
            : translate('kunden.link.ambiguousDesc')
        }
        backLabel={translate('common.back')}
        onBack={() => navigate('/kunden')}
      />

      {targets.length > 0 && (
        <div className="card-list" data-testid="kunden-legacy-link-targets">
          {targets.map((target) => (
            <Link
              key={`${target.kind}:${target.key}`}
              to={target.route}
              className="card-link"
              data-testid={`kunden-legacy-target-${target.kind}-${target.key}`}
            >
              <Card>
                <CardTitle>{target.name}</CardTitle>
                <CardMeta>
                  {target.kind === 'legacy' ? `${translate('kunden.legacyBadge')} · ` : ''}
                  {target.kind === 'orphan' ? `${translate('kunden.orphanBadge')} · ` : ''}
                  {target.addressLine || '—'}
                </CardMeta>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <Link to="/kunden">
        <Button fullWidth>{translate('kunden.detail.backToList')}</Button>
      </Link>
    </div>
  );
}

export function KundenDetailPage({ kind }: { kind: KundenIdentityKind }) {
  const { translate, showToast } = useApp();
  const navigate = useNavigate();
  const params = useParams<{ customerId?: string; legacyKey?: string }>();
  // React Router already decodes the parameter — never decode a second time.
  const rawKey = kind === 'legacy' ? params.legacyKey : params.customerId;

  /**
   * CUSTOMER-FACHOBJEKT-05A — master data editing for an id-customer only.
   * `reloadToken` re-reads the stores after a successful save; no provider,
   * no subscription and no page reload.
   */
  const [reloadToken, setReloadToken] = useState(0);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  /** Synchronous lock — a second submit in the same event turn must not save again. */
  const savingRef = useRef(false);

  // A real identity change resets the page-local edit state; reloadToken must not.
  useEffect(() => {
    savingRef.current = false;
    setSaving(false);
    setEditing(false);
    setEditError(null);
  }, [kind, rawKey]);

  const workspace = useMemo(
    () => (rawKey ? getKundenWorkspace(kind, rawKey) : null),
    [kind, rawKey, reloadToken],
  );
  const editableCustomer = useMemo(
    () => (kind === 'customer' && rawKey ? getCustomerById(rawKey.trim()) : undefined),
    [kind, rawKey, reloadToken],
  );

  const handleSave = (changes: CustomerBilling) => {
    // The ref blocks a second submit within the same event turn; it is released
    // only after the turn, so a correction after an error stays possible.
    if (!editableCustomer || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);

    const release = () => {
      savingRef.current = false;
      setSaving(false);
    };

    const result = updateCustomer(editableCustomer.id, changes);
    if (!result.success) {
      // Inputs stay untouched so the user can correct them.
      setEditError(translate(result.errorKey as TranslationKey));
      queueMicrotask(release);
      return;
    }
    setEditError(null);
    setEditing(false);
    setReloadToken((value) => value + 1);
    showToast(translate('kunden.edit.success'));
    queueMicrotask(release);
  };

  if (!workspace) {
    return (
      <div className="page kunden-detail-page" data-testid="kunden-detail-page">
        <PageHeader
          title={translate('kunden.detail.notFoundTitle')}
          subtitle={translate('kunden.detail.notFoundSubtitle')}
          backLabel={translate('common.back')}
          onBack={() => navigate('/kunden')}
        />
        <EmptyStateBlock
          title={translate('kunden.detail.notFoundTitle')}
          description={translate('kunden.detail.notFoundDesc')}
          testId="kunden-detail-empty"
          actions={
            <Link to="/kunden">
              <Button fullWidth>{translate('kunden.detail.backToList')}</Button>
            </Link>
          }
        />
      </div>
    );
  }

  const { contact } = workspace;

  return (
    <div className="page kunden-detail-page" data-testid="kunden-detail-page">
      {/* No readable name stored: a neutral title per identity kind — never the key or id. */}
      <PageHeader
        title={
          contact.name ||
          translate(kind === 'orphan' ? 'kunden.orphanBadge' : 'kunden.legacyBadge')
        }
        subtitle={translate('kunden.detail.subtitle')}
        backLabel={translate('common.back')}
        onBack={() => navigate('/kunden')}
      />

      <section className="kunden-detail-section" data-testid="kunden-contact">
        <h2 className="kunden-detail-section__title">{translate('kunden.detail.contactTitle')}</h2>

        {/* Editing exists only for an id-customer; legacy and orphan stay read-only. */}
        {editableCustomer && editing ? (
          <CustomerEditForm
            customer={editableCustomer}
            busy={saving}
            error={editError}
            onSave={handleSave}
            onCancel={() => {
              setEditing(false);
              setEditError(null);
            }}
          />
        ) : null}

        <Card>
          <DataRow label={translate('kunden.detail.contactPerson')} value={contact.contactPerson || '—'} />
          <DataRow label={translate('kunden.detail.phone')} value={contact.phone || '—'} />
          <DataRow label={translate('kunden.detail.email')} value={contact.email || '—'} />
          <DataRow label={translate('kunden.detail.address')} value={contact.addressLine || '—'} />
        </Card>

        {editableCustomer && !editing ? (
          <Button
            variant="secondary"
            data-testid="kunden-edit-action"
            onClick={() => {
              savingRef.current = false;
              setSaving(false);
              setEditError(null);
              setEditing(true);
            }}
          >
            {translate('kunden.edit.action')}
          </Button>
        ) : null}
      </section>

      <section className="kunden-detail-section" data-testid="kunden-baustellen">
        <h2 className="kunden-detail-section__title">{translate('kunden.detail.sitesTitle')}</h2>
        {workspace.baustellen.length === 0 ? (
          <CardMeta>{translate('kunden.detail.sitesEmpty')}</CardMeta>
        ) : (
          <div className="card-list">
            {workspace.baustellen.map((site) => (
              <Link
                key={site.label}
                to={`/vorgaenge/${site.vorgangId}`}
                className="card-link"
                data-testid={`kunden-baustelle-${site.label}`}
              >
                <Card>
                  <CardTitle>{site.label}</CardTitle>
                  <CardMeta>{site.vorgangTitle}</CardMeta>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="kunden-detail-section" data-testid="kunden-vorgaenge-open">
        <h2 className="kunden-detail-section__title">{translate('kunden.detail.openOrdersTitle')}</h2>
        {workspace.openVorgaenge.length === 0 ? (
          <CardMeta>{translate('kunden.detail.openOrdersEmpty')}</CardMeta>
        ) : (
          <div className="card-list">
            {workspace.openVorgaenge.map((vorgang) => (
              <Link key={vorgang.id} to={vorgang.route} className="card-link" data-testid={`kunden-vorgang-${vorgang.id}`}>
                <Card>
                  <CardTitle>{vorgang.title}</CardTitle>
                  <CardMeta>{vorgang.baustelle}</CardMeta>
                  <Badge tone="warning">{translate(`status.${vorgang.status}` as TranslationKey)}</Badge>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="kunden-detail-section" data-testid="kunden-vorgaenge-closed">
        <h2 className="kunden-detail-section__title">{translate('kunden.detail.closedOrdersTitle')}</h2>
        {workspace.closedVorgaenge.length === 0 ? (
          <CardMeta>{translate('kunden.detail.closedOrdersEmpty')}</CardMeta>
        ) : (
          <div className="card-list">
            {workspace.closedVorgaenge.map((vorgang) => (
              <Link key={vorgang.id} to={vorgang.route} className="card-link" data-testid={`kunden-vorgang-${vorgang.id}`}>
                <Card>
                  <CardTitle>{vorgang.title}</CardTitle>
                  <CardMeta>{vorgang.baustelle}</CardMeta>
                  <Badge tone="success">{translate(`status.${vorgang.status}` as TranslationKey)}</Badge>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="kunden-detail-section" data-testid="kunden-invoices">
        <h2 className="kunden-detail-section__title">{translate('kunden.detail.invoicesTitle')}</h2>
        <Card data-testid="kunden-receivables">
          <DataRow
            label={translate('kunden.detail.openReceivable')}
            value={workspace.openReceivableLabel}
          />
        </Card>

        <h3 className="kunden-detail-section__subtitle">{translate('kunden.detail.openInvoicesTitle')}</h3>
        {workspace.openInvoices.length === 0 ? (
          <CardMeta>{translate('kunden.detail.openInvoicesEmpty')}</CardMeta>
        ) : (
          <div className="card-list">
            {workspace.openInvoices.map((invoice) => (
              <Link key={invoice.id} to={invoice.route} className="card-link" data-testid={`kunden-invoice-${invoice.id}`}>
                <Card>
                  <CardTitle>{invoice.number}</CardTitle>
                  <CardMeta>
                    {invoice.vorgangTitle} · {invoice.openAmountLabel}
                  </CardMeta>
                </Card>
              </Link>
            ))}
          </div>
        )}

        <h3 className="kunden-detail-section__subtitle">{translate('kunden.detail.paidInvoicesTitle')}</h3>
        {workspace.paidInvoices.length === 0 ? (
          <CardMeta>{translate('kunden.detail.paidInvoicesEmpty')}</CardMeta>
        ) : (
          <div className="card-list">
            {workspace.paidInvoices.map((invoice) => (
              <Link key={invoice.id} to={invoice.route} className="card-link" data-testid={`kunden-invoice-${invoice.id}`}>
                <Card>
                  <CardTitle>{invoice.number}</CardTitle>
                  <CardMeta>{invoice.vorgangTitle}</CardMeta>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="kunden-detail-section" data-testid="kunden-documents">
        <h2 className="kunden-detail-section__title">{translate('kunden.detail.documentsTitle')}</h2>
        {workspace.documents.length === 0 ? (
          <CardMeta>{translate('kunden.detail.documentsEmpty')}</CardMeta>
        ) : (
          <div className="card-list">
            {workspace.documents.map((doc) => (
              <Link key={doc.id} to={doc.route} className="card-link" data-testid={`kunden-document-${doc.id}`}>
                <Card>
                  <CardTitle>{doc.title}</CardTitle>
                  <CardMeta>
                    {doc.kindLabel}
                    {doc.date ? ` · ${doc.date}` : ''}
                  </CardMeta>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="kunden-detail-section" data-testid="kunden-tasks">
        <h2 className="kunden-detail-section__title">{translate('kunden.detail.tasksTitle')}</h2>
        {workspace.tasks.length === 0 ? (
          <CardMeta>{translate('kunden.detail.tasksEmpty')}</CardMeta>
        ) : (
          <div className="card-list">
            {workspace.tasks.map((task) => (
              <Link key={task.id} to={task.route} className="card-link" data-testid={`kunden-task-${task.id}`}>
                <Card>
                  <CardTitle>{task.title}</CardTitle>
                  <CardMeta>
                    {task.vorgangTitle ?? ''}
                    {task.dueDate ? ` · ${task.dueDate}` : ''}
                    {task.done ? ` · ${translate('kunden.detail.taskDone')}` : ''}
                  </CardMeta>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

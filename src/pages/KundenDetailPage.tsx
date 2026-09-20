import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useParams, useNavigate } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { CustomerEditForm } from '../components/customer/CustomerEditForm';
import { updateCustomer } from '../services/customerService';
import { getCustomerById } from '../services/customerStoreService';
import type { CustomerBilling } from '../types/models';
import { DataRow, PageHeader, StatusBadge } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { BusinessList, BusinessListItem } from '../components/ui/Lists';
import { Page } from '../components/ui/Page';
import { DetailSection, SummaryList } from '../components/ui/Section';
import { getBusinessLettersForCustomer } from '../services/businessLetterService';
import { vorgangStatusTone } from '../services/ui/statusTone';
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
  const { name: rawName } = useParams<{ name: string }>();
  const targets = resolveKundenLinkTargets(rawName ?? '');

  if (targets.length === 1) {
    return <Navigate to={targets[0]!.route} replace />;
  }

  return (
    <Page className="kunden-detail-page" testId="kunden-legacy-link">
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
        backHref="/kunden"
      />

      {targets.length > 0 && (
        <BusinessList testId="kunden-legacy-link-targets">
          {targets.map((target) => (
            <BusinessListItem
              key={`${target.kind}:${target.key}`}
              to={target.route}
              linkTestId={`kunden-legacy-target-${target.kind}-${target.key}`}
              title={target.name}
              subtitle={target.addressLine || '—'}
              status={
                target.kind === 'legacy' ? (
                  <Badge tone="neutral">{translate('kunden.legacyBadge')}</Badge>
                ) : target.kind === 'orphan' ? (
                  <Badge tone="warning">{translate('kunden.orphanBadge')}</Badge>
                ) : undefined
              }
            />
          ))}
        </BusinessList>
      )}

      <div className="detail-actions">
        <Link to="/kunden">
          <Button variant="outline">{translate('kunden.detail.backToList')}</Button>
        </Link>
      </div>
    </Page>
  );
}

export function KundenDetailPage({ kind }: { kind: KundenIdentityKind }) {
  const { translate, showToast } = useApp();
  const params = useParams<{ customerId?: string; legacyKey?: string }>();
  const navigate = useNavigate();
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

  /* BRIEFE-01C — Schreiben an diesen Kunden; nur ein echter Kundenstamm trägt sie. */
  const letterCustomerId = kind === 'customer' && rawKey ? rawKey.trim() : '';
  const customerLetters = useMemo(
    () => (letterCustomerId ? getBusinessLettersForCustomer(letterCustomerId) : []),
    [letterCustomerId, reloadToken],
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
      <Page className="kunden-detail-page" testId="kunden-detail-page">
        <PageHeader
          title={translate('kunden.detail.notFoundTitle')}
          subtitle={translate('kunden.detail.notFoundSubtitle')}
          backLabel={translate('common.back')}
          backHref="/kunden"
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
      </Page>
    );
  }

  const { contact } = workspace;
  const identityBadge =
    kind !== 'customer' ? (
      <Badge tone={kind === 'orphan' ? 'warning' : 'neutral'}>
        {translate(kind === 'orphan' ? 'kunden.orphanBadge' : 'kunden.legacyBadge')}
      </Badge>
    ) : undefined;
  /* Editing exists only for an id-customer; legacy and orphan stay read-only. */
  const editAction =
    editableCustomer && !editing ? (
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
    ) : undefined;
  const statusFor = (status: string) => (
    <StatusBadge tone={vorgangStatusTone(status as never)} label={translate(`status.${status}` as TranslationKey)} icon={false} />
  );

  /*
   * UIUX-FOUNDATION-01F — Detailmuster: Back (Parent), Kundenidentität,
   * Bearbeiten als Hauptaktion (nur id-Kunde), Sections mit Business-Listen.
   * No readable name stored: a neutral title per identity kind — never the key or id.
   */
  return (
    <Page className="kunden-detail-page" testId="kunden-detail-page">
      <PageHeader
        title={
          contact.name ||
          translate(kind === 'orphan' ? 'kunden.orphanBadge' : 'kunden.legacyBadge')
        }
        subtitle={contact.addressLine || translate('kunden.detail.subtitle')}
        status={identityBadge}
        backLabel={translate('common.back')}
        backHref="/kunden"
        backTestId="kunden-detail-back"
        primaryAction={editAction}
      />

      {/* VISUAL-POLISH-01C — Desktop zweispaltig: Stammdaten und Baustellen links, Arbeit (Aufträge, Rechnungen, Dokumente, Aufgaben) rechts. */}
      <div className="work-detail-grid work-detail-grid--side-first kunden-detail__grid">
      <div className="work-detail-grid__side">
      <DetailSection title={translate('kunden.detail.contactTitle')} testId="kunden-contact">
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
        <SummaryList>
          <DataRow label={translate('kunden.detail.contactPerson')} value={contact.contactPerson || '—'} />
          <DataRow label={translate('kunden.detail.phone')} value={contact.phone || '—'} />
          <DataRow label={translate('kunden.detail.email')} value={contact.email || '—'} />
          <DataRow label={translate('kunden.detail.address')} value={contact.addressLine || '—'} />
        </SummaryList>
      </DetailSection>

      <DetailSection title={translate('kunden.detail.sitesTitle')} testId="kunden-baustellen">
        {workspace.baustellen.length === 0 ? (
          <p className="detail-empty">{translate('kunden.detail.sitesEmpty')}</p>
        ) : (
          <BusinessList>
            {workspace.baustellen.map((site) => (
              <BusinessListItem
                key={site.label}
                to={`/vorgaenge/${site.vorgangId}`}
                linkTestId={`kunden-baustelle-${site.label}`}
                title={site.label}
                subtitle={site.vorgangTitle}
              />
            ))}
          </BusinessList>
        )}
      </DetailSection>
      </div>

      <div className="work-detail-grid__main">
      <DetailSection title={translate('kunden.detail.openOrdersTitle')} testId="kunden-vorgaenge-open">
        {workspace.openVorgaenge.length === 0 ? (
          <p className="detail-empty">{translate('kunden.detail.openOrdersEmpty')}</p>
        ) : (
          <BusinessList>
            {workspace.openVorgaenge.map((vorgang) => (
              <BusinessListItem key={vorgang.id} to={vorgang.route} linkTestId={`kunden-vorgang-${vorgang.id}`} title={vorgang.title} subtitle={vorgang.baustelle} status={statusFor(vorgang.status)} />
            ))}
          </BusinessList>
        )}
      </DetailSection>

      <DetailSection title={translate('kunden.detail.closedOrdersTitle')} testId="kunden-vorgaenge-closed">
        {workspace.closedVorgaenge.length === 0 ? (
          <p className="detail-empty">{translate('kunden.detail.closedOrdersEmpty')}</p>
        ) : (
          <BusinessList>
            {workspace.closedVorgaenge.map((vorgang) => (
              <BusinessListItem key={vorgang.id} to={vorgang.route} linkTestId={`kunden-vorgang-${vorgang.id}`} title={vorgang.title} subtitle={vorgang.baustelle} status={statusFor(vorgang.status)} />
            ))}
          </BusinessList>
        )}
      </DetailSection>

      <DetailSection title={translate('kunden.detail.invoicesTitle')} testId="kunden-invoices">
        <SummaryList columns={1} testId="kunden-receivables">
          <DataRow label={translate('kunden.detail.openReceivable')} value={workspace.openReceivableLabel} />
        </SummaryList>

        <h3 className="ui-section-header__title">{translate('kunden.detail.openInvoicesTitle')}</h3>
        {workspace.openInvoices.length === 0 ? (
          <p className="detail-empty">{translate('kunden.detail.openInvoicesEmpty')}</p>
        ) : (
          <BusinessList>
            {workspace.openInvoices.map((invoice) => (
              <BusinessListItem
                key={invoice.id}
                to={invoice.route}
                linkTestId={`kunden-invoice-${invoice.id}`}
                title={invoice.number}
                subtitle={invoice.vorgangTitle}
                amount={<span className="money-display">{invoice.openAmountLabel}</span>}
              />
            ))}
          </BusinessList>
        )}

        <h3 className="ui-section-header__title">{translate('kunden.detail.paidInvoicesTitle')}</h3>
        {workspace.paidInvoices.length === 0 ? (
          <p className="detail-empty">{translate('kunden.detail.paidInvoicesEmpty')}</p>
        ) : (
          <BusinessList>
            {workspace.paidInvoices.map((invoice) => (
              <BusinessListItem key={invoice.id} to={invoice.route} linkTestId={`kunden-invoice-${invoice.id}`} title={invoice.number} subtitle={invoice.vorgangTitle} />
            ))}
          </BusinessList>
        )}
      </DetailSection>

      <DetailSection title={translate('kunden.detail.documentsTitle')} testId="kunden-documents">
        {workspace.documents.length === 0 ? (
          <p className="detail-empty">{translate('kunden.detail.documentsEmpty')}</p>
        ) : (
          <BusinessList>
            {workspace.documents.map((doc) => (
              <BusinessListItem key={doc.id} to={doc.route} linkTestId={`kunden-document-${doc.id}`} title={doc.title} subtitle={doc.kindLabel} date={doc.date || undefined} />
            ))}
          </BusinessList>
        )}
      </DetailSection>


      {/*
        * BRIEFE-01C — Geschaeftsschreiben an diesen Kunden. Schlichte Liste,
        * daneben der Einstieg mit bereits vorbelegtem Empfaenger.
        */}
      <DetailSection title={translate('businessLetter.customer.section')} testId="kunden-letters">
        {letterCustomerId ? (
          <div className="form-actions">
            <Button
              type="button"
              variant="secondary"
              onClick={() => navigate(`/schreiben/neu?customerId=${letterCustomerId}`)}
              data-testid="kunden-letter-create"
            >
              {translate('businessLetter.customer.create')}
            </Button>
          </div>
        ) : null}
        {customerLetters.length === 0 ? (
          <p className="detail-empty">{translate('businessLetter.customer.empty')}</p>
        ) : (
          <BusinessList>
            {customerLetters.map((brief) => (
              <BusinessListItem
                key={brief.id}
                to={`/schreiben/${brief.id}`}
                linkTestId={`kunden-letter-${brief.id}`}
                title={brief.subject}
                subtitle={translate(
                  brief.status === 'finalized'
                    ? 'businessLetter.status.finalized'
                    : 'businessLetter.status.draft',
                )}
                date={brief.letterDate || undefined}
              />
            ))}
          </BusinessList>
        )}
      </DetailSection>
      <DetailSection title={translate('kunden.detail.tasksTitle')} testId="kunden-tasks">
        {workspace.tasks.length === 0 ? (
          <p className="detail-empty">{translate('kunden.detail.tasksEmpty')}</p>
        ) : (
          <BusinessList>
            {workspace.tasks.map((task) => (
              <BusinessListItem
                key={task.id}
                to={task.route}
                linkTestId={`kunden-task-${task.id}`}
                title={task.title}
                subtitle={task.vorgangTitle ?? undefined}
                date={task.dueDate || undefined}
                status={task.done ? <StatusBadge tone="success" label={translate('kunden.detail.taskDone')} icon={false} /> : undefined}
              />
            ))}
          </BusinessList>
        )}
      </DetailSection>
      </div>
      </div>
    </Page>
  );
}

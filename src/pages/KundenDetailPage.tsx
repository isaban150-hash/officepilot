import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { Badge, Card, CardMeta, CardTitle, DataRow, PageHeader } from '../components/ui/Card';
import { EmptyStateBlock } from '../components/ui/EmptyStateBlock';
import { useApp } from '../context/AppContext';
import { getKundenWorkspace } from '../services/kundenWorkspaceService';
import type { TranslationKey } from '../i18n';

export function KundenDetailPage() {
  const { translate } = useApp();
  const navigate = useNavigate();
  const { name: rawName } = useParams<{ name: string }>();
  const workspace = rawName ? getKundenWorkspace(rawName) : null;

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
      <PageHeader
        title={contact.name}
        subtitle={translate('kunden.detail.subtitle')}
        backLabel={translate('common.back')}
        onBack={() => navigate('/kunden')}
      />

      <section className="kunden-detail-section" data-testid="kunden-contact">
        <h2 className="kunden-detail-section__title">{translate('kunden.detail.contactTitle')}</h2>
        <Card>
          <DataRow label={translate('kunden.detail.contactPerson')} value={contact.contactPerson || '—'} />
          <DataRow label={translate('kunden.detail.phone')} value={contact.phone || '—'} />
          <DataRow label={translate('kunden.detail.email')} value={contact.email || '—'} />
          <DataRow label={translate('kunden.detail.address')} value={contact.addressLine || '—'} />
        </Card>
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

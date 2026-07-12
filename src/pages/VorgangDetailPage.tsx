import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { OrderPositionForm } from '../components/vorgang/OrderPositionForm';
import { DetailExperienceCard } from '../components/detail/DetailExperienceCard';
import { Card, CardMeta, CardTitle, DataRow } from '../components/ui/Card';
import { ShowMoreSection } from '../components/ui/ShowMoreSection';
import { useApp } from '../context/AppContext';
import { formatPaperFilingInstruction } from '../services/paperFolderService';
import { resolveVorgangDocumentDisplayName } from '../services/vorgangDocumentLinkService';
import {
  canAddOrderPosition,
  canDeleteOrderPosition,
  getBilledQuantity,
  getOpenQuantity,
  getPositionBillingStatus,
  hasFinalSchlussrechnung,
  hasSchlussrechnung,
} from '../services/invoiceService';
import { hasMissingOrderPrice } from '../services/orderPositionFactory';
import { formatOrderUnitDisplay } from '../services/orderUnitMapper';
import { getVorgangById, removeOrderPosition } from '../services/vorgangService';
import { InvoiceListCard } from '../components/invoice/InvoiceListCard';
import { CommunicationIntegrationPanel } from '../components/communication/CommunicationIntegrationPanel';
import { VORGANG_COMMUNICATION_BUTTON_KEYS } from '../components/communication/communicationNavigation';
import { AreaAiPanel } from '../components/ai/AreaAiPanel';
import {
  formatPaymentCurrency,
  summarizeVorgangInvoicePayments,
} from '../services/invoicePaymentService';
import {
  addVorgangNote,
  deleteVorgangNote,
  getNotesForVorgang,
} from '../services/vorgangNoteService';
import { askVorgangAi } from '../services/vorgang/vorgangAiService';
import { recordVorgangContext } from '../services/brain/companySessionService';
import type { VorgangNote } from '../types/communication';
import type { OrderPosition, Vorgang } from '../types/models';
import type { TranslationKey } from '../i18n';

type FormMode = { type: 'add' } | { type: 'edit'; position: OrderPosition } | null;

export function VorgangDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { translate, showToast } = useApp();
  const navigate = useNavigate();
  const [vorgang, setVorgang] = useState<Vorgang | undefined>(() =>
    id ? getVorgangById(id) : undefined,
  );
  const [formMode, setFormMode] = useState<FormMode>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [notes, setNotes] = useState<VorgangNote[]>(() =>
    id ? getNotesForVorgang(id) : [],
  );
  const [showDetails, setShowDetails] = useState(false);

  const refreshNotes = useCallback(() => {
    if (id) setNotes(getNotesForVorgang(id));
  }, [id]);

  const refreshVorgang = useCallback(() => {
    if (id) {
      setVorgang(getVorgangById(id));
    }
  }, [id]);

  useEffect(() => {
    if (id) {
      recordVorgangContext(id);
    }
  }, [id, vorgang?.status, vorgang?.invoices?.length]);

  useEffect(() => {
    refreshVorgang();
    refreshNotes();
    setShowDetails(false);
  }, [refreshVorgang, refreshNotes, id]);

  const handleAddNote = () => {
    const trimmed = noteDraft.trim();
    if (!trimmed || !id) return;
    const result = addVorgangNote(id, { body: trimmed });
    if (result.success) {
      setNoteDraft('');
      refreshNotes();
      showToast(translate('vorgangNote.saved'));
    }
  };

  const handleDeleteNote = (noteId: string) => {
    if (!window.confirm(translate('vorgangNote.deleteConfirm'))) return;
    const result = deleteVorgangNote(noteId);
    if (result.success) {
      refreshNotes();
      showToast(translate('vorgangNote.deleted'));
    }
  };

  if (!vorgang) {
    return (
      <div className="page">
        <p className="empty-state">{translate('vorgang.notFound')}</p>
        <Button variant="outline" onClick={() => navigate('/vorgaenge')}>
          {translate('common.back')}
        </Button>
      </div>
    );
  }

  const statusKey = `status.${vorgang.status}` as TranslationKey;
  const materialKey = `material.${vorgang.materialSource}` as TranslationKey;
  const hasOrderPositions = vorgang.orderPositions.length > 0;
  const schlussExists = hasSchlussrechnung(vorgang);
  const positionsLocked = hasFinalSchlussrechnung(vorgang);
  const canAdd = canAddOrderPosition(vorgang);
  const missingPrice = hasMissingOrderPrice(vorgang.orderPositions);

  const sortedInvoices = [...vorgang.invoices].sort(
    (a, b) => new Date(b.issueDate ?? b.date).getTime() - new Date(a.issueDate ?? a.date).getTime(),
  );
  const paymentTotals = summarizeVorgangInvoicePayments(vorgang.invoices);

  const openTasks = vorgang.tasks.filter((task) => !task.done);
  const highlights: string[] = [];
  if (openTasks.length > 0) {
    highlights.push(
      openTasks.length === 1
        ? openTasks[0]!.title
        : translate('vorgang.highlight.openTasks').replace('{count}', String(openTasks.length)),
    );
  }
  if (missingPrice) {
    highlights.push(translate('vorgang.missingPriceHint'));
  }
  if (paymentTotals.openTotal > 0) {
    highlights.push(
      translate('vorgang.highlight.openInvoices').replace(
        '{amount}',
        formatPaymentCurrency(paymentTotals.openTotal),
      ),
    );
  }
  if (!hasOrderPositions) {
    highlights.push(translate('vorgang.noOrderPositions'));
  }

  const handleSaved = (updated: Vorgang) => {
    setVorgang(updated);
  };

  const handleInvoiceUpdated = () => {
    refreshVorgang();
  };

  const handlePaymentToast = (message: string) => {
    showToast(message);
  };

  const primaryActions = (
    <>
      {hasOrderPositions && (
        <Link to={`/vorgaenge/${vorgang.id}/rechnung?type=rechnung`}>
          <Button fullWidth>{translate('detail.action.writeInvoice')}</Button>
        </Link>
      )}
      <Button variant="outline" fullWidth onClick={() => navigate('/scan')}>
        {translate('detail.action.addPhoto')}
      </Button>
      <Button
        variant="outline"
        fullWidth
        onClick={() => navigate(`/kommunikation?context=vorgang&id=${vorgang.id}`)}
      >
        {translate('detail.action.writeMessage')}
      </Button>
    </>
  );

  const technicalPanels = (
    <>
      <Card>
        <DataRow label={translate('analysis.baustelle')} value={vorgang.baustelle} />
        <DataRow label={translate('vorgang.materialSource')} value={translate(materialKey)} />
      </Card>

      <section className="section">
        <h2 className="section__title">{translate('vorgang.documents')}</h2>
        {vorgang.documents.length === 0 ? (
          <p className="empty-state">{translate('vorgang.noDocuments')}</p>
        ) : (
          vorgang.documents.map((doc) => {
            const typeKey = `docType.${doc.type}` as TranslationKey;
            return (
              <Card key={doc.id}>
                <CardTitle>{resolveVorgangDocumentDisplayName(doc)}</CardTitle>
                <CardMeta>{translate(typeKey)} · {doc.date}</CardMeta>
                {doc.paperFiling && (
                  <p className="filing-hint">{formatPaperFilingInstruction(doc.paperFiling)}</p>
                )}
              </Card>
            );
          })
        )}
      </section>

      <section className="section">
        <div className="section__header-row">
          <h2 className="section__title">{translate('vorgang.orderPositions')}</h2>
          {canAdd && (
            <Button variant="outline" onClick={() => setFormMode({ type: 'add' })}>
              {translate('position.add')}
            </Button>
          )}
        </div>

        {positionsLocked && (
          <p className="invoice-hint invoice-hint--warning">{translate('position.schlussLocked')}</p>
        )}

        {!hasOrderPositions ? (
          canAdd && (
            <Button fullWidth onClick={() => setFormMode({ type: 'add' })}>
              {translate('position.addFirst')}
            </Button>
          )
        ) : (
          vorgang.orderPositions.map((pos) => {
            const billing = getPositionBillingStatus(vorgang, pos.id);
            const billed = billing?.billedQuantity ?? getBilledQuantity(vorgang, pos.id);
            const open = billing?.openQuantity ?? getOpenQuantity(vorgang, pos.id);
            const deletable = canDeleteOrderPosition(vorgang, pos.id);

            const unitLabel = formatOrderUnitDisplay(pos.unit, pos.unitLabel);

            return (
              <Card key={pos.id} className="order-position-card">
                <CardTitle>{pos.description}</CardTitle>
                <DataRow
                  label={translate('invoice.planned')}
                  value={`${pos.plannedQuantity} ${unitLabel}`}
                />
                <DataRow
                  label={translate('invoice.unitPrice')}
                  value={`${pos.unitPrice.toLocaleString('de-DE')} €`}
                />
                <DataRow
                  label={translate('invoice.alreadyBilled')}
                  value={`${billed} ${unitLabel}`}
                />
                <DataRow
                  label={translate('invoice.stillOpen')}
                  value={`${open} ${unitLabel}`}
                />
                {pos.unitPrice === 0 && (
                  <p className="invoice-pos-hint">{translate('vorgang.missingPriceHint')}</p>
                )}
                {billing?.hasBilling && !positionsLocked && (
                  <p className="invoice-pos-hint">{translate('position.billedLockHint')}</p>
                )}
                <div className="order-position-card__actions">
                  {!positionsLocked && (
                    <Button variant="outline" onClick={() => setFormMode({ type: 'edit', position: pos })}>
                      {translate('position.edit')}
                    </Button>
                  )}
                  {deletable && (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        if (window.confirm(translate('position.deleteConfirm'))) {
                          const result = removeOrderPosition(vorgang.id, pos.id);
                          if (result.success) setVorgang(result.vorgang);
                        }
                      }}
                    >
                      {translate('position.delete')}
                    </Button>
                  )}
                </div>
              </Card>
            );
          })
        )}
      </section>

      <section className="section">
        <h2 className="section__title">{translate('vorgang.tasks')}</h2>
        {vorgang.tasks.map((task) => (
          <Card key={task.id} className={task.done ? 'card--done' : ''}>
            <CardTitle>{task.title}</CardTitle>
            {task.dueDate && <CardMeta>Frist: {task.dueDate}</CardMeta>}
          </Card>
        ))}
      </section>

      <section className="section">
        <h2 className="section__title">{translate('vorgangNote.title')}</h2>
        <Card>
          <label className="form-group">
            <span>{translate('vorgangNote.addLabel')}</span>
            <textarea
              className="input"
              rows={3}
              value={noteDraft}
              onChange={(event) => setNoteDraft(event.target.value)}
              placeholder={translate('vorgangNote.placeholder')}
            />
          </label>
          <Button type="button" onClick={handleAddNote} disabled={!noteDraft.trim()}>
            {translate('vorgangNote.add')}
          </Button>
        </Card>
        {notes.length === 0 ? (
          <p className="empty-state">{translate('vorgangNote.empty')}</p>
        ) : (
          notes.map((note) => (
            <Card key={note.id}>
              <CardMeta>{note.occurredAt}</CardMeta>
              <CardTitle>{note.body}</CardTitle>
              <Button type="button" variant="ghost" onClick={() => handleDeleteNote(note.id)}>
                {translate('vorgangNote.delete')}
              </Button>
            </Card>
          ))
        )}
      </section>

      <section className="section">
        <h2 className="section__title">{translate('vorgang.photos')}</h2>
        {vorgang.photos.length === 0 ? (
          <p className="empty-state">{translate('vorgang.noPhotos')}</p>
        ) : (
          vorgang.photos.map((photo) => (
            <Card key={photo.id}>
              <CardTitle>📷 {photo.caption}</CardTitle>
              <CardMeta>{photo.date}</CardMeta>
            </Card>
          ))
        )}
      </section>

      <section className="section">
        <h2 className="section__title">{translate('vorgang.invoices')}</h2>
        {sortedInvoices.length > 0 && (
          <Card className="vorgang-invoice-totals">
            <DataRow
              label={translate('payment.vorgangOpenTotal')}
              value={formatPaymentCurrency(paymentTotals.openTotal)}
            />
            <DataRow
              label={translate('payment.vorgangPaidTotal')}
              value={formatPaymentCurrency(paymentTotals.paidTotal)}
            />
          </Card>
        )}
        {sortedInvoices.length === 0 ? (
          <p className="empty-state">{translate('vorgang.noInvoices')}</p>
        ) : (
          sortedInvoices.map((inv) => (
            <InvoiceListCard
              key={inv.id}
              vorgangId={vorgang.id}
              invoice={inv}
              translate={translate}
              onInvoiceUpdated={handleInvoiceUpdated}
              onPaymentToast={handlePaymentToast}
            />
          ))
        )}
      </section>

      <CommunicationIntegrationPanel
        contextRef={{ type: 'vorgang', id: vorgang.id }}
        buttonKeys={VORGANG_COMMUNICATION_BUTTON_KEYS}
        testIdPrefix="vorgang"
      />

      <AreaAiPanel
        title={translate('detail.askOrder')}
        placeholder={translate('detail.askPlaceholder')}
        askLabel={translate('areaAi.ask')}
        loadingLabel={translate('areaAi.loading')}
        notConfiguredLabel={translate('areaAi.notConfigured')}
        testIdPrefix="vorgang-ai"
        onAsk={(question) => askVorgangAi({ vorgangId: vorgang.id, question })}
      />

      <div className="action-stack">
        {hasOrderPositions && !schlussExists && (
          <Link to={`/vorgaenge/${vorgang.id}/rechnung?type=schluss`}>
            <Button variant="outline" fullWidth>
              {translate('vorgang.prepareSchluss')}
            </Button>
          </Link>
        )}
        <Link to="/papierarchiv">
          <Button variant="outline" fullWidth>{translate('vorgang.paperArchive')}</Button>
        </Link>
      </div>
    </>
  );

  return (
    <div className="page vorgang-detail-page" data-testid="vorgang-detail-page">
      <button type="button" className="back-link" onClick={() => navigate('/vorgaenge')}>
        ← {translate('common.back')}
      </button>

      <DetailExperienceCard
        recognizedTitle={vorgang.title}
        recognizedSummary={`${vorgang.customer} · ${translate(statusKey)}`}
        assistantMessage={translate('vorgang.experience.managed')}
        highlights={highlights.length > 0 ? highlights : undefined}
        actions={primaryActions}
        testId="vorgang-detail-experience"
      />

      <ShowMoreSection
        expanded={showDetails}
        onToggle={() => setShowDetails((open) => !open)}
        showLabel={translate('common.showMore')}
        hideLabel={translate('common.showLess')}
        testId="vorgang-detail-show-more"
      >
        {technicalPanels}
      </ShowMoreSection>

      {formMode && (
        <OrderPositionForm
          mode={formMode.type}
          vorgang={vorgang}
          position={formMode.type === 'edit' ? formMode.position : undefined}
          onSaved={handleSaved}
          onClose={() => setFormMode(null)}
        />
      )}
    </div>
  );
}

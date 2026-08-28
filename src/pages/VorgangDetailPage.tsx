import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { OrderPositionForm } from '../components/vorgang/OrderPositionForm';
import { DetailExperienceCard } from '../components/detail/DetailExperienceCard';
import { Badge, Card, CardMeta, CardTitle, DataRow } from '../components/ui/Card';
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
import {
  getAllowedVorgangStatusTransitions,
} from '../services/vorgangLifecycleService';
import { isContractPlanLocked } from '../services/orderPlanIntegrityService';
import {
  assignCustomerToVorgang,
  getVorgangById,
  getVorgangCustomerMasterPreview,
  updateVorgangCustomerFromMaster,
  isVorgangCustomerAssignmentEligible,
  removeOrderPosition,
  updateVorgangStatus,
} from '../services/vorgangService';
import { getCustomerById } from '../services/customerStoreService';
import {
  CustomerDecisionChoice,
  type CustomerDecisionMode,
} from '../components/customer/CustomerDecisionChoice';
import {
  buildCustomerDecisionFromUi,
  buildCustomerInputFromUi,
  createEmptyCustomerExtraFields,
  isCustomerDecisionIncomplete,
  loadSelectableCustomers,
  resolveNewCustomerHintKey,
  type CustomerExtraFields,
} from '../components/customer/customerDecisionUi';
import { InvoiceListCard } from '../components/invoice/InvoiceListCard';
import { CommunicationIntegrationPanel } from '../components/communication/CommunicationIntegrationPanel';
import { VORGANG_COMMUNICATION_BUTTON_KEYS } from '../components/communication/communicationNavigation';
import { VorgangNegotiationPanel } from '../components/vorgang/VorgangNegotiationPanel';
import { VorgangContractConfirmPanel } from '../components/vorgang/VorgangContractConfirmPanel';
import { VorgangExecutionStartPanel } from '../components/vorgang/VorgangExecutionStartPanel';
import { VorgangOrderAmendmentPanel } from '../components/vorgang/VorgangOrderAmendmentPanel';
import { OrderPositionExecutedQuantityField } from '../components/vorgang/OrderPositionExecutedQuantityField';
import {
  VorgangSectionNav,
  vorgangSectionPanelProps,
  type VorgangDetailSection,
} from '../components/vorgang/VorgangSectionNav';
import { OrderSummaryPanel } from '../components/vorgang/OrderSummaryPanel';
import { VorgangNachweisePanel } from '../components/vorgang/VorgangNachweisePanel';
import { VorgangScopePanel } from '../components/vorgang/VorgangScopePanel';
import { VorgangBillingPreparationPanel } from '../components/vorgang/VorgangBillingPreparationPanel';
import { VorgangBillingOverviewHint } from '../components/vorgang/VorgangBillingOverviewHint';
import {
  formatAmendmentChangeTypeLabel,
  formatAmendmentMoney,
  positionLineTotal,
} from '../components/vorgang/orderAmendmentUiHelpers';
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
import { getLastPersistSuccess } from '../services/persistenceService';
import type { VorgangNote } from '../types/communication';
import type {
  Customer,
  CustomerBilling,
  OrderPosition,
  Vorgang,
  VorgangStatus,
} from '../types/models';
import type { TranslationKey } from '../i18n';
import { useReportUiSession } from '../hooks/useReportUiSession';
import { useUiSessionRestore } from '../hooks/useUiSessionRestore';

type FormMode = { type: 'add' } | { type: 'edit'; position: OrderPosition } | null;

export function VorgangDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { translate, showToast } = useApp();
  const navigate = useNavigate();
  const restoredSession = useUiSessionRestore();
  const skipChromeResetRef = useRef(Boolean(restoredSession));
  const [vorgang, setVorgang] = useState<Vorgang | undefined>(() =>
    id ? getVorgangById(id) : undefined,
  );
  const [formMode, setFormMode] = useState<FormMode>(null);
  const [customerMode, setCustomerMode] = useState<CustomerDecisionMode | null>(null);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const [newCustomerName, setNewCustomerName] = useState('');
  const [customerOptions, setCustomerOptions] = useState<Customer[]>([]);
  const [customerError, setCustomerError] = useState<string | null>(null);
  const [isAssigning, setIsAssigning] = useState(false);
  // CUSTOMER-FACHOBJEKT-05C — optional master data of a new customer.
  const [customerExtra, setCustomerExtra] = useState<CustomerExtraFields>(
    createEmptyCustomerExtraFields,
  );
  /** Synchronous lock — a second click in the same event turn must not assign again. */
  const assignLockRef = useRef(false);
  // CUSTOMER-FACHOBJEKT-06B — explicit takeover of the master data into this Vorgang.
  const [masterConfirmOpen, setMasterConfirmOpen] = useState(false);
  const [masterSaving, setMasterSaving] = useState(false);
  const [masterError, setMasterError] = useState<string | null>(null);
  const masterLockRef = useRef(false);
  const [masterReloadToken, setMasterReloadToken] = useState(0);
  const [noteDraft, setNoteDraft] = useState(() => {
    const note = restoredSession?.drafts.values.note;
    return typeof note === 'string' ? note : '';
  });
  const [notes, setNotes] = useState<VorgangNote[]>(() =>
    id ? getNotesForVorgang(id) : [],
  );
  const [showDetails, setShowDetails] = useState(
    () => restoredSession?.panelState.detailsOpen ?? false,
  );
  const [activeSection, setActiveSection] = useState<VorgangDetailSection>(
    () => (restoredSession?.activeSection as VorgangDetailSection | undefined) ?? 'overview',
  );

  useReportUiSession({
    workspaceType: 'vorgang',
    activeSection,
    panelState: {
      deepWorkspaceOpen: false,
      moreOptionsExpanded: false,
      detailsOpen: showDetails,
      assistOpen: false,
    },
    drafts: {
      values: noteDraft.trim() ? { note: noteDraft } : {},
      dirty: Boolean(noteDraft.trim()),
    },
    resumeLabel: vorgang
      ? {
          titleText: vorgang.title,
          subtitleText: vorgang.customer,
          entityHint: '',
        }
      : undefined,
  });

  /**
   * CUSTOMER-FACHOBJEKT-05C — one visible message per failed assignment.
   * The Vorgang mutation reports `order_amendment_local_persist_failed`, an
   * internal key without a dot; the assignment rolls everything back, so the
   * existing customer wording fits. Unknown free texts are never treated as keys.
   */
  const resolveAssignErrorMessage = (errorKey: string): string => {
    if (errorKey === 'order_amendment_local_persist_failed') {
      return translate('customer.persistFailed');
    }
    return errorKey.includes('.') ? translate(errorKey as TranslationKey) : errorKey;
  };

  const customerMasterPreview = useMemo(
    () => (id ? getVorgangCustomerMasterPreview(id) : null),
    [id, vorgang?.customer, vorgang?.customerId, vorgang?.customerBilling, masterReloadToken],
  );

  /** One readable line per stored field; empty values stay neutral. */
  const billingLines = (name: string, billing: CustomerBilling) => (
    <>
      <DataRow label={translate('kunden.edit.name')} value={name || '—'} />
      <DataRow
        label={translate('kunden.detail.contactPerson')}
        value={billing.contactPerson || '—'}
      />
      <DataRow label={translate('companyProfile.street')} value={billing.street || '—'} />
      <DataRow label={translate('companyProfile.zip')} value={billing.zip || '—'} />
      <DataRow label={translate('companyProfile.city')} value={billing.city || '—'} />
      <DataRow label={translate('companyProfile.email')} value={billing.email || '—'} />
      <DataRow label={translate('companyProfile.phone')} value={billing.phone || '—'} />
    </>
  );

  const handleApplyCustomerMaster = () => {
    if (!id || masterLockRef.current) return;
    // Locked synchronously; released only after this event turn.
    masterLockRef.current = true;
    setMasterSaving(true);
    const release = () => {
      masterLockRef.current = false;
      setMasterSaving(false);
    };

    const result = updateVorgangCustomerFromMaster(id);
    if (!result.success) {
      setMasterError(resolveAssignErrorMessage(result.errorKey));
      queueMicrotask(release);
      return;
    }
    setMasterError(null);
    setMasterConfirmOpen(false);
    setMasterReloadToken((value) => value + 1);
    refreshVorgang();
    if (result.changed) showToast(translate('vorgang.customerMaster.success'));
    queueMicrotask(release);
  };

  const handleAssignCustomer = () => {
    if (!vorgang || assignDisabled || assignLockRef.current) return;
    setCustomerError(null);

    const decision = buildCustomerDecisionFromUi(
      customerMode,
      buildCustomerInputFromUi(newCustomerName, customerExtra),
      selectedCustomerId,
    );
    if (!decision || decision.kind === 'none') {
      setCustomerError(translate('customerDecision.required'));
      return;
    }
    if (decision.kind === 'existing' && !getCustomerById(decision.customerId)) {
      setCustomerError(translate('customerDecision.missing'));
      return;
    }

    // Locked synchronously; released only after this event turn.
    assignLockRef.current = true;
    setIsAssigning(true);
    try {
      const result = assignCustomerToVorgang(vorgang.id, decision);
      if (!result.success) {
        // Auswahl bleibt erhalten, damit der Nutzer korrigieren kann.
        // Genau einmal auflösen; interne Rohschlüssel werden nie sichtbar.
        const message = resolveAssignErrorMessage(result.errorKey);
        setCustomerError(message);
        showToast(message);
        return;
      }
      setCustomerMode(null);
      setSelectedCustomerId(null);
      setNewCustomerName('');
      setCustomerExtra(createEmptyCustomerExtraFields());
      refreshVorgang();
      showToast(translate('vorgang.assignCustomer.success'));
    } finally {
      // Never released synchronously — a second event of the same turn must not pass.
      queueMicrotask(() => {
        assignLockRef.current = false;
        setIsAssigning(false);
      });
    }
  };

  const refreshNotes = useCallback(() => {
    if (id) setNotes(getNotesForVorgang(id));
  }, [id]);

  // CUSTOMER-FACHOBJEKT-04D-U4 — later assignment, only in the exact unknown state.
  const customerAssignmentVisible = Boolean(
    vorgang && isVorgangCustomerAssignmentEligible(vorgang),
  );
  const assignHintKey = resolveNewCustomerHintKey(customerMode, newCustomerName);
  const assignDisabled = isCustomerDecisionIncomplete(
    customerMode,
    newCustomerName,
    selectedCustomerId,
  );

  /**
   * CUSTOMER-FACHOBJEKT-06B3 — the 06B confirmation belongs to exactly one
   * Vorgang. A real identity change closes it and clears error, busy state and
   * the synchronous lock; normal renders, preview recalculations, reloadToken
   * changes and form input never trigger this effect.
   */
  useEffect(() => {
    masterLockRef.current = false;
    setMasterSaving(false);
    setMasterConfirmOpen(false);
    setMasterError(null);
  }, [id, vorgang?.id]);

  // Beim Wechsel des angezeigten Vorgangs darf keine Auswahl übernommen werden.
  useEffect(() => {
    setCustomerMode(null);
    setSelectedCustomerId(null);
    setNewCustomerName('');
    setCustomerError(null);
    setCustomerExtra(createEmptyCustomerExtraFields());
    assignLockRef.current = false;
    setIsAssigning(false);
    setCustomerOptions(customerAssignmentVisible ? loadSelectableCustomers() : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerAssignmentVisible, vorgang?.id]);

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
    if (skipChromeResetRef.current) {
      skipChromeResetRef.current = false;
      return;
    }
    setShowDetails(false);
    setActiveSection('overview');
    setNoteDraft('');
  }, [refreshVorgang, refreshNotes, id]);

  const handleAddNote = () => {
    const trimmed = noteDraft.trim();
    if (!trimmed || !id) return;
    const result = addVorgangNote(id, { body: trimmed });
    if (result.success) {
      setNoteDraft('');
      refreshNotes();
      if (!getLastPersistSuccess()) {
        showToast(translate('persist.failed.userAction'));
      } else {
        showToast(translate('vorgangNote.saved'));
      }
    }
  };

  const handleDeleteNote = (noteId: string) => {
    if (!window.confirm(translate('vorgangNote.deleteConfirm'))) return;
    const result = deleteVorgangNote(noteId);
    if (result.success) {
      refreshNotes();
      if (!getLastPersistSuccess()) {
        showToast(translate('persist.failed.userAction'));
      } else {
        showToast(translate('vorgangNote.deleted'));
      }
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
  const planLocked = isContractPlanLocked(vorgang);
  const positionsLocked = hasFinalSchlussrechnung(vorgang) || planLocked;
  const canAdd = canAddOrderPosition(vorgang) && !planLocked;
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

  const handleStatusChange = (nextStatus: VorgangStatus) => {
    if (!vorgang) return;
    const result = updateVorgangStatus(vorgang.id, nextStatus);
    if (!result.success) {
      showToast(translate(result.errorKey));
      return;
    }
    setVorgang(result.vorgang);
    if (!getLastPersistSuccess()) {
      showToast(translate('persist.failed.userAction'));
    }
  };

  const allowedStatusTransitions = vorgang
    ? getAllowedVorgangStatusTransitions(vorgang.status)
    : [];

  const handleInvoiceUpdated = () => {
    refreshVorgang();
  };

  const handlePaymentToast = (message: string) => {
    showToast(message);
  };

  const goToAmendments = () => {
    setActiveSection('amendments');
  };

  const primaryActions = (
    <>
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

  const hasOpenAmendmentDraft = (vorgang.orderAmendments?.length ?? 0) > 0;
  const prepareInvoicePath = `/vorgaenge/${vorgang.id}/rechnung?type=rechnung`;

  const secondaryPanels = (
    <>
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

      <VorgangSectionNav
        activeSection={activeSection}
        onChange={setActiveSection}
        translate={translate}
      />

      <div {...vorgangSectionPanelProps('overview', activeSection)}>
        <DetailExperienceCard
          recognizedTitle={vorgang.title}
          recognizedSummary={`${vorgang.customer} · ${translate(statusKey)}`}
          assistantMessage={translate('vorgang.experience.managed')}
          highlights={highlights.length > 0 ? highlights : undefined}
          actions={primaryActions}
          testId="vorgang-detail-experience"
        />

        {customerAssignmentVisible && (
          <Card data-testid="vorgang-assign-customer">
            <h2 className="section__title">{translate('vorgang.assignCustomer.title')}</h2>
            <CustomerDecisionChoice
              mode={customerMode}
              onModeChange={(next) => {
                setCustomerMode(next);
                setSelectedCustomerId(null);
                setCustomerError(null);
              }}
              customers={customerOptions}
              selectedCustomerId={selectedCustomerId}
              onSelectCustomer={(id) => {
                setSelectedCustomerId(id);
                setCustomerError(null);
              }}
              hint={assignHintKey ? translate(assignHintKey) : customerError}
              extraFields={customerExtra}
              onExtraFieldChange={(field, value) => {
                setCustomerExtra((prev) => ({ ...prev, [field]: value }));
                setCustomerError(null);
              }}
            />
            {customerMode === 'new' && (
              <label className="edit-field">
                <span className="edit-field__label">{translate('kunden.edit.name')}</span>
                <input
                  type="text"
                  className="input"
                  value={newCustomerName}
                  data-testid="vorgang-assign-customer-name"
                  onChange={(event) => {
                    setNewCustomerName(event.target.value);
                    setCustomerError(null);
                  }}
                />
              </label>
            )}
            <Button
              fullWidth
              data-testid="vorgang-assign-customer-submit"
              disabled={assignDisabled || isAssigning}
              onClick={handleAssignCustomer}
            >
              {translate('vorgang.assignCustomer.action')}
            </Button>
          </Card>
        )}

        {customerMasterPreview?.differs && (
          <Card data-testid="vorgang-customer-master">
            <h2 className="section__title">{translate('vorgang.customerMaster.title')}</h2>
            {!masterConfirmOpen ? (
              <Button
                type="button"
                variant="secondary"
                data-testid="vorgang-customer-master-action"
                onClick={() => {
                  masterLockRef.current = false;
                  setMasterSaving(false);
                  setMasterError(null);
                  setMasterConfirmOpen(true);
                }}
              >
                {translate('vorgang.customerMaster.action')}
              </Button>
            ) : (
              <div data-testid="vorgang-customer-master-confirm">
                <h3 className="section__subtitle">
                  {translate('vorgang.customerMaster.currentTitle')}
                </h3>
                <div data-testid="vorgang-customer-master-current">
                  {billingLines(customerMasterPreview.currentName, customerMasterPreview.current)}
                </div>
                <h3 className="section__subtitle">
                  {translate('vorgang.customerMaster.masterTitle')}
                </h3>
                <div data-testid="vorgang-customer-master-next">
                  {billingLines(customerMasterPreview.master.name, customerMasterPreview.master)}
                </div>
                <p className="hint-text">{translate('vorgang.customerMaster.scope')}</p>
                <p className="hint-text">{translate('vorgang.customerMaster.futureDrafts')}</p>
                <p className="hint-text">{translate('vorgang.customerMaster.existingInvoices')}</p>
                <p className="hint-text">{translate('vorgang.customerMaster.overwrite')}</p>
                {masterError && (
                  <p className="form-error" data-testid="vorgang-customer-master-error">
                    {masterError}
                  </p>
                )}
                <div className="form-actions">
                  <Button
                    type="button"
                    disabled={masterSaving}
                    data-testid="vorgang-customer-master-apply"
                    onClick={handleApplyCustomerMaster}
                  >
                    {translate('vorgang.customerMaster.confirmAction')}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={masterSaving}
                    data-testid="vorgang-customer-master-cancel"
                    onClick={() => {
                      masterLockRef.current = false;
                      setMasterSaving(false);
                      setMasterError(null);
                      setMasterConfirmOpen(false);
                    }}
                  >
                    {translate('common.cancel')}
                  </Button>
                </div>
              </div>
            )}
          </Card>
        )}

        <Card data-testid="vorgang-overview-status">
          <DataRow label={translate('vorgang.status.label')} value={translate(statusKey)} />
          <DataRow label={translate('analysis.baustelle')} value={vorgang.baustelle} />
          <DataRow label={translate('vorgang.materialSource')} value={translate(materialKey)} />
          {allowedStatusTransitions.length > 0 ? (
            <label className="form-group">
              <span>{translate('vorgang.status.next')}</span>
              <select
                className="input"
                data-testid="vorgang-status-select"
                value=""
                onChange={(event) => {
                  const next = event.target.value as VorgangStatus;
                  if (next) handleStatusChange(next);
                }}
              >
                <option value="">{translate('vorgang.status.next')}</option>
                {allowedStatusTransitions.map((status) => (
                  <option key={status} value={status}>
                    {translate(`status.${status}` as TranslationKey)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </Card>

        <OrderSummaryPanel vorgang={vorgang} translate={translate} />

        <VorgangScopePanel vorgang={vorgang} translate={translate} />

        <VorgangNachweisePanel vorgangId={vorgang.id} translate={translate} />

        <VorgangBillingOverviewHint
          vorgang={vorgang}
          translate={translate}
          onOpenInvoices={() => setActiveSection('invoices')}
        />
      </div>

      <div {...vorgangSectionPanelProps('order', activeSection)}>
        <section className="section">
          <h2 className="section__title">{translate('vorgang.section.order')}</h2>
          <p className="order-amendment-section__intro">{translate('vorgang.orderSectionIntro')}</p>
        </section>

        <VorgangNegotiationPanel
          vorgang={vorgang}
          translate={translate}
          onUpdated={refreshVorgang}
          onToast={showToast}
        />

        <VorgangContractConfirmPanel
          vorgang={vorgang}
          translate={translate}
          onUpdated={refreshVorgang}
          onToast={showToast}
        />

        <VorgangExecutionStartPanel
          vorgang={vorgang}
          translate={translate}
          onUpdated={refreshVorgang}
          onToast={showToast}
        />

        <section className="section">
          <div className="section__header-row">
            <h2 className="section__title">{translate('vorgang.orderPositions')}</h2>
            {canAdd && (
              <Button variant="outline" onClick={() => setFormMode({ type: 'add' })}>
                {translate('position.add')}
              </Button>
            )}
          </div>

          {planLocked && (
            <p className="invoice-hint invoice-hint--warning" data-testid="order-plan-confirmed-hint">
              {translate('orderPlan.confirmedHint')}{' '}
              <Button
                variant="ghost"
                data-testid="order-plan-prepare-amendment-link"
                onClick={goToAmendments}
              >
                {translate('orderAmendment.prepare')}
              </Button>
            </p>
          )}
          {!planLocked && positionsLocked && (
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
              const deletable = !planLocked && canDeleteOrderPosition(vorgang, pos.id);

              const unitLabel = formatOrderUnitDisplay(pos.unit, pos.unitLabel);
              const changeType = pos.amendmentChangeType;
              const isAmendmentSourced =
                changeType === 'add' || changeType === 'quantity_increase';

              return (
                <Card key={pos.id} className="order-position-card" data-testid={`order-position-card-${pos.id}`}>
                  <div className="order-position-card__header">
                    <Badge tone={isAmendmentSourced ? 'info' : 'default'}>
                      {isAmendmentSourced
                        ? formatAmendmentChangeTypeLabel(changeType, translate)
                        : translate('order.position.sourceMain')}
                    </Badge>
                    <CardTitle>{pos.description}</CardTitle>
                  </div>
                  <DataRow
                    label={translate('execution.plannedQuantity')}
                    value={`${pos.plannedQuantity} ${unitLabel}`}
                  />
                  <OrderPositionExecutedQuantityField
                    vorgang={vorgang}
                    position={pos}
                    unitLabel={unitLabel}
                    translate={translate}
                    onUpdated={setVorgang}
                    onToast={showToast}
                  />
                  <DataRow
                    label={translate('order.position.billedQuantity')}
                    value={`${billed} ${unitLabel}`}
                  />
                  <DataRow
                    label={translate('order.position.openBillableQuantity')}
                    value={`${open} ${unitLabel}`}
                  />
                  <DataRow
                    label={translate('invoice.unitPrice')}
                    value={formatAmendmentMoney(pos.unitPrice)}
                  />
                  <DataRow
                    label={translate('order.position.total')}
                    value={formatAmendmentMoney(
                      positionLineTotal(pos.plannedQuantity, pos.unitPrice),
                    )}
                  />
                  {pos.unitPrice === 0 && (
                    <p className="invoice-pos-hint">{translate('vorgang.missingPriceHint')}</p>
                  )}
                  {billing?.hasBilling && !positionsLocked && !planLocked && (
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
      </div>

      <div {...vorgangSectionPanelProps('amendments', activeSection)}>
        <VorgangOrderAmendmentPanel
          vorgang={vorgang}
          translate={translate}
          onUpdated={refreshVorgang}
          onToast={showToast}
          isSectionActive={activeSection === 'amendments'}
        />
      </div>

      <div {...vorgangSectionPanelProps('invoices', activeSection)}>
        <VorgangBillingPreparationPanel vorgang={vorgang} translate={translate} />

        <section
          className="section vorgang-invoices-section"
          data-testid="vorgang-invoices-section"
        >
          <div className="vorgang-invoices-section__header">
            <div className="vorgang-invoices-section__heading">
              <h2 className="section__title">{translate('vorgang.invoices')}</h2>
              <p className="vorgang-invoices-section__intro">
                {translate('vorgang.invoicesSectionIntro')}
              </p>
            </div>
            {/*
              Nach einer Schlussrechnung führt dieser Einstieg nur noch in einen
              Editor ohne offene Mengen. Der Einstieg für Schlussrechnungen
              (oben) prüft das längst — der allgemeine bislang nicht.
              Bewusst ohne Mengenprüfung: solange keine Schlussrechnung
              existiert, bleibt ein pauschaler Abschlag ein legitimer Weg.
            */}
            {hasOrderPositions && !schlussExists ? (
              <div className="vorgang-invoices-section__cta">
                <Link
                  to={prepareInvoicePath}
                  data-testid="vorgang-prepare-invoice"
                  className="vorgang-invoices-section__cta-link"
                >
                  <Button fullWidth>{translate('vorgang.prepareInvoice')}</Button>
                </Link>
              </div>
            ) : null}
            {/* Bestehende Hinweis-Optik der Sektion; keine neue CSS-Regel nötig. */}
            {hasOrderPositions && schlussExists ? (
              <p
                className="vorgang-invoices-section__draft-hint"
                data-testid="vorgang-invoices-closed"
              >
                {translate('vorgang.invoicesClosedBySchluss')}
              </p>
            ) : null}
          </div>

          {hasOpenAmendmentDraft ? (
            <p
              className="vorgang-invoices-section__draft-hint"
              data-testid="vorgang-invoices-open-draft-hint"
            >
              {translate('vorgang.invoicesOpenDraftHint')}
            </p>
          ) : null}

          {sortedInvoices.length > 0 ? (
            <Card className="vorgang-invoice-totals" data-testid="vorgang-invoice-summary">
              <DataRow
                label={translate('vorgang.invoicesSummaryCount')}
                value={String(sortedInvoices.length)}
              />
              <DataRow
                label={translate('vorgang.invoicesSummaryOpen')}
                value={formatPaymentCurrency(paymentTotals.openTotal)}
              />
              <DataRow
                label={translate('vorgang.invoicesSummaryPaid')}
                value={formatPaymentCurrency(paymentTotals.paidTotal)}
              />
            </Card>
          ) : null}

          {sortedInvoices.length === 0 ? (
            <div
              className="vorgang-invoices-section__empty"
              data-testid="vorgang-invoices-empty"
            >
              {hasOrderPositions ? (
                <>
                  <p className="empty-state">
                    {translate('vorgang.invoicesEmptyWithPositions')}
                  </p>
                  <p className="vorgang-invoices-section__empty-detail">
                    {translate('vorgang.invoicesEmptyWithPositionsHint')}
                  </p>
                </>
              ) : (
                <p className="empty-state">
                  {translate('vorgang.invoicesEmptyNoPositions')}
                </p>
              )}
            </div>
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
      </div>

      <ShowMoreSection
        expanded={showDetails}
        onToggle={() => setShowDetails((open) => !open)}
        showLabel={translate('common.showMore')}
        hideLabel={translate('common.showLess')}
        testId="vorgang-detail-show-more"
      >
        {secondaryPanels}
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

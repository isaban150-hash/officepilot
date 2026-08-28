import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../ui/Button';
import { Card, DataRow } from '../ui/Card';
import { useApp } from '../../context/AppContext';
import { buildInvoiceCreatePath } from '../../services/invoiceNavigation';
import {
  createVorgangFromInboxWithContract,
  getContractPreviewForInbox,
} from '../../services/intakeWorkflowService';
import {
  buildVorgangDraftFromInbox,
  findSimilarVorgaenge,
  getAllVorgaenge,
  getVorgangById,
  getVorgangCardMode,
  isInboxLinkedToVorgang,
  linkInboxToExistingVorgang,
  type VorgangCardMode,
} from '../../services/vorgangService';
import { getLastPersistSuccess } from '../../services/persistenceService';
import { getCustomerById } from '../../services/customerStoreService';
import type { CustomerDecision } from '../../services/customerService';
import {
  buildCustomerSubline,
  CustomerDecisionChoice,
  type CustomerDecisionMode,
} from '../customer/CustomerDecisionChoice';
import {
  buildCustomerDecisionFromUi,
  buildCustomerInputFromUi,
  createEmptyCustomerExtraFields,
  isCustomerDecisionIncomplete,
  loadSelectableCustomers,
  resolveNewCustomerHintKey,
  type CustomerExtraFields,
} from '../customer/customerDecisionUi';
import type { Customer, InboxItem, MaterialStandard, Vorgang, VorgangDraft } from '../../types/models';
import type { TranslationKey } from '../../i18n';

interface InboxVorgangPanelProps {
  item: InboxItem;
  materialDefault: MaterialStandard;
  onLinked: (inbox: InboxItem, vorgang: Vorgang) => void;
  requestOpenDialog?: number;
}

export function InboxVorgangPanel({
  item,
  materialDefault,
  onLinked,
  requestOpenDialog = 0,
}: InboxVorgangPanelProps) {
  const { translate, showToast } = useApp();
  const mode = getVorgangCardMode(item);
  const contractPreview = getContractPreviewForInbox(item);
  const isOrderCreate = mode === 'create';
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState<VorgangDraft>(() =>
    buildVorgangDraftFromInbox(item, materialDefault),
  );
  const [similar, setSimilar] = useState<Vorgang[]>([]);
  const [selectedVorgangId, setSelectedVorgangId] = useState<string>('');
  const [customerMode, setCustomerMode] = useState<CustomerDecisionMode | null>(null);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  /** Runtime failures only (vanished customer). Static validation is derived below. */
  const [customerError, setCustomerError] = useState<string | null>(null);
  /** CUSTOMER-FACHOBJEKT-05C — optional master data of a new customer. */
  const [customerExtra, setCustomerExtra] = useState<CustomerExtraFields>(
    createEmptyCustomerExtraFields,
  );
  const [creating, setCreating] = useState(false);
  /** Synchronous lock — a second click in the same event turn must not create again. */
  const creatingRef = useRef(false);

  if (mode === 'none') return null;

  const openDialog = () => {
    const nextDraft = buildVorgangDraftFromInbox(item, materialDefault);
    let matches = findSimilarVorgaenge(nextDraft);

    if (mode === 'link') {
      if (item.vorgangId) {
        const suggested = getVorgangById(item.vorgangId);
        if (suggested && !matches.some((m) => m.id === suggested.id)) {
          matches = [suggested, ...matches];
        }
      }
      if (matches.length === 0) {
        matches = getAllVorgaenge();
      }
    }

    setDraft(nextDraft);
    setSimilar(matches);
    setSelectedVorgangId(matches[0]?.id ?? item.vorgangId ?? '');

    // Fresh snapshot per opening; no decision is carried over from a previous run.
    setCustomers(loadSelectableCustomers());
    setCustomerMode(null);
    setSelectedCustomerId(null);
    setCustomerError(null);
    setCustomerExtra(createEmptyCustomerExtraFields());
    creatingRef.current = false;
    setCreating(false);
    setDialogOpen(true);
  };

  useEffect(() => {
    if (requestOpenDialog > 0 && mode !== 'open') {
      openDialog();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestOpenDialog]);

  const closeDialog = () => setDialogOpen(false);

  const handleLink = (vorgangId: string) => {
    const result = linkInboxToExistingVorgang(item, vorgangId);
    if (result) {
      onLinked(result.inbox, result.vorgang);
      closeDialog();
      if (!getLastPersistSuccess()) {
        showToast(translate('persist.failed.userAction'));
      } else {
        showToast(translate('vorgang.link.success'));
      }
    }
  };

  const createDisabled = isCustomerDecisionIncomplete(
    customerMode,
    draft.customer,
    selectedCustomerId,
  );

  // Derived from the current state so the reason is visible while the button is
  // still disabled — a click on a disabled button never fires.
  const newCustomerHintKey = resolveNewCustomerHintKey(customerMode, draft.customer);
  const customerValidationHint = newCustomerHintKey ? translate(newCustomerHintKey) : null;

  const buildCustomerDecision = (): CustomerDecision | null => {
    if (customerMode === 'existing' && selectedCustomerId && !getCustomerById(selectedCustomerId)) {
      setCustomerError(translate('customerDecision.missing'));
      return null;
    }
    return buildCustomerDecisionFromUi(
      customerMode,
      buildCustomerInputFromUi(draft.customer, customerExtra),
      selectedCustomerId,
    );
  };

  const handleCreate = () => {
    if (customerMode === null || creatingRef.current) return;
    setCustomerError(null);

    const customerDecision = buildCustomerDecision();
    if (!customerDecision) return;

    // Locked synchronously, released only after this event turn.
    creatingRef.current = true;
    setCreating(true);
    const release = () => {
      creatingRef.current = false;
      setCreating(false);
    };

    const result = createVorgangFromInboxWithContract(item, draft, materialDefault, {
      customerDecision,
    });
    queueMicrotask(release);
    if (result) {
      onLinked(result.inbox, result.vorgang);
      closeDialog();
      if (!getLastPersistSuccess()) {
        showToast(translate('persist.failed.userAction'));
      } else {
        showToast(translate('vorgang.create.success'));
      }
      return;
    }

    // Dialog stays open and keeps the selection; never report success on null.
    if (!getLastPersistSuccess()) {
      showToast(translate('persist.failed.userAction'));
    } else if (isInboxLinkedToVorgang(item)) {
      showToast(translate('vorgang.alreadyLinked'));
    } else {
      showToast(translate('vorgang.createFailed'));
    }
  };

  const customerPreview =
    customerMode === 'none'
      ? translate('customerDecision.previewNone')
      : customerMode === 'existing' && selectedCustomerId
        ? (() => {
            const selected = customers.find((c) => c.id === selectedCustomerId);
            return selected
              ? `${selected.name} · ${buildCustomerSubline(
                  selected,
                  translate('customerDecision.noAddress'),
                )}`
              : draft.customer;
          })()
        : draft.customer;

  const formatCurrency = (value: number) =>
    `${value.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

  const primaryLabel =
    mode === 'open'
      ? translate('vorgang.open')
      : mode === 'create'
        ? translate(isOrderCreate ? 'vorgang.createOrder' : 'vorgang.create')
        : translate('vorgang.link');

  return (
    <>
      <Card className="vorgang-panel">
        <h3 className="section__title">{translate('vorgang.panelTitle')}</h3>
        {mode === 'open' && item.vorgangTitle && (
          <p className="vorgang-panel__linked">{item.vorgangTitle}</p>
        )}
        {mode !== 'open' && (
          <p className="vorgang-panel__hint">
            {mode === 'create'
              ? translate(isOrderCreate ? 'vorgang.createOrderHint' : 'vorgang.createHint')
              : translate('vorgang.linkHint')}
          </p>
        )}
        {mode === 'open' && item.vorgangId ? (
          <div className="vorgang-panel__actions">
            <Link to={`/vorgaenge/${item.vorgangId}`}>
              <Button fullWidth>{primaryLabel}</Button>
            </Link>
            <Link to={buildInvoiceCreatePath(item.vorgangId, 'rechnung')}>
              <Button fullWidth variant="outline">
                {translate('vorgang.prepareInvoice')}
              </Button>
            </Link>
          </div>
        ) : (
          <Button fullWidth onClick={openDialog}>
            {primaryLabel}
          </Button>
        )}
      </Card>

      {dialogOpen && (
        <div className="vorgang-dialog-backdrop" role="presentation" onClick={closeDialog}>
          <div
            className="vorgang-dialog"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="vorgang-dialog__title">
              {translate(
                isOrderCreate ? 'vorgang.createOrderDialogTitle' : 'vorgang.dialogTitle',
              )}
            </h3>
            <p className="vorgang-dialog__subtitle">{translate('vorgang.dialogSubtitle')}</p>

            <div className="vorgang-dialog__preview">
              <DataRow label={translate('vorgang.fieldTitle')} value={draft.title} />
              <DataRow label={translate('inbox.sender')} value={customerPreview} />
              <DataRow label={translate('analysis.baustelle')} value={draft.baustelle} />
              {isOrderCreate && contractPreview.hasContractPositions && (
                <>
                  <DataRow
                    label={translate('vorgang.preview.positionCount')}
                    value={String(contractPreview.positionCount)}
                  />
                  <DataRow
                    label={translate('vorgang.preview.contractSum')}
                    value={formatCurrency(contractPreview.contractSum)}
                  />
                </>
              )}
              {isOrderCreate && (
                <p className="vorgang-dialog__review-hint">
                  {translate('vorgang.preview.reviewBeforeInvoice')}
                </p>
              )}
              <DataRow
                label={translate('vorgang.materialSource')}
                value={translate(`material.${draft.materialSource}` as TranslationKey)}
              />
            </div>

            {mode === 'create' && (
              <div className="vorgang-dialog__edit">
                <label className="edit-field">
                  <span className="edit-field__label">{translate('vorgang.fieldTitle')}</span>
                  <input
                    type="text"
                    className="input"
                    value={draft.title}
                    onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  />
                </label>
                <label className="edit-field">
                  <span className="edit-field__label">{translate('kunden.edit.name')}</span>
                  <input
                    type="text"
                    className="input"
                    value={draft.customer}
                    disabled={customerMode === 'existing' || customerMode === 'none'}
                    data-testid="vorgang-dialog-customer-input"
                    onChange={(e) => {
                      setDraft({ ...draft, customer: e.target.value });
                      setCustomerError(null);
                    }}
                  />
                </label>
                <label className="edit-field">
                  <span className="edit-field__label">{translate('analysis.baustelle')}</span>
                  <input
                    type="text"
                    className="input"
                    value={draft.baustelle}
                    onChange={(e) => setDraft({ ...draft, baustelle: e.target.value })}
                  />
                </label>
              </div>
            )}

            {mode === 'create' && (
              <CustomerDecisionChoice
                mode={customerMode}
                onModeChange={(next) => {
                  setCustomerMode(next);
                  setSelectedCustomerId(null);
                  setCustomerError(null);
                }}
                customers={customers}
                selectedCustomerId={selectedCustomerId}
                onSelectCustomer={(id) => {
                  setSelectedCustomerId(id);
                  setCustomerError(null);
                }}
                hint={customerValidationHint ?? customerError}
                extraFields={customerExtra}
                onExtraFieldChange={(field, value) => {
                  setCustomerExtra((prev) => ({ ...prev, [field]: value }));
                  setCustomerError(null);
                }}
              />
            )}

            {similar.length > 0 && (
              <div className="vorgang-dialog__similar">
                <h4 className="vorgang-dialog__similar-title">
                  {translate('vorgang.similarFound')}
                </h4>
                <div className="similar-list">
                  {similar.map((v) => (
                    <label key={v.id} className="similar-item">
                      <input
                        type="radio"
                        name="similarVorgang"
                        value={v.id}
                        checked={selectedVorgangId === v.id}
                        onChange={() => setSelectedVorgangId(v.id)}
                      />
                      <span>
                        <strong>{v.title}</strong>
                        <br />
                        {v.customer} · {v.baustelle}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div className="vorgang-dialog__actions">
              {(mode === 'link' || similar.length > 0) && (
                <Button
                  fullWidth
                  onClick={() => selectedVorgangId && handleLink(selectedVorgangId)}
                  disabled={!selectedVorgangId}
                >
                  {translate('vorgang.linkExisting')}
                </Button>
              )}
              {mode === 'create' && (
                <Button
                  variant={similar.length > 0 ? 'outline' : 'primary'}
                  fullWidth
                  disabled={createDisabled || creating}
                  data-testid="vorgang-dialog-create"
                  onClick={handleCreate}
                >
                  {translate(
                    isOrderCreate && similar.length === 0
                      ? 'vorgang.createOrderConfirm'
                      : 'vorgang.createNew',
                  )}
                </Button>
              )}
              <Button variant="ghost" fullWidth onClick={closeDialog}>
                {translate('inbox.edit.cancel')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export { getVorgangCardMode };
export type { VorgangCardMode };

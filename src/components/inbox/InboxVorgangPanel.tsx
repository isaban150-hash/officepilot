import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../ui/Button';
import { Card, DataRow } from '../ui/Card';
import { useApp } from '../../context/AppContext';
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
import { isOwnCompanyName } from '../../services/customerOwnCompanyGuard';
import { getCustomerById, getCustomerStoreSnapshot } from '../../services/customerStoreService';
import {
  buildCustomerSubline,
  CustomerDecisionChoice,
  type CustomerDecisionMode,
} from '../customer/CustomerDecisionChoice';
import type { CustomerDecision } from '../../services/customerService';
import type { Customer, InboxItem, MaterialStandard, Vorgang, VorgangDraft } from '../../types/models';
import type { TranslationKey } from '../../i18n';

/** Selectable customers: no empty names, never the own company, deterministic order. */
function loadSelectableCustomers(): Customer[] {
  return getCustomerStoreSnapshot()
    .filter((customer) => customer.name.trim() && !isOwnCompanyName(customer.name))
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name, 'de') ||
        a.city.localeCompare(b.city, 'de') ||
        a.createdAt.localeCompare(b.createdAt),
    );
}

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

  const trimmedCustomerName = draft.customer.trim();
  const isOwnCompanyCustomer = isOwnCompanyName(trimmedCustomerName);
  const createDisabled =
    customerMode === null ||
    (customerMode === 'new' && (!trimmedCustomerName || isOwnCompanyCustomer)) ||
    (customerMode === 'existing' && !selectedCustomerId);

  // Derived from the current state so the reason is visible while the button is
  // still disabled — a click on a disabled button never fires.
  const customerValidationHint =
    customerMode !== 'new'
      ? null
      : !trimmedCustomerName
        ? translate('customerDecision.nameRequired')
        : isOwnCompanyCustomer
          ? translate('customerDecision.ownCompany')
          : null;

  const buildCustomerDecision = (): CustomerDecision | null => {
    if (customerMode === 'new') {
      if (!trimmedCustomerName || isOwnCompanyCustomer) return null;
      return { kind: 'new', input: { name: draft.customer } };
    }
    if (customerMode === 'existing') {
      if (!selectedCustomerId || !getCustomerById(selectedCustomerId)) {
        setCustomerError(translate('customerDecision.missing'));
        return null;
      }
      return { kind: 'existing', customerId: selectedCustomerId };
    }
    return { kind: 'none' };
  };

  const handleCreate = () => {
    if (customerMode === null) return;
    setCustomerError(null);

    const customerDecision = buildCustomerDecision();
    if (!customerDecision) return;

    const result = createVorgangFromInboxWithContract(item, draft, materialDefault, {
      customerDecision,
    });
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
            <Link to={`/vorgaenge/${item.vorgangId}/rechnung`}>
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
                  <span className="edit-field__label">{translate('inbox.sender')}</span>
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
                  disabled={createDisabled}
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

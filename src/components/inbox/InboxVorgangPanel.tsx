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
  linkInboxToExistingVorgang,
  type VorgangCardMode,
} from '../../services/vorgangService';
import type { InboxItem, MaterialStandard, Vorgang, VorgangDraft } from '../../types/models';
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
      showToast(translate('vorgang.link.success'));
      onLinked(result.inbox, result.vorgang);
      closeDialog();
    }
  };

  const handleCreate = () => {
    const result = createVorgangFromInboxWithContract(item, draft, materialDefault);
    if (result) {
      showToast(translate('vorgang.create.success'));
      onLinked(result.inbox, result.vorgang);
      closeDialog();
    } else {
      showToast(translate('vorgang.alreadyLinked'));
    }
  };

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
              <DataRow label={translate('inbox.sender')} value={draft.customer} />
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
                    onChange={(e) => setDraft({ ...draft, customer: e.target.value })}
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
                <Button variant={similar.length > 0 ? 'outline' : 'primary'} fullWidth onClick={handleCreate}>
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

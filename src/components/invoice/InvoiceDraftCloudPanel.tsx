/**
 * CLOUD-SYNC S5 — sichtbarer Konflikt und „Entwurf verwerfen" in beiden
 * Rechnungseditoren.
 *
 * Keine Feld-Merge-Oberfläche: Es gibt nur die Aktionen, die der
 * implementierte Vertrag sicher trägt, und jede davon erst nach ausdrücklicher
 * Bestätigung.
 */
import { useState, type ReactNode } from 'react';
import type { TranslationKey } from '../../i18n';
import type { InvoiceDraftCloudState } from '../../services/invoice/useInvoiceDraftCloudState';
import type { InvoiceDraftCloudDecisionResult } from '../../services/invoice/invoiceDraftCloudBridge';
import { Button } from '../ui/Button';
import { InlineNotice } from '../ui/States';
import { SimpleConfirmDialog } from '../ui/SimpleConfirmDialog';

type PendingAction =
  | 'takeCloud'
  | 'keepMine'
  | 'acceptEnd'
  | 'continueAsNew'
  | 'adoptOther'
  | 'keepOwn'
  | 'discard';

interface InvoiceDraftCloudPanelProps {
  cloud: InvoiceDraftCloudState;
  translate: (key: TranslationKey) => string;
  /** Aktiver Entwurf ohne laufende Freigabe — nur dann darf verworfen werden. */
  canDiscard: boolean;
  /** Nach Verwerfen oder angenommenem Ende den Editor verlassen (optional zur fertigen Rechnung). */
  onLeave: (finalizedInvoiceId?: string) => void;
}

const CONFIRM: Record<PendingAction, { title: TranslationKey; body: TranslationKey; label: TranslationKey; danger: boolean }> = {
  takeCloud: {
    title: 'invoiceDraftCloud.confirm.takeCloud.title',
    body: 'invoiceDraftCloud.confirm.takeCloud.body',
    label: 'invoiceDraftCloud.action.takeCloud',
    danger: true,
  },
  keepMine: {
    title: 'invoiceDraftCloud.confirm.keepMine.title',
    body: 'invoiceDraftCloud.confirm.keepMine.body',
    label: 'invoiceDraftCloud.action.keepMine',
    danger: true,
  },
  acceptEnd: {
    title: 'invoiceDraftCloud.confirm.acceptDiscard.title',
    body: 'invoiceDraftCloud.confirm.acceptDiscard.body',
    label: 'invoiceDraftCloud.action.acceptDiscard',
    danger: true,
  },
  continueAsNew: {
    title: 'invoiceDraftCloud.confirm.continueAsNew.title',
    body: 'invoiceDraftCloud.confirm.continueAsNew.body',
    label: 'invoiceDraftCloud.action.continueAsNew',
    danger: false,
  },
  adoptOther: {
    title: 'invoiceDraftCloud.confirm.adoptOther.title',
    body: 'invoiceDraftCloud.confirm.adoptOther.body',
    label: 'invoiceDraftCloud.action.adoptOther',
    danger: true,
  },
  keepOwn: {
    title: 'invoiceDraftCloud.confirm.keepOwn.title',
    body: 'invoiceDraftCloud.confirm.keepOwn.body',
    label: 'invoiceDraftCloud.action.keepOwnDiscardOther',
    danger: true,
  },
  discard: {
    title: 'invoiceDraftCloud.discard.title',
    body: 'invoiceDraftCloud.discard.body',
    label: 'invoiceDraftCloud.discard.action',
    danger: true,
  },
};

export function InvoiceDraftCloudPanel({ cloud, translate, canDiscard, onLeave }: InvoiceDraftCloudPanelProps) {
  const [pending, setPending] = useState<PendingAction | null>(null);
  const conflict = cloud.conflict;

  const perform = async (action: PendingAction): Promise<boolean> => {
    let result: InvoiceDraftCloudDecisionResult;
    switch (action) {
      case 'takeCloud':
        result = await cloud.takeCloud();
        break;
      case 'keepMine':
        result = await cloud.keepMine();
        break;
      case 'acceptEnd':
        result = await cloud.acceptEnd();
        break;
      case 'continueAsNew':
        result = await cloud.continueAsNew();
        break;
      case 'adoptOther':
        result = await cloud.adoptOther();
        break;
      case 'keepOwn':
        result = await cloud.keepOwnDiscardOther();
        break;
      default:
        result = await cloud.discard();
    }
    if (!result.ok) return false;
    setPending(null);
    if (action === 'discard' || action === 'acceptEnd') {
      onLeave(result.finalizedInvoiceId);
    }
    return true;
  };

  const failureMessage =
    pending === 'continueAsNew'
      ? translate('invoiceDraftCloud.decision.slotTaken')
      : pending === 'discard'
        ? translate('invoiceDraftCloud.discard.failed')
        : translate('invoiceDraftCloud.decision.failed');

  const action = (key: PendingAction, label: TranslationKey, variant: 'primary' | 'secondary' | 'outline' = 'secondary') => (
    <Button
      type="button"
      variant={variant}
      size="sm"
      disabled={cloud.busy}
      onClick={() => setPending(key)}
      data-testid={`invoice-draft-cloud-${key}`}
    >
      {translate(label)}
    </Button>
  );

  let notice: ReactNode = null;
  if (conflict?.kind === 'version') {
    notice = (
      <InlineNotice
        tone="warning"
        testId="invoice-draft-cloud-conflict"
        title={translate('invoiceDraftCloud.conflict.version.title')}
        action={
          <div className="form-actions">
            {action('takeCloud', 'invoiceDraftCloud.action.takeCloud', 'primary')}
            {action('keepMine', 'invoiceDraftCloud.action.keepMine')}
          </div>
        }
      >
        {translate('invoiceDraftCloud.conflict.version.body')}
      </InlineNotice>
    );
  } else if (conflict?.kind === 'deleted') {
    notice = (
      <InlineNotice
        tone="warning"
        testId="invoice-draft-cloud-conflict"
        title={translate('invoiceDraftCloud.conflict.deleted.title')}
        action={
          <div className="form-actions">
            {action('continueAsNew', 'invoiceDraftCloud.action.continueAsNew', 'primary')}
            {action('acceptEnd', 'invoiceDraftCloud.action.acceptDiscard')}
          </div>
        }
      >
        {translate('invoiceDraftCloud.conflict.deleted.body')}
      </InlineNotice>
    );
  } else if (conflict?.kind === 'finalized') {
    notice = (
      <InlineNotice
        tone="info"
        testId="invoice-draft-cloud-conflict"
        title={translate('invoiceDraftCloud.conflict.finalized.title')}
        action={
          <div className="form-actions">
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={cloud.busy}
              data-testid="invoice-draft-cloud-acknowledge"
              onClick={() => {
                void perform('acceptEnd');
              }}
            >
              {translate('invoiceDraftCloud.action.acknowledge')}
            </Button>
          </div>
        }
      >
        {translate('invoiceDraftCloud.conflict.finalized.body')}
      </InlineNotice>
    );
  } else if (conflict?.kind === 'slot') {
    notice = (
      <InlineNotice
        tone="warning"
        testId="invoice-draft-cloud-conflict"
        title={translate('invoiceDraftCloud.conflict.slot.title')}
        action={
          <div className="form-actions">
            {action('adoptOther', 'invoiceDraftCloud.action.adoptOther', 'primary')}
            {action('keepOwn', 'invoiceDraftCloud.action.keepOwnDiscardOther')}
          </div>
        }
      >
        {translate('invoiceDraftCloud.conflict.slot.body')}
      </InlineNotice>
    );
  }

  const confirm = pending ? CONFIRM[pending] : null;

  return (
    <div className="invoice-draft-cloud" data-testid="invoice-draft-cloud" data-conflict={conflict?.kind ?? 'none'}>
      {notice}
      {!conflict && canDiscard ? (
        <div className="invoice-draft-cloud__discard">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={cloud.busy}
            data-testid="invoice-draft-discard"
            onClick={() => setPending('discard')}
          >
            {translate('invoiceDraftCloud.discard.action')}
          </Button>
        </div>
      ) : null}
      {confirm && pending ? (
        <SimpleConfirmDialog
          open
          title={translate(confirm.title)}
          message={translate(
            // Andere Geräte nur erwähnen, wenn Entwürfe wirklich geräteübergreifend abgeglichen werden.
            pending === 'discard' && !cloud.enabled ? 'invoiceDraftCloud.discard.bodyLocal' : confirm.body,
          )}
          confirmLabel={translate(confirm.label)}
          cancelLabel={translate('invoiceDraftCloud.action.cancel')}
          confirmVariant={confirm.danger ? 'danger' : 'primary'}
          confirmTestId={`invoice-draft-cloud-confirm-${pending}`}
          cancelTestId="invoice-draft-cloud-confirm-cancel"
          dialogTestId="invoice-draft-cloud-confirm"
          failureMessage={failureMessage}
          onConfirm={() => perform(pending)}
          onCancel={() => setPending(null)}
        />
      ) : null}
    </div>
  );
}

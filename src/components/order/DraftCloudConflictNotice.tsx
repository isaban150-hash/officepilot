/**
 * CLOUD-SYNC S6 — sichtbarer Konflikt eines Auftrags- oder Nachtragsentwurfs.
 *
 * Keine Feld-Merge-Oberfläche: Angeboten werden nur die Aktionen, die der
 * implementierte Vertrag sicher trägt, und jede, die Inhalt verwirft oder
 * ersetzt, erst nach ausdrücklicher Bestätigung. Ein verworfener oder
 * verbrauchter Entwurf wird nie mit derselben Kennung wieder aktiv — „Als
 * neuen Entwurf behalten" legt immer eine neue Kennung an.
 */
import { useState } from 'react';
import type { TranslationKey } from '../../i18n';
import type { DraftCloudConflictKind } from '../../types/draftCloud';
import { Button } from '../ui/Button';
import { InlineNotice } from '../ui/States';
import { SimpleConfirmDialog } from '../ui/SimpleConfirmDialog';

export type DraftCloudConflictAction =
  | 'takeCloud'
  | 'keepMine'
  | 'acceptEnd'
  | 'continueAsNew'
  | 'keepDraft'
  | 'discardAgain';

interface DraftCloudConflictNoticeProps {
  kind: DraftCloudConflictKind;
  /** `orderDraftCloud` oder `orderAmendmentCloud` — die Textfamilie. */
  textPrefix: 'orderDraftCloud' | 'orderAmendmentCloud';
  translate: (key: TranslationKey) => string;
  busy?: boolean;
  /** Führt die Entscheidung aus; `false` hält den Dialog mit Fehlerhinweis offen. */
  onDecide: (action: DraftCloudConflictAction) => boolean | Promise<boolean>;
  /** Optional: Weg zum entstandenen Auftrag (nur beim Auftragsentwurf). */
  orderLink?: { label: string; onOpen: () => void };
  testIdPrefix: string;
}

const CONFIRM: Partial<Record<DraftCloudConflictAction, { title: TranslationKey; body: TranslationKey; danger: boolean }>> = {
  takeCloud: { title: 'orderDraftCloud.confirm.takeCloud.title', body: 'orderDraftCloud.confirm.takeCloud.body', danger: true },
  keepMine: { title: 'orderDraftCloud.confirm.keepMine.title', body: 'orderDraftCloud.confirm.keepMine.body', danger: true },
  acceptEnd: { title: 'orderDraftCloud.confirm.acceptEnd.title', body: 'orderDraftCloud.confirm.acceptEnd.body', danger: true },
  continueAsNew: {
    title: 'orderDraftCloud.confirm.continueAsNew.title',
    body: 'orderDraftCloud.confirm.continueAsNew.body',
    danger: false,
  },
  discardAgain: { title: 'orderDraftCloud.confirm.discardAgain.title', body: 'orderDraftCloud.confirm.discardAgain.body', danger: true },
};

const LABEL: Record<DraftCloudConflictAction, TranslationKey> = {
  takeCloud: 'orderDraftCloud.action.takeCloud',
  keepMine: 'orderDraftCloud.action.keepMine',
  acceptEnd: 'orderDraftCloud.action.acceptDiscard',
  continueAsNew: 'orderDraftCloud.action.continueAsNew',
  keepDraft: 'orderDraftCloud.action.keepDraft',
  discardAgain: 'orderDraftCloud.action.discardAgain',
};

function actionsFor(kind: DraftCloudConflictKind): DraftCloudConflictAction[] {
  switch (kind) {
    case 'version':
      return ['takeCloud', 'keepMine'];
    case 'deleted':
    case 'consumed':
      return ['continueAsNew', 'acceptEnd'];
    case 'discard_rejected':
      return ['keepDraft', 'discardAgain'];
    default:
      return [];
  }
}

function textKey(prefix: string, kind: DraftCloudConflictKind, part: 'title' | 'body'): TranslationKey {
  const name = kind === 'discard_rejected' ? 'discardRejected' : kind;
  return `${prefix}.conflict.${name}.${part}` as TranslationKey;
}

export function DraftCloudConflictNotice({
  kind,
  textPrefix,
  translate,
  busy = false,
  onDecide,
  orderLink,
  testIdPrefix,
}: DraftCloudConflictNoticeProps) {
  const [pending, setPending] = useState<DraftCloudConflictAction | null>(null);
  const actions = actionsFor(kind);
  const confirm = pending ? CONFIRM[pending] : undefined;

  const trigger = (action: DraftCloudConflictAction) => {
    if (CONFIRM[action]) {
      setPending(action);
      return;
    }
    void onDecide(action);
  };

  return (
    <>
      <InlineNotice
        tone={kind === 'consumed' ? 'info' : 'warning'}
        testId={`${testIdPrefix}-conflict`}
        title={translate(textKey(textPrefix, kind, 'title'))}
        action={
          <div className="form-actions" data-testid={`${testIdPrefix}-conflict-actions`}>
            {orderLink && kind === 'consumed' ? (
              <Button type="button" size="sm" variant="primary" onClick={orderLink.onOpen} data-testid={`${testIdPrefix}-open-order`}>
                {orderLink.label}
              </Button>
            ) : null}
            {actions.map((action, index) => (
              <Button
                key={action}
                type="button"
                size="sm"
                variant={index === 0 && !(orderLink && kind === 'consumed') ? 'primary' : 'secondary'}
                disabled={busy}
                onClick={() => trigger(action)}
                data-testid={`${testIdPrefix}-${action}`}
              >
                {translate(kind === 'consumed' && action === 'acceptEnd' ? 'orderDraftCloud.action.closeDraft' : LABEL[action])}
              </Button>
            ))}
          </div>
        }
      >
        {translate(textKey(textPrefix, kind, 'body'))}
      </InlineNotice>
      <SimpleConfirmDialog
        open={Boolean(pending && confirm)}
        title={confirm ? translate(confirm.title) : ''}
        message={confirm ? translate(confirm.body) : ''}
        confirmLabel={pending ? translate(LABEL[pending]) : ''}
        cancelLabel={translate('common.cancel')}
        confirmVariant={confirm?.danger ? 'danger' : 'primary'}
        failureMessage={translate('orderDraftCloud.decision.failed')}
        dialogTestId={`${testIdPrefix}-decision-dialog`}
        confirmTestId={`${testIdPrefix}-decision-confirm`}
        cancelTestId={`${testIdPrefix}-decision-cancel`}
        onConfirm={async () => {
          if (!pending) return true;
          const ok = await onDecide(pending);
          if (ok) setPending(null);
          return ok;
        }}
        onCancel={() => setPending(null)}
      />
    </>
  );
}

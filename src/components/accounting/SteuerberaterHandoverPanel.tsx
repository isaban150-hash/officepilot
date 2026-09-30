/**
 * STEUERBERATER & BUCHFUEHRUNGSINTELLIGENZ 02B — der Übergabestatus.
 *
 * Eine Zeile Gesamtaussage, darunter die Einzelpunkte. Dieselbe Quelle wie
 * das Badge im Seitenkopf und das 06C-Gate (`deriveSteuerberaterHandoverStatus`),
 * deshalb können sie sich nicht widersprechen.
 *
 * Der Bankabgleich steht ehrlich als „noch nicht verfügbar“ da — OfficeTakt
 * gleicht noch keine Kontoauszüge ab und behauptet das auch nicht.
 */
import type { SteuerberaterHandoverStatus } from '../../services/steuerberater/steuerberaterHandoverStatus';
import type { TranslationKey } from '../../i18n';
import { InlineNotice } from '../ui/States';

interface Props {
  status: SteuerberaterHandoverStatus;
  translate: (key: TranslationKey) => string;
}

export function SteuerberaterHandoverPanel({ status, translate }: Props) {
  const tone = status.state === 'ready' ? 'success' : status.packageAllowed ? 'info' : 'warning';
  const closure = status.issues.includes('changed_after_close')
    ? translate('handover.closure.changed')
    : status.closedRevision !== null && status.packageAllowed
      ? translate('handover.closure.closed').replace('{revision}', String(status.closedRevision))
      : translate('handover.closure.open');
  const count = (value: number) => (value === 0 ? translate('handover.none') : String(value));

  return (
    <div data-testid="steuerberater-handover" data-state={status.state}>
      <InlineNotice tone={tone} title={translate('handover.title')} testId="steuerberater-handover-state">
        {translate(`handover.state.${status.state}` as TranslationKey)}
      </InlineNotice>
      <dl className="detail-list" data-testid="steuerberater-handover-rows">
        <div>
          <dt>{translate('handover.row.closure')}</dt>
          <dd data-testid="steuerberater-handover-closure">{closure}</dd>
        </div>
        <div>
          <dt>{translate('handover.row.unclear')}</dt>
          <dd data-testid="steuerberater-handover-unclear">{count(status.counts.unclearCases)}</dd>
        </div>
        <div>
          <dt>{translate('handover.row.proofs')}</dt>
          <dd data-testid="steuerberater-handover-proofs">{count(status.counts.missingProofs)}</dd>
        </div>
        <div>
          <dt>{translate('handover.row.bank')}</dt>
          <dd data-testid="steuerberater-handover-bank">{translate('handover.bank.notAvailable')}</dd>
        </div>
      </dl>
    </div>
  );
}

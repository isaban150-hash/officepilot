import { Button } from '../ui/Button';
import { Card, CardTitle, DataRow } from '../ui/Card';
import type { TranslationKey } from '../../i18n';
import { startOrderExecution } from '../../services/orderExecutionStartService';
import type { Vorgang } from '../../types/models';

interface VorgangExecutionStartPanelProps {
  vorgang: Vorgang;
  translate: (key: TranslationKey) => string;
  onUpdated: () => void;
  onToast: (message: string) => void;
}

function formatStartedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('de-DE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function VorgangExecutionStartPanel({
  vorgang,
  translate,
  onUpdated,
  onToast,
}: VorgangExecutionStartPanelProps) {
  const canStart =
    vorgang.status === 'beauftragt' && Boolean(vorgang.contractConfirmation);
  const isRunning =
    vorgang.status === 'in_bearbeitung' && Boolean(vorgang.executionStartedAt);

  if (!canStart && !isRunning) {
    return null;
  }

  const handleStart = () => {
    const result = startOrderExecution(vorgang.id);
    if (!result.success) {
      onToast(translate(`execution.error.${result.errorKey}` as TranslationKey));
      return;
    }
    onUpdated();
    onToast(translate('execution.started'));
  };

  return (
    <section className="section" data-testid="vorgang-execution-start-panel">
      <h2 className="section__title">{translate('execution.title')}</h2>

      {canStart ? (
        <Card>
          <p className="empty-state">{translate('execution.intro')}</p>
          <Button fullWidth onClick={handleStart} data-testid="execution-start-button">
            {translate('execution.start')}
          </Button>
        </Card>
      ) : null}

      {isRunning ? (
        <Card data-testid="execution-running-card">
          <CardTitle>{translate('execution.running')}</CardTitle>
          <DataRow
            label={translate('execution.startedAt')}
            value={formatStartedAt(vorgang.executionStartedAt!)}
          />
        </Card>
      ) : null}
    </section>
  );
}

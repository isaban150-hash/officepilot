import { Button } from '../ui/Button';
import { Card, CardMeta, CardTitle } from '../ui/Card';
import { useApp } from '../../context/AppContext';
import type { ScanResultViewModel } from '../../services/scanResultViewService';
import type { TranslationKey } from '../../i18n';

interface ScanResultPanelProps {
  view: ScanResultViewModel;
  onAction?: (actionId: string) => void;
}

function formatMessage(
  key: TranslationKey,
  params: Record<string, string> | undefined,
  translate: (key: TranslationKey) => string,
): string {
  let text = translate(key);
  if (params) {
    for (const [paramKey, value] of Object.entries(params)) {
      text = text.replace(`{${paramKey}}`, value);
    }
  }
  return text;
}

export function ScanResultPanel({ view, onAction }: ScanResultPanelProps) {
  const { translate } = useApp();

  return (
    <div className="scan-result-panel" data-testid="scan-result-panel">
      <Card className="scan-result-panel__card">
      <CardTitle>{translate('scanResult.title')}</CardTitle>

      <section className="scan-result-section">
        <h3 className="scan-result-section__label">{translate('scanResult.recognized')}</h3>
        <p className="scan-result-section__value">{view.recognizedTitle}</p>
        {view.recognizedSummary && (
          <CardMeta>{view.recognizedSummary}</CardMeta>
        )}
      </section>

      <section className="scan-result-section">
        <h3 className="scan-result-section__label">{translate('scanResult.assistantDid')}</h3>
        <p className="scan-result-section__value scan-result-section__value--assistant">
          {formatMessage(view.assistantMessageKey, view.assistantMessageParams, translate)}
        </p>
      </section>

      {view.paperInstruction && (
        <section className="scan-result-section scan-result-section--paper">
          <h3 className="scan-result-section__label">{translate('scanResult.paperFolder')}</h3>
          <p className="scan-result-section__value">{view.paperInstruction}</p>
        </section>
      )}

      {view.nextActions.length > 0 && (
        <section className="scan-result-section">
          <h3 className="scan-result-section__label">{translate('scanResult.nextActions')}</h3>
          <div className="scan-result-actions">
            {view.nextActions.map((action) => (
              <Button
                key={action.id}
                variant={action.id === view.nextActions[0]?.id ? 'primary' : 'outline'}
                fullWidth
                onClick={() => onAction?.(action.id)}
              >
                {translate(action.labelKey)}
              </Button>
            ))}
          </div>
        </section>
      )}
    </Card>
    </div>
  );
}

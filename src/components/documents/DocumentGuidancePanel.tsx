import { Card } from '../ui/Card';
import type { TranslationKey } from '../../i18n';
import type { DocumentGuidance, GuidanceTextBlock } from '../../services/documentGuidanceService';

function interpolate(
  translate: (key: TranslationKey) => string,
  block: GuidanceTextBlock,
): string {
  let text = translate(block.key);
  if (!block.params) return text;
  for (const [name, value] of Object.entries(block.params)) {
    if (name === 'typeKey' || name === 'originalKey' || name === 'storageKey') {
      text = text.replace(`{${name}}`, translate(value as TranslationKey));
    } else {
      text = text.replace(`{${name}}`, String(value));
    }
  }
  return text;
}

interface DocumentGuidancePanelProps {
  guidance: DocumentGuidance;
  translate: (key: TranslationKey) => string;
}

const ROWS: Array<{
  id: string;
  labelKey: TranslationKey;
  field: keyof Pick<
    DocumentGuidance,
    'what' | 'whyReceived' | 'mustAct' | 'deadline' | 'mustReply' | 'retain' | 'paperFolder'
  >;
}> = [
  { id: 'what', labelKey: 'docGuidance.q.what', field: 'what' },
  { id: 'why', labelKey: 'docGuidance.q.why', field: 'whyReceived' },
  { id: 'act', labelKey: 'docGuidance.q.act', field: 'mustAct' },
  { id: 'deadline', labelKey: 'docGuidance.q.deadline', field: 'deadline' },
  { id: 'reply', labelKey: 'docGuidance.q.reply', field: 'mustReply' },
  { id: 'retain', labelKey: 'docGuidance.q.retain', field: 'retain' },
  { id: 'paper', labelKey: 'docGuidance.q.paper', field: 'paperFolder' },
];

export function DocumentGuidancePanel({ guidance, translate }: DocumentGuidancePanelProps) {
  return (
    <Card className="document-assistant-panel__section">
      <div data-testid="document-guidance-panel">
      <h2 className="document-assistant-panel__heading">{translate('docGuidance.title')}</h2>
      <dl className="document-guidance-panel__list">
        {ROWS.map((row) => (
          <div key={row.id} className="document-guidance-panel__row" data-testid={`doc-guidance-${row.id}`}>
            <dt>{translate(row.labelKey)}</dt>
            <dd>{interpolate(translate, guidance[row.field])}</dd>
          </div>
        ))}
        <div className="document-guidance-panel__row" data-testid="doc-guidance-actions">
          <dt>{translate('docGuidance.q.actions')}</dt>
          <dd>
            <ul className="document-assistant-panel__steps">
              {guidance.actions.map((action) => (
                <li key={action.id}>{translate(action.labelKey)}</li>
              ))}
            </ul>
          </dd>
        </div>
      </dl>
      <p className="document-assistant-panel__muted" data-testid="doc-guidance-disclaimer">
        {translate(guidance.disclaimerKey)}
      </p>
      </div>
    </Card>
  );
}

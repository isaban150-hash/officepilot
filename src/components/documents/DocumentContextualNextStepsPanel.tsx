import { Card, CardTitle } from '../ui/Card';
import { buildDocumentContextualNextSteps } from '../../services/documentContextualNextStepsService';
import type { DocumentFieldFillConfirmRow } from '../../types/documentFieldFillConfirm';

export interface DocumentContextualNextStepsPanelProps {
  rows: readonly DocumentFieldFillConfirmRow[];
  coreMessage: string;
  hasReplyDraft: boolean;
  testIdPrefix?: string;
}

/**
 * Session-only contextual next-step suggestions for the consolidated assist lane.
 * Text-only; no action buttons and no persistence.
 */
export function DocumentContextualNextStepsPanel({
  rows,
  coreMessage,
  hasReplyDraft,
  testIdPrefix = 'document-contextual-next-steps',
}: DocumentContextualNextStepsPanelProps) {
  const model = buildDocumentContextualNextSteps({
    rows,
    coreMessage,
    hasReplyDraft,
  });

  if (
    model.suggestions.length === 0 &&
    model.missingOrUnconfirmed.length === 0 &&
    model.consideredFacts.length === 0
  ) {
    return null;
  }

  return (
    <section
      className="document-contextual-next-steps"
      data-testid={`${testIdPrefix}-panel`}
    >
      <Card className="document-contextual-next-steps__card">
        <CardTitle>Nächste Schritte – Vorschlag</CardTitle>
        <p className="document-contextual-next-steps__hint">
          Lokale Hinweise aus bestätigten Angaben und Ihrer Eingabe — keine Pflicht und keine
          automatische Aktion.
        </p>

        {model.suggestions.length > 0 ? (
          <div data-testid={`${testIdPrefix}-suggestions`}>
            <p className="document-contextual-next-steps__meta-title">Vorschläge</p>
            <ul>
              {model.suggestions.map((suggestion) => (
                <li key={suggestion}>{suggestion}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div data-testid={`${testIdPrefix}-missing`}>
          <p className="document-contextual-next-steps__meta-title">
            Noch fehlend oder unbestätigt
          </p>
          {model.missingOrUnconfirmed.length === 0 ? (
            <p className="document-contextual-next-steps__meta-empty">
              Keine offenen relevanten Angaben.
            </p>
          ) : (
            <ul>
              {model.missingOrUnconfirmed.map((label) => (
                <li key={label}>{label}</li>
              ))}
            </ul>
          )}
        </div>

        <div data-testid={`${testIdPrefix}-considered`}>
          <p className="document-contextual-next-steps__meta-title">
            Berücksichtigte bestätigte Fakten
          </p>
          {model.consideredFacts.length === 0 ? (
            <p className="document-contextual-next-steps__meta-empty">
              Noch keine bestätigten Angaben.
            </p>
          ) : (
            <ul>
              {model.consideredFacts.map((fact) => (
                <li key={`${fact.label}:${fact.value}`}>
                  {fact.label}: {fact.value}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    </section>
  );
}

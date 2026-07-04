import { Button } from '../ui/Button';
import { Badge, Card, DataRow } from '../ui/Card';
import type { ContractAnalysisResult, ContractSuggestedAction } from '../../types/models';
import { isContractActionAvailable } from '../../services/officeActionService';
import type { InboxItem } from '../../types/models';
import type { TranslationKey } from '../../i18n';

interface Props {
  analysis: ContractAnalysisResult;
  item: InboxItem;
  translate: (key: TranslationKey) => string;
  onAction: (actionId: ContractSuggestedAction['id']) => void;
  onCreateContractTasks?: () => void;
}

function confidenceTone(confidence: ContractAnalysisResult['confidence']): 'default' | 'info' | 'success' {
  if (confidence === 'high') return 'success';
  if (confidence === 'medium') return 'info';
  return 'default';
}

export function ContractAnalysisPanel({ analysis, item, translate, onAction, onCreateContractTasks }: Props) {
  if (!analysis.isContract || !analysis.contractType) return null;

  const visibleActions = analysis.suggestedActions.filter((action) =>
    isContractActionAvailable(action.id, item),
  );

  const typeKey = `contract.type.${analysis.contractType}` as TranslationKey;
  const confidenceKey = `contract.confidence.${analysis.confidence}` as TranslationKey;

  return (
    <Card className="contract-analysis" highlight>
      <h3 className="section__title">{translate('contract.analysisTitle')}</h3>

      <div className="badge-row contract-analysis__badges">
        <Badge tone="success">{translate('contract.detected')}</Badge>
        <Badge tone={confidenceTone(analysis.confidence)}>{translate(typeKey)}</Badge>
        <Badge>{translate(confidenceKey)}</Badge>
      </div>

      <p className="contract-analysis__reason">{analysis.reason}</p>

      {analysis.fields.bauvorhaben && (
        <DataRow label={translate('contract.field.bauvorhaben')} value={analysis.fields.bauvorhaben} />
      )}
      {analysis.fields.auftraggeber && (
        <DataRow label={translate('contract.field.auftraggeber')} value={analysis.fields.auftraggeber} />
      )}
      {analysis.fields.subunternehmer && (
        <DataRow label={translate('contract.field.subunternehmer')} value={analysis.fields.subunternehmer} />
      )}
      {analysis.fields.baustellenadresse && (
        <DataRow
          label={translate('contract.field.baustellenadresse')}
          value={analysis.fields.baustellenadresse}
        />
      )}
      {analysis.fields.projektname && (
        <DataRow label={translate('contract.field.projektname')} value={analysis.fields.projektname} />
      )}
      {analysis.fields.leistungszeitraum && (
        <DataRow
          label={translate('contract.field.leistungszeitraum')}
          value={analysis.fields.leistungszeitraum}
        />
      )}
      {analysis.fields.vertragsdatum && (
        <DataRow label={translate('contract.field.vertragsdatum')} value={analysis.fields.vertragsdatum} />
      )}
      {analysis.fields.auftragsnummer && (
        <DataRow label={translate('contract.field.auftragsnummer')} value={analysis.fields.auftragsnummer} />
      )}
      {analysis.fields.ansprechpartner && (
        <DataRow
          label={translate('contract.field.ansprechpartner')}
          value={`${analysis.fields.ansprechpartner}${analysis.fields.telefon ? ` · ${analysis.fields.telefon}` : ''}${analysis.fields.email ? ` · ${analysis.fields.email}` : ''}`}
        />
      )}

      {analysis.paymentTerms.length > 0 && (
        <div className="contract-analysis__section">
          <h4 className="contract-analysis__subtitle">{translate('contract.paymentTermsTitle')}</h4>
          <ul className="contract-analysis__list">
            {analysis.paymentTerms.map((term) => (
              <li key={`${term.type}-${term.label}`}>
                {term.label}
                {term.value && term.type === 'payment_due' ? `: ${term.value}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      {analysis.requiredDocuments.length > 0 && (
        <div className="contract-analysis__section">
          <h4 className="contract-analysis__subtitle">{translate('contract.requiredDocsTitle')}</h4>
          <ul className="contract-analysis__list">
            {analysis.requiredDocuments.map((doc) => (
              <li key={doc.type}>
                {translate(`classifiedKind.${doc.type}` as TranslationKey)} – {doc.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {analysis.positions.length > 0 && (
        <div className="contract-analysis__section">
          <h4 className="contract-analysis__subtitle">
            {translate('contract.positionsTitle')} ({analysis.positions.length})
          </h4>
          <div className="contract-analysis__positions">
            {analysis.positions.map((pos) => (
              <div key={pos.positionNumber ?? pos.description} className="contract-analysis__position">
                <strong>
                  {pos.positionNumber ? `${pos.positionNumber}. ` : ''}
                  {pos.description}
                </strong>
                <span>
                  {pos.quantity} {pos.unit} × {pos.unitPrice.toLocaleString('de-DE', { minimumFractionDigits: 2 })} €
                  {' = '}
                  {pos.lineTotal.toLocaleString('de-DE', { minimumFractionDigits: 2 })} €
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {analysis.signatureHint && (
        <p className="invoice-hint invoice-hint--warning">{analysis.signatureHint}</p>
      )}

      {analysis.signaturePages.length > 0 && (
        <ul className="contract-analysis__list">
          {analysis.signaturePages.map((page) => (
            <li key={page.pageHint}>{page.pageHint}: {page.description}</li>
          ))}
        </ul>
      )}

      {analysis.requiredDocuments.length > 0 && onCreateContractTasks && (
        <div className="contract-analysis__section">
          <Button type="button" onClick={onCreateContractTasks}>
            {translate('contract.createTasks')}
          </Button>
        </div>
      )}

      <div className="contract-analysis__section">
        <h4 className="contract-analysis__subtitle">{translate('contract.actionsTitle')}</h4>
        <div className="classification-actions__buttons">
          {visibleActions.map((action) => (
            <Button
              key={action.id}
              type="button"
              variant={action.variant ?? 'outline'}
              onClick={() => onAction(action.id)}
            >
              {translate(action.labelKey as TranslationKey)}
            </Button>
          ))}
        </div>
        <p className="contract-analysis__hint">{translate('contract.noAutoApply')}</p>
      </div>
    </Card>
  );
}

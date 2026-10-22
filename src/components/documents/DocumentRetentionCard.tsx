/**
 * DOKUMENTE-01 / D-017 — die gesetzliche Aufbewahrung eines abgelegten Dokuments.
 *
 * Die Karte nennt die Mindestfrist und ihren Grund, nie einen Zeitpunkt zum
 * Entsorgen. Ohne feste Regel heißt sie „Aufbewahrung prüfen" — dann schlägt
 * OfficeTakt nichts vor. Sie führt nichts aus; gelöscht wird nur über den
 * Löschweg der Seite, der dieselbe Regel prüft.
 */
import { Card, CardMeta, CardTitle } from '../ui/Card';
import { useApp } from '../../context/AppContext';
import type { DocumentRetention } from '../../services/document/documentRetention';
import { interpolateParams, type TranslationKey } from '../../i18n';
import { formatSafeDocumentDate } from '../../utils/documentDateDisplay';

interface DocumentRetentionCardProps {
  retention: DocumentRetention;
  /** Selbst erzeugte Belege haben kein Papieroriginal; der Hinweis entfällt. */
  ohnePapieroriginal?: boolean;
}

export function DocumentRetentionCard({ retention, ohnePapieroriginal = false }: DocumentRetentionCardProps) {
  const { translate, setup } = useApp();
  const klasse = translate(`document.retention.class.${retention.klasse}` as TranslationKey);
  const datum = retention.fristEnde ? formatSafeDocumentDate(retention.fristEnde, setup.language, retention.fristEnde) : '';
  const params = { klasse, jahre: retention.jahre ?? '', datum };

  return (
    <div className="detail-experience-card document-retention-card" data-testid="document-retention">
      <Card className="detail-experience-card__inner">
        <CardTitle>{translate('document.retention.title')}</CardTitle>
        <CardMeta>{klasse}</CardMeta>

        <section className="detail-experience-section">
          <p
            className="detail-experience-section__value"
            data-testid="document-retention-status"
            data-retention-status={retention.status}
            data-retention-class={retention.klasse}
          >
            {retention.status === 'laeuft'
              ? interpolateParams(translate('document.retention.running'), params)
              : retention.status === 'abgelaufen'
                ? interpolateParams(translate('document.retention.expired'), params)
                : translate('document.retention.review')}
          </p>
          <p className="detail-experience-section__hint" data-testid="document-retention-hint">
            {retention.status === 'laeuft'
              ? translate('document.retention.running.locked')
              : retention.status === 'abgelaufen'
                ? translate('document.retention.expired.hint')
                : translate('document.retention.review.hint')}
          </p>
        </section>

        <section className="detail-experience-section">
          <h3 className="detail-experience-section__label">{translate('document.retention.reasonLabel')}</h3>
          <p className="detail-experience-section__value" data-testid="document-retention-reason">
            {translate(`document.retention.reason.${retention.grund}` as TranslationKey)}
          </p>
          {retention.klasse === 'pruefen' ? null : (
            <p className="detail-experience-section__hint" data-testid="document-retention-basis">
              {translate(`document.retention.basis.${retention.klasse}` as TranslationKey)}
            </p>
          )}
        </section>

        {retention.klasse === 'pruefen' || ohnePapieroriginal ? null : (
          <p className="detail-experience-section__hint" data-testid="document-retention-paper">
            {translate('document.retention.paper')}
          </p>
        )}
        <p className="detail-experience-section__hint">{translate('document.retention.disclaimer')}</p>
      </Card>
    </div>
  );
}

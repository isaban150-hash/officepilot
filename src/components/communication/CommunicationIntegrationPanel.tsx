import { Link } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { buildKommunikationPath } from './communicationNavigation';
import type { CommunicationContextRef } from '../../types/communication';
import type { TranslationKey } from '../../i18n';

interface CommunicationIntegrationPanelProps {
  contextRef: CommunicationContextRef;
  buttonKeys: TranslationKey[];
  testIdPrefix: string;
}

export function CommunicationIntegrationPanel({
  contextRef,
  buttonKeys,
  testIdPrefix,
}: CommunicationIntegrationPanelProps) {
  const { translate } = useApp();
  const href = buildKommunikationPath(contextRef);

  return (
    <section className="section communication-integration-section" data-testid={`${testIdPrefix}-communication`}>
      <h2 className="section__title">{translate('communication.integration.title')}</h2>
      <div className="communication-integration-actions">
        {buttonKeys.map((key) => (
          <Link
            key={key}
            to={href}
            className="btn btn--outline btn--full communication-integration-link"
            data-testid={`${testIdPrefix}-communication-link-${key}`}
          >
            {translate(key)}
          </Link>
        ))}
      </div>
      <Link
        to={href}
        className="communication-history-link"
        data-testid={`${testIdPrefix}-communication-history-link`}
      >
        {translate('communication.history.viewLink')}
      </Link>
    </section>
  );
}

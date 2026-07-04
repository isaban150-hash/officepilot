import { Link } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { getCommunicationReplyStatus } from '../../services/communicationHistoryService';
import { buildKommunikationPath } from './communicationNavigation';
import type { CommunicationContextRef } from '../../types/communication';
import type { CommunicationReplyStatus } from '../../types/communicationHistory';
import type { TranslationKey } from '../../i18n';

interface CommunicationIntegrationPanelProps {
  contextRef: CommunicationContextRef;
  buttonKeys: TranslationKey[];
  testIdPrefix: string;
}

function shouldShowReplyStatus(status: CommunicationReplyStatus): boolean {
  return status !== 'needs_reply';
}

export function CommunicationIntegrationPanel({
  contextRef,
  buttonKeys,
  testIdPrefix,
}: CommunicationIntegrationPanelProps) {
  const { translate } = useApp();
  const href = buildKommunikationPath(contextRef);
  const replyStatus = getCommunicationReplyStatus(contextRef);

  return (
    <section className="section communication-integration-section" data-testid={`${testIdPrefix}-communication`}>
      <h2 className="section__title">{translate('communication.integration.title')}</h2>
      {shouldShowReplyStatus(replyStatus) && (
        <p className="communication-reply-status" data-testid={`${testIdPrefix}-communication-reply-status`}>
          {translate(`communication.reply.status.${replyStatus}` as TranslationKey)}
        </p>
      )}
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

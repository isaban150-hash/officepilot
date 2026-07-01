import { useMemo } from 'react';
import { Card, CardMeta, CardTitle } from '../ui/Card';
import { useApp } from '../../context/AppContext';
import { getEventsForContext } from '../../services/communicationHistoryService';
import type { CommunicationContextRef } from '../../types/communication';
import type { CommunicationEvent } from '../../types/communicationHistory';
import type { TranslationKey } from '../../i18n';

interface CommunicationHistoryPanelProps {
  contextRef: CommunicationContextRef;
  refreshKey?: number;
}

function formatTime(timestamp: string): string {
  try {
    return new Date(timestamp).toLocaleString('de-DE', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return timestamp;
  }
}

function contextLabelKey(contextRef: CommunicationContextRef): TranslationKey | null {
  if (contextRef.type === 'none') return null;
  return `communication.context.${contextRef.type}` as TranslationKey;
}

function eventSummary(event: CommunicationEvent): string {
  return event.resultExcerpt || event.userInputExcerpt || '—';
}

export function CommunicationHistoryPanel({
  contextRef,
  refreshKey = 0,
}: CommunicationHistoryPanelProps) {
  const { translate } = useApp();
  const events = useMemo(
    () => getEventsForContext(contextRef),
    [contextRef, refreshKey],
  );

  return (
    <section className="section communication-history-section" data-testid="communication-history">
      <h2 className="section__title">{translate('communication.history.title')}</h2>
      {events.length === 0 ? (
        <p className="empty-state">{translate('communication.history.empty')}</p>
      ) : (
        events.map((event) => {
          const contextKey = contextLabelKey(event.contextRef);
          return (
            <div key={event.id} data-testid="communication-history-item">
              <Card className="communication-history-item">
                <CardMeta>
                  <span className="communication-history-item__meta">
                    <span data-testid="communication-history-time">{formatTime(event.timestamp)}</span>
                    {' · '}
                    <span data-testid="communication-history-type">
                      {translate(`communication.history.type.${event.type}` as TranslationKey)}
                    </span>
                    {event.channel && (
                      <>
                        {' · '}
                        <span data-testid="communication-history-channel">
                          {translate(`communication.channel.${event.channel}` as TranslationKey)}
                        </span>
                      </>
                    )}
                  </span>
                </CardMeta>
                <CardTitle>{eventSummary(event)}</CardTitle>
                {contextKey && (
                  <p className="communication-history-item__context" data-testid="communication-history-context">
                    {translate(contextKey)}
                    {event.contextRef.id ? ` (${event.contextRef.id})` : ''}
                  </p>
                )}
              </Card>
            </div>
          );
        })
      )}
    </section>
  );
}

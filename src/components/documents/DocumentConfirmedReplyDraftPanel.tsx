import { useState } from 'react';
import { Button } from '../ui/Button';
import { Card, CardTitle } from '../ui/Card';
import {
  buildConfirmedReplyDraft,
  formatConfirmedReplyDraftClipboardText,
} from '../../services/documentConfirmedReplyDraftService';
import { buildDocumentReplyDraftHandoffPayload } from '../../services/documentReplyDraftHandoffService';
import type { DocumentFieldFillConfirmRow } from '../../types/documentFieldFillConfirm';
import type { DocumentConfirmedReplyDraft } from '../../types/documentConfirmedReplyDraft';
import type { DocumentReplyDraftHandoffPayload } from '../../types/documentReplyDraftHandoff';
import type { InboxItem } from '../../types/models';

export interface DocumentConfirmedReplyDraftPanelProps {
  item: InboxItem;
  rows: readonly DocumentFieldFillConfirmRow[];
  testIdPrefix?: string;
  /** Explicit handoff into Kommunikation — only called on user click. */
  onHandoffToCommunication?: (payload: DocumentReplyDraftHandoffPayload) => void;
}

/**
 * Session-only reply draft from confirmed fill-confirm facts.
 * Never saves, sends, or changes the document.
 */
export function DocumentConfirmedReplyDraftPanel({
  item,
  rows,
  testIdPrefix = 'document-confirmed-reply-draft',
  onHandoffToCommunication,
}: DocumentConfirmedReplyDraftPanelProps) {
  const [coreMessage, setCoreMessage] = useState('');
  const [draft, setDraft] = useState<DocumentConfirmedReplyDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

  const handlePrepare = (): void => {
    const next = buildConfirmedReplyDraft({
      coreMessage,
      subject: item.title,
      sender: item.sender,
      rows,
    });
    if (!next) {
      setDraft(null);
      setError('Bitte zuerst angeben, was du mitteilen möchtest.');
      setCopyFeedback(null);
      return;
    }
    setError(null);
    setDraft(next);
    setCopyFeedback(null);
  };

  const handleCopy = async (): Promise<void> => {
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(formatConfirmedReplyDraftClipboardText(draft));
      setCopyFeedback('Antwortentwurf kopiert.');
    } catch {
      setCopyFeedback('Kopieren nicht möglich.');
    }
  };

  const handleHandoff = (): void => {
    if (!draft || !onHandoffToCommunication) return;
    const payload = buildDocumentReplyDraftHandoffPayload({
      item,
      draft,
      coreMessage,
    });
    if (!payload) return;
    onHandoffToCommunication(payload);
  };

  return (
    <section
      className="document-confirmed-reply-draft"
      data-testid={`${testIdPrefix}-panel`}
    >
      <Card className="document-confirmed-reply-draft__card">
        <CardTitle>Antwortentwurf</CardTitle>
        <p className="document-confirmed-reply-draft__hint">
          Nur aus bestätigten Angaben und deiner Kernaussage — lokal, ohne Speichern oder
          Versand.
        </p>

        <label className="document-confirmed-reply-draft__label" htmlFor={`${testIdPrefix}-core`}>
          Was möchtest du mitteilen?
        </label>
        <textarea
          id={`${testIdPrefix}-core`}
          className="input document-confirmed-reply-draft__core"
          value={coreMessage}
          onChange={(event) => setCoreMessage(event.target.value)}
          placeholder="Was möchtest du mitteilen?"
          rows={3}
          data-testid={`${testIdPrefix}-core`}
        />

        <div className="document-confirmed-reply-draft__actions">
          <Button
            type="button"
            size="sm"
            onClick={handlePrepare}
            data-testid={`${testIdPrefix}-prepare`}
          >
            Antwortentwurf vorbereiten
          </Button>
        </div>

        {error ? (
          <p className="document-confirmed-reply-draft__error" data-testid={`${testIdPrefix}-error`}>
            {error}
          </p>
        ) : null}

        {draft ? (
          <div
            className="document-confirmed-reply-draft__result"
            data-testid={`${testIdPrefix}-result`}
          >
            <p
              className="document-confirmed-reply-draft__proposal-badge"
              data-testid={`${testIdPrefix}-proposal-badge`}
            >
              Vorschlag – noch nicht gespeichert oder versendet
            </p>
            <pre
              className="document-confirmed-reply-draft__body"
              data-testid={`${testIdPrefix}-body`}
            >
              {draft.body}
            </pre>

            <div data-testid={`${testIdPrefix}-considered`}>
              <p className="document-confirmed-reply-draft__meta-title">Berücksichtigt</p>
              {draft.considered.length === 0 ? (
                <p className="document-confirmed-reply-draft__meta-empty">
                  Keine bestätigten Angaben.
                </p>
              ) : (
                <ul>
                  {draft.considered.map((fact) => (
                    <li key={`${fact.label}:${fact.value}`}>
                      {fact.label}: {fact.value}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div data-testid={`${testIdPrefix}-not-included`}>
              <p className="document-confirmed-reply-draft__meta-title">Nicht enthalten</p>
              {draft.notIncluded.length === 0 ? (
                <p className="document-confirmed-reply-draft__meta-empty">
                  Alle relevanten Angaben bestätigt.
                </p>
              ) : (
                <ul>
                  {draft.notIncluded.map((label) => (
                    <li key={label}>{label}</li>
                  ))}
                </ul>
              )}
            </div>

            <div className="document-confirmed-reply-draft__result-actions">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void handleCopy()}
                data-testid={`${testIdPrefix}-copy`}
              >
                Entwurf kopieren
              </Button>
              {onHandoffToCommunication ? (
                <Button
                  type="button"
                  size="sm"
                  onClick={handleHandoff}
                  data-testid={`${testIdPrefix}-handoff`}
                >
                  Im Kommunikationsbereich prüfen
                </Button>
              ) : null}
            </div>
            {copyFeedback ? (
              <p
                className="document-confirmed-reply-draft__copy-feedback"
                data-testid={`${testIdPrefix}-copy-feedback`}
              >
                {copyFeedback}
              </p>
            ) : null}
          </div>
        ) : null}
      </Card>
    </section>
  );
}

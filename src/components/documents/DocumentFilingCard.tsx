import { useState } from 'react';
import { Card, CardMeta, CardTitle } from '../ui/Card';
import { Button, type ButtonVariant } from '../ui/Button';
import { useApp } from '../../context/AppContext';
import {
  formatPaperLocationSummary,
  getPhysicalFilingStatusLabel,
} from '../../services/paperFolderService';
import {
  getDocumentMemoryByDocumentId,
  getPaperRegisterEntryForDocument,
  markDocumentPhysicallyFiled,
} from '../../services/officePilotMemoryService';
import {
  getDocumentById,
  isGeneratedOutgoingInvoiceDocument,
} from '../../services/documentService';

interface DocumentFilingCardProps {
  documentId: string;
  onChanged?: () => void;
  /** Visual emphasis only; handler and confirm-first behavior stay unchanged. Default primary. */
  markFiledVariant?: ButtonVariant;
}

export function DocumentFilingCard({
  documentId,
  onChanged,
  markFiledVariant = 'primary',
}: DocumentFilingCardProps) {
  const { translate, showToast } = useApp();
  const [revision, setRevision] = useState(0);

  const document = getDocumentById(documentId);
  const memory = getDocumentMemoryByDocumentId(documentId);
  const registerEntry = getPaperRegisterEntryForDocument(documentId);

  if (!document && !memory) {
    return null;
  }

  void revision;

  const digitalPath = memory
    ? `${memory.digitalFolder.name} (${memory.digitalFolder.path})`
    : document
      ? `${document.digitalFolder.name} (${document.digitalFolder.path})`
      : '—';

  const paperFolder = memory?.paperFolder ?? document?.paperFolder;
  const hasPaperFolder = Boolean(paperFolder?.folderId || paperFolder?.label);
  const paperFolderLabel = hasPaperFolder
    ? formatPaperLocationSummary(paperFolder!)
    : translate('document.filing.noPaperFolder');

  const register =
    registerEntry?.register ?? paperFolder?.register ?? translate('document.filing.noRegister');

  const isGeneratedInvoice = document ? isGeneratedOutgoingInvoiceDocument(document) : false;
  const physicalFiled = memory?.physicalFiled ?? registerEntry?.physicalFiled ?? false;
  const filedAt = memory?.filedAt ?? registerEntry?.filedAt;
  const statusInfo = getPhysicalFilingStatusLabel(physicalFiled, filedAt);
  const paperStatusLabel =
    statusInfo.statusKey === 'document.filing.statusFiled' && statusInfo.filedAtLabel
      ? `${translate('document.filing.statusFiled')} (${statusInfo.filedAtLabel})`
      : translate(statusInfo.statusKey);

  const handleMarkFiled = () => {
    const updated = markDocumentPhysicallyFiled(documentId);
    if (updated) {
      setRevision((value) => value + 1);
      onChanged?.();
      showToast(translate('document.filing.markedFiled'));
    }
  };

  return (
    <div
      className="detail-experience-card document-filing-card"
      data-testid="document-filing-card"
    >
      <Card className="detail-experience-card__inner">
        <CardTitle>{translate('document.filing.title')}</CardTitle>
        <CardMeta>{translate('document.filing.digitalSaved')}</CardMeta>

        <section className="detail-experience-section">
          <h3 className="detail-experience-section__label">
            {translate('document.filing.digital')}
          </h3>
          <p className="detail-experience-section__value" data-testid="document-filing-digital-path">
            {digitalPath}
          </p>
        </section>

        {/*
          GENERATED-INVOICE-UNDERSTANDING-02B — eine selbst erzeugte Rechnung
          existiert nur digital. Ein Papierstatus wäre hier keine Information,
          sondern eine Aufforderung, die niemand erfüllen kann.
        */}
        {isGeneratedInvoice ? null : (
        <section className="detail-experience-section document-understanding-meta">
          <div>
            <h3 className="detail-experience-section__label">
              {translate('document.filing.paperFolder')}
            </h3>
            <p className="detail-experience-section__value">{paperFolderLabel}</p>
          </div>
          <div>
            <h3 className="detail-experience-section__label">
              {translate('document.filing.register')}
            </h3>
            <p className="detail-experience-section__value">{register}</p>
          </div>
          <div>
            <h3 className="detail-experience-section__label">
              {translate('document.filing.originalStatus')}
            </h3>
            <p
              className="detail-experience-section__value"
              data-testid="document-filing-paper-status"
            >
              {paperStatusLabel}
            </p>
          </div>
        </section>
        )}

        {hasPaperFolder && !physicalFiled && !isGeneratedInvoice && (
          <div className="detail-experience-card__actions">
            <Button
              fullWidth
              variant={markFiledVariant}
              onClick={handleMarkFiled}
              data-testid="document-filing-mark-filed"
            >
              {translate('document.filing.markFiledAction')}
            </Button>
            <p className="detail-experience-section__hint" data-testid="document-filing-paper-only-hint">
              {translate('document.filing.paperOnlyHint')}
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}

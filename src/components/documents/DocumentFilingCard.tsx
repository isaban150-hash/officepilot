import { useState } from 'react';
import { Card, CardMeta, CardTitle } from '../ui/Card';
import { Button } from '../ui/Button';
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
import { getDocumentById } from '../../services/documentService';

interface DocumentFilingCardProps {
  documentId: string;
}

export function DocumentFilingCard({ documentId }: DocumentFilingCardProps) {
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

  const physicalFiled = memory?.physicalFiled ?? registerEntry?.physicalFiled ?? false;
  const filedAt = memory?.filedAt ?? registerEntry?.filedAt;
  const statusInfo = getPhysicalFilingStatusLabel(physicalFiled, filedAt);
  const statusLabel =
    statusInfo.statusKey === 'document.filing.statusFiled' && statusInfo.filedAtLabel
      ? `${translate('document.filing.statusFiled')} (${statusInfo.filedAtLabel})`
      : translate(statusInfo.statusKey);

  const handleMarkFiled = () => {
    const updated = markDocumentPhysicallyFiled(documentId);
    if (updated) {
      setRevision((value) => value + 1);
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
        <CardMeta>{statusLabel}</CardMeta>

        <section className="detail-experience-section">
          <h3 className="detail-experience-section__label">
            {translate('document.filing.digital')}
          </h3>
          <p className="detail-experience-section__value">{digitalPath}</p>
        </section>

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
            <p className="detail-experience-section__value">{statusLabel}</p>
          </div>
        </section>

        {hasPaperFolder && !physicalFiled && (
          <div className="detail-experience-card__actions">
            <Button
              fullWidth
              onClick={handleMarkFiled}
              data-testid="document-filing-mark-filed"
            >
              {translate('document.filing.markFiledAction')}
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}

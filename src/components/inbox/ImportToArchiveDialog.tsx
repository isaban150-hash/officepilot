import { Button } from '../ui/Button';
import { useApp } from '../../context/AppContext';
import type { CompanyDocument } from '../../types/models';
import type { TranslationKey } from '../../i18n';

interface ImportToArchiveDialogProps {
  existingDocument: CompanyDocument;
  isImporting?: boolean;
  onSaveNew: () => void;
  onUpdateExisting: () => void;
  onCancel: () => void;
}

export function ImportToArchiveDialog({
  existingDocument,
  isImporting = false,
  onSaveNew,
  onUpdateExisting,
  onCancel,
}: ImportToArchiveDialogProps) {
  const { translate } = useApp();

  return (
    <div className="vorgang-dialog-backdrop" role="presentation" onClick={onCancel}>
      <div
        className="vorgang-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-archive-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="import-archive-title" className="vorgang-dialog__title">
          {translate('inbox.importToArchive.duplicateTitle')}
        </h3>
        <p className="vorgang-dialog__subtitle">
          {translate('inbox.importToArchive.duplicateHint')}
        </p>
        <div className="vorgang-dialog__preview">
          <strong>{existingDocument.title}</strong>
          <p>
            {existingDocument.issuer} ·{' '}
            {translate(`document.category.${existingDocument.category}` as TranslationKey)}
          </p>
        </div>
        <div className="vorgang-dialog__actions">
          <Button fullWidth disabled={isImporting} onClick={onSaveNew}>
            {translate('inbox.importToArchive.saveNew')}
          </Button>
          <Button variant="secondary" fullWidth disabled={isImporting} onClick={onUpdateExisting}>
            {translate('inbox.importToArchive.updateExisting')}
          </Button>
          <Button variant="ghost" fullWidth disabled={isImporting} onClick={onCancel}>
            {translate('inbox.importToArchive.cancel')}
          </Button>
        </div>
      </div>
    </div>
  );
}

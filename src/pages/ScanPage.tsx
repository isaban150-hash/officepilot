import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { Card, CardMeta, CardTitle, PageHeader } from '../components/ui/Card';
import { useApp } from '../context/AppContext';
import {
  UPLOAD_DOCUMENT_KINDS,
  UPLOAD_KIND_LABELS,
} from '../services/inboxUploadFactory';
import { processUpload } from '../services/inboxService';
import type { UploadDocumentKind } from '../types/models';

export function ScanPage() {
  const { translate, showToast } = useApp();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedKind, setSelectedKind] = useState<UploadDocumentKind | null>(null);

  const handleUploadComplete = (itemId: string) => {
    showToast(translate('scanResult.toastRecognized'));
    navigate(`/ablage/${itemId}`);
  };

  const handleCapture = () => {
    const item = processUpload({ kind: selectedKind ?? undefined });
    handleUploadComplete(item.id);
  };

  const handleFileSelect = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const sourceFileName = file?.name ?? undefined;
    const item = processUpload({
      sourceFileName,
      kind: selectedKind ?? undefined,
    });
    e.target.value = '';
    handleUploadComplete(item.id);
  };

  return (
    <div className="page scan-page" data-testid="scan-page">
      <PageHeader
        title={translate('scan.title')}
        subtitle={translate('scan.subtitle')}
      />

      <Card className="upload-card upload-card--capture">
        <CardTitle>{translate('scan.captureTitle')}</CardTitle>
        <CardMeta>{translate('scan.captureHint')}</CardMeta>

        <fieldset className="form-group upload-kind-picker">
          <legend>{translate('scan.selectType')}</legend>
          <div className="chip-group">
            <button
              type="button"
              className={`chip ${selectedKind === null ? 'chip--active' : ''}`}
              onClick={() => setSelectedKind(null)}
            >
              {translate('scan.typeAuto')}
            </button>
            {UPLOAD_DOCUMENT_KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                className={`chip ${selectedKind === kind ? 'chip--active' : ''}`}
                onClick={() => setSelectedKind(kind)}
              >
                {UPLOAD_KIND_LABELS[kind]}
              </button>
            ))}
          </div>
        </fieldset>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,.pdf"
          className="sr-only"
          onChange={handleFileChange}
        />

        <div className="upload-actions">
          <Button fullWidth data-testid="scan-capture-button" onClick={handleCapture}>
            {translate('heute.scanButton')}
          </Button>
          <Button variant="outline" fullWidth onClick={handleFileSelect}>
            {translate('scan.uploadFile')}
          </Button>
        </div>
      </Card>
    </div>
  );
}

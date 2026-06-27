import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { InboxCard } from '../components/inbox/InboxCard';
import { Button } from '../components/ui/Button';
import { Card, CardMeta, CardTitle, PageHeader } from '../components/ui/Card';
import { useApp } from '../context/AppContext';
import {
  UPLOAD_DOCUMENT_KINDS,
  UPLOAD_KIND_LABELS,
} from '../services/inboxUploadFactory';
import {
  filterActiveItems,
  getInboxItems,
  getInboxSummary,
  processUpload,
} from '../services/inboxService';
import type { UploadDocumentKind } from '../types/models';

export function EingangPage() {
  const { translate, showToast } = useApp();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState(() => filterActiveItems(getInboxItems()));
  const [selectedKind, setSelectedKind] = useState<UploadDocumentKind | null>(null);
  const summary = getInboxSummary();

  const refresh = useCallback(() => {
    setItems(filterActiveItems(getInboxItems()));
  }, []);

  const handleUploadComplete = (itemId: string) => {
    refresh();
    showToast(translate('inbox.uploadRecognized'));
    navigate(`/eingang/${itemId}`);
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

  const handleReview = (id: string) => {
    navigate(`/eingang/${id}`);
  };

  return (
    <div className="page">
      <PageHeader
        title={translate('inbox.title')}
        subtitle={translate('inbox.subtitle')}
      />

      <Card className="upload-card upload-card--capture">
        <CardTitle>{translate('inbox.addDocument')}</CardTitle>
        <CardMeta>{translate('inbox.uploadHint')}</CardMeta>

        <fieldset className="form-group upload-kind-picker">
          <legend>{translate('inbox.selectType')}</legend>
          <div className="chip-group">
            <button
              type="button"
              className={`chip ${selectedKind === null ? 'chip--active' : ''}`}
              onClick={() => setSelectedKind(null)}
            >
              {translate('inbox.typeRandom')}
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
          <Button fullWidth onClick={handleCapture}>
            {translate('eingang.capture')}
          </Button>
          <Button variant="outline" fullWidth onClick={handleFileSelect}>
            {translate('eingang.upload')}
          </Button>
        </div>
      </Card>

      <div className="inbox-summary">
        <span className="inbox-summary__stat">
          <strong>{summary.neu}</strong> {translate('inbox.newCount')}
        </span>
        <span className="inbox-summary__divider">·</span>
        <span className="inbox-summary__stat inbox-summary__stat--urgent">
          <strong>{summary.urgent}</strong> {translate('inbox.urgentCount')}
        </span>
      </div>

      <p className="inbox-intro">{translate('inbox.intro')}</p>

      <div className="card-list">
        {items.length === 0 ? (
          <p className="empty-state">{translate('inbox.empty')}</p>
        ) : (
          items.map((item) => (
            <InboxCard
              key={item.id}
              item={item}
              onReview={handleReview}
              onUpdated={refresh}
            />
          ))
        )}
      </div>
    </div>
  );
}

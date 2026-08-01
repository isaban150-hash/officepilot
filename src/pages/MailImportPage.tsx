import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { Card, CardMeta, CardTitle, PageHeader } from '../components/ui/Card';
import { useApp } from '../context/AppContext';
import {
  createMailImport,
  importMailAsInboxItem,
  importMailAttachment,
} from '../services/mailImportService';

export function MailImportPage() {
  const { translate, showToast } = useApp();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [from, setFrom] = useState('');
  const [subject, setSubject] = useState('');
  const [bodyText, setBodyText] = useState('');
  const [attachment, setAttachment] = useState<File | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!from.trim() || !subject.trim()) {
      showToast(translate('mailImport.validationRequired'));
      return;
    }

    setIsSubmitting(true);
    try {
      const mailImport = createMailImport({
        from: from.trim(),
        subject: subject.trim(),
        bodyText: bodyText.trim(),
      });

      let inboxItemId: string | undefined;

      if (attachment) {
        const result = await importMailAttachment(mailImport.id, attachment);
        inboxItemId = result.inboxItem.id;
      } else {
        const result = importMailAsInboxItem(mailImport.id);
        inboxItemId = result.inboxItems[0]?.id;
      }

      showToast(translate('mailImport.successToast'));

      if (inboxItemId) {
        navigate(`/ablage/${inboxItemId}`);
      } else {
        navigate('/ablage');
      }
    } catch {
      showToast(translate('mailImport.failedToast'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="page mail-import-page" data-testid="mail-import-page">
      <Link to="/mehr" className="back-link">
        ← {translate('common.back')}
      </Link>

      <PageHeader
        title={translate('mailImport.title')}
        subtitle={translate('mailImport.subtitle')}
      />

      <section className="mail-import-form" data-testid="mail-import-form">
        <Card>
          <CardTitle>{translate('mailImport.formTitle')}</CardTitle>
          <CardMeta>{translate('mailImport.formHint')}</CardMeta>

        <label className="form-field">
          <span className="form-field__label">{translate('mailImport.fieldFrom')}</span>
          <input
            type="email"
            className="form-field__input"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            placeholder={translate('mailImport.fieldFromPlaceholder')}
            data-testid="mail-import-from"
          />
        </label>

        <label className="form-field">
          <span className="form-field__label">{translate('mailImport.fieldSubject')}</span>
          <input
            type="text"
            className="form-field__input"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            placeholder={translate('mailImport.fieldSubjectPlaceholder')}
            data-testid="mail-import-subject"
          />
        </label>

        <label className="form-field">
          <span className="form-field__label">{translate('mailImport.fieldBody')}</span>
          <textarea
            className="form-field__textarea"
            rows={8}
            value={bodyText}
            onChange={(event) => setBodyText(event.target.value)}
            placeholder={translate('mailImport.fieldBodyPlaceholder')}
            data-testid="mail-import-body"
          />
        </label>

        <label className="form-field">
          <span className="form-field__label">{translate('mailImport.fieldAttachment')}</span>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,application/pdf,image/*,image/heic,image/heif"
            className="form-field__input"
            onChange={(event) => setAttachment(event.target.files?.[0] ?? null)}
            data-testid="mail-import-attachment"
          />
          {attachment && (
            <p className="form-field__hint" data-testid="mail-import-attachment-name">
              {attachment.name}
            </p>
          )}
        </label>

        <div className="mail-import-form__actions">
          <Button
            fullWidth
            onClick={handleSubmit}
            disabled={isSubmitting}
            data-testid="mail-import-submit"
          >
            {translate('mailImport.submit')}
          </Button>
        </div>
        </Card>
      </section>
    </div>
  );
}

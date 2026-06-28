import { useState, type FormEvent } from 'react';
import { PAPER_FOLDERS } from '../../data/mockData';
import { useApp } from '../../context/AppContext';
import {
  COMPANY_DOCUMENT_CATEGORIES,
  addDocument,
  updateDocument,
} from '../../services/documentService';
import { getAllVorgaenge } from '../../services/vorgangService';
import type {
  CompanyDocument,
  CompanyDocumentCategory,
  CompanyDocumentInput,
} from '../../types/models';
import type { TranslationKey } from '../../i18n';
import { Button } from '../ui/Button';

export interface DocumentFormDraft {
  title: string;
  category: CompanyDocumentCategory;
  issuer: string;
  recognizedText: string;
  issueDate: string;
  validUntil: string;
  digitalFolderName: string;
  digitalFolderPath: string;
  paperFolderId: string;
  paperRegister: string;
  tagsText: string;
  linkedCompany: string;
  linkedVorgangId: string;
  archived: boolean;
}

function draftFromDocument(doc: CompanyDocument): DocumentFormDraft {
  return {
    title: doc.title,
    category: doc.category,
    issuer: doc.issuer,
    recognizedText: doc.recognizedText,
    issueDate: doc.issueDate ?? '',
    validUntil: doc.validUntil ?? '',
    digitalFolderName: doc.digitalFolder.name,
    digitalFolderPath: doc.digitalFolder.path,
    paperFolderId: doc.paperFolder.folderId,
    paperRegister: doc.paperFolder.register,
    tagsText: doc.tags.join(', '),
    linkedCompany: doc.linkedCompany,
    linkedVorgangId: doc.linkedVorgang?.vorgangId ?? '',
    archived: doc.archived,
  };
}

function createEmptyDraft(linkedCompany: string): DocumentFormDraft {
  const defaultFolder = PAPER_FOLDERS[4] ?? PAPER_FOLDERS[0];
  return {
    title: '',
    category: 'sonstiges',
    issuer: '',
    recognizedText: '',
    issueDate: '',
    validUntil: '',
    digitalFolderName: 'Firmendokumente',
    digitalFolderPath: '/Firma/Dokumente/',
    paperFolderId: defaultFolder.id,
    paperRegister: defaultFolder.registers[0] ?? 'A',
    tagsText: '',
    linkedCompany,
    linkedVorgangId: '',
    archived: true,
  };
}

function draftToInput(draft: DocumentFormDraft): CompanyDocumentInput {
  const folder = PAPER_FOLDERS.find((f) => f.id === draft.paperFolderId) ?? PAPER_FOLDERS[0];
  const vorgaenge = getAllVorgaenge();
  const linkedVorgang = draft.linkedVorgangId
    ? vorgaenge.find((v) => v.id === draft.linkedVorgangId)
    : undefined;

  return {
    title: draft.title,
    category: draft.category,
    issuer: draft.issuer,
    recognizedText: draft.recognizedText,
    issueDate: draft.issueDate || null,
    validUntil: draft.validUntil || null,
    digitalFolder: {
      id: `dig-doc-${Date.now()}`,
      name: draft.digitalFolderName.trim() || 'Firmendokumente',
      path: draft.digitalFolderPath.trim() || '/Firma/Dokumente/',
    },
    paperFolder: {
      folderId: draft.paperFolderId,
      register: draft.paperRegister,
      label: folder.name,
    },
    tags: draft.tagsText
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    linkedCompany: draft.linkedCompany,
    linkedVorgang: linkedVorgang
      ? { vorgangId: linkedVorgang.id, vorgangTitle: linkedVorgang.title }
      : null,
    archived: draft.archived,
  };
}

interface DocumentFormProps {
  mode: 'add' | 'edit';
  document?: CompanyDocument;
  onSaved: (document: CompanyDocument) => void;
  onCancel: () => void;
}

export function DocumentForm({ mode, document, onSaved, onCancel }: DocumentFormProps) {
  const { translate, setup, showToast } = useApp();
  const [draft, setDraft] = useState<DocumentFormDraft>(() =>
    mode === 'edit' && document
      ? draftFromDocument(document)
      : createEmptyDraft(setup.companyName),
  );
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);

  const vorgaenge = getAllVorgaenge();
  const selectedPaperFolder =
    PAPER_FOLDERS.find((f) => f.id === draft.paperFolderId) ?? PAPER_FOLDERS[0];

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setErrorKey(null);

    const input = draftToInput(draft);
    const result =
      mode === 'edit' && document
        ? updateDocument(document.id, input)
        : addDocument(input);

    if (!result.success) {
      setErrorKey(result.errorKey as TranslationKey);
      return;
    }

    showToast(
      translate(mode === 'add' ? 'document.added' : 'document.saved'),
    );
    onSaved(result.document);
  };

  return (
    <form className="document-form" onSubmit={handleSubmit}>
      <fieldset className="form-group">
        <label htmlFor="doc-title">{translate('document.fieldTitle')}</label>
        <input
          id="doc-title"
          className="input"
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          required
        />
      </fieldset>

      <fieldset className="form-group">
        <legend>{translate('document.fieldCategory')}</legend>
        <div className="chip-group">
          {COMPANY_DOCUMENT_CATEGORIES.map((cat) => {
            const key = `document.category.${cat}` as TranslationKey;
            return (
              <button
                key={cat}
                type="button"
                className={`chip ${draft.category === cat ? 'chip--active' : ''}`}
                onClick={() => setDraft({ ...draft, category: cat })}
              >
                {translate(key)}
              </button>
            );
          })}
        </div>
      </fieldset>

      <fieldset className="form-group">
        <label htmlFor="doc-issuer">{translate('document.fieldIssuer')}</label>
        <input
          id="doc-issuer"
          className="input"
          value={draft.issuer}
          onChange={(e) => setDraft({ ...draft, issuer: e.target.value })}
        />
      </fieldset>

      <div className="form-row">
        <fieldset className="form-group">
          <label htmlFor="doc-issue">{translate('document.fieldIssueDate')}</label>
          <input
            id="doc-issue"
            type="date"
            className="input"
            value={draft.issueDate}
            onChange={(e) => setDraft({ ...draft, issueDate: e.target.value })}
          />
        </fieldset>
        <fieldset className="form-group">
          <label htmlFor="doc-valid">{translate('document.fieldValidUntil')}</label>
          <input
            id="doc-valid"
            type="date"
            className="input"
            value={draft.validUntil}
            onChange={(e) => setDraft({ ...draft, validUntil: e.target.value })}
          />
        </fieldset>
      </div>

      <fieldset className="form-group">
        <label htmlFor="doc-tags">{translate('document.fieldTags')}</label>
        <input
          id="doc-tags"
          className="input"
          placeholder={translate('document.tagsPlaceholder')}
          value={draft.tagsText}
          onChange={(e) => setDraft({ ...draft, tagsText: e.target.value })}
        />
      </fieldset>

      <fieldset className="form-group">
        <label htmlFor="doc-text">{translate('document.fieldRecognizedText')}</label>
        <textarea
          id="doc-text"
          className="input document-form__textarea"
          rows={3}
          value={draft.recognizedText}
          onChange={(e) => setDraft({ ...draft, recognizedText: e.target.value })}
        />
      </fieldset>

      <fieldset className="form-group">
        <label htmlFor="doc-digital-name">{translate('document.fieldDigitalFolder')}</label>
        <input
          id="doc-digital-name"
          className="input"
          value={draft.digitalFolderName}
          onChange={(e) => setDraft({ ...draft, digitalFolderName: e.target.value })}
        />
        <input
          className="input"
          aria-label={translate('inbox.edit.digitalPath')}
          value={draft.digitalFolderPath}
          onChange={(e) => setDraft({ ...draft, digitalFolderPath: e.target.value })}
        />
      </fieldset>

      <fieldset className="form-group">
        <label htmlFor="doc-paper-folder">{translate('document.fieldPaperFolder')}</label>
        <select
          id="doc-paper-folder"
          className="select"
          value={draft.paperFolderId}
          onChange={(e) => {
            const folder = PAPER_FOLDERS.find((f) => f.id === e.target.value);
            setDraft({
              ...draft,
              paperFolderId: e.target.value,
              paperRegister: folder?.registers[0] ?? 'A',
            });
          }}
        >
          {PAPER_FOLDERS.map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folder.name}
            </option>
          ))}
        </select>
        <select
          className="select"
          aria-label={translate('common.register')}
          value={draft.paperRegister}
          onChange={(e) => setDraft({ ...draft, paperRegister: e.target.value })}
        >
          {selectedPaperFolder.registers.map((reg) => (
            <option key={reg} value={reg}>
              {translate('common.register')} {reg}
            </option>
          ))}
        </select>
      </fieldset>

      <fieldset className="form-group">
        <label htmlFor="doc-vorgang">{translate('document.fieldLinkedVorgang')}</label>
        <select
          id="doc-vorgang"
          className="select"
          value={draft.linkedVorgangId}
          onChange={(e) => setDraft({ ...draft, linkedVorgangId: e.target.value })}
        >
          <option value="">{translate('common.unassigned')}</option>
          {vorgaenge.map((v) => (
            <option key={v.id} value={v.id}>
              {v.title}
            </option>
          ))}
        </select>
      </fieldset>

      {errorKey && <p className="form-error">{translate(errorKey)}</p>}

      <div className="form-actions">
        <Button type="button" variant="ghost" onClick={onCancel}>
          {translate('common.cancel')}
        </Button>
        <Button type="submit" variant="primary">
          {translate('common.save')}
        </Button>
      </div>
    </form>
  );
}

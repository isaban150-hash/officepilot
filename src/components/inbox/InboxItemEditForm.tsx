import type { ReactNode } from 'react';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { useApp } from '../../context/AppContext';
import { PAPER_FOLDERS } from '../../data/mockData';
import { EDITABLE_ACTIONS, EDITABLE_PRIORITIES } from '../../services/inboxService';
import type { InboxItem, InboxPriority, RecommendedAction } from '../../types/models';
import type { TranslationKey } from '../../i18n';

export interface InboxEditDraft {
  sender: string;
  deadline: string;
  vorgangTitle: string;
  priority: InboxPriority;
  recognizedData: Record<string, string>;
  digitalFolderPath: string;
  digitalFolderName: string;
  paperFilingFolderId: string;
  paperFilingRegister: string;
  recommendedAction: RecommendedAction;
}

export function createEditDraftFromItem(item: InboxItem): InboxEditDraft {
  return {
    sender: item.sender,
    deadline: item.deadline ?? '',
    vorgangTitle: item.vorgangTitle ?? '',
    priority: item.priority,
    recognizedData: { ...item.recognizedData },
    digitalFolderPath: item.digitalFolder.path,
    digitalFolderName: item.digitalFolder.name,
    paperFilingFolderId: item.paperFiling.folderId,
    paperFilingRegister: item.paperFiling.register,
    recommendedAction: item.recommendedAction,
  };
}

interface InboxItemEditFormProps {
  draft: InboxEditDraft;
  onChange: (draft: InboxEditDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}

function EditField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="edit-field">
      <span className="edit-field__label">{label}</span>
      {children}
    </label>
  );
}

export function InboxItemEditForm({
  draft,
  onChange,
  onSave,
  onCancel,
}: InboxItemEditFormProps) {
  const { translate } = useApp();

  const updateDraft = (partial: Partial<InboxEditDraft>) => {
    onChange({ ...draft, ...partial });
  };

  const updateRecognizedField = (key: string, value: string) => {
    onChange({
      ...draft,
      recognizedData: { ...draft.recognizedData, [key]: value },
    });
  };

  const selectedFolder = PAPER_FOLDERS.find((f) => f.id === draft.paperFilingFolderId);
  const registerOptions = selectedFolder?.registers ?? [];

  return (
    <div className="inbox-edit">
      <Card className="inbox-edit__section">
        <h3 className="section__title">{translate('inbox.edit.sectionDocument')}</h3>
        <EditField label={translate('inbox.sender')}>
          <input
            type="text"
            className="input"
            value={draft.sender}
            onChange={(e) => updateDraft({ sender: e.target.value })}
          />
        </EditField>
        <EditField label={translate('analysis.deadline')}>
          <input
            type="date"
            className="input"
            value={draft.deadline}
            onChange={(e) => updateDraft({ deadline: e.target.value })}
          />
        </EditField>
        <EditField label={translate('inbox.edit.priority')}>
          <select
            className="select"
            value={draft.priority}
            onChange={(e) => updateDraft({ priority: e.target.value as InboxPriority })}
          >
            {EDITABLE_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {translate(`priority.${p}` as TranslationKey)}
              </option>
            ))}
          </select>
        </EditField>
        {Object.entries(draft.recognizedData).map(([key, value]) => (
          <EditField key={key} label={key}>
            <input
              type="text"
              className="input"
              value={value}
              onChange={(e) => updateRecognizedField(key, e.target.value)}
            />
          </EditField>
        ))}
      </Card>

      <Card className="inbox-edit__section">
        <h3 className="section__title">{translate('inbox.edit.sectionAssignment')}</h3>
        <EditField label={translate('analysis.vorgang')}>
          <input
            type="text"
            className="input"
            value={draft.vorgangTitle}
            onChange={(e) => updateDraft({ vorgangTitle: e.target.value })}
            placeholder={translate('common.unassigned')}
          />
        </EditField>
      </Card>

      <Card className="inbox-edit__section">
        <h3 className="section__title">{translate('inbox.edit.sectionFiling')}</h3>
        <EditField label={translate('inbox.edit.digitalPath')}>
          <input
            type="text"
            className="input"
            value={draft.digitalFolderPath}
            onChange={(e) => updateDraft({ digitalFolderPath: e.target.value })}
          />
        </EditField>
        <EditField label={translate('inbox.edit.digitalName')}>
          <input
            type="text"
            className="input"
            value={draft.digitalFolderName}
            onChange={(e) => updateDraft({ digitalFolderName: e.target.value })}
          />
        </EditField>
        <EditField label={translate('inbox.edit.paperFolder')}>
          <select
            className="select"
            value={draft.paperFilingFolderId}
            onChange={(e) => {
              const folder = PAPER_FOLDERS.find((f) => f.id === e.target.value);
              updateDraft({
                paperFilingFolderId: e.target.value,
                paperFilingRegister: folder?.registers[0] ?? draft.paperFilingRegister,
              });
            }}
          >
            {PAPER_FOLDERS.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.name}
              </option>
            ))}
          </select>
        </EditField>
        <EditField label={translate('common.register')}>
          <select
            className="select"
            value={draft.paperFilingRegister}
            onChange={(e) => updateDraft({ paperFilingRegister: e.target.value })}
          >
            {registerOptions.map((reg) => (
              <option key={reg} value={reg}>
                {reg}
              </option>
            ))}
          </select>
        </EditField>
      </Card>

      <Card className="inbox-edit__section">
        <h3 className="section__title">{translate('inbox.edit.sectionAction')}</h3>
        <EditField label={translate('inbox.recommendedAction')}>
          <select
            className="select"
            value={draft.recommendedAction}
            onChange={(e) =>
              updateDraft({ recommendedAction: e.target.value as RecommendedAction })
            }
          >
            {EDITABLE_ACTIONS.map((action) => (
              <option key={action} value={action}>
                {translate(`action.${action}` as TranslationKey)}
              </option>
            ))}
          </select>
        </EditField>
      </Card>

      <div className="inbox-edit__footer">
        <Button fullWidth onClick={onSave}>
          {translate('inbox.edit.save')}
        </Button>
        <Button variant="outline" fullWidth onClick={onCancel}>
          {translate('inbox.edit.cancel')}
        </Button>
      </div>
    </div>
  );
}

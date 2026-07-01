import { Button } from '../ui/Button';
import { Card, CardTitle } from '../ui/Card';
import type { MissingCommunicationInfo } from '../../types/communication';
import type { TranslationKey } from '../../i18n';

interface CommunicationMissingInfoFormProps {
  fields: MissingCommunicationInfo[];
  values: Record<string, string>;
  onChange: (fieldId: string, value: string) => void;
  onSubmit: () => void;
  title: string;
  submitLabel: string;
  translate: (key: TranslationKey) => string;
}

export function CommunicationMissingInfoForm({
  fields,
  values,
  onChange,
  onSubmit,
  title,
  submitLabel,
  translate,
}: CommunicationMissingInfoFormProps) {
  return (
    <Card className="communication-missing-card" data-testid="communication-missing-form">
      <CardTitle>{title}</CardTitle>
      <div className="communication-missing-fields">
        {fields.map((field) => (
          <label key={field.fieldId} className="communication-missing-field">
            <span className="communication-missing-field__label">
              {translate(field.labelKey as TranslationKey)}
              {field.required && ' *'}
            </span>
            <span className="communication-missing-field__prompt">
              {translate(field.promptKey as TranslationKey)}
            </span>
            <input
              type={field.inputType === 'number' ? 'number' : field.inputType === 'date' ? 'date' : 'text'}
              className="input"
              data-testid={`communication-field-${field.fieldId}`}
              value={values[field.fieldId] ?? ''}
              onChange={(event) => onChange(field.fieldId, event.target.value)}
            />
          </label>
        ))}
      </div>
      <Button type="button" data-testid="communication-missing-submit" onClick={onSubmit}>
        {submitLabel}
      </Button>
    </Card>
  );
}

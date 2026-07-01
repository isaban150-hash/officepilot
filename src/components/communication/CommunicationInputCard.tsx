import { Button } from '../ui/Button';
import { Card } from '../ui/Card';

interface CommunicationInputCardProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  submitLabel: string;
  disabled?: boolean;
}

export function CommunicationInputCard({
  value,
  onChange,
  onSubmit,
  placeholder,
  submitLabel,
  disabled = false,
}: CommunicationInputCardProps) {
  return (
    <Card className="communication-input-card">
      <div className="communication-input-row">
        <textarea
          className="input communication-input"
          data-testid="communication-input"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              onSubmit();
            }
          }}
          placeholder={placeholder}
          rows={3}
          disabled={disabled}
        />
        <Button
          type="button"
          data-testid="communication-submit"
          onClick={onSubmit}
          disabled={disabled || !value.trim()}
        >
          {submitLabel}
        </Button>
      </div>
    </Card>
  );
}

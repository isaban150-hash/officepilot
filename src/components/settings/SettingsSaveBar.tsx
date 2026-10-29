import { Button } from '../ui/Button';
import { PrimaryActionBar } from '../ui/PrimaryActionBar';
import { useApp } from '../../context/AppContext';
import { useLeaveGuard } from '../../hooks/useLeaveGuard';

/**
 * EINRICHTUNG-01 (AP5; Vertrag 1.17) — die Speicherleiste der Einstellungsformulare.
 *
 * Unter 1024 px klebt sie unten über der Bottom-Navigation, sobald das Formular geändert ist, mit „Speichern“ und
 * „Verwerfen“; sie steht im Fluss der Seite und verdeckt deshalb am Ende keinen Inhalt. Ohne Änderung steht sie still
 * am Formularende. Ab 1024 px gilt das bestehende Design-System (statisch, wie `PrimaryActionBar`).
 *
 * Die Leiste gehört in das `<form>`: „Speichern“ ist der Absendeknopf. Seiten ohne eigenes Formular (Design) geben
 * `onSave` mit; dann ist „Speichern“ ein gewöhnlicher Knopf. Seiten ohne Schreibrecht zeigen die Leiste nicht (1.16).
 *
 * EINRICHTUNG-01 (AP8; 1.27) — solange das Formular geändert ist, schützt die Leiste vor dem Verlassen (Rückfrage);
 * `draftKept` sagt, ob die Seite ihre Eingaben als Entwurf behält (Wiederaufnahme).
 */
export interface SettingsSaveBarProps {
  dirty: boolean;
  saving?: boolean;
  onDiscard: () => void;
  /** Präfix der Test-IDs: `<prefix>-save`, `<prefix>-discard`, `<prefix>-dirty`, `<prefix>-save-bar`. */
  testIdPrefix: string;
  /** Zusätzliche Sperre des Speicherns (z. B. offene Feldfehler). */
  saveDisabled?: boolean;
  /** Ohne umgebendes Formular: Speichern als Knopf mit dieser Aktion. */
  onSave?: () => void;
  /** Die Seite behält ihre Eingaben als Entwurf (Text der Rückfrage beim Verlassen). */
  draftKept?: boolean;
  /** EINRICHTUNG-01 (AP9; 1.30) — ein Speicherfehler als bleibender Hinweis (`role="alert"`), schon übersetzt. */
  error?: string | null;
}

export function SettingsSaveBar({ dirty, saving = false, onDiscard, testIdPrefix, saveDisabled = false, onSave, draftKept = false, error = null }: SettingsSaveBarProps) {
  const { translate } = useApp();
  useLeaveGuard(dirty, draftKept);
  return (
    <PrimaryActionBar
      sticky={dirty}
      className={['settings-save-bar', dirty ? 'settings-save-bar--dirty' : ''].filter(Boolean).join(' ')}
      testId={`${testIdPrefix}-save-bar`}
      ariaLabel={translate('settings.saveBar.region')}
      note={
        <>
          {error ? (
            <span className="form-error settings-save-bar__error" role="alert" data-testid={`${testIdPrefix}-save-error`}>
              {error}
            </span>
          ) : null}
          <span className="settings-form__dirty" data-testid={`${testIdPrefix}-dirty`}>
            {dirty ? translate('settings.saveBar.unsaved') : translate('settings.saveBar.clean')}
          </span>
        </>
      }
      secondary={
        dirty ? (
          <Button type="button" variant="outline" disabled={saving} onClick={onDiscard} data-testid={`${testIdPrefix}-discard`}>
            {translate('settings.saveBar.discard')}
          </Button>
        ) : null
      }
      primary={
        <Button
          type={onSave ? 'button' : 'submit'}
          onClick={onSave}
          disabled={!dirty || saving || saveDisabled}
          loading={saving}
          data-testid={`${testIdPrefix}-save`}
        >
          {translate('settings.saveBar.save')}
        </Button>
      }
    />
  );
}

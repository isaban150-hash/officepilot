import { describe, expect, it } from 'vitest';
import { deBackup } from './i18n/locales/de/backup';

describe('PILOT-HARDENING-01 copy', () => {
  it('restore hint uses current replace wording', () => {
    expect(deBackup['backup.validate.replaceHint']).toContain(
      'ersetzt alle lokalen OfficePilot-Daten',
    );
    expect(deBackup['backup.validate.replaceHint']).not.toContain('später');
    expect(
      Object.prototype.hasOwnProperty.call(deBackup, 'backup.validate.restoreUnavailable'),
    ).toBe(false);
  });

  // SETTINGS-FINAL — die Pilothinweis-Tafel wurde mit der Firmendaten-Seite abgelöst; ihre Texte sind entfernt.
});

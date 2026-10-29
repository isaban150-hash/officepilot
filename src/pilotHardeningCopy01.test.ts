import { describe, expect, it } from 'vitest';
import { deBackup } from './i18n/locales/de/backup';

describe('PILOT-HARDENING-01 copy', () => {
  it('restore hint uses current replace wording', () => {
    // EINRICHTUNG-01 (AP7; 1.23, D-03.1) — ersetzt wird dieser Betrieb auf diesem Gerät, nicht „alle lokalen Daten“.
    expect(deBackup['backup.validate.replaceHint']).toContain('ersetzt die Daten dieses Betriebs auf diesem Gerät');
    expect(deBackup['backup.validate.replaceHint']).not.toMatch(/alle lokalen|in diesem Browser/);
    expect(deBackup['backup.validate.replaceHint']).not.toContain('später');
    expect(
      Object.prototype.hasOwnProperty.call(deBackup, 'backup.validate.restoreUnavailable'),
    ).toBe(false);
  });

  // SETTINGS-FINAL — die Pilothinweis-Tafel wurde mit der Firmendaten-Seite abgelöst; ihre Texte sind entfernt.
});

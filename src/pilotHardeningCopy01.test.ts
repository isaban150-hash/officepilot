import { describe, expect, it } from 'vitest';
import { deBackup } from './i18n/locales/de/backup';
import { dePilot } from './i18n/locales/de/pilot';

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

  it('pilot boundaries are visible as dedicated hints', () => {
    expect(dePilot['pilot.hints.title']).toBe('Hinweise zum Pilotbetrieb');
    expect(dePilot['pilot.hints.noCloud']).toMatch(/Internet|KI|Synchronisation|Freigabe/i);
    expect(dePilot['pilot.hints.noAutoSend']).toMatch(/nicht|keine/i);
    expect(dePilot['pilot.hints.backup']).toMatch(/ZIP|Datensicherung|Backup/i);
  });
});

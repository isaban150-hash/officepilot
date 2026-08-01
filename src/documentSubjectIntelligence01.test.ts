import { describe, expect, it } from 'vitest';
import {
  composeIntelligentDocumentSubject,
  extractDocumentSubjectSignals,
  formatSubjectAbsender,
} from './services/documentSubjectIntelligence';

describe('SUBJECT-CONTRACT-01', () => {
  it('bildet Absender · Dokumentinhalt mit Kennzeichen', () => {
    const text =
      'VHV Gewerbeversicherung Kfz-Versicherung Hannover Cirmak Haustechnik GmbH ' +
      'Beitragsrechnung Kfz-Versicherung Datum 08.01.2026 · Kennzeichen LIP-CH 1002';
    const subject = composeIntelligentDocumentSubject({
      text,
      sender: 'VHV Gewerbeversicherung',
      typeLabel: 'Fahrzeugversicherung',
    });
    expect(subject).toMatch(/^VHV\s·\s/i);
    expect(subject).toMatch(/Kfz/i);
    expect(subject).toMatch(/LIP-CH\s*1002/i);
  });

  it('verbindet Absender mit Lohnabrechnung und Person', () => {
    const text =
      'Cirmak Haustechnik GmbH Gehaltsabrechnung Lohnabrechnung Februar 2026 Sandra Keller ' +
      '· erstellt über Steuerberatung Ostwestfalen GmbH';
    const subject = composeIntelligentDocumentSubject({
      text,
      sender: 'Steuerberatung Ostwestfalen GmbH',
    });
    expect(subject).toMatch(/^Steuerberatung Ostwestfalen\s·\s/i);
    expect(subject).toMatch(/Lohnabrechnung/i);
    expect(subject).toMatch(/Sandra Keller/i);
    expect(subject).not.toMatch(/EMP-/i);
  });

  it('nutzt Absender allein, wenn kein Dokumentinhalt vorliegt', () => {
    const subject = composeIntelligentDocumentSubject({
      text: 'Seite 1 von 1',
      sender: 'Cirmak Haustechnik GmbH',
      typeLabel: 'Sonstiges',
    });
    expect(subject).toBe('Cirmak Haustechnik');
  });

  it('lässt Absender weg, wenn keiner ermittelt werden kann', () => {
    const subject = composeIntelligentDocumentSubject({
      text: 'Krankmeldung / AU Versicherter Jonas Richter',
      typeLabel: 'Krankmeldung',
    });
    expect(subject).toMatch(/Krankmeldung/i);
    expect(subject).toMatch(/Jonas Richter/i);
    expect(subject).not.toMatch(/\s·\s/);
  });

  it('kürzt Marken-Absender ohne generischen Zusatz', () => {
    expect(formatSubjectAbsender('VHV Gewerbeversicherung')).toBe('VHV');
    expect(formatSubjectAbsender('Alphabet Leasing')).toBe('Alphabet');
    expect(formatSubjectAbsender('Steuerberatung Ostwestfalen GmbH')).toBe(
      'Steuerberatung Ostwestfalen',
    );
  });

  it('bildet Katalog-Subject aus Dokumentkopf ohne Absender', () => {
    const subject = composeIntelligentDocumentSubject({
      text:
        'W Werkzeugkatalog Frühjahr 2026 Prospekt — keine Rechnung · keine Verpflichtung ' +
        'Neu im Sortiment: Akku-Schlagschrauber',
      sender: 'Absender nicht eindeutig erkannt.',
      typeLabel: 'Sonstiges',
      title: 'Sonstiges – Absender nicht eindeutig erkannt.',
    });
    expect(subject).toMatch(/Werkzeugkatalog Frühjahr 2026/i);
    expect(subject).not.toMatch(/Absender nicht eindeutig/i);
    expect(subject).not.toMatch(/\s·\s/);
  });

  it('extrahiert Person und Kennzeichen als Signale', () => {
    const signals = extractDocumentSubjectSignals(
      'Krankmeldung / AU Versicherter Jonas Richter Kennzeichen LIP-CH 1001 Datum 10.03.2026',
    );
    expect(signals.person).toMatch(/Jonas Richter/);
    expect(signals.plate).toMatch(/LIP-CH\s*1001/);
  });
});

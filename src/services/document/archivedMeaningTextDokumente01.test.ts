/**
 * DOKUMENTE-01 / F7 — die Bedeutung eines abgelegten Dokuments liest den
 * Originaltext, nicht den ganzen Archivtext.
 *
 * Der Archivtext entsteht beim Ablegen aus allen erkannten Feldern
 * (`Schlüssel: Wert`): Feldliste, der Originaltext zweimal (`_extractedText`,
 * `_vertragstext`) und die Seiten als eine einzige JSON-Zeile (`_pageTexts`).
 * In dieser Zeile gibt es keinen echten Zeilenumbruch — „Auslagenerstattung"
 * aus einer früheren Zeile färbte auf den Betrag ab und machte ihn zur
 * „Gutschrift zu Ihren Gunsten".
 *
 * Alle Texte sind frei erfunden.
 */
import { describe, expect, it } from 'vitest';
import { buildDocumentAiContextFromDocument, resolveArchivedMeaningText } from './documentAiContextService';
import { buildDocumentMeaningView } from './documentMeaningPresentationService';
import { hydrateInboxStore } from '../inboxService';
import type { CompanyDocument, InboxItem } from '../../types/models';

const ORIGINAL = [
  'Quittung',
  'Auslagenerstattung Mitarbeiter',
  'Parkschein Baustelle Hauptstraße',
  '12,50 €',
  'Bar erhalten',
].join('\n');

/** Wie `buildRecognizedTextFromInbox`: alle Felder als Zeilen, danach der Vorschlag. */
function archivtext(recognizedData: Record<string, string>, vorschlag?: string): string {
  const zeilen = Object.entries(recognizedData).map(([k, v]) => `${k}: ${v}`);
  if (vorschlag) zeilen.push('', vorschlag);
  return zeilen.join('\n').trim();
}

function dokument(recognizedText: string): CompanyDocument {
  return {
    id: 'doc-dokumente01-f7',
    title: 'Quittung Parkschein',
    category: 'steuer',
    issuer: 'Parkhaus Beispiel',
    recognizedText,
    issueDate: '2026-09-14',
    validUntil: null,
    digitalFolder: 'belege' as CompanyDocument['digitalFolder'],
    paperFolder: { folderId: '', register: '', label: '' },
    tags: [],
    linkedCompany: '',
    linkedVorgang: null,
    archived: true,
    createdAt: '2026-09-14T10:00:00.000Z',
  } as CompanyDocument;
}

const ABGELEGT = dokument(
  archivtext(
    {
      Dokumentart: 'Quittung',
      Betrag: '12,50 €',
      _extractedText: ORIGINAL,
      _vertragstext: ORIGINAL,
      _pageTexts: JSON.stringify([{ page: 1, text: ORIGINAL }]),
    },
    'Als Ausgabe speichern',
  ),
);

describe('DOKUMENTE-01 F7 — Bedeutung abgelegter Dokumente aus dem Originaltext', () => {
  it('liefert genau den Originaltext, ohne Feldliste, Doppel und Seiten-JSON', () => {
    const text = resolveArchivedMeaningText(ABGELEGT);
    expect(text).toBe(ORIGINAL);
    expect(text).not.toContain('_pageTexts');
    expect(text).not.toContain('_vertragstext');
  });

  it('der ganze Archivtext hätte den Betrag zur Gutschrift gemacht (Nachweis des Fehlers)', () => {
    const ausArchivtext = buildDocumentMeaningView({ text: ABGELEGT.recognizedText });
    expect(ausArchivtext.amounts.some((zeile) => zeile.amount.includes('12,50'))).toBe(true);
  });

  it('aus dem Originaltext entsteht keine Gutschrift und kein doppelter Betrag', () => {
    const ansicht = buildDocumentMeaningView({ text: resolveArchivedMeaningText(ABGELEGT) });
    expect(ansicht.amounts.filter((zeile) => zeile.amount.includes('12,50'))).toHaveLength(0);
  });

  it('ohne Originaltext bleibt die Feldliste, aber ohne die Seiten-JSON-Zeile', () => {
    const nurFelder = dokument(
      archivtext({ Dokumentart: 'Schreiben', Absender: 'Beispiel GmbH', _pageTexts: 'kein gültiges JSON' }),
    );
    expect(resolveArchivedMeaningText(nurFelder)).toBe('Dokumentart: Schreiben\nAbsender: Beispiel GmbH');
  });

  it('ein Text ohne Archivfelder bleibt unverändert', () => {
    const schlicht = dokument('Sehr geehrte Damen und Herren,\nanbei die Unterlagen.');
    expect(resolveArchivedMeaningText(schlicht)).toBe('Sehr geehrte Damen und Herren,\nanbei die Unterlagen.');
  });

  it('der KI-Kontext eines abgelegten Dokuments enthält keine Seiten-JSON und keinen doppelten Text', () => {
    const kontext = buildDocumentAiContextFromDocument(ABGELEGT);
    expect(kontext.recognizedText).toBeDefined();
    expect(kontext.recognizedText).not.toContain('_pageTexts');
    expect(kontext.recognizedText).not.toContain('_vertragstext');
    expect((kontext.recognizedText ?? '').split('Auslagenerstattung').length - 1).toBe(1);
  });

  it('die KI liest nur den eigenen Text des Dokuments, die Bedeutung bevorzugt den Eingangsposten', () => {
    hydrateInboxStore([
      { id: 'inbox-dokumente01-f7', recognizedData: { _extractedText: 'Text des Eingangspostens' } } as unknown as InboxItem,
    ]);
    const mitEingang = { ...ABGELEGT, sourceInboxItemId: 'inbox-dokumente01-f7' };
    expect(resolveArchivedMeaningText(mitEingang)).toBe('Text des Eingangspostens');
    expect(resolveArchivedMeaningText(mitEingang, { nurEigenerText: true })).toBe(ORIGINAL);
  });

  it('derselbe Betrag in derselben Rolle steht nur einmal in der Bedeutung', () => {
    const ansicht = buildDocumentMeaningView({
      text: 'Rechnung Nr. 118\nRechnungsbetrag: 240,00 EUR\nBitte überweisen Sie den Rechnungsbetrag: 240,00 EUR bis zum 30.10.2026.',
    });
    expect(ansicht.amounts.filter((zeile) => zeile.amount.includes('240,00'))).toHaveLength(1);
  });
});

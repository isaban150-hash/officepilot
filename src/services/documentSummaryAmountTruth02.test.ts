/**
 * WEISS-NACHARBEIT 02 — Betragswahrheit auf der Eingangskarte.
 *
 * Eine Lieferantengutschrift über netto 240,00 € + 45,60 € Steuer stand auf
 * der Karte mit 240,00 €, im Detail desselben Falls mit 285,60 €. Der
 * Nettoteil hatte sich als Gesamtbetrag ausgegeben.
 *
 * Die Tests prüfen die produktive Logik — ohne Sonderregel für eine
 * Dokumentkennung und ohne Gutschrift-Sonderweg.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildInboxDocumentSummary } from './documentSummary';
import { buildDocumentMeaningView } from './document/documentMeaningPresentationService';
import { hydrateInboxStore } from './inboxService';
import { hydrateDocumentWorkResultStore } from './documentWorkResultStoreService';
import { t, type TranslationKey } from '../i18n';
import type { InboxItem } from '../types/models';

const translate = (key: TranslationKey): string => t(key, 'de');

/** Der Volltext, wie ihn die Analyse im Arbeitsstand ablegt. */
const GUTSCHRIFT_TEXT = [
  'Muster Baustoffe GmbH',
  'Gutschrift MB-GS-2026-0311',
  'Datum: 11.03.2026',
  '',
  'Wir schreiben Ihnen folgenden Betrag gut:',
  'Nettobetrag: 240,00 EUR',
  'Umsatzsteuer 19%: 45,60 EUR',
  'Gutschrift Brutto: 285,60 EUR',
].join('\n');

const RECHNUNG_TEXT = [
  'Muster Baustoffe GmbH',
  'Rechnung RE-2026-0999',
  'Nettobetrag: 1.000,00 EUR',
  'Umsatzsteuer 19%: 190,00 EUR',
  'Rechnungsbetrag: 1.190,00 EUR',
].join('\n');

const EINZELBETRAG_TEXT = ['Stadtwerke Musterstadt', 'Rechnungsbetrag: 88,40 EUR'].join('\n');

const UNKLAR_TEXT = ['Musterverein e.V.', 'Einladung zur Jahresversammlung.'].join('\n');

function posten(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'inbox-amount-1',
    title: 'Gerade erfasst: Gutschrift – Muster Baustoffe GmbH',
    documentType: 'sonstiges',
    sender: 'Muster Baustoffe GmbH',
    priority: 'mittel',
    deadline: null,
    recommendedAction: 'pruefen',
    digitalFolder: { id: 'dig', name: 'Eingang', path: '/Eingang/' },
    paperFiling: { folderId: 'f', register: 'A', label: 'x' },
    status: 'neu',
    receivedAt: '2026-10-05',
    recognizedData: {},
    officePilotSuggestion: '',
    nextTaskLabel: '',
    securityHint: '',
    ...overrides,
  } as InboxItem;
}

/**
 * Den Volltext dort ablegen, wo `resolveInboxDocumentText` zuerst sucht —
 * genau so, wie ihn ein frisch hochgeladener Posten mitbringt.
 */
function mitVolltext(item: InboxItem, text: string): InboxItem {
  const mitText = {
    ...item,
    recognizedData: { ...item.recognizedData, _extractedText: text },
  } as InboxItem;
  hydrateInboxStore([mitText]);
  return mitText;
}

function kartenbetrag(item: InboxItem): string | undefined {
  return buildInboxDocumentSummary(item, { translate }).facts.find((f) => f.id === 'amount')?.value;
}

describe('WEISS-02 — die Karte zeigt den fachlichen Gesamtbetrag', () => {
  beforeEach(() => {
    localStorage.clear();
    hydrateInboxStore([]);
    hydrateDocumentWorkResultStore([]);
  });

  it('A — Gutschrift netto 240,00 + Steuer 45,60: die Karte zeigt 285,60 €', () => {
    const item = posten({
      classifiedKind: 'gutschrift',
      recognizedData: {
        Lieferant: 'Muster Baustoffe GmbH',
        Absender: 'Muster Baustoffe GmbH',
        Dokumentart: 'gutschrift',
        /* Genau das Rohfeld, das den Fehler verursachte. */
        Betrag: '240,00 EUR',
      },
    });
    const geladen = mitVolltext(item, GUTSCHRIFT_TEXT);

    const betrag = kartenbetrag(geladen);
    expect(betrag).toContain('285,60');
    expect(betrag).not.toContain('240,00');
  });

  it('B — Karte und Detail nennen denselben Betrag', () => {
    const item = posten({
      classifiedKind: 'gutschrift',
      recognizedData: { Lieferant: 'Muster Baustoffe GmbH', Betrag: '240,00 EUR' },
    });
    const geladen = mitVolltext(item, GUTSCHRIFT_TEXT);

    const detail = buildDocumentMeaningView({ text: GUTSCHRIFT_TEXT, sender: geladen.sender });
    expect(detail.amounts[0]?.amount).toContain('285,60');
    expect(kartenbetrag(geladen)).toBe(detail.amounts[0]?.amount);
  });

  it('C — normale Eingangsrechnung mit Netto/Steuer/Brutto bleibt korrekt', () => {
    const item = posten({
      id: 'inbox-amount-re',
      classifiedKind: 'eingangsrechnung',
      documentType: 'eingangsrechnung',
      title: 'Rechnung – Muster Baustoffe GmbH',
      recognizedData: { Lieferant: 'Muster Baustoffe GmbH', Rechnungsnummer: 'RE-2026-0999' },
    });
    const geladen = mitVolltext(item, RECHNUNG_TEXT);

    const betrag = kartenbetrag(geladen);
    expect(betrag).toContain('1.190,00');
    expect(betrag).not.toContain('190,00 EUR');
  });

  it('D — ein Dokument mit nur einem Gesamtbetrag bleibt korrekt', () => {
    const item = posten({
      id: 'inbox-amount-einzel',
      classifiedKind: 'eingangsrechnung',
      documentType: 'eingangsrechnung',
      title: 'Rechnung – Stadtwerke',
      sender: 'Stadtwerke Musterstadt',
      recognizedData: { Lieferant: 'Stadtwerke Musterstadt' },
    });
    const geladen = mitVolltext(item, EINZELBETRAG_TEXT);
    expect(kartenbetrag(geladen)).toContain('88,40');
  });

  it('E — ohne erkennbaren Betrag wird keiner erfunden', () => {
    const item = posten({
      id: 'inbox-amount-unklar',
      title: 'Einladung – Musterverein',
      sender: 'Musterverein e.V.',
      recognizedData: {},
    });
    const geladen = mitVolltext(item, UNKLAR_TEXT);
    expect(kartenbetrag(geladen)).toBeUndefined();
  });

  it('F — ohne Volltext bleibt das Rohfeld die letzte Quelle', () => {
    /*
     * Kein Rückschritt für Altbestände ohne gespeicherten Arbeitsstand: Lieber
     * das Rohfeld als gar kein Betrag.
     */
    const item = posten({
      id: 'inbox-amount-ohne-text',
      recognizedData: { Lieferant: 'Muster Baustoffe GmbH', Betrag: '240,00 EUR' },
    });
    hydrateInboxStore([item]);
    hydrateDocumentWorkResultStore([]);
    expect(kartenbetrag(item)).toContain('240,00');
  });

  it('G — der Fix hängt an keiner Dokumentkennung', async () => {
    const quelle = await import('node:fs').then((fs) =>
      fs.readFileSync('src/services/documentSummary.ts', 'utf8'),
    );
    expect(quelle).not.toContain('MB-GS-2026-0311');
    expect(quelle).not.toContain('inbox-upload-1789841766573');
    /* Und keine Sonderregel nur für Gutschriften. */
    expect(quelle).not.toMatch(/gutschrift[^\n]*285/i);
  });

  it('H — dieselbe Auswahl wie das Detail, keine zweite Rangfolge', async () => {
    const quelle = await import('node:fs').then((fs) =>
      fs.readFileSync('src/services/documentSummary.ts', 'utf8'),
    );
    expect(quelle).toContain('buildDocumentMeaningView');
    /* Keine eigene Rollenbewertung in der Zusammenfassung. */
    expect(quelle).not.toContain('credit_amount');
    expect(quelle).not.toContain('invoice_total');
  });
});

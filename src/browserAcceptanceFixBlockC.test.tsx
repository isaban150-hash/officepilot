/**
 * BROWSER-ACCEPTANCE-FIX 01 / Block C — C1–C7.
 *
 * C1 §13b-Prüfhinweis nicht im Druck · C2 keine Doppelung „Noch offen … Offen"
 * C3 valides HTML im Ablagepfad · C4 Einstellungen siezen · C5 Beträge im
 * Eingang einheitlich · C6 Heizungs-Komposita · C7 keine leere „Baustelle:".
 *
 * Neutrale Beispieldaten, kein Netzwerk.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { InvoiceTaxNotice } from './components/invoice/InvoiceTaxNotice';
import { DocumentFilingCard } from './components/documents/DocumentFilingCard';
import { buildInvoicePrintModel } from './services/invoicePrintModel';
import { createNormalPrintSetup, createReverseChargePrintSetup } from './test/invoicePrintFixtures';
import { buildInvoiceDetailHighlights } from './services/invoice/invoiceDetailHighlights';
import { addDocument } from './services/documentService';
import { deSettings } from './i18n/locales/de/settings';

const deDicts: Record<string, string> = deSettings;
import { formatRecognizedMoneyText, parseSafeEuroText } from './utils/moneyText';
import { formatSummaryFactValue } from './services/documentSummaryContent';
import { deriveGewerk } from './services/contractScopeDerivationService';
import { buildVorgangScopeView } from './services/vorgangScopeView';
import { tryResolveCompanyContextQuestion } from './services/brain/companyContextResolver';
import { recordVorgangContext, resetCompanySessionForTests, getCompanySession } from './services/brain/companySessionService';
import { hydrateVorgangStore } from './services/vorgangService';
import { resetTestStores } from './test/resetStores';
import { createOrderPosition, createTestVorgang } from './test/fixtures';
import type { Vorgang } from './types/models';

const setupComplete = { ...DEFAULT_SETUP, setupComplete: true };

function renderWithApp(element: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(AppProvider, { initialSetup: setupComplete }, element)),
  );
}

/* ------------------------------------------------------------------ */
/* C1                                                                   */
/* ------------------------------------------------------------------ */

describe('C1 — §13b-Prüfhinweis: in der Oberfläche ja, im Druck nein', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
  const printStart = css.indexOf('@media print {');
  const printBlock = css.slice(printStart, css.indexOf('\n}\n', printStart));
  const hiddenList = printBlock.slice(0, printBlock.indexOf('display: none !important;'));

  it('C1-1: interner Prüfhinweis und kundenrelevante §13b-Hinweise sind in der Ansicht vorhanden', () => {
    const { draft, setup } = createReverseChargePrintSetup();
    const html = renderWithApp(createElement(InvoiceTaxNotice, { model: buildInvoicePrintModel(draft, setup) }));
    expect(html).toContain('class="invoice-tax-notice__review" data-testid="invoice-13b-preview-hint"');
    expect(html).toContain('data-testid="invoice-13b-no-vat"');
    expect(html).toContain('Keine Umsatzsteuer ausgewiesen (§ 13b).');
    expect(html).toContain('invoice-tax-notice__status');
  });

  it('C1-2: das Druck-CSS blendet nur den Prüfhinweis aus', () => {
    expect(printStart).toBeGreaterThan(-1);
    expect(hiddenList).toContain('.invoice-tax-notice__review');
    // Die Kundenhinweise stehen nicht in der Ausblendliste.
    for (const selector of ['.invoice-tax-notice__status', '.invoice-tax-notice__list', '.invoice-tax-notice {', '.invoice-tax-notice,']) {
      expect(hiddenList).not.toContain(selector);
    }
  });

  it('C1-3: das PDF bleibt, wie es war — der Prüfhinweis gehört nicht hinein', () => {
    const pdf = readFileSync(resolve(process.cwd(), 'src/services/invoicePdfService.ts'), 'utf8');
    expect(pdf).not.toContain('previewHint');
  });

  it('C1-4: ohne §13b gibt es keinen Prüfhinweis', () => {
    const { draft, setup } = createNormalPrintSetup();
    const html = renderWithApp(createElement(InvoiceTaxNotice, { model: buildInvoicePrintModel(draft, setup) }));
    expect(html).not.toContain('invoice-13b-preview-hint');
  });
});

/* ------------------------------------------------------------------ */
/* C2                                                                   */
/* ------------------------------------------------------------------ */

describe('C2 — Rechnungsstatus ohne Doppelung', () => {
  const base = { openAmountText: 'Noch offen: 40,00 €' };
  it('C2-1: offen → nur „Noch offen: 40,00 €"', () => {
    expect(buildInvoiceDetailHighlights({ ...base, status: 'offen', openAmount: 40, statusText: 'Offen' })).toEqual([
      'Noch offen: 40,00 €',
    ]);
  });
  it('C2-2: teilbezahlt/überfällig bleiben als zusätzliche Information', () => {
    expect(buildInvoiceDetailHighlights({ ...base, status: 'teilbezahlt', openAmount: 40, statusText: 'Teilbezahlt' })).toEqual([
      'Noch offen: 40,00 €',
      'Teilbezahlt',
    ]);
    expect(buildInvoiceDetailHighlights({ ...base, status: 'ueberfaellig', openAmount: 40, statusText: 'Überfällig' })).toEqual([
      'Noch offen: 40,00 €',
      'Überfällig',
    ]);
  });
  it('C2-3: nichts offen → nur der Status', () => {
    expect(buildInvoiceDetailHighlights({ ...base, status: 'bezahlt', openAmount: 0, statusText: 'Bezahlt' })).toEqual(['Bezahlt']);
  });
});

/* ------------------------------------------------------------------ */
/* C3                                                                   */
/* ------------------------------------------------------------------ */

describe('C3 — Ablagepfad: valides HTML, einmal vorgelesen', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  beforeEach(() => resetTestStores());
  afterEach(() => {
    if (root) act(() => root!.unmount());
    container?.remove();
    container = null;
    root = null;
    resetTestStores();
  });

  it('C3-1: <details> steht nicht in einem <p>, bleibt bedienbar, Pfad vorhanden', () => {
    const created = addDocument({
      title: 'Lieferschein Holz AG',
      category: 'sonstiges',
      issuer: 'Holz AG',
      recognizedText: 'Lieferschein',
      issueDate: '2026-08-01',
      classifiedKind: 'sonstiges',
      archived: true,
    });
    if (!created.success) throw new Error('Dokument nicht angelegt');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        createElement(
          MemoryRouter,
          null,
          createElement(AppProvider, { initialSetup: setupComplete }, createElement(DocumentFilingCard, { documentId: created.document.id })),
        ),
      );
    });

    const block = container.querySelector('[data-testid="document-filing-digital-path"]') as HTMLElement;
    expect(block).not.toBeNull();
    expect(block.tagName).toBe('DIV');
    expect(container.querySelector('p details')).toBeNull();

    const details = block.querySelector('details') as HTMLDetailsElement | null;
    if (created.document.digitalFolder.path) {
      expect(details).not.toBeNull();
      expect(details!.querySelector('code')?.textContent).toBe(created.document.digitalFolder.path);
      act(() => (details!.querySelector('summary') as HTMLElement).click());
      expect(details!.open).toBe(true);
    }

    // Der Name wird dem Screenreader nur einmal angeboten (sr-only mit Pfad), die sichtbare Kopie ist ausgeblendet.
    const visibleName = block.querySelector('.document-filing-card__digital-name') as HTMLElement;
    expect(visibleName.getAttribute('aria-hidden')).toBe('true');
    expect(block.querySelector('.sr-only')?.textContent).toContain(created.document.digitalFolder.name);
  });
});

/* ------------------------------------------------------------------ */
/* C4                                                                   */
/* ------------------------------------------------------------------ */

describe('C4 — Einstellungen in der Sie-Form', () => {
  it('C4-1: die vier Texte siezen', () => {
    expect(deDicts['settings.subtitle']).toBe('Verwalten Sie Ihren Betrieb, Ihre Rechnungen und OfficeTakt.');
    expect(deDicts['settings.documents.description']).toBe('Fußzeile und Hinweise auf Ihren Rechnungen');
    expect(deDicts['settings.operating.role.admin']).toBe(
      'Sie können Firmenprofil, Rechnungs-Vorbelegungen und Design für diesen Betrieb ändern.',
    );
    expect(deDicts['settings.operating.role.member']).toBe(
      'Mit Ihrem Benutzerkonto sehen Sie die Einstellungen; ändern können sie nur Administratoren.',
    );
  });
  it('C4-2: kein „du/dein" und keine Du-Imperative mehr in den deutschen Einstellungstexten', () => {
    expect(deDicts['settings.company.validationSummary']).toBe('Bitte prüfen Sie die markierten Felder.');
    expect(Object.values(deDicts).some((text) => /(^|\s)prüfe(\s|$)/i.test(text))).toBe(false);
    const duzen = Object.entries(deDicts).filter(([, text]) => /\b(du|dein|deine|deinen|deiner|dich|dir)\b/i.test(text));
    expect(duzen).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* C5                                                                   */
/* ------------------------------------------------------------------ */

describe('C5 — erkannte Beträge einheitlich, unsichere unverändert', () => {
  it('C5-1: sichere Euro-Beträge werden einheitlich mit €', () => {
    expect(formatRecognizedMoneyText('240,00 EUR')).toBe('240,00 €');
    expect(formatRecognizedMoneyText('5.000,00 EUR')).toBe('5.000,00 €');
    expect(formatRecognizedMoneyText('4.188,80 €')).toBe('4.188,80 €');
    expect(formatRecognizedMoneyText('70,51 €')).toBe('70,51 €');
    expect(formatRecognizedMoneyText('70,51 €')).toBe('70,51 €');
    expect(formatRecognizedMoneyText('EUR 1.234.567,8')).toBe('1.234.567,80 €');
    expect(formatRecognizedMoneyText('€ 12')).toBe('12,00 €');
    expect(formatRecognizedMoneyText('300 Euro')).toBe('300,00 €');
    expect(formatRecognizedMoneyText('5.000 EUR')).toBe('5.000,00 €');
  });
  it('C5-2: unsichere Werte bleiben Originaltext — keine falsche Zahl', () => {
    for (const raw of ['240,00', '240.00 EUR', '1,234.56 €', '12.34.56 €', 'ca. 500 €', '240,00 EUR zzgl. MwSt.', '240,005 €', 'siehe Anlage', '100 € + 50 €', '-40,00 €', '40 USD']) {
      expect(parseSafeEuroText(raw), raw).toBeNull();
      expect(formatRecognizedMoneyText(raw), raw).toBe(raw);
    }
  });
  it('C5-3: angewendet auf die Betrags-Angabe der Zusammenfassung, andere Angaben unberührt', () => {
    expect(formatSummaryFactValue('amount', '240,00 EUR')).toBe('240,00 €');
    expect(formatSummaryFactValue('orderValue', '5.000,00 EUR')).toBe('5.000,00 €');
    expect(formatSummaryFactValue('amount', 'ca. 500 €')).toBe('ca. 500 €');
    expect(formatSummaryFactValue('reference', '240,00 EUR')).toBe('240,00 EUR');
  });
  it('C5-4: der gespeicherte Erkennungswert bleibt, wie er war', () => {
    const recognized = { Betrag: '240,00 EUR' };
    formatSummaryFactValue('amount', recognized.Betrag);
    expect(recognized.Betrag).toBe('240,00 EUR');
  });
});

/* ------------------------------------------------------------------ */
/* C6                                                                   */
/* ------------------------------------------------------------------ */

describe('C6 — Heizungs-Komposita', () => {
  it('C6-1: Heizung, Heizungsmodernisierung, Heizungsanlage, Heizungsinstallation', () => {
    for (const text of ['Heizung', 'Heizungsmodernisierung Einfamilienhaus', 'Wartung Heizungsanlage', 'Heizungsinstallation im Neubau', 'Fußbodenheizung verlegen']) {
      expect(deriveGewerk({ vertragsgegenstand: text }), text).toBe('Sanitär');
    }
  });
  it('C6-2: bestehende Gewerke bleiben', () => {
    expect(deriveGewerk({ vertragsgegenstand: 'Flachdach Abdichtung mit PVC-Folie' })).toBe('Dachabdichtung');
    expect(deriveGewerk({ vertragsgegenstand: 'Trockenbau Gipskarton' })).toBe('Trockenbau');
    expect(deriveGewerk({ vertragsgegenstand: 'Elektroinstallation Unterverteilung' })).toBe('Elektro');
    expect(deriveGewerk({ vertragsgegenstand: 'Malerarbeiten Anstrich' })).toBe('Malerarbeiten');
    expect(deriveGewerk({ vertragsgegenstand: 'Fliesen im Bad' })).toBe('Fliesenarbeiten');
  });
  it('C6-3: fremde Begriffe werden nicht Heizung', () => {
    for (const text of ['Heizkostenabrechnung prüfen', 'Hebebühne mieten', 'Gerüst stellen']) {
      expect(deriveGewerk({ vertragsgegenstand: text }), text).toBeUndefined();
    }
  });
});

/* ------------------------------------------------------------------ */
/* C7                                                                   */
/* ------------------------------------------------------------------ */

describe('C7 — keine leere „Baustelle:"-Zeile', () => {
  beforeEach(() => {
    resetTestStores();
    resetCompanySessionForTests();
  });
  afterEach(() => {
    resetTestStores();
    resetCompanySessionForTests();
  });

  function seed(baustelle: string): void {
    hydrateVorgangStore([
      {
        ...createTestVorgang({
          id: 'v-c7',
          title: 'Heizungsmodernisierung',
          status: 'beauftragt',
          customer: 'Beispiel Bau GmbH',
          baustelle,
          orderPositions: [createOrderPosition({ id: 'op-1', unit: 'Stk', plannedQuantity: 1, unitPrice: 100 })],
        }),
        invoices: [],
      } as Vorgang,
    ]);
    recordVorgangContext('v-c7');
  }

  it('C7-1: ohne Baustelle keine Zeile', () => {
    seed('');
    for (const question of ['Wer ist der Kunde?', 'Rechnung jetzt erstellen']) {
      const bullets = tryResolveCompanyContextQuestion(question, getCompanySession())?.assistantAnswer.bullets ?? [];
      expect(bullets.some((b) => b.startsWith('Baustelle')), question).toBe(false);
      expect(bullets.some((b) => /:\s*$/.test(b)), question).toBe(false);
    }
  });

  it('C7-2: mit Baustelle wie bisher', () => {
    seed('Musterweg 1, 33602 Bielefeld');
    const bullets = tryResolveCompanyContextQuestion('Wer ist der Kunde?', getCompanySession())?.assistantAnswer.bullets ?? [];
    expect(bullets).toContain('Baustelle: Musterweg 1, 33602 Bielefeld');
  });
});

describe('C6 — Auftragsbezeichnung als letzter Rückfall', () => {
  function vorgangMit(title: string, positionDescription: string): Vorgang {
    return {
      ...createTestVorgang({
        id: 'v-c6',
        title,
        status: 'beauftragt',
        customer: 'Beispiel Bau GmbH',
        orderPositions: [createOrderPosition({ id: 'op-1', description: positionDescription, unit: 'Stk', plannedQuantity: 1, unitPrice: 100 })],
      }),
      invoices: [],
    } as Vorgang;
  }

  it('C6-4: Titel „…BielefeldHeizungsmodernisierung" (Abnahmefall) → Sanitär/Heizung', () => {
    expect(buildVorgangScopeView(vorgangMit('Bezeichnung: TESTBürogebäude BielefeldHeizungsmodernisierung', 'Testposition Skonto')).gewerk).toBe('Sanitär');
  });

  it('C6-5: Positionen gehen dem Titel vor; ohne Fachwort bleibt es unbestimmt', () => {
    expect(buildVorgangScopeView(vorgangMit('Heizungsmodernisierung', 'Gipskarton Trockenbauwand')).gewerk).toBe('Trockenbau');
    expect(buildVorgangScopeView(vorgangMit('TEST Einzelauftrag', 'Testposition Skonto')).gewerk).toBeUndefined();
  });
});

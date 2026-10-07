/**
 * CLOUD-DURABILITY-CORE-01E — die ruhige Auskunft „bleibt auf diesem Gerät".
 *
 * Nach 01B–01D reisen Notizen, Aufgaben und Mahnnachweise mit. Was weiterhin
 * nur auf einem Gerät liegt, darf nicht so aussehen, als läge es überall:
 * Dort stand ein kurzer Satz — zuletzt nur noch beim Wissen.
 *
 * CLOUD-SYNC S1 — der Haken für die Papierablage reist seitdem mit. Sein
 * Hinweis ist entfallen; Test 6 hält fest, dass er nicht zurückkommt.
 *
 * CLOUD-SYNC S2 — ebenso der Kommunikationsverlauf; Test 5 hält es fest.
 *
 * CLOUD-SYNC S3 — und das bestätigte Wissen. Damit ist kein Gerätehinweis
 * mehr übrig: Test 1 hält fest, dass keiner zurückkommt, Test 4, dass die
 * Wissensseite es nicht mehr behauptet, und Test 2, dass ihr verbliebener
 * Hinweis in Nutzersprache bleibt.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { CommunicationHistoryPanel } from './components/communication/CommunicationHistoryPanel';
import { DocumentFilingCard } from './components/documents/DocumentFilingCard';
import { WissenPage } from './pages/WissenPage';
import { DEFAULT_SETUP } from './data/mockData';
import { bg, bgLegacy, de, deLegacy, t, tr, trLegacy, type TranslationKey } from './i18n';
import { importInboxDocumentForTests } from './test/confirmFilingDecisionForTests';
import { createAuftragInboxItem } from './test/fixtures';
import { resetMemory } from './services/officePilotMemoryService';
import { hydrateDocumentStore } from './services/documentService';

/** Wörter, die in der Oberfläche eines Handwerksbetriebs nichts zu suchen haben. */
const JARGON = [
  'local-only',
  'Local-Only',
  'Sync',
  'sync',
  'Outbox',
  'Supabase',
  'Entity',
  'Cloud',
  'Durability',
];

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <AppProvider initialSetup={DEFAULT_SETUP}>{node}</AppProvider>
    </MemoryRouter>,
  );
}

describe('DEVICE-ONLY-TRANSPARENZ-01E — Texte', () => {
  it('1: kein Gerätehinweis ist übrig — in keiner der drei Sprachen (S3)', () => {
    for (const [name, woerter] of Object.entries({ de, deLegacy, tr, trLegacy, bg, bgLegacy })) {
      const uebrig = Object.keys(woerter).filter((key) => key.startsWith('deviceOnly.'));
      expect(uebrig, name).toEqual([]);
    }
  });

  it('2: der verbliebene Hinweis der Wissensseite bleibt in Nutzersprache', () => {
    const german = t('knowledge.page.hint', 'de');
    expect(german.length).toBeGreaterThan(0);
    expect(german).not.toContain('nur auf diesem Gerät');
    for (const word of JARGON) {
      expect(german, `knowledge.page.hint enthält "${word}"`).not.toContain(word);
    }
  });

  it('3: auch die neuen Sync-Bezeichnungen bleiben in Nutzersprache', () => {
    for (const key of ['sync.entity.vorgang_note', 'sync.entity.dunning_documentation'] as TranslationKey[]) {
      for (const lang of ['de', 'tr', 'bg'] as const) {
        const value = t(key, lang);
        expect(value.length, `${key}/${lang}`).toBeGreaterThan(0);
        expect(value, `${key}/${lang}`).not.toBe(key);
        expect(value).not.toContain('_');
      }
    }
  });
});

describe('DEVICE-ONLY-TRANSPARENZ-01E — Oberfläche', () => {
  it('4: die Wissensseite behauptet nicht mehr, nur auf diesem Gerät zu liegen (S3)', () => {
    const html = render(<WissenPage />);
    // Der bisherige Hinweis steht weiter da — nur der Gerätesatz ist entfallen.
    expect(html).toContain(t('knowledge.page.hint', 'de'));
    expect(html.match(/data-testid="inline-notice"/g) ?? []).toHaveLength(1);
    expect(html).not.toContain('nur auf diesem Gerät');
  });

  it('5: der Kommunikationsverlauf behauptet nicht mehr, nur auf diesem Gerät zu liegen (S2)', () => {
    const html = render(<CommunicationHistoryPanel contextRef={{ type: 'none' }} />);
    // Der Verlauf steht weiter da — nur der Gerätehinweis ist entfallen.
    expect(html).toContain('data-testid="communication-history"');
    expect(html).not.toContain('data-testid="communication-history-device-only"');
    expect(html).not.toContain('nur auf diesem Gerät');
  });

  it('6: der Papierablage-Haken behauptet nicht mehr, nur auf diesem Gerät zu liegen (S1)', () => {
    resetMemory();
    hydrateDocumentStore([]);
    const result = importInboxDocumentForTests(
      createAuftragInboxItem({
        id: 'inbox-01e-paper',
        title: 'Lieferschein – SanitärPartner',
      }),
      'Test GmbH',
    );
    expect(result.success).toBe(true);
    if (!result.success) return;

    const html = render(<DocumentFilingCard documentId={result.document.id} />);
    // Der Status steht weiter da — nur der Gerätehinweis ist entfallen.
    expect(html).toContain('data-testid="document-filing-paper-status"');
    expect(html).not.toContain('data-testid="document-filing-device-only"');
    expect(html).not.toContain('nur auf diesem Gerät');
  });
});

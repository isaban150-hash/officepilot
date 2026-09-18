/**
 * CLOUD-DURABILITY-CORE-01E — die ruhige Auskunft „bleibt auf diesem Gerät".
 *
 * Nach 01B–01D reisen Notizen, Aufgaben und Mahnnachweise mit. Was weiterhin
 * nur auf einem Gerät liegt, darf nicht so aussehen, als läge es überall:
 * Wissen, der Kommunikationsverlauf und der Haken für die Papierablage sind
 * Nutzerangaben, und genau dort steht jetzt ein kurzer Satz.
 *
 * Geprüft wird dreierlei: dass der Satz an der richtigen Stelle erscheint, dass
 * er in allen drei Sprachen existiert und sich unterscheidet, und dass er ohne
 * technischen Wortschatz auskommt.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { CommunicationHistoryPanel } from './components/communication/CommunicationHistoryPanel';
import { DocumentFilingCard } from './components/documents/DocumentFilingCard';
import { WissenPage } from './pages/WissenPage';
import { DEFAULT_SETUP } from './data/mockData';
import { t, type TranslationKey } from './i18n';
import { importInboxDocumentForTests } from './test/confirmFilingDecisionForTests';
import { createAuftragInboxItem } from './test/fixtures';
import { resetMemory } from './services/officePilotMemoryService';
import { hydrateDocumentStore } from './services/documentService';

const HINT_KEYS: TranslationKey[] = [
  'deviceOnly.knowledge',
  'deviceOnly.communicationHistory',
  'deviceOnly.paperFiling',
];

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
  it('1: jeder Hinweis existiert in Deutsch, Türkisch und Bulgarisch', () => {
    for (const key of HINT_KEYS) {
      for (const lang of ['de', 'tr', 'bg'] as const) {
        const value = t(key, lang);
        expect(value.length, `${key}/${lang}`).toBeGreaterThan(0);
        // Ein fehlender Eintrag gäbe den Schlüssel selbst zurück.
        expect(value, `${key}/${lang}`).not.toBe(key);
      }
      expect(t(key, 'tr')).not.toBe(t(key, 'de'));
      expect(t(key, 'bg')).not.toBe(t(key, 'de'));
    }
  });

  it('2: die Hinweise sprechen vom Gerät, nicht von Technik', () => {
    for (const key of HINT_KEYS) {
      const german = t(key, 'de');
      expect(german).toContain('nur auf diesem Gerät');
      for (const word of JARGON) {
        expect(german, `${key} enthält "${word}"`).not.toContain(word);
      }
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
  it('4: die Wissensseite sagt es im vorhandenen Hinweisfeld', () => {
    const html = render(<WissenPage />);
    expect(html).toContain(t('deviceOnly.knowledge', 'de'));
    // Kein zweites Hinweisfeld, keine neue Karte.
    expect(html.match(/data-testid="inline-notice"/g) ?? []).toHaveLength(1);
    // Der bisherige Hinweis bleibt erhalten.
    expect(html).toContain(t('knowledge.page.hint', 'de'));
  });

  it('5: der Kommunikationsverlauf sagt es einmal, nicht je Zeile', () => {
    const html = render(<CommunicationHistoryPanel contextRef={{ type: 'none' }} />);
    expect(html).toContain(t('deviceOnly.communicationHistory', 'de'));
    expect(html.match(/data-testid="communication-history-device-only"/g) ?? []).toHaveLength(1);
  });

  it('6: der Papierablage-Haken sagt es direkt beim Status', () => {
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
    expect(html).toContain('data-testid="document-filing-paper-status"');
    expect(html).toContain('data-testid="document-filing-device-only"');
    expect(html).toContain(t('deviceOnly.paperFiling', 'de'));
  });
});

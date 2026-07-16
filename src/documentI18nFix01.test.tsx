import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DocumentAssistantPanel } from './components/documents/DocumentAssistantPanel';
import { DocumentUploadErrorPanel } from './components/documents/DocumentUploadErrorPanel';
import { ScanPage } from './pages/ScanPage';
import { DEFAULT_SETUP } from './data/mockData';
import {
  assertCoreTranslations,
  bg,
  de,
  t,
  tr,
} from './i18n';
import { getLegalDisclaimer } from './i18n/resolveStoredText';
import { getTerminologyLabel } from './i18n/terminology';
import {
  answerInboxDocumentQuestion,
  isDraftReplyQuestion,
} from './services/documentAssistantQuestionService';
import { buildInboxDocumentAssistant } from './services/documentAssistantService';
import { formatPaperFilingInstruction } from './services/paperFolderService';
import { createMockInboxItemFromUpload } from './services/inboxUploadFactory';
import {
  applyStateToStores,
  createSeedState,
  getCachedSetup,
  loadPersistedState,
  savePersistedState,
} from './services/persistenceService';
import { resolveUploadErrorView } from './services/documentUploadErrorService';
import type { AppLanguage, InboxItem } from './types/models';

const GERMAN_CORE_MARKERS = [
  'Bitte prüfen',
  'Erneut versuchen',
  'Neues Foto',
  'Dokument hinzufügen',
  'Abheften',
  'Absender nicht eindeutig erkannt.',
  'Steuerberatung',
  'keine Rechts- oder Steuerberatung',
];

function createInboxItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return createMockInboxItemFromUpload({
    sourceFileName: 'bg-bau.pdf',
    recognizedText: 'BG BAU Beitragsbescheid 250 EUR Frist 30.03.2026',
    kind: 'bg_bau',
    ...overrides,
  });
}

function renderScanPage(lang: AppLanguage): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <AppProvider initialSetup={{ ...DEFAULT_SETUP, language: lang }}>
        <ScanPage />
      </AppProvider>
    </MemoryRouter>,
  );
}

describe('DOCUMENT-I18N-FIX-01', () => {
  it('core document paths have DE/TR/BG without empty values', () => {
    const missing = assertCoreTranslations({
      de: de as Record<string, string>,
      tr,
      bg,
      ro: {},
      ru: {},
    });
    expect(missing).toEqual([]);
  });

  it('scan core has no German fallback in TR', () => {
    expect(t('scan.title', 'tr')).not.toBe(t('scan.title', 'de'));
    expect(t('scan.camera', 'tr')).toMatch(/Kamera/i);
    expect(t('heute.scanButton', 'tr')).not.toMatch(/Foto \/ Scan/);
    expect(t('uploadKind.auftrag', 'tr')).not.toMatch(/^Auftrag$/);
  });

  it('scan core has no German fallback in BG', () => {
    expect(t('scan.title', 'bg')).toMatch(/[А-Яа-яЁё]/);
    expect(t('scan.gallery', 'bg')).toMatch(/[А-Яа-яЁё]/);
    expect(t('docAssistant.error.retry', 'bg')).not.toMatch(/Erneut versuchen/);
    expect(t('scan.ocr.partialHint', 'bg')).toMatch(/[А-Яа-яЁё]/);
  });

  it('DocumentAssistantPanel renders complete BG assistant sections', () => {
    const item = createInboxItem();
    const assistant = buildInboxDocumentAssistant(item, null, 'bg');
    const html = renderToStaticMarkup(
      <DocumentAssistantPanel
        item={item}
        workflow={null}
        translate={(key) => t(key, 'bg')}
        language="bg"
      />,
    );
    expect(html).toContain(t('docAssistant.section.brief', 'bg'));
    expect(html).toContain(t('docAssistant.section.filing', 'bg'));
    expect(html).toContain(t('docAssistant.section.original', 'bg'));
    expect(html).toContain(t(assistant.documentTypeLabelKey, 'bg'));
    expect(html).not.toMatch(/Erneut versuchen|Bitte prüfen Sie das Ergebnis/);
  });

  it('DocumentReview BG review core keys are localized', () => {
    expect(t('reviewWorkflow.hero.title', 'bg')).toMatch(/[А-Яа-яЁё]/);
    expect(t('reviewWorkflow.recommend.title', 'bg')).not.toBe(t('reviewWorkflow.recommend.title', 'de'));
    expect(t('reviewWorkflow.action.applySuggestion', 'bg')).toMatch(/[А-Яа-яЁё]/);
  });

  it('DocumentUploadErrorPanel BG is complete', () => {
    const view = resolveUploadErrorView('no_text');
    const html = renderToStaticMarkup(
      <DocumentUploadErrorPanel
        errorCode="no_text"
        translate={(key) => t(key, 'bg')}
        onRetry={() => undefined}
        onNewPhoto={() => undefined}
        onSelectFile={() => undefined}
      />,
    );
    expect(html).toContain(t(view.titleKey, 'bg'));
    expect(html).toContain(t('docAssistant.error.retry', 'bg'));
    expect(html).toContain(t('docAssistant.error.newPhoto', 'bg'));
    expect(html).toContain(t('docAssistant.error.selectFile', 'bg'));
    expect(html).not.toMatch(/Erneut versuchen/);
  });

  it('recognizes Bulgarian document questions', () => {
    const item = createInboxItem();
    const assistant = buildInboxDocumentAssistant(item, null, 'bg');
    const cases: Array<{ question: string; answerKey: string }> = [
      { question: 'Трябва ли да го платя?', answerKey: 'docAssistant.answer.payUncertain' },
      { question: 'Защо получих това писмо?', answerKey: 'docAssistant.answer.whyReceived' },
      { question: 'До кога трябва да отговоря?', answerKey: 'docAssistant.answer.deadlineKnown' },
      {
        question: 'Какво става, ако не направя нищо?',
        answerKey: assistant.inactionConsequence?.key ?? 'docAssistant.answer.ignoreNoRisk',
      },
      { question: 'Трябва ли да отиде при Steuerberater?', answerKey: assistant.steuerberaterReasonKey },
      { question: 'Къде да го архивирам?', answerKey: 'docAssistant.answer.filing' },
      { question: 'Мога ли да го изхвърля?', answerKey: 'docAssistant.answer.disposeKeep' },
    ];
    for (const entry of cases) {
      const answer = answerInboxDocumentQuestion(item, assistant, entry.question);
      expect(answer.answerKey).toBe(entry.answerKey);
    }
    expect(isDraftReplyQuestion('Напиши отговор')).toBe(true);
  });

  it('paper filing instruction is localized DE/TR/BG', () => {
    const rule = {
      folderId: 'paper-behoerden',
      register: 'Finanzamt',
      label: 'Behörden',
    };
    expect(formatPaperFilingInstruction(rule, 'de')).toContain('abheften');
    expect(formatPaperFilingInstruction(rule, 'tr')).toMatch(/dosyalayın|Defter/i);
    expect(formatPaperFilingInstruction(rule, 'bg')).toMatch(/[А-Яа-яЁё]/);
    expect(formatPaperFilingInstruction(rule, 'bg')).not.toContain('abheften');
  });

  it('legal disclaimer is localized DE/TR/BG', () => {
    expect(getLegalDisclaimer('de')).toContain('Steuerberatung');
    expect(getLegalDisclaimer('tr')).toMatch(/hukuki|vergi/i);
    expect(getLegalDisclaimer('bg')).toMatch(/[А-Яа-яЁё]/);
    expect(getLegalDisclaimer('tr')).not.toContain('keine Rechts- oder Steuerberatung');
  });

  it('terminology: Aufmaß = Обмер and Mahnung ≠ Zahlungserinnerung in BG', () => {
    expect(getTerminologyLabel('aufmasz', 'bg')).toContain('Обмер');
    expect(getTerminologyLabel('mahnung', 'bg')).not.toBe(getTerminologyLabel('zahlungserinnerung', 'bg'));
    expect(getTerminologyLabel('mahnung', 'bg')).toMatch(/писмо/i);
    expect(getTerminologyLabel('zahlungserinnerung', 'bg')).toMatch(/напомняне/i);
  });

  it('language TR/BG persists after reload', () => {
    for (const lang of ['tr', 'bg'] as const) {
      const seed = createSeedState({ ...DEFAULT_SETUP, language: lang, setupComplete: true });
      savePersistedState(seed);
      const reloaded = loadPersistedState();
      expect(reloaded?.setup.language).toBe(lang);
      applyStateToStores(reloaded!);
      expect(getCachedSetup().language).toBe(lang);
    }
  });

  it('scan page TR/BG markup avoids German core strings', () => {
    for (const lang of ['tr', 'bg'] as const) {
      const html = renderScanPage(lang);
      for (const marker of GERMAN_CORE_MARKERS) {
        expect(html).not.toContain(marker);
      }
      expect(t('scan.captureTitle', lang)).not.toBe(t('scan.captureTitle', 'de'));
    }
  });
});

import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CommunicationResultCard } from './CommunicationResultCard';
import { CommunicationChannelTabs } from './CommunicationChannelTabs';
import { CommunicationCopyButton } from './CommunicationCopyButton';
import { formatCommunicationDraftText } from './CommunicationDraftView';
import type { CommunicationResult } from '../../types/communication';
import type { TranslationKey } from '../../i18n';

function translate(key: TranslationKey): string {
  const de: Partial<Record<TranslationKey, string>> = {
    'communication.blocked.title': 'Nicht möglich',
    'communication.block.notRelevant': 'Kein Firmenbezug',
    'communication.unknown.title': 'Keine Informationen gefunden',
    'communication.unknown.summary': 'Unbekannte Anfrage',
    'communication.needsInfo.title': 'Weitere Angaben nötig',
    'communication.needsInfo.summary': 'Bitte ergänzen',
    'communication.missingForm.title': 'Noch ein paar Angaben',
    'communication.missingForm.submit': 'Entwurf erstellen',
    'communication.field.reason': 'Grund',
    'communication.prompt.reason': 'Warum?',
    'communication.qa.title': 'Antwort zum Dokument',
    'communication.qa.uncertain': 'Unsicher',
    'communication.draftReady.summary': 'Entwurf bereit',
    'communication.intent.delay_notice': 'Verzögerung',
    'communication.channel.label': 'Kanal',
    'communication.channel.email': 'E-Mail',
    'communication.channel.whatsapp': 'WhatsApp',
    'communication.channel.letter': 'Brief',
    'communication.draft.subject': 'Betreff',
    'communication.draft.basedOn': 'Basierend auf',
    'communication.draft.notIncluded': 'Nicht enthalten',
    'communication.copy': 'Kopieren',
    'communication.copied': 'Kopiert!',
  };
  return de[key] ?? key;
}

const sampleDraft = {
  intent: 'delay_notice' as const,
  channel: 'email' as const,
  subject: 'Verzögerung',
  greeting: 'Guten Tag,',
  body: 'Es verzögert sich wegen Material.',
  closing: 'Grüße',
  tone: 'neutral' as const,
  basedOnFacts: ['Material verzögert'],
  notIncluded: [],
};

const defaultAiProps = {
  aiConfigured: true,
  aiLoading: false,
  aiStyle: 'professional' as const,
  onAiStyleChange: () => undefined,
  onAiEnhance: () => undefined,
  aiEnhancedDraft: null,
  aiVariant: 'original' as const,
  onAiVariantChange: () => undefined,
  aiMessage: null,
};

describe('CommunicationResultCard', () => {
  it('renders blocked state', () => {
    const result: CommunicationResult = {
      mode: 'draft',
      intent: 'document_question',
      status: 'blocked',
      title: 'communication.blocked.title',
      summary: 'communication.block.notRelevant',
      disclaimer: 'Disclaimer',
    };
    const html = renderToStaticMarkup(
      <CommunicationResultCard
        result={result}
        channel="email"
        onChannelChange={() => undefined}
        missingValues={{}}
        onMissingChange={() => undefined}
        onMissingSubmit={() => undefined}
        translate={translate}
        {...defaultAiProps}
      />,
    );
    expect(html).toContain('data-testid="communication-blocked"');
    expect(html).toContain('Kein Firmenbezug');
  });

  it('renders no_data state', () => {
    const result: CommunicationResult = {
      mode: 'draft',
      intent: 'unknown',
      status: 'no_data',
      title: 'communication.unknown.title',
      summary: 'communication.unknown.summary',
      disclaimer: 'Disclaimer',
    };
    const html = renderToStaticMarkup(
      <CommunicationResultCard
        result={result}
        channel="email"
        onChannelChange={() => undefined}
        missingValues={{}}
        onMissingChange={() => undefined}
        onMissingSubmit={() => undefined}
        translate={translate}
        {...defaultAiProps}
      />,
    );
    expect(html).toContain('data-testid="communication-no-data"');
  });

  it('renders needs_info form', () => {
    const result: CommunicationResult = {
      mode: 'draft',
      intent: 'price_adjustment',
      status: 'needs_info',
      title: 'communication.needsInfo.title',
      summary: 'communication.needsInfo.summary',
      missingInfo: [
        {
          fieldId: 'reason',
          labelKey: 'communication.field.reason',
          promptKey: 'communication.prompt.reason',
          required: true,
          inputType: 'text',
        },
      ],
      disclaimer: 'Disclaimer',
    };
    const html = renderToStaticMarkup(
      <CommunicationResultCard
        result={result}
        channel="email"
        onChannelChange={() => undefined}
        missingValues={{}}
        onMissingChange={() => undefined}
        onMissingSubmit={() => undefined}
        translate={translate}
        {...defaultAiProps}
      />,
    );
    expect(html).toContain('data-testid="communication-needs-info"');
    expect(html).toContain('communication-field-reason');
  });
});

describe('CommunicationChannelTabs', () => {
  it('marks active channel', () => {
    const html = renderToStaticMarkup(
      <CommunicationChannelTabs channel="whatsapp" onChange={() => undefined} translate={translate} />,
    );
    expect(html).toContain('communication-channel-tab--active');
    expect(html).toContain('WhatsApp');
  });
});

describe('formatCommunicationDraftText', () => {
  it('is used by copy workflow', () => {
    const text = formatCommunicationDraftText(sampleDraft);
    expect(text).toContain('Es verzögert sich wegen Material.');
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn() } });
    renderToStaticMarkup(
      <CommunicationCopyButton text={text} label="Kopieren" copiedLabel="Kopiert!" />,
    );
  });
});

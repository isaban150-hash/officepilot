/**
 * UI-VALIDIERUNG-01 — Empty-State-Sichtbarkeit (Happy Path → WV-LV-01 Referenztest).
 * Nur Darstellung — keine neue Fachlogik.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Auftragskarte } from './components/inbox/review/Auftragskarte';
import { VorgangNachweisePanel } from './components/vorgang/VorgangNachweisePanel';
import { VorgangScopePanel } from './components/vorgang/VorgangScopePanel';
import { hydrateDocumentStore } from './services/documentService';
import { hydrateInboxStore } from './services/inboxService';
import { hydrateMemory, resetMemory } from './services/officePilotMemoryService';
import { hydrateVorgangStore } from './services/vorgangService';
import type { TranslationKey } from './i18n';
import type { DocumentSummary } from './types/documentSummary';
import type { Vorgang } from './types/models';

function translate(key: TranslationKey): string {
  const map: Partial<Record<TranslationKey, string>> = {
    'auftragskarte.title': 'Neuer Auftrag',
    'auftragskarte.field.ownRole': 'Ihre Rolle',
    'auftragskarte.field.summary': 'Kurz zusammengefasst',
    'auftragskarte.field.gewerk': 'Gewerk',
    'auftragskarte.field.hauptleistungen': 'Hauptleistungen',
    'auftragskarte.field.orderValue': 'Auftragswert',
    'auftragskarte.field.risks': 'Wichtige Hinweise',
    'auftragskarte.field.project': 'Bauvorhaben',
    'auftragskarte.action.accept': 'Auftrag annehmen',
    'auftragskarte.action.showScope': 'Leistungsumfang anzeigen',
    'auftragskarte.action.hideScope': 'Leistungsumfang ausblenden',
    'auftragskarte.gewerk.unknown': 'Gewerk konnte nicht bestimmt werden.',
    'auftragskarte.hauptleistungen.empty': 'Keine Hauptleistungen erkannt.',
    'documentExperience.details': 'Details',
    'documentExperience.alerts': 'Auffälligkeiten',
    'documentIntelligence.party.auftraggeber': 'Auftraggeber',
    'documentIntelligence.party.auftragnehmer': 'Auftragnehmer',
    'documentIntelligence.party.subunternehmer': 'Subunternehmer',
    'documentIntelligence.label.werkvertragMitLv': 'Werkvertrag mit LV',
    'vorgang.scope.title': 'Leistungsumfang',
    'vorgang.scope.gewerk': 'Gewerk',
    'vorgang.scope.hauptleistungen': 'Hauptleistungen',
    'vorgang.scope.gewerkUnknown': 'Gewerk konnte nicht bestimmt werden.',
    'vorgang.scope.hauptleistungenEmpty': 'Keine Hauptleistungen erkannt.',
    'vorgang.proofs.title': 'Nachweise',
    'vorgang.proofs.empty': 'Für diesen Auftrag wurden noch keine Nachweise erkannt.',
  };
  return map[key] ?? key;
}

describe('UI-VALIDIERUNG-01 – Empty-State-Sichtbarkeit', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
      length: 0,
    });
    resetMemory();
    hydrateMemory({
      documentMemories: [],
      proofMemories: [],
      relations: [],
      paperRegisterEntries: [],
    });
    hydrateDocumentStore([]);
    hydrateVorgangStore([]);
    hydrateInboxStore([]);
  });

  afterEach(() => {
    resetMemory();
    vi.unstubAllGlobals();
  });

  it('Auftragskarte: leere Gewerk/Hauptleistungen zeigen Hinweis statt zu verschwinden', () => {
    const summary: DocumentSummary = {
      id: 'summary:ui-val',
      sourceInboxItemId: 'ui-val',
      generatedAt: new Date(0).toISOString(),
      documentKind: 'werkvertrag',
      documentTypeLabelKey: 'documentIntelligence.label.werkvertragMitLv',
      family: 'contract',
      headline: 'Neuer Auftrag',
      facts: [
        {
          id: 'customer',
          labelKey: 'documentIntelligence.party.auftraggeber',
          value: 'Kunde',
        },
        {
          id: 'project',
          labelKey: 'auftragskarte.field.project',
          value: 'Projekt',
        },
        {
          id: 'gewerk',
          labelKey: 'auftragskarte.field.gewerk',
          value: 'Gewerk konnte nicht bestimmt werden.',
        },
      ],
      alerts: [],
      primaryAction: {
        id: 'accept_contract_order',
        labelKey: 'auftragskarte.action.accept',
        enabled: true,
      },
      secondaryActions: [],
      details: [
        {
          id: 'service',
          titleKey: 'auftragskarte.field.summary',
          proseText: 'Kurzfassung',
          rows: [
            {
              id: 'ownRole',
              labelKey: 'auftragskarte.field.ownRole',
              value: 'Subunternehmer',
            },
          ],
          listItems: [],
          listEmptyKey: 'auftragskarte.hauptleistungen.empty',
        },
      ],
      workspaceType: 'contract_order',
      hasDeepWorkspace: true,
    };

    const html = renderToStaticMarkup(
      createElement(Auftragskarte, {
        summary,
        translate,
        onAccept: () => undefined,
        scopeExpanded: false,
        onToggleScope: () => undefined,
      }),
    );

    expect(html).toContain('data-testid="document-experience-card"');
    expect(html).toContain('Gewerk konnte nicht bestimmt werden.');
    expect(html).toContain('data-testid="auftragskarte-hauptleistungen-empty"');
    expect(html).toContain('Keine Hauptleistungen erkannt.');
  });

  it('Vorgang: Nachweise und Scope bleiben bei leerem Zustand sichtbar', () => {
    const emptyVorgang = {
      id: 'v-empty-ui-val',
      recognizedData: {},
    } as Vorgang;

    const scopeHtml = renderToStaticMarkup(
      createElement(VorgangScopePanel, { vorgang: emptyVorgang, translate }),
    );
    expect(scopeHtml).toContain('data-testid="vorgang-scope"');
    expect(scopeHtml).toContain('Gewerk konnte nicht bestimmt werden.');
    expect(scopeHtml).toContain('Keine Hauptleistungen erkannt.');

    const proofsHtml = renderToStaticMarkup(
      createElement(VorgangNachweisePanel, { vorgangId: 'v-empty-ui-val', translate }),
    );
    expect(proofsHtml).toContain('data-testid="vorgang-nachweise"');
    expect(proofsHtml).toContain('data-testid="vorgang-nachweise-empty"');
    expect(proofsHtml).toContain('Für diesen Auftrag wurden noch keine Nachweise erkannt.');
  });
});

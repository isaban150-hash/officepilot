/**
 * FULLSUITE-BASELINE-11-REPAIR-01 — bestätigte Verknüpfung, Confirm-first und die
 * sichtbare Aussage bei genau einem Kandidaten.
 *
 * Verbindliche Regel: Eine bestätigte Verknüpfung liegt ausschließlich vor, wenn
 * isInboxLinkedToVorgang wahr ist (vorgangId gesetzt UND vorgangLinkStatus linked
 * oder created) und der Ziel-Vorgang existiert. known_link allein genügt nicht —
 * es entsteht bereits aus einem blossen vorgangId.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DocumentExperienceCard } from '../components/inbox/review/DocumentExperienceCard';
import { t, type TranslationKey } from '../i18n';
import { buildDocumentCaseMatch } from './documentCaseMatchService';
import { resolveConfirmedLinkCaseId } from './documentCaseMatchPresentation';
import { buildInboxDocumentSummary } from './documentSummary';
import { processUploadedDocument } from './intakeWorkflowService';
import { hydrateInboxStore } from './inboxService';
import { hydrateVorgangStore, isInboxLinkedToVorgang } from './vorgangService';
import { createAuftragInboxItem, createTestVorgang } from '../test/fixtures';
import { resetTestStores } from '../test/resetStores';

function translate(key: TranslationKey): string {
  return t(key, 'de');
}

function seedVorgang() {
  hydrateVorgangStore([
    createTestVorgang({
      id: 'v-confirmed',
      title: 'Sägewerk Ernst Flisch',
      customer: 'Ernst Flisch',
      baustelle: 'Werkstraße 1',
    }),
  ]);
}

const RECOGNIZED = {
  Auftraggeber: 'Ernst Flisch',
  Baustelle: 'Werkstraße 1',
  Bauvorhaben: 'Sägewerk Ernst Flisch',
};

describe('CONFIRMED-VORGANG-LINK-01 – open_vorgang haengt am bestaetigten Linkstatus', () => {
  beforeEach(() => resetTestStores());

  it('bestaetigt gespeicherte Verknuepfung zu vorhandenem Vorgang → open_vorgang', () => {
    seedVorgang();
    const item = createAuftragInboxItem({
      id: 'inbox-confirmed',
      classifiedKind: 'werkvertrag',
      vorgangId: 'v-confirmed',
      vorgangTitle: 'Sägewerk Ernst Flisch',
      vorgangLinkStatus: 'linked',
      recognizedData: RECOGNIZED,
    });

    expect(isInboxLinkedToVorgang(item)).toBe(true);
    expect(resolveConfirmedLinkCaseId(item)).toBe('v-confirmed');

    const summary = buildInboxDocumentSummary(item, { translate });
    expect(summary.primaryAction.id).toBe('open_vorgang');
    expect(summary.primaryAction.labelKey).toBe('documentExperience.action.openCase');
  });

  it('errechneter Exact-Treffer ohne bestaetigte Verknuepfung → link_vorgang', () => {
    seedVorgang();
    const item = createAuftragInboxItem({
      id: 'inbox-computed-exact',
      classifiedKind: 'werkvertrag',
      recognizedData: RECOGNIZED,
    });

    const match = buildDocumentCaseMatch(item);
    expect(match.matchStatus).toBe('exact');
    expect(match.reasons).not.toContain('known_link');
    expect(resolveConfirmedLinkCaseId(item)).toBeNull();

    const summary = buildInboxDocumentSummary(item, { translate });
    expect(summary.primaryAction.id).toBe('link_vorgang');
  });

  it('vorgangId ohne gueltigen Linkstatus → nicht open_vorgang, kein stiller No-op', () => {
    seedVorgang();
    const item = createAuftragInboxItem({
      id: 'inbox-legacy-halflinked',
      classifiedKind: 'werkvertrag',
      vorgangId: 'v-confirmed',
      recognizedData: RECOGNIZED,
    });

    // known_link entsteht trotzdem — genau deshalb darf es nicht als Beweis dienen.
    expect(buildDocumentCaseMatch(item).reasons).toContain('known_link');
    expect(isInboxLinkedToVorgang(item)).toBe(false);
    expect(resolveConfirmedLinkCaseId(item)).toBeNull();

    const summary = buildInboxDocumentSummary(item, { translate });
    expect(summary.primaryAction.id).not.toBe('open_vorgang');

    // Kein stiller No-op: der Altzustand bleibt über einen bestätigungspflichtigen
    // Linkpfad reparierbar.
    hydrateInboxStore([item]);
    const workflow = processUploadedDocument(item.id)!;
    const linkAction = workflow.nextActions.find((action) => action.id === 'link_vorgang');
    expect(linkAction, 'Reparaturpfad link_vorgang fehlt').toBeTruthy();
    expect(linkAction!.enabled).toBe(true);
  });

  it('bestaetigte Verknuepfung auf geloeschten Vorgang → kein open_vorgang', () => {
    hydrateVorgangStore([]);
    const item = createAuftragInboxItem({
      id: 'inbox-dangling',
      classifiedKind: 'werkvertrag',
      vorgangId: 'v-weg',
      vorgangTitle: 'Weg',
      vorgangLinkStatus: 'linked',
      recognizedData: RECOGNIZED,
    });

    expect(isInboxLinkedToVorgang(item)).toBe(true);
    expect(resolveConfirmedLinkCaseId(item)).toBeNull();
    expect(buildInboxDocumentSummary(item, { translate }).primaryAction.id).not.toBe(
      'open_vorgang',
    );
  });
});

describe('CONFIRMED-VORGANG-LINK-01 – Kandidatenzahl in der Ueberschrift', () => {
  beforeEach(() => resetTestStores());

  function renderCardFor(vorgaenge: Parameters<typeof hydrateVorgangStore>[0]) {
    hydrateVorgangStore(vorgaenge);
    const item = createAuftragInboxItem({
      id: 'inbox-cand',
      classifiedKind: 'eingangsrechnung',
      documentType: 'eingangsrechnung',
      recognizedData: {
        Auftraggeber: 'Isobautec GmbH',
        Lieferant: 'Baumarkt GmbH',
        Rechnungsnummer: 'RE-1',
      },
    });
    const summary = buildInboxDocumentSummary(item, { translate });
    const html = renderToStaticMarkup(
      createElement(DocumentExperienceCard, { summary, translate, onAction: () => undefined }),
    );
    return { summary, html };
  }

  it('genau ein Kandidat → keine Aussage ueber mehrere Vorgaenge', () => {
    const { summary, html } = renderCardFor([
      createTestVorgang({
        id: 'v-one',
        title: 'Auftrag A',
        customer: 'Isobautec GmbH',
        baustelle: 'Andere Straße 9',
      }),
    ]);

    expect(summary.caseMatch?.matchStatus).toBe('multiple');
    expect(summary.caseMatch?.candidates).toHaveLength(1);
    expect(html).not.toContain('Mehrere passende Vorgänge');
    expect(html).toContain('Vorgang prüfen');
    // Confirm-first bleibt unverändert.
    expect(summary.primaryAction.id).toBe('select_vorgang');
  });

  it('mehrere Kandidaten → bisherige Mehrzahl-Ueberschrift', () => {
    const { summary, html } = renderCardFor([
      createTestVorgang({
        id: 'v-one',
        title: 'Auftrag A',
        customer: 'Isobautec GmbH',
        baustelle: 'Andere Straße 9',
      }),
      createTestVorgang({
        id: 'v-two',
        title: 'Auftrag B',
        customer: 'Isobautec GmbH',
        baustelle: 'Dritte Straße 3',
      }),
    ]);

    expect(summary.caseMatch?.matchStatus).toBe('multiple');
    expect(summary.caseMatch!.candidates.length).toBeGreaterThan(1);
    expect(html).toContain('Mehrere passende Vorgänge');
    expect(summary.primaryAction.id).toBe('select_vorgang');
  });
});

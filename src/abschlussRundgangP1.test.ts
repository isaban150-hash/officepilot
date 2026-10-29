/**
 * P1 A-04/A-02 — Abschluss-Rundgang (SCHWARZ, 26./27.10.2026): Gezielte Tests zu den Befunden der praktischen
 * Browserprüfung. Jeder Test nennt seinen Befund (R-xx, Bericht `pruefunterlagen/p1-korrektur-a04-a02/abschluss/`).
 * Reine Dienste und Texte; die Oberflächenteile (CSS, Seitenlayout, E-Mail-Versand) sind im Browser nachgeprüft.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { t } from './i18n';
import type { TranslationKey } from './i18n';
import { validateSetupStep } from './services/setupValidationService';
import { resolveResumableManualStep, hasCompleteManualDetails } from './services/invoice/manualInvoiceFlow';
import { buildPendingSummary } from './services/pendingEngineService';
import { buildExpenseInputFromInbox } from './services/officeActionService';
import { inlineActionLabel } from './components/documents/DocumentFilingDecisionPanel';
import { buildDocumentLeadText } from './services/documentLeadText';
import { createDefaultSetupWizardDraft } from './types/setup';
import { resetTestStores } from './test/resetStores';
import type { InboxItem, InvoiceDraft, PendingItem } from './types/models';
import type { DocumentSummary } from './types/documentSummary';

afterEach(() => {
  resetTestStores();
});

const de = (key: string) => t(key as TranslationKey, 'de');

describe('R-02 — Einrichtungsassistent prüft die USt-IdNr. wie die Firmendaten', () => {
  const draft = (vatId: string) => ({ ...createDefaultSetupWizardDraft(), taxNumber: '19/123/45678', vatId });

  it('weist eine unplausible USt-IdNr. ab, wenn das Feld bearbeitet wird (formatChecks strict)', () => {
    const result = validateSetupStep('tax', draft('DE12'), { formatChecks: 'strict' });
    expect(result.valid).toBe(false);
    expect(result.errors.vatId).toBe('companyProfile.format.vatId');
  });

  it('nimmt eine plausible USt-IdNr. und ein leeres Feld an', () => {
    expect(validateSetupStep('tax', draft('DE123456789'), { formatChecks: 'strict' }).valid).toBe(true);
    expect(validateSetupStep('tax', draft(''), { formatChecks: 'strict' }).valid).toBe(true);
  });

  it('blockiert ohne Formatprüfung (andere Seiten mit Altbestand) weiterhin nicht', () => {
    expect(validateSetupStep('tax', draft('DE12')).valid).toBe(true);
  });
});

describe('R-03 — Wiederaufnahme einer manuellen Rechnung landet nicht in der Vorschau, wenn der Leistungszeitraum fehlt', () => {
  const entwurf = (extra: Partial<InvoiceDraft> = {}) =>
    ({
      customerId: 'cust-1',
      customerBilling: { name: 'Nordlicht Handel KG' },
      positions: [{ id: 'p1', description: 'Montage', quantity: 8, unit: 'Stunden', unitPrice: 65.5 }],
      servicePeriodFrom: '',
      servicePeriodTo: '',
      ...extra,
    }) as unknown as InvoiceDraft;

  it('ohne bestätigten Leistungszeitraum: „details“ statt „review“', () => {
    const step = resolveResumableManualStep({ requested: null, draft: entwurf(), taxDecisionSettled: true, finalizationLocked: false });
    expect(step).toBe('details');
  });

  it('mit bestätigtem, gültigem Leistungszeitraum: weiter „review“', () => {
    const fertig = entwurf({ servicePeriodFrom: '2026-10-19', servicePeriodTo: '2026-10-23', servicePeriodConfirmed: true });
    expect(hasCompleteManualDetails(fertig)).toBe(true);
    expect(resolveResumableManualStep({ requested: null, draft: fertig, taxDecisionSettled: true, finalizationLocked: false })).toBe('review');
  });

  it('ein ausdrücklicher Wunsch aus der Adresse (?step=review) bleibt erlaubt; ein gesperrter Entwurf bleibt in der Vorschau', () => {
    expect(resolveResumableManualStep({ requested: 'review', draft: entwurf(), taxDecisionSettled: true, finalizationLocked: false })).toBe('review');
    expect(resolveResumableManualStep({ requested: null, draft: entwurf(), taxDecisionSettled: true, finalizationLocked: true })).toBe('review');
  });

  it('unvollständig: umgekehrter Zeitraum oder unbestätigt', () => {
    expect(hasCompleteManualDetails({ servicePeriodFrom: '2026-10-23', servicePeriodTo: '2026-10-19', servicePeriodConfirmed: true })).toBe(false);
    expect(hasCompleteManualDetails({ servicePeriodFrom: '2026-10-19', servicePeriodTo: '2026-10-23', servicePeriodConfirmed: false })).toBe(false);
  });
});

describe('R-06 — die umgestellten Texte siezen', () => {
  const KEYS = [
    'mobile.home.greeting', 'mobile.home.assistantTitle', 'mobile.home.assistantPlaceholder', 'mobile.add.pageSubtitle',
    'heute.action.askOfficePilot', 'docAssistant.section.actions', 'docAssistant.section.inaction', 'docGuidance.q.why',
    'docGuidance.q.act', 'docGuidance.q.reply', 'docGuidance.q.retain', 'docGuidance.q.actions', 'invoice.companyDrift.message',
    'uiSession.continue.title',
  ];
  it.each(KEYS)('%s ohne Du-Form', (key) => {
    const text = de(key);
    expect(text).not.toMatch(/\b(du|Du|dein|Dein|deine|Deine|Frag|Prüfe bitte|Wähle)\b/);
  });
});

describe('R-11 — Zähler mit richtiger Einzahl', () => {
  const eintrag = (id: string, kind: PendingItem['kind']): PendingItem => ({ id, kind, title: id, priority: 'normal', route: '/', sourceType: 'inbox' });

  it('1 neues Dokument / 2 neue Dokumente', () => {
    const eins = buildPendingSummary([eintrag('a', 'inbox_new')], '2026-10-27').highlights.find((h) => h.id === 'new-inbox');
    expect(eins?.labelKey).toBe('pending.highlight.newInboxOne');
    expect(de('pending.highlight.newInboxOne')).toBe('1 neues Dokument');
    const zwei = buildPendingSummary([eintrag('a', 'inbox_new'), eintrag('b', 'inbox_new')], '2026-10-27').highlights.find((h) => h.id === 'new-inbox');
    expect(zwei?.labelKey).toBe('pending.highlight.newInbox');
  });

  it('1 teilbezahlte Rechnung / 1 Rechnung bald fällig', () => {
    const summary = buildPendingSummary([
      { ...eintrag('p', 'invoice_partial'), sourceType: 'invoice' },
      { ...eintrag('s', 'invoice_due_soon'), sourceType: 'invoice' },
    ], '2026-10-27');
    expect(summary.highlights.find((h) => h.id === 'partial-invoices')?.labelKey).toBe('pending.highlight.partialInvoiceOne');
    expect(summary.highlights.find((h) => h.id === 'due-soon-invoices')?.labelKey).toBe('pending.highlight.dueSoonInvoiceOne');
    expect(de('pending.highlight.partialInvoiceOne')).toBe('1 teilbezahlte Rechnung');
  });

  it('Kundenliste: „1 Auftrag“ und „0 Aufträge“ statt „Auftrag/Aufträge“', () => {
    expect(de('kunden.meta.orderOne')).toBe('1 Auftrag');
    expect(de('kunden.meta.orders').replace('{count}', '0')).toBe('0 Aufträge');
    expect(de('heute.openInboxDescOne')).toBe('1 neues Dokument');
    expect(de('desk.priority.newDocumentOne')).toBe('1 neues Dokument wartet.');
  });
});

describe('R-12 — „Gerade erfasst:“ wird kein Belegtitel', () => {
  it('die Ausgabe aus dem Eingang heißt wie die Eingangsrechnung', () => {
    const item = {
      id: 'inbox-r12',
      title: 'Gerade erfasst: Eingangsrechnung – Elektro Hansen GmbH',
      sender: 'Elektro Hansen GmbH',
      recognizedData: { Betrag: '499,80' },
      classifiedKind: 'eingangsrechnung',
    } as unknown as InboxItem;
    expect(buildExpenseInputFromInbox(item, 'eingangsrechnung').title).toBe('Eingangsrechnung – Elektro Hansen GmbH');
  });

  it('ein Titel ohne Präfix bleibt unverändert', () => {
    const item = { id: 'inbox-r12b', title: 'Tankbeleg', sender: 'ARAL', recognizedData: {}, classifiedKind: 'tankbeleg' } as unknown as InboxItem;
    expect(buildExpenseInputFromInbox(item, 'tankbeleg').title).toBe('Tankbeleg');
  });
});

describe('R-17 — Aktion mitten im Satz', () => {
  it.each([
    ['Ausgabe erfassen', 'Ausgabe erfassen'],
    ['Aufgabe anlegen', 'Aufgabe anlegen'],
    ['Als Ausgabe speichern', 'als Ausgabe speichern'],
    ['Passendem Vorgang zuordnen', 'passendem Vorgang zuordnen'],
    ['Speichern', 'speichern'],
  ])('%s → %s', (label, erwartet) => {
    expect(inlineActionLabel(label)).toBe(erwartet);
  });
});

describe('R-18 — der Platzhalter-Absender ist kein „erkannter Absender“', () => {
  const summary = (sender: string): DocumentSummary =>
    ({
      family: 'generic',
      facts: [{ id: 'sender', label: 'Absender', value: sender }],
    }) as unknown as DocumentSummary;

  it('kein Satz „Erkannter Absender: Absender nicht eindeutig erkannt..“', () => {
    const text = buildDocumentLeadText(summary(de('common.unknownSender')), de);
    expect(text).not.toContain('Erkannter Absender');
    expect(text).not.toContain('..');
  });

  it('ein echter Absender mit Schlusspunkt endet mit genau einem Punkt', () => {
    const text = buildDocumentLeadText(summary('Müller e.K.'), de);
    expect(text).toContain('Erkannter Absender: Müller e.K.');
    expect(text).not.toContain('e.K..');
  });
});

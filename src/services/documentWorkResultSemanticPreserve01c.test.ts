/**
 * DOKUMENTVERSTAENDNIS-01C — der semantische Kern überlebt die erneute Analyse.
 *
 * Der belegte Fehler: Beim Öffnen eines gespeicherten Eingangsposten läuft die
 * Analyse erneut. Sie arbeitet auf dem gespeicherten Posten, und der trägt
 * seinen Volltext nicht mehr — ihr Ergebnis hat deshalb keinen Kern. Weil die
 * frische Projektion bisher vollständig gewann, überschrieb das leere Ergebnis
 * den beim Hochladen berechneten Kern, und die Bedeutung eines Schreibens war
 * nach dem ersten Wiederöffnen verschwunden.
 *
 * Geprüft wird genau diese Übergabe — nicht der Kern selbst, der in 01B
 * abgesichert ist.
 *
 * Neutrale Beispieldaten.
 */
import { describe, expect, it } from 'vitest';
import { mergeDocumentWorkResultOnReanalysis } from './documentWorkResultMergeService';
import { DOCUMENT_WORK_RESULT_SCHEMA_VERSION } from '../types/documentWorkResult';
import type { DocumentWorkResult } from '../types/documentWorkResult';
import type { BusinessInterpretationResult } from '../types/businessInterpretation';
import type { DocumentSemanticCore } from '../types/documentSemanticCore';
import { emptyDocumentSemanticCore } from '../types/documentSemanticCore';

const KERN: DocumentSemanticCore = {
  ...emptyDocumentSemanticCore(),
  subject: { value: 'Maengelanzeige - Gewerbepark Senne', certainty: 'detected' },
  deadlines: [
    { date: '2026-09-22', type: 'response_due', appliesTo: 'Antwort', actionRequired: true, certainty: 'detected' },
  ],
};

function interpretation(semantic?: DocumentSemanticCore): BusinessInterpretationResult {
  return {
    readOnly: true,
    sourceDocument: {
      sourceDocumentId: 'inbox-1',
      classifiedKind: 'sonstiges',
      classificationConfidence: 'low',
      recognitionUncertain: true,
    },
    meaning: {
      eventType: 'review_required',
      certainty: 'uncertain',
      summary: 'Bitte prüfen.',
      alternativeEventTypes: [],
    },
    operational: {
      primaryCase: 'review_required',
      meanings: ['review'],
      nextStep: 'Bitte prüfen.',
      confirmRequirement: 'Ablage bestätigen.',
      certainty: 'uncertain',
    },
    vorgangRef: { status: 'unknown' } as BusinessInterpretationResult['vorgangRef'],
    parties: [],
    effects: [],
    missingInformation: [],
    conflicts: [],
    requiredConfirmations: [],
    nextActionCandidates: [],
    facts: {} as BusinessInterpretationResult['facts'],
    ...(semantic ? { semantic } : {}),
    derivedFrom: {
      hasContractIntelligence: false,
      hasContractOrderProposal: false,
      hasClassification: true,
      hasDocumentUnderstanding: false,
      companyRelevant: true,
    },
  };
}

function stand(
  overrides: Partial<DocumentWorkResult> = {},
): DocumentWorkResult {
  return {
    schemaVersion: DOCUMENT_WORK_RESULT_SCHEMA_VERSION,
    inboxItemId: 'inbox-1',
    workspaceId: 'ws-1',
    analyzedAt: '2026-09-19T10:00:00.000Z',
    analysisVersion: 'v1',
    sourceFingerprint: 'hash:abc',
    businessInterpretation: interpretation(),
    specialistRefs: {} as DocumentWorkResult['specialistRefs'],
    overlay: [],
    ...overrides,
  };
}

describe('01C — der gespeicherte Kern überlebt eine erneute Analyse', () => {
  it('zieht den Kern nach, wenn die neue Auswertung keinen hat', () => {
    const vorher = stand({ businessInterpretation: interpretation(KERN) });
    const neu = stand({ businessInterpretation: interpretation() });

    const ergebnis = mergeDocumentWorkResultOnReanalysis(vorher, neu);

    expect(ergebnis.businessInterpretation?.semantic).toEqual(KERN);
    /* Alles Übrige bleibt die jüngere Auswertung. */
    expect(ergebnis.businessInterpretation?.meaning.summary).toBe('Bitte prüfen.');
  });

  it('lässt einen eigenen neuen Kern unangetastet', () => {
    const neuerKern: DocumentSemanticCore = {
      ...emptyDocumentSemanticCore(),
      subject: { value: 'Neuer Betreff', certainty: 'detected' },
    };
    const ergebnis = mergeDocumentWorkResultOnReanalysis(
      stand({ businessInterpretation: interpretation(KERN) }),
      stand({ businessInterpretation: interpretation(neuerKern) }),
    );

    expect(ergebnis.businessInterpretation?.semantic?.subject?.value).toBe('Neuer Betreff');
  });

  it('lässt den alten Kern fallen, wenn sich der Quelltext geändert hat', () => {
    /*
     * Ein anderer Fingerabdruck heisst anderer Inhalt. Die alte Bedeutung
     * gehört dann zu einem anderen Schreiben und darf nicht weiterleben.
     */
    const ergebnis = mergeDocumentWorkResultOnReanalysis(
      stand({ businessInterpretation: interpretation(KERN), sourceFingerprint: 'hash:alt' }),
      stand({ businessInterpretation: interpretation(), sourceFingerprint: 'hash:neu' }),
    );

    expect(ergebnis.businessInterpretation?.semantic).toBeUndefined();
  });

  it('kommt mit einem alten Stand ohne Kern zurecht', () => {
    const ergebnis = mergeDocumentWorkResultOnReanalysis(
      stand({ businessInterpretation: interpretation() }),
      stand({ businessInterpretation: interpretation() }),
    );

    expect(ergebnis.businessInterpretation).not.toBeNull();
    expect(ergebnis.businessInterpretation?.semantic).toBeUndefined();
  });

  it('kommt mit einer neuen Auswertung ganz ohne Interpretation zurecht', () => {
    const ergebnis = mergeDocumentWorkResultOnReanalysis(
      stand({ businessInterpretation: interpretation(KERN) }),
      stand({ businessInterpretation: null }),
    );

    expect(ergebnis.businessInterpretation).toBeNull();
  });

  it('lässt die bisherigen Zusagen der Zusammenführung unberührt', () => {
    const ergebnis = mergeDocumentWorkResultOnReanalysis(
      stand({ businessInterpretation: interpretation(KERN), workspaceId: 'ws-1' }),
      stand({ businessInterpretation: interpretation(), workspaceId: null }),
    );

    /* Arbeitsbereichsbindung und Überlagerung verhalten sich wie zuvor. */
    expect(ergebnis.workspaceId).toBe('ws-1');
    expect(ergebnis.overlay).toEqual([]);
  });
});

/**
 * DOKUMENT-ASSISTENT-01H2 — Prüfung nach Art der Behauptung.
 *
 * Die Tests sind nach dem sichtbaren Schaden geordnet, nicht nach den
 * Funktionen: Zuerst die Sätze, die bisher zu Unrecht vernichtet wurden, dann
 * die, die weiterhin nicht stehen bleiben dürfen, dann die Kette bis zur
 * Oberfläche.
 *
 * Alle Steuer- und Rechtsbeispiele sind **Prüfsätze**, keine Auskunft: Sie
 * zeigen, wie die Schranke urteilt, und behaupten nichts über deutsches Recht.
 */
import { describe, expect, it, afterEach } from 'vitest';
import {
  classifyLegalClaim,
  reviewAiAnswerText,
  reviewLegalClaims,
  splitIntoClaimSegments,
} from './legalClaimGuard';
import { validateAiOutput } from './aiOutputGuardService';
import { runAiRequest, setAiGenerateTextForTests } from './aiRequestRunner';

afterEach(() => setAiGenerateTextForTests(null));

describe('A–F — die drei Behauptungsklassen', () => {
  it('A: eine Dokumenttatsache mit „müssen" ist keine Rechtsaussage', () => {
    expect(
      classifyLegalClaim(
        'Laut Schreiben müssen Sie die Mängel bis zum 30.09.2026 beseitigen.',
      ),
    ).toBe('general_information');
  });

  it('B: „Das ist keine Rechtsberatung" bleibt stehen — genau daran scheiterte es bisher', () => {
    expect(classifyLegalClaim('Das ist keine Rechtsberatung.')).toBe('general_information');
  });

  it('C: „Diese Auskunft ist nicht rechtsverbindlich" ist ein Vorbehalt, keine Zusage', () => {
    expect(classifyLegalClaim('Diese Auskunft ist nicht rechtsverbindlich.')).toBe(
      'general_information',
    );
  });

  it('D: eine Entscheidung über den Einzelfall ohne Vorbehalt fällt', () => {
    expect(classifyLegalClaim('Sie können diese Kosten steuerlich absetzen.')).toBe(
      'binding_individual_decision',
    );
  });

  it('E: dieselbe Sache mit Vorbehalt bleibt', () => {
    expect(
      classifyLegalClaim(
        'Ob Sie diese Kosten steuerlich absetzen können, hängt vom Einzelfall ab.',
      ),
    ).toBe('uncertain_individual');
  });

  it('F: die angemasste Beraterrolle fällt immer', () => {
    expect(classifyLegalClaim('Ich berate Sie steuerlich zu diesem Vorgang.')).toBe(
      'binding_individual_decision',
    );
    expect(classifyLegalClaim('Als Ihr Rechtsanwalt rate ich zum Widerspruch.')).toBe(
      'binding_individual_decision',
    );
  });
});

describe('G–I — ein Wort vernichtet keine Antwort mehr', () => {
  it('G: einzelne Wörter blockieren für sich genommen nichts', () => {
    for (const satz of [
      'Für steuerliche Fragen ist das Finanzamt zuständig.',
      'Die Rechtslage dazu steht nicht im Dokument.',
      'Das Gesetz nennt dafür keine feste Frist im Schreiben.',
      'Eine Mängelanzeige hat üblicherweise rechtliche Folgen.',
    ]) {
      expect(classifyLegalClaim(satz), satz).not.toBe('binding_individual_decision');
    }
  });

  it('H: nur der beanstandete Satz entfällt, der Rest bleibt erhalten', () => {
    const antwort =
      'Das Schreiben nennt eine Frist bis zum 30.09.2026. Sie können diese Kosten steuerlich absetzen. Für steuerliche Fragen ist das Finanzamt zuständig.';
    const pruefung = reviewLegalClaims(antwort);

    expect(pruefung.findings).toHaveLength(1);
    expect(pruefung.safeText).toContain('30.09.2026');
    expect(pruefung.safeText).toContain('Finanzamt zuständig');
    expect(pruefung.safeText).not.toContain('absetzen');
  });

  it('I: bleibt nichts Brauchbares übrig, fällt die Antwort ganz — fail-closed', () => {
    const pruefung = reviewLegalClaims('Sie können diese Kosten steuerlich absetzen.');
    expect(pruefung.safeText).toBeNull();
  });
});

describe('J–K — Zerlegung', () => {
  it('J: ein Datum zerreisst keinen Satz', () => {
    const segmente = splitIntoClaimSegments(
      'Die Bescheinigung gilt vom 01.09.2026 bis zum 31.08.2029. Danach ist sie zu erneuern.',
    );
    expect(segmente).toHaveLength(2);
    expect(segmente[0]).toContain('31.08.2029');
  });

  it('J2: eine Abkürzung zerschneidet keinen Satz — sonst entstehen Löcher im Text', () => {
    const satz =
      'Für spezifische steuerliche Fragen, z. B. Beratung, ist das Finanzamt zuständig.';
    expect(splitIntoClaimSegments(satz)).toHaveLength(1);
    expect(reviewLegalClaims(satz).safeText).toBe(satz);
  });

  it('K: unbeanstandeter Text bleibt Zeichen für Zeichen unverändert', () => {
    const text = 'Das Dokument ist eine Freistellungsbescheinigung. Es nennt keine Frist.';
    expect(reviewLegalClaims(text).safeText).toBe(text);
  });
});

describe('L–M — Modellantworten im JSON-Format', () => {
  it('L: im JSON entfällt der Satz, die Antwort bleibt lesbar', () => {
    const roh = JSON.stringify({
      directAnswer: 'Das Schreiben nennt keine Frist gegenüber dem Finanzamt.',
      explanation:
        'Die Bescheinigung ist Ihren Auftraggebern vorzulegen. Sie können diese Kosten steuerlich absetzen.',
    });
    const pruefung = reviewAiAnswerText(roh);

    expect(pruefung.findings).toHaveLength(1);
    const geprueft = JSON.parse(pruefung.safeText ?? '{}') as Record<string, string>;
    expect(geprueft.directAnswer).toContain('keine Frist');
    expect(geprueft.explanation).toContain('vorzulegen');
    expect(geprueft.explanation).not.toContain('absetzen');
  });

  it('M: fällt die Kernantwort weg, rückt die geprüfte Begründung nach — keine leeren Klammern', () => {
    const roh = JSON.stringify({
      directAnswer: 'Sie können diese Kosten steuerlich absetzen.',
      explanation:
        'Ob das zutrifft, hängt vom Einzelfall ab. Zuständig ist dafür das Finanzamt.',
    });
    const geprueft = JSON.parse(reviewAiAnswerText(roh).safeText ?? '{}') as Record<
      string,
      string
    >;

    expect(geprueft.directAnswer).toContain('Einzelfall');
    expect(geprueft.directAnswer).not.toContain('absetzen');
  });
});

describe('N–P — die Kette bis zur Oberfläche', () => {
  it('N: der Guard meldet den geprüften Text und verwirft die Antwort nicht mehr', () => {
    const ergebnis = validateAiOutput(
      'Das Schreiben nennt eine Frist. Sie können diese Kosten steuerlich absetzen. Zuständig ist das Finanzamt.',
      'qa',
    );

    expect(ergebnis.valid).toBe(true);
    expect(ergebnis.safeText).toBeDefined();
    expect(ergebnis.safeText).not.toContain('absetzen');
  });

  it('O: nur der geprüfte Text verlässt den Runner', async () => {
    setAiGenerateTextForTests(async () => ({
      success: true,
      text: 'Das Schreiben nennt eine Frist bis zum 30.09.2026. Sie können diese Kosten steuerlich absetzen.',
    }));

    const ergebnis = await runAiRequest({
      operation: 'document_question',
      prompt: 'Frage',
      guardProfile: 'qa',
    });

    expect(ergebnis.success).toBe(true);
    expect(ergebnis.text).toContain('30.09.2026');
    expect(ergebnis.text).not.toContain('absetzen');
  });

  it('P: bleibt nichts übrig, kommt keine technische Meldung zurück', async () => {
    setAiGenerateTextForTests(async () => ({
      success: true,
      text: 'Sie können diese Kosten steuerlich absetzen.',
    }));

    const ergebnis = await runAiRequest({
      operation: 'document_question',
      prompt: 'Frage',
      guardProfile: 'qa',
    });

    expect(ergebnis.success).toBe(false);
    expect(ergebnis.errorCode).toBe('guard_rejected');
    expect(ergebnis.message).toBeUndefined();
  });
});

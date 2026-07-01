import { describe, expect, it } from 'vitest';
import { validateEnhancedCommunicationText } from './communicationAiGuardService';

const baseInput = {
  originalText: 'Der Preis wird auf 120,00 € angepasst. Termin: 15.07.2026.',
  allowedSourceText: '120,00 €\n15.07.2026\nGrund: Materialengpass',
};

describe('communicationAiGuardService', () => {
  it('akzeptiert eine gültige Verbesserung', () => {
    const result = validateEnhancedCommunicationText({
      ...baseInput,
      enhancedText: 'Wir passen den Preis auf 120,00 € an. Der Termin bleibt am 15.07.2026.',
    });

    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('blockiert neuen Geldbetrag', () => {
    const result = validateEnhancedCommunicationText({
      ...baseInput,
      enhancedText: 'Der neue Preis beträgt 250,00 €.',
    });

    expect(result.valid).toBe(false);
    expect(result.warnings.some((warning) => warning.includes('Geldbetrag'))).toBe(true);
  });

  it('blockiert neues Datum', () => {
    const result = validateEnhancedCommunicationText({
      ...baseInput,
      enhancedText: 'Wir melden uns am 20.08.2026 zurück.',
    });

    expect(result.valid).toBe(false);
    expect(result.warnings.some((warning) => warning.includes('Datumsangabe'))).toBe(true);
  });

  it('blockiert Rechts-/Steuerberatung', () => {
    const result = validateEnhancedCommunicationText({
      ...baseInput,
      enhancedText: 'Das ist steuerlich absetzbar und rechtsverbindlich.',
    });

    expect(result.valid).toBe(false);
    expect(result.warnings[0]).toContain('Rechts-/Steuerformulierung');
  });

  it('blockiert leere KI-Antwort', () => {
    const result = validateEnhancedCommunicationText({
      ...baseInput,
      enhancedText: '   ',
    });

    expect(result.valid).toBe(false);
    expect(result.warnings[0]).toContain('Leere');
  });
});

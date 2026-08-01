/**
 * REFERENZVERTRAG V1 – SPRINT C — Gewerk & Hauptleistungen.
 * Happy-Path UI/Accept → REFERENCE WV-LV-01; hier Determinismus/Dedupe.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveHauptleistungen } from './contractScopeDerivationService';
import { resetMemory, hydrateMemory } from './officePilotMemoryService';

describe('REFERENZVERTRAG V1 – SPRINT C – Gewerk & Hauptleistungen', () => {
  beforeEach(() => {
    resetMemory();
    hydrateMemory({
      documentMemories: [],
      proofMemories: [],
      relations: [],
      paperRegisterEntries: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('bildet Hauptleistungen deterministisch und ohne Duplikate', () => {
    const descriptions = [
      'PE-Folie verlegen',
      'Dämmung verlegen',
      'PVC-Folie 1,5 mm verlegen',
      'Traufanschluss',
      'Attikaanschluss',
      'Lichtkuppel eindichten',
      'Randdämmung',
      'Gefälledämmung',
      'Anschlussblech',
      'Dachdurchführung',
      'Kleinmaterial und Hilfsmittel',
      'PE-Folie verlegen',
    ];
    const labels = deriveHauptleistungen(descriptions);
    expect(labels).toEqual([
      'PE-Folie',
      'Wärmedämmung',
      'PVC-Dachfolie',
      'Traufanschlüsse',
      'Attikaanschlüsse',
      'Lichtkuppeln',
      'Randdämmung',
      'Gefälledämmung',
      'Anschlussbleche',
      'Dachdurchführungen',
    ]);
    expect(labels.filter((label) => label === 'PE-Folie')).toHaveLength(1);
    expect(labels).not.toContain('Kleinmaterial und Hilfsmittel');
  });
});

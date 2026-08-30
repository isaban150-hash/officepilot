/**
 * SECURITY-GEMINI-KEY-01B — jede Fachkette meldet ihre Operation.
 *
 * Der Server erlaubt Operationen, keine beliebigen Anfragen. Wenn eine Kette
 * die falsche Operation angibt, greifen Modellwahl, Größengrenze und Zählklasse
 * am falschen Ort — deshalb wird die Zuordnung hier festgehalten.
 *
 * Geprüft wird am Quelltext, weil die fünf Ketten sehr unterschiedliche
 * Eingaben brauchen und ein Durchlauf durch alle fünf mehr über die Fixtures
 * als über die Verdrahtung aussagen würde.
 */
import { describe, expect, it } from 'vitest';
import documentAiSource from '../document/documentAiService.ts?raw';
import documentFactAiSource from '../document/documentFactAiService.ts?raw';
import communicationAiSource from '../communication/communicationAiService.ts?raw';
import brainSource from '../officePilotBrainService.ts?raw';
import vorgangAiSource from '../vorgang/vorgangAiService.ts?raw';
import { AI_OPERATIONS } from '../../../supabase/functions/_shared/aiContract';

const WIRING: Array<[string, string, string]> = [
  ['documentAiService', documentAiSource, 'document_question'],
  ['documentFactAiService', documentFactAiSource, 'document_facts'],
  ['communicationAiService', communicationAiSource, 'communication_draft'],
  ['officePilotBrainService', brainSource, 'assistant'],
  ['vorgangAiService', vorgangAiSource, 'vorgang_question'],
];

describe('SECURITY-GEMINI-KEY-01B: Operationszuordnung', () => {
  it('jede der fünf Ketten gibt genau ihre Operation an', () => {
    for (const [name, source, operation] of WIRING) {
      expect(source, name).toContain(`operation: '${operation}'`);

      // Und keine fremde Operation.
      for (const other of AI_OPERATIONS) {
        if (other === operation) continue;
        expect(source, `${name} darf ${other} nicht verwenden`).not.toContain(
          `operation: '${other}'`,
        );
      }
    }
  });

  it('die Zuordnung deckt genau die fünf Serveroperationen ab', () => {
    expect(WIRING.map(([, , operation]) => operation).sort()).toEqual([...AI_OPERATIONS].sort());
  });

  it('keine Fachkette baut ihren eigenen Providerzugang', () => {
    for (const [name, source] of WIRING) {
      expect(source, name).not.toContain('generativelanguage');
      expect(source, name).not.toContain('GEMINI_API_KEY');
      expect(source, name).not.toContain('gemini-2.5');
      // Der Weg führt über den zentralen Trichter.
      expect(source, name).toContain('runAiRequest');
    }
  });
});

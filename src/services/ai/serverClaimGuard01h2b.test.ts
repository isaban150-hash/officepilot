/**
 * DOKUMENT-ASSISTENT-01H2B — die Schranke auf dem Serverweg.
 *
 * Diese Tests prüfen **nicht** die Clientfunktion, sondern genau das Modul,
 * das die Edge Function ausführt:
 * `supabase/functions/_shared/legalClaimCore.ts`. Es ist Deno-frei und
 * importfrei, deshalb läuft hier dieselbe Datei, die dort läuft — nach
 * demselben Muster, mit dem `aiContract` schon geprüft wird.
 *
 * Damit ist die Frage beantwortet, um die es in diesem Block geht: Kommt ein
 * unmittelbarer Aufruf des Endpunkts an der Grenze vorbei?
 *
 * Alle Beispielsätze sind Prüfsätze. Sie zeigen, wie die Schranke urteilt,
 * und behaupten nichts über deutsches Recht.
 */
import { describe, expect, it } from 'vitest';
import {
  guardAiAnswerText,
  isServerClaimGuardedOperation,
  NEUTRAL_CLAIM_FALLBACK_TEXT,
  SERVER_CLAIM_GUARDED_OPERATIONS,
} from '../../../supabase/functions/_shared/legalClaimCore';
import * as clientGuard from './legalClaimGuard';
import * as serverCore from '../../../supabase/functions/_shared/legalClaimCore';
import { AI_OPERATIONS } from '../../../supabase/functions/_shared/aiContract';
import { validateAiOutput } from './aiOutputGuardService';

/** Beanstandet der Serverkern diesen Satz? */
function beanstandet(text: string): boolean {
  return guardAiAnswerText(text).removed > 0;
}

describe('A–H — der direkte Serverweg', () => {
  it('A: ein Haftungsausschluss passiert — das Wort allein blockiert nicht', () => {
    expect(beanstandet('Dies ist keine Rechtsberatung.')).toBe(false);
  });

  it('B: eine offene Unsicherheit passiert', () => {
    expect(
      beanstandet(
        'Allgemein lässt sich das aus den vorliegenden Informationen nicht sicher beurteilen.',
      ),
    ).toBe(false);
  });

  it('C: eine verbindliche Rechtsentscheidung wird beanstandet', () => {
    expect(beanstandet('Sie müssen die Mängel rechtlich anerkennen.')).toBe(true);
  });

  it('D: eine Zulässigkeitszusage wird beanstandet', () => {
    expect(beanstandet('Die 5.000 EUR dürfen rechtmäßig einbehalten werden.')).toBe(true);
  });

  it('E: eine verbindliche Steuerentscheidung wird beanstandet', () => {
    expect(beanstandet('Diese Kosten können Sie definitiv steuerlich absetzen.')).toBe(true);
  });

  it('F: eine Erfolgszusage wird beanstandet', () => {
    expect(beanstandet('Der Antrag wird genehmigt.')).toBe(true);
  });

  it('G: ein Dokumentfakt passiert', () => {
    expect(beanstandet('Im Dokument wird eine Antwort bis zum 22.09.2026 verlangt.')).toBe(
      false,
    );
  });

  it('H: ein Einbehalt als Dokumentfakt passiert', () => {
    expect(beanstandet('Der Absender nennt einen Einbehalt von 5.000 EUR.')).toBe(false);
  });
});

describe('Fail-closed und Antwortschema', () => {
  it('die beanstandete Aussage verlässt den Server nicht', () => {
    const ergebnis = guardAiAnswerText('Der Antrag wird genehmigt.');
    expect(ergebnis.text).not.toContain('genehmigt');
    expect(ergebnis.replaced).toBe(true);
    expect(ergebnis.text).toBe(NEUTRAL_CLAIM_FALLBACK_TEXT);
  });

  it('bleibt Sicheres übrig, wird nur der eine Satz entfernt', () => {
    const ergebnis = guardAiAnswerText(
      'Im Dokument wird eine Antwort bis zum 22.09.2026 verlangt. Der Antrag wird genehmigt.',
    );
    expect(ergebnis.replaced).toBe(false);
    expect(ergebnis.text).toContain('22.09.2026');
    expect(ergebnis.text).not.toContain('genehmigt');
  });

  it('der Ersatztext besteht die eigene Prüfung — sonst wäre er eine Falle', () => {
    expect(beanstandet(NEUTRAL_CLAIM_FALLBACK_TEXT)).toBe(false);
  });

  it('es kommt immer ein nicht leerer Text zurück, das API-Schema bleibt gültig', () => {
    for (const probe of [
      'Der Antrag wird genehmigt.',
      'Dies ist keine Rechtsberatung.',
      'Sie müssen die Mängel rechtlich anerkennen.',
    ]) {
      const { text } = guardAiAnswerText(probe);
      expect(typeof text).toBe('string');
      expect(text.trim().length).toBeGreaterThan(0);
      /* So, wie die Funktion antwortet: { ok: true, text }. */
      expect(() => JSON.parse(JSON.stringify({ ok: true, text }))).not.toThrow();
    }
  });
});

describe('Scope und gemeinsame Regel', () => {
  it('geprüft werden die drei Freitext-Ketten, nicht alle fünf', () => {
    expect([...SERVER_CLAIM_GUARDED_OPERATIONS].sort()).toEqual([
      'assistant',
      'document_question',
      'vorgang_question',
    ]);
    expect(isServerClaimGuardedOperation('document_question')).toBe(true);
    expect(isServerClaimGuardedOperation('document_facts')).toBe(false);
    expect(isServerClaimGuardedOperation('communication_draft')).toBe(false);
  });

  it('jede geprüfte Operation ist eine echte Operation des Serververtrags', () => {
    for (const operation of SERVER_CLAIM_GUARDED_OPERATIONS) {
      expect(AI_OPERATIONS as readonly string[]).toContain(operation);
    }
  });

  it('Client und Server verwenden dieselbe Funktion, nicht zwei gleich aussehende', () => {
    expect(clientGuard.classifyLegalClaim).toBe(serverCore.classifyLegalClaim);
    expect(clientGuard.reviewAiAnswerText).toBe(serverCore.reviewAiAnswerText);
    expect(clientGuard.guardAiAnswerText).toBe(serverCore.guardAiAnswerText);
  });

  it('die Clientprüfung bleibt aktiv — Defense in Depth, kein Ersatz', () => {
    const ergebnis = validateAiOutput(
      'Im Dokument steht eine Frist. Der Antrag wird genehmigt.',
      'qa',
    );
    expect(ergebnis.safeText).toBeDefined();
    expect(ergebnis.safeText).not.toContain('genehmigt');
  });
});

describe('Kein Fachwissen in diesem Block', () => {
  it('der Serverkern kennt weder Wissensbestand noch Quellen', () => {
    const quelle = serverCore as unknown as Record<string, unknown>;
    for (const name of Object.keys(quelle)) {
      expect(name).not.toMatch(/knowledge|Knowledge|source|Source/);
    }
  });
});

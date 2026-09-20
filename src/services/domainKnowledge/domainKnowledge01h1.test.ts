/**
 * DOKUMENT-ASSISTENT-01H1 — Quelle, Gültigkeit und Prüfstand.
 *
 * Dieser Block hat bewusst keine Oberfläche: Er legt fest, wie alt eine
 * fachliche Aussage sein darf, bevor die erste davon einen Benutzer erreicht.
 * Geprüft wird deshalb ausschliesslich die Zeit- und Belegbarkeitslogik.
 *
 * **Alle zeitkritischen Fälle sind Vorlagen.** Sie modellieren Steuer- und
 * Behördenwissen, ohne eine fachliche Behauptung aufzustellen: Der Text ist
 * erkennbar erfunden, die Quelle ebenso. Das ist der Punkt — die Architektur
 * soll sich beweisen lassen, ohne dass dabei ungeprüfte Fachaussagen in den
 * Bestand geraten.
 *
 * Der Stichtag wird immer übergeben; kein Ergebnis hängt an der Uhr.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateKnowledgeFreshness,
  maxReviewAgeDays,
  resolveKnowledgeUsage,
} from './knowledgeFreshnessPolicy';
import { findKnowledgeStatements, type KnowledgeStock } from './domainKnowledgeRetrieval';
import {
  DOMAIN_KNOWLEDGE_REGISTRY_VERSION,
  DOMAIN_KNOWLEDGE_SOURCES,
  DOMAIN_KNOWLEDGE_STATEMENTS,
} from './domainKnowledgeRegistry';
import type { KnowledgeSource, KnowledgeStatement } from '../../types/domainKnowledge';

const STICHTAG = '2026-09-19';

/* ---------------- Vorlagen — frei erfunden, keine Fachaussage ------------- */

const QUELLE_AMT: KnowledgeSource = {
  id: 'src-fixture-amt',
  title: 'Musteramt — Beispielmerkblatt (Vorlage)',
  publisher: 'Musteramt',
  identifier: 'fixture://musteramt/merkblatt',
  kind: 'authority_publication',
  trust: 'official_guidance',
  jurisdiction: { country: 'DE' },
};

const QUELLE_LAND: KnowledgeSource = {
  id: 'src-fixture-land',
  title: 'Musterland — Beispielregelung (Vorlage)',
  publisher: 'Musterland',
  kind: 'authority_publication',
  trust: 'official_guidance',
  jurisdiction: { country: 'DE', region: 'Musterland' },
};

const QUELLE_UNEINGEORDNET = {
  id: 'src-fixture-unklar',
  title: 'Unbekannte Herkunft (Vorlage)',
  publisher: '(unklar)',
  kind: 'internal_curated',
  /* Eine Vertrauensstufe, die es nicht gibt — so verhält sich ein Pflegefehler. */
  trust: 'blog_or_forum' as unknown as KnowledgeSource['trust'],
  jurisdiction: { country: 'DE' },
} as KnowledgeSource;

function aussage(overrides: Partial<KnowledgeStatement> = {}): KnowledgeStatement {
  return {
    id: 'stmt-fixture',
    topic: 'beispielregel',
    topicClass: 'tax_rule',
    statement: 'Beispielhafte Regel ohne fachliche Aussage (Vorlage).',
    sourceId: QUELLE_AMT.id,
    validFrom: '2026-01-01',
    reviewedAt: '2026-08-01',
    ...overrides,
  };
}

const BESTAND = (
  statements: KnowledgeStatement[],
  sources: KnowledgeSource[] = [QUELLE_AMT, QUELLE_LAND],
): KnowledgeStock => ({ statements, sources });

const pruefe = (s: KnowledgeStatement, q: KnowledgeSource | undefined = QUELLE_AMT) =>
  evaluateKnowledgeFreshness(s, q, STICHTAG);

/* ------------------------------ A – E ------------------------------------ */

describe('01H1 — der Zustand einer Aussage', () => {
  it('A: gültig und frisch geprüft ergibt „current"', () => {
    const ergebnis = pruefe(aussage({ reviewedAt: '2026-09-01' }));
    expect(ergebnis.freshness).toBe('current');
    expect(ergebnis.usableAsCurrent).toBe(true);
  });

  it('B: eine erst künftig geltende Regel ergibt „future"', () => {
    const ergebnis = pruefe(aussage({ validFrom: '2027-01-01', reviewedAt: '2026-09-01' }));
    expect(ergebnis.freshness).toBe('future');
    expect(ergebnis.reason).toContain('2027-01-01');
  });

  it('C: eine abgelaufene Regel ergibt „expired"', () => {
    const ergebnis = pruefe(
      aussage({ validUntil: '2026-06-30', reviewedAt: '2026-09-01' }),
    );
    expect(ergebnis.freshness).toBe('expired');
    expect(ergebnis.reason).toContain('2026-06-30');
  });

  it('D: ein zu alter Prüfstand ergibt „stale"', () => {
    /* Steuerregeln gelten nur 180 Tage als geprüft. */
    const ergebnis = pruefe(aussage({ reviewedAt: '2025-01-01' }));
    expect(ergebnis.freshness).toBe('stale');
    expect(ergebnis.reviewAgeDays).toBeGreaterThan(maxReviewAgeDays('tax_rule'));
  });

  it('E: eine nicht eingeordnete Quelle ergibt „unverified"', () => {
    const ergebnis = evaluateKnowledgeFreshness(
      aussage({ sourceId: QUELLE_UNEINGEORDNET.id }),
      QUELLE_UNEINGEORDNET,
      STICHTAG,
    );
    expect(ergebnis.freshness).toBe('unverified');
    expect(ergebnis.usableAsCurrent).toBe(false);
  });

  it('E2: ohne Quelle ist eine Aussage nicht belegt', () => {
    /* Direkt aufgerufen: Ein Standardwert würde ein `undefined` hier ersetzen. */
    expect(evaluateKnowledgeFreshness(aussage(), undefined, STICHTAG).freshness).toBe('unverified');
  });

  it('die Reihenfolge steht fest: unbelegt schlägt alles andere', () => {
    /* Künftig **und** unbelegt — die Belegbarkeit entscheidet zuerst. */
    const ergebnis = evaluateKnowledgeFreshness(
      aussage({ validFrom: '2027-01-01' }),
      QUELLE_UNEINGEORDNET,
      STICHTAG,
    );
    expect(ergebnis.freshness).toBe('unverified');
  });

  it('die Reihenfolge steht fest: künftig schlägt einen alten Prüfstand', () => {
    const ergebnis = pruefe(aussage({ validFrom: '2027-01-01', reviewedAt: '2024-01-01' }));
    expect(ergebnis.freshness).toBe('future');
  });
});

/* ------------------------------ F – J ------------------------------------ */

describe('01H1 — was verwendet werden darf', () => {
  const faelle: Array<[string, KnowledgeStatement, boolean]> = [
    ['F: künftig', aussage({ validFrom: '2027-01-01', reviewedAt: '2026-09-01' }), false],
    ['G: abgelaufen', aussage({ validUntil: '2026-06-30', reviewedAt: '2026-09-01' }), false],
    ['H: zu alt geprüft', aussage({ reviewedAt: '2024-01-01' }), false],
    ['J: gültig und frisch', aussage({ reviewedAt: '2026-09-01' }), true],
  ];

  for (const [name, statement, verwendbar] of faelle) {
    it(`${name} → ${verwendbar ? 'verwendbar' : 'nicht als aktuell verwendbar'}`, () => {
      const ergebnis = findKnowledgeStatements(
        { topic: 'beispielregel', asOf: STICHTAG },
        BESTAND([statement]),
      );
      expect(ergebnis.all).toHaveLength(1);
      expect(ergebnis.usable).toHaveLength(verwendbar ? 1 : 0);
    });
  }

  it('I: eine nicht eingeordnete Quelle wird nie verwendet', () => {
    const ergebnis = findKnowledgeStatements(
      { topic: 'beispielregel', asOf: STICHTAG },
      BESTAND([aussage({ sourceId: QUELLE_UNEINGEORDNET.id })], [QUELLE_UNEINGEORDNET]),
    );
    expect(ergebnis.all[0].freshness.freshness).toBe('unverified');
    expect(ergebnis.usable).toHaveLength(0);
  });

  it('die Verwendungsregel steht an einer Stelle', () => {
    expect(resolveKnowledgeUsage('current')).toBe('use_as_current');
    expect(resolveKnowledgeUsage('future')).toBe('mention_as_future');
    expect(resolveKnowledgeUsage('expired')).toBe('mention_with_caveat');
    expect(resolveKnowledgeUsage('stale')).toBe('mention_with_caveat');
    expect(resolveKnowledgeUsage('unverified')).toBe('do_not_use');
  });

  it('eine Aussage, deren Quelle fehlt, verschwindet nicht stillschweigend', () => {
    const ergebnis = findKnowledgeStatements(
      { topic: 'beispielregel', asOf: STICHTAG },
      BESTAND([aussage({ sourceId: 'gibt-es-nicht' })]),
    );
    expect(ergebnis.all).toHaveLength(1);
    expect(ergebnis.all[0].freshness.freshness).toBe('unverified');
    expect(ergebnis.usable).toHaveLength(0);
  });
});

/* ------------------------------ K – N ------------------------------------ */

describe('01H1 — Abfrage', () => {
  it('K: der Stichtag bestimmt das Ergebnis, nicht die Uhr', () => {
    const regel = aussage({ validFrom: '2026-10-01', reviewedAt: '2026-09-01' });

    expect(evaluateKnowledgeFreshness(regel, QUELLE_AMT, '2026-09-19').freshness).toBe('future');
    expect(evaluateKnowledgeFreshness(regel, QUELLE_AMT, '2026-10-01').freshness).toBe('current');
    expect(evaluateKnowledgeFreshness(regel, QUELLE_AMT, '2026-12-01').freshness).toBe('current');
  });

  it('K2: am Tag des Ablaufs gilt die Regel noch', () => {
    const regel = aussage({ validUntil: '2026-09-19', reviewedAt: '2026-09-01' });
    expect(evaluateKnowledgeFreshness(regel, QUELLE_AMT, '2026-09-19').freshness).toBe('current');
    expect(evaluateKnowledgeFreshness(regel, QUELLE_AMT, '2026-09-20').freshness).toBe('expired');
  });

  it('L: die Rechtsordnung filtert', () => {
    const bundesweit = aussage({ id: 'a', sourceId: QUELLE_AMT.id, reviewedAt: '2026-09-01' });
    const land = aussage({ id: 'b', sourceId: QUELLE_LAND.id, reviewedAt: '2026-09-01' });
    const bestand = BESTAND([bundesweit, land]);

    /* Bundesweit gilt überall; eine Landesregelung nur in ihrem Land. */
    const imLand = findKnowledgeStatements(
      { topic: 'beispielregel', jurisdiction: { country: 'DE', region: 'Musterland' }, asOf: STICHTAG },
      bestand,
    );
    expect(imLand.all.map((t) => t.statement.id).sort()).toEqual(['a', 'b']);

    const anderesLand = findKnowledgeStatements(
      { topic: 'beispielregel', jurisdiction: { country: 'DE', region: 'Anderland' }, asOf: STICHTAG },
      bestand,
    );
    expect(anderesLand.all.map((t) => t.statement.id)).toEqual(['a']);

    const anderesLandKomplett = findKnowledgeStatements(
      { topic: 'beispielregel', jurisdiction: { country: 'AT' }, asOf: STICHTAG },
      bestand,
    );
    expect(anderesLandKomplett.all).toHaveLength(0);
  });

  it('M: das Thema filtert, auch über Aliasse', () => {
    const treffer = findKnowledgeStatements({ topic: 'abschlag', asOf: STICHTAG });
    expect(treffer.all).toHaveLength(1);
    expect(treffer.all[0].statement.topic).toBe('abschlagsrechnung');

    expect(findKnowledgeStatements({ topic: 'gewährleistung', asOf: STICHTAG }).all).toHaveLength(1);
    expect(findKnowledgeStatements({ topic: 'gibt-es-nicht', asOf: STICHTAG }).all).toHaveLength(0);
  });

  it('N: Quelle und Aussage bleiben getrennte Objekte', () => {
    const treffer = findKnowledgeStatements({ topic: 'abnahme', asOf: STICHTAG }).all[0];

    expect(treffer.statement.sourceId).toBe(treffer.source.id);
    expect(treffer.statement).not.toHaveProperty('publisher');
    expect(treffer.source).not.toHaveProperty('statement');
    /* Mehrere Aussagen teilen sich dieselbe Quelle — das ist der Zweck der Trennung. */
    const alle = findKnowledgeStatements({ asOf: STICHTAG }).all;
    expect(alle.length).toBeGreaterThan(new Set(alle.map((t) => t.source.id)).size);
  });
});

/* ------------------------------ O – P ------------------------------------ */

describe('01H1 — Bestand und Abgrenzung', () => {
  it('P: der Bestand trägt einen Stand', () => {
    expect(DOMAIN_KNOWLEDGE_REGISTRY_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
  });

  it('O: der produktive Bestand enthält nur belegte, eingeordnete Quellen', () => {
    for (const quelle of DOMAIN_KNOWLEDGE_SOURCES) {
      expect(['official_primary', 'official_guidance', 'professional_body', 'curated_secondary'])
        .toContain(quelle.trust);
      expect(quelle.publisher.trim().length).toBeGreaterThan(0);
    }
  });

  it('O2: eine Adresse gibt es nur dort, wo es wirklich eine gibt', () => {
    /*
     * 01H1 trug nur den eigenen Begriffsbestand, und der hat keine Netzadresse
     * — eine zu erfinden wäre die Unehrlichkeit gewesen, die dieses Modell
     * verhindern soll. Seit 01H3 stehen amtliche Quellen daneben, und die
     * haben eine echte, geprüfte Adresse. Die Zusage ist dieselbe geblieben:
     * keine erfundene URL. Sie lautet nur nicht mehr „gar keine".
     */
    for (const quelle of DOMAIN_KNOWLEDGE_SOURCES) {
      if (quelle.kind === 'internal_curated') {
        expect(quelle.url, quelle.id).toBeUndefined();
        continue;
      }
      expect(quelle.url?.startsWith('https://'), quelle.id).toBe(true);
    }
  });

  it('O3: am Stichtag von 01H1 gilt genau der Bestand von 01H1', () => {
    /*
     * Ein schöner Beweis der Zeitregel: Die amtlichen Aussagen aus 01H3 gehören
     * dem Bestand erst ab dem 20.09.2026 an. Fragt man einen Tag davor, sind
     * sie „künftig" — und kein Abruf behandelt sie als geltendes Recht.
     */
    const treffer = findKnowledgeStatements({ asOf: STICHTAG });
    expect(treffer.all).toHaveLength(DOMAIN_KNOWLEDGE_STATEMENTS.length);
    const definitionen = DOMAIN_KNOWLEDGE_STATEMENTS.filter(
      (statement) => statement.topicClass === 'stable_definition',
    );
    expect(treffer.usable).toHaveLength(definitionen.length);
  });

  it('O3b: einen Tag später sind auch die amtlichen Aussagen belegt und verwendbar', () => {
    const treffer = findKnowledgeStatements({ asOf: '2026-09-20' });
    expect(treffer.usable).toHaveLength(DOMAIN_KNOWLEDGE_STATEMENTS.length);
  });

  it('O4: Fachwissen und betriebliches Gedächtnis bleiben getrennt', () => {
    /*
     * `KnowledgeFact` ist das Gedächtnis eines Arbeitsbereichs und wird
     * synchronisiert. Eine Fachaussage gehört niemandem und darf weder
     * `scope` noch `sync` kennen — sonst wäre die Trennung nur eine Absicht.
     */
    for (const statement of DOMAIN_KNOWLEDGE_STATEMENTS) {
      expect(statement).not.toHaveProperty('scope');
      expect(statement).not.toHaveProperty('scopeId');
      expect(statement).not.toHaveProperty('sync');
      expect(statement).not.toHaveProperty('confirmedAt');
    }
  });
});

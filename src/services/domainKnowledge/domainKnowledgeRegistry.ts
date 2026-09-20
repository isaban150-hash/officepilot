/**
 * DOKUMENT-ASSISTENT-01H1 — der kuratierte Bestand belegter Fachaussagen.
 *
 * Bewusst klein. Dieser Bestand soll die Architektur tragen, nicht OfficeTakt
 * in ein Steuerlexikon verwandeln.
 *
 * **Zwei Teile mit verschiedener Herkunft, und das muss sichtbar bleiben:**
 *
 * Der erste Teil gibt Handwerksbegriffe wieder, die im Bestand von OfficeTakt
 * bereits kuratiert vorliegen (`brain/handwerkKnowledgeRegistry`). Es sind
 * Definitionen, keine Rechts- oder Steuerregeln: Was ein Aufmass ist, hängt an
 * keinem Paragrafen und an keinem Stichtag.
 *
 * Der zweite Teil (01H3) stammt aus amtlichen Quellen — dem Gesetzestext
 * selbst, dem Bundeszentralamt für Steuern und ELSTER. Jeder dieser Sätze
 * wurde am angegebenen Prüftag an der angegebenen Adresse gelesen. Was dort
 * nicht steht, steht auch hier nicht: Modellwissen wurde nicht ergänzt, und
 * es ist keine Aussage dabei, die nicht durch ihren Wortlaut gedeckt wäre.
 * Eine erfundene Quelle wäre schlimmer als gar keine.
 *
 * `validFrom` bedeutet bei einer Definition **nicht** „gilt rechtlich ab":
 * Es ist der Tag, seit dem die Aussage zum geprüften Bestand gehört.
 * `reviewedAt` ist der Tag, an dem sie zuletzt gegen den kuratierten Bestand
 * abgeglichen wurde.
 */
import type { KnowledgeSource, KnowledgeStatement } from '../../types/domainKnowledge';

/**
 * Der Stand des Wissensbestands.
 *
 * Er wird erhöht, wenn Aussagen hinzukommen, sich ändern oder entfallen. So
 * lässt sich später sagen, mit welchem Stand eine Antwort entstanden ist —
 * und ein fehlerhafter Stand lässt sich benennen, statt ihn zu suchen.
 */
export const DOMAIN_KNOWLEDGE_REGISTRY_VERSION = '2026-09-20.2';

/** Der Tag, an dem dieser Bestand zuletzt gegen seine Quelle geprüft wurde. */
const GEPRUEFT_AM = '2026-09-19';

/**
 * DOKUMENT-ASSISTENT-01H3 — der Tag, an dem die amtlichen Quellen geprüft wurden.
 *
 * Jeder Satz weiter unten wurde an diesem Tag am angegebenen Ort gelesen und
 * gegen den Wortlaut abgeglichen. Das ist die Bedeutung von `reviewedAt`: kein
 * Datum der Ablage, sondern der Tag, an dem ein Mensch nachgesehen hat.
 */
const GEPRUEFT_AM_AMTLICH = '2026-09-20';

const QUELLE_HANDWERK_BESTAND: KnowledgeSource = {
  id: 'src-officetakt-handwerk',
  title: 'OfficeTakt — kuratierter Handwerksbegriffsbestand',
  publisher: 'OfficeTakt',
  /*
   * Keine Adresse: Dieser Bestand liegt im Programm selbst. Eine URL zu
   * erfinden, nur damit das Feld gefüllt ist, wäre genau die Unehrlichkeit,
   * die dieses Modell verhindern soll.
   */
  identifier: 'brain/handwerkKnowledgeRegistry',
  kind: 'internal_curated',
  trust: 'curated_secondary',
  jurisdiction: { country: 'DE' },
};

/* ------------------------------------------------------------------ *
 * DOKUMENT-ASSISTENT-01H3 — die ersten amtlichen Quellen
 * ------------------------------------------------------------------ */

/**
 * Die Vertrauensklasse beschreibt die **Quelle**, nicht den Speicherort.
 *
 * Dass der Satz hier im Programm steht, macht ihn nicht zu einem von uns
 * zusammengetragenen Eintrag: Er stammt aus dem Gesetzestext oder von der
 * Behörde, und genau das steht hier. Ihn `curated_secondary` zu nennen, weil
 * die Datei in unserem Verzeichnis liegt, wäre eine Untertreibung, die den
 * Benutzer die Verlässlichkeit falsch einschätzen liesse.
 */
const QUELLE_ESTG_48: KnowledgeSource = {
  id: 'src-estg-48',
  title: '§ 48 EStG — Steuerabzug bei Bauleistungen',
  publisher: 'Bundesministerium der Justiz — gesetze-im-internet.de',
  url: 'https://www.gesetze-im-internet.de/estg/__48.html',
  identifier: '§ 48 EStG',
  kind: 'statute',
  trust: 'official_primary',
  jurisdiction: { country: 'DE' },
};

const QUELLE_ESTG_48B: KnowledgeSource = {
  id: 'src-estg-48b',
  title: '§ 48b EStG — Freistellungsbescheinigung',
  publisher: 'Bundesministerium der Justiz — gesetze-im-internet.de',
  url: 'https://www.gesetze-im-internet.de/estg/__48b.html',
  identifier: '§ 48b EStG',
  kind: 'statute',
  trust: 'official_primary',
  jurisdiction: { country: 'DE' },
};

const QUELLE_BZST_BAULEISTUNGEN: KnowledgeSource = {
  id: 'src-bzst-bauleistungen',
  title: 'Bauabzugsteuer — Freistellungsbescheinigungen nach § 48b EStG',
  publisher: 'Bundeszentralamt für Steuern',
  url: 'https://www.bzst.de/DE/Unternehmen/Bauleistungen/bauleistungen_node.html',
  kind: 'authority_publication',
  trust: 'official_guidance',
  jurisdiction: { country: 'DE' },
};

const QUELLE_ELSTER_SONSTIGE_NACHRICHT: KnowledgeSource = {
  id: 'src-elster-sonstige-nachricht',
  title: 'Sonstige Nachricht an das Finanzamt',
  publisher: 'ELSTER — Online-Finanzamt der Steuerverwaltung',
  url: 'https://www.elster.de/eportal/formulare-leistungen/alleformulare/eingsonstnachr',
  kind: 'form_or_procedure',
  trust: 'official_guidance',
  jurisdiction: { country: 'DE' },
};

/* ------------------------------------------------------------------ *
 * DOKUMENT-FACHWISSEN-01I2 — Umsatzsteuer, Bescheinigung USt 1 TG
 * ------------------------------------------------------------------ */

const QUELLE_USTG_13B: KnowledgeSource = {
  id: 'src-ustg-13b',
  title: '§ 13b UStG — Leistungsempfänger als Steuerschuldner',
  publisher: 'Bundesministerium der Justiz — gesetze-im-internet.de',
  url: 'https://www.gesetze-im-internet.de/ustg_1980/__13b.html',
  identifier: '§ 13b UStG',
  kind: 'statute',
  trust: 'official_primary',
  jurisdiction: { country: 'DE' },
};

/**
 * Das amtliche Muster der Bescheinigung.
 *
 * `identifier` trägt den Stand des **Musters** — den 10.04.2026. Das ist
 * etwas anderes als `reviewedAt` an der einzelnen Aussage: Das eine ist der
 * Tag, an dem das Ministerium den Vordruck neu bekannt gegeben hat, das
 * andere der Tag, an dem wir nachgesehen haben. Die beiden zu vermischen
 * würde heissen, unseren Prüfstand für amtlich auszugeben.
 */
const QUELLE_BMF_UST1TG: KnowledgeSource = {
  id: 'src-bmf-ust1tg',
  title:
    'Bescheinigung für Zwecke der Steuerschuldnerschaft des Leistungsempfängers bei Bauleistungen und / oder Gebäudereinigungsleistungen (USt 1 TG)',
  publisher: 'Bundesministerium der Finanzen',
  url: 'https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Umsatzsteuer/2026-04-10-bescheinigung-USt-1-TG.html',
  identifier: 'BMF-Schreiben vom 10.04.2026',
  kind: 'form_or_procedure',
  trust: 'official_guidance',
  jurisdiction: { country: 'DE' },
};

/**
 * DOKUMENT-FACHWISSEN-01I3 — das amtliche Muster der Ansässigkeitsbescheinigung.
 *
 * Die Adresse zeigt auf das PDF des Ministeriums, nicht auf die Übersichtsseite:
 * Deren Abruf lief beim Prüfen in einen Bot-Schutz, das PDF selbst war unter
 * dieser Adresse erreichbar. Lieber die Adresse, die nachweislich das Dokument
 * liefert, als die schönere, die vielleicht eine Sperrseite zeigt.
 *
 * `§ 13b UStG` ist hier **nicht** noch einmal eingetragen — die Quelle steht
 * bereits aus 01I2 im Bestand und trägt jetzt zwei Themen. Genau dafür sind
 * Quelle und Aussage getrennt.
 */
const QUELLE_BMF_UST1TS: KnowledgeSource = {
  id: 'src-bmf-ust1ts',
  title:
    'Bescheinigung über die Ansässigkeit im Inland nach § 13b Absatz 7 Satz 5 UStG (USt 1 TS)',
  publisher: 'Bundesministerium der Finanzen',
  url: 'https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Umsatzsteuer/2026-04-10-bescheinigung-USt-1-TS.pdf',
  identifier: 'BMF-Schreiben vom 10.04.2026',
  kind: 'form_or_procedure',
  trust: 'official_guidance',
  jurisdiction: { country: 'DE' },
};

export const DOMAIN_KNOWLEDGE_SOURCES: readonly KnowledgeSource[] = Object.freeze([
  QUELLE_HANDWERK_BESTAND,
  QUELLE_ESTG_48,
  QUELLE_ESTG_48B,
  QUELLE_BZST_BAULEISTUNGEN,
  QUELLE_ELSTER_SONSTIGE_NACHRICHT,
  QUELLE_USTG_13B,
  QUELLE_BMF_UST1TG,
  QUELLE_BMF_UST1TS,
]);

function definition(
  id: string,
  topic: string,
  statement: string,
  aliases: string[],
): KnowledgeStatement {
  return {
    id,
    topic,
    topicClass: 'stable_definition',
    statement,
    sourceId: QUELLE_HANDWERK_BESTAND.id,
    validFrom: GEPRUEFT_AM,
    reviewedAt: GEPRUEFT_AM,
    aliases,
  };
}

/**
 * Die Aussagen. Jede ist für sich zitierbar — das ist der Punkt: Nicht „diese
 * Antwort hat drei Quellen", sondern „diese Tatsache stammt von dort".
 */
const HANDWERK_STATEMENTS: readonly KnowledgeStatement[] = Object.freeze([
  definition(
    'stmt-abschlagsrechnung',
    'abschlagsrechnung',
    'Eine Abschlagsrechnung ist eine Zwischenrechnung über bereits erbrachte Leistungen während der Ausführung. Die Beträge werden in der Schlussrechnung verrechnet.',
    ['abschlag', 'zwischenrechnung', 'teilrechnung'],
  ),
  definition(
    'stmt-schlussrechnung',
    'schlussrechnung',
    'Eine Schlussrechnung ist die abschliessende Rechnung nach Leistungsende. Sie zieht bereits gestellte Abschläge ab und rechnet offene Restmengen ab.',
    ['endrechnung'],
  ),
  definition(
    'stmt-aufmass',
    'aufmass',
    'Ein Aufmass ist die Ermittlung der tatsächlich ausgeführten Mengen auf der Baustelle. Es liefert die Grundlage für Abschlags- und Schlussrechnungen.',
    ['aufmasz', 'mengenermittlung'],
  ),
  definition(
    'stmt-nachtrag',
    'nachtrag',
    'Ein Nachtrag ist eine zusätzliche oder geänderte Leistung, die im ursprünglichen Vertrag nicht enthalten war. Er sollte schriftlich bestätigt und im Auftrag nachgeführt werden.',
    ['zusatzauftrag', 'zusatzleistung'],
  ),
  definition(
    'stmt-abnahme',
    'abnahme',
    'Die Abnahme ist die förmliche Übernahme der erbrachten Leistung durch den Auftraggeber. Sie ist üblicherweise Voraussetzung für die Schlussrechnung.',
    ['uebergabe', 'übernahme'],
  ),
  definition(
    'stmt-gewaehrleistung',
    'gewaehrleistung',
    'Die Gewährleistung ist die Haftung für Mängel nach der Abnahme. Frist und Umfang ergeben sich im Einzelfall aus dem Vertrag.',
    ['gewährleistung', 'maengelhaftung', 'mängelhaftung'],
  ),
]);

/* ------------------------------------------------------------------ *
 * DOKUMENT-ASSISTENT-01H3 — Bauabzugsteuer und Freistellungsbescheinigung
 * ------------------------------------------------------------------ */

/**
 * Was `validFrom` bei diesen Aussagen bedeutet — und was nicht.
 *
 * Es ist **nicht** der Tag, an dem die Vorschrift in Kraft trat. Der lässt
 * sich aus dem gelesenen Wortlaut nicht entnehmen, und ihn zu schätzen hiesse,
 * ein historisches Datum zu erfinden, das später jemand für belegt hält.
 * Deshalb steht hier der Tag, seit dem die Aussage zu unserem **geprüften**
 * Bestand gehört. Für die Frage, die dieses Feld zu beantworten hat — darf die
 * Aussage heute als geltend verwendet werden? —, ist das die ehrliche Angabe.
 */
function amtlich(
  id: string,
  topic: string,
  topicClass: KnowledgeStatement['topicClass'],
  sourceId: string,
  statement: string,
  aliases: string[] = [],
): KnowledgeStatement {
  return {
    id,
    topic,
    topicClass,
    statement,
    sourceId,
    validFrom: GEPRUEFT_AM_AMTLICH,
    reviewedAt: GEPRUEFT_AM_AMTLICH,
    retrievedAt: GEPRUEFT_AM_AMTLICH,
    aliases,
  };
}

/**
 * Die Themenschlüssel, unter denen gesucht wird.
 *
 * Sie stehen hier und nicht im Abrufmodul, damit Bestand und Suche nicht
 * auseinanderlaufen: Ein Thema, das niemand mehr trifft, ist totes Wissen.
 */
export const KNOWLEDGE_TOPIC_BAUABZUGSTEUER = 'bauabzugsteuer';
export const KNOWLEDGE_TOPIC_FREISTELLUNG = 'freistellungsbescheinigung';
export const KNOWLEDGE_TOPIC_FREISTELLUNG_ANTRAG = 'freistellungsbescheinigung-antrag';
export const KNOWLEDGE_TOPIC_FREISTELLUNG_GUELTIGKEIT =
  'freistellungsbescheinigung-gueltigkeit';

/**
 * Acht Aussagen, jede einzeln zitierbar und jede durch ihren Wortlaut gedeckt.
 *
 * **Was bewusst fehlt: die Betragsgrenzen des § 48 Abs. 2.**
 *
 * Sie sind fachlich real — 5.000 Euro, in bestimmten Fällen 15.000 Euro. Sie
 * beziehen sich aber auf die im laufenden Kalenderjahr für denselben
 * Leistungsempfänger voraussichtlich zu erbringenden Bauleistungen
 * **insgesamt**, nicht auf eine einzelne Rechnung. Ein Assistent, der sie
 * kennt und eine Rechnung über 4.000 Euro vor sich hat, wird früher oder
 * später „dann fällt keine Bauabzugsteuer an" sagen — und das wäre falsch.
 * Diese Voraussetzungen sind in OfficeTakt heute nicht sicher bekannt, also
 * bleibt die Regel draussen, bis sie es sind.
 */
const BAUABZUGSTEUER_STATEMENTS: readonly KnowledgeStatement[] = [
  amtlich(
    'stmt-estg48-steuerabzug-15',
    KNOWLEDGE_TOPIC_BAUABZUGSTEUER,
    'tax_rule',
    QUELLE_ESTG_48.id,
    'Erbringt jemand im Inland eine Bauleistung an einen Unternehmer im Sinne des § 2 Umsatzsteuergesetz oder an eine juristische Person des öffentlichen Rechts, ist der Leistungsempfänger verpflichtet, von der Gegenleistung einen Steuerabzug in Höhe von 15 Prozent für Rechnung des Leistenden vorzunehmen.',
    ['bauabzugssteuer', 'steuerabzug bauleistung', 'bauleistung steuerabzug'],
  ),
  amtlich(
    'stmt-estg48-ausnahme-freistellung',
    KNOWLEDGE_TOPIC_FREISTELLUNG,
    'tax_rule',
    QUELLE_ESTG_48.id,
    'Der Steuerabzug muss nicht vorgenommen werden, wenn der Leistende dem Leistungsempfänger eine im Zeitpunkt der Gegenleistung gültige Freistellungsbescheinigung nach § 48b Absatz 1 Satz 1 EStG vorlegt.',
    [KNOWLEDGE_TOPIC_BAUABZUGSTEUER],
  ),
  amtlich(
    'stmt-estg48b-erteilung',
    KNOWLEDGE_TOPIC_FREISTELLUNG_ANTRAG,
    'tax_rule',
    QUELLE_ESTG_48B.id,
    'Auf Antrag des Leistenden hat das für ihn zuständige Finanzamt eine Bescheinigung nach amtlich vorgeschriebenem Vordruck zu erteilen, wenn der zu sichernde Steueranspruch nicht gefährdet erscheint und ein inländischer Empfangsbevollmächtigter bestellt ist.',
    [KNOWLEDGE_TOPIC_FREISTELLUNG],
  ),
  amtlich(
    'stmt-estg48b-angaben-geltungsdauer',
    KNOWLEDGE_TOPIC_FREISTELLUNG_GUELTIGKEIT,
    'tax_rule',
    QUELLE_ESTG_48B.id,
    'Zu den Angaben einer Freistellungsbescheinigung gehören unter anderem Name, Anschrift und Steuernummer des Leistenden, die Geltungsdauer der Bescheinigung, der Umfang der Freistellung und das ausstellende Finanzamt.',
    [KNOWLEDGE_TOPIC_FREISTELLUNG],
  ),
  amtlich(
    'stmt-bzst-keine-ausstellung',
    KNOWLEDGE_TOPIC_FREISTELLUNG_ANTRAG,
    'authority_process',
    QUELLE_BZST_BAULEISTUNGEN.id,
    'Das Bundeszentralamt für Steuern stellt Freistellungsbescheinigungen nicht selbst aus und versendet sie nicht; die Bescheinigung wird dem Leistenden vom Finanzamt ausgestellt und in Papierform versendet.',
  ),
  amtlich(
    'stmt-bzst-antrag-formlos',
    KNOWLEDGE_TOPIC_FREISTELLUNG_ANTRAG,
    'authority_process',
    QUELLE_BZST_BAULEISTUNGEN.id,
    'Die Antragstellung erfolgt formlos beim jeweiligen Betriebsstättenfinanzamt beziehungsweise beim Finanzamt am Sitz der Geschäftsleitung.',
  ),
  amtlich(
    'stmt-bzst-eibe-bestaetigung',
    KNOWLEDGE_TOPIC_FREISTELLUNG_GUELTIGKEIT,
    'authority_process',
    QUELLE_BZST_BAULEISTUNGEN.id,
    'Leistungsempfänger können über das EIBE-Portal des Bundeszentralamts für Steuern kostenlos eine Bestätigung über die Gültigkeit einer Freistellungsbescheinigung nach § 48b EStG einholen; dafür ist eine Registrierung erforderlich.',
  ),
  amtlich(
    'stmt-elster-formloser-antrag',
    KNOWLEDGE_TOPIC_FREISTELLUNG_ANTRAG,
    'form_or_application',
    QUELLE_ELSTER_SONSTIGE_NACHRICHT.id,
    'Das ELSTER-Formular „Sonstige Nachricht an das Finanzamt" kann für formlose Anträge an das Finanzamt genutzt werden, ausdrücklich auch für die Erteilung einer Freistellungsbescheinigung für Bauleistungen.',
  ),
];


/**
 * DOKUMENT-FACHWISSEN-01I2 — das Thema der Bescheinigung USt 1 TG.
 *
 * Ein **eigenes** Thema, bewusst getrennt von der Freistellungsbescheinigung.
 * Beide betreffen Bauleistungen, beide kommen vom Finanzamt — und sie regeln
 * entgegengesetzte Dinge: die eine, dass nichts einbehalten wird, die andere,
 * wer die Umsatzsteuer schuldet. Läge beides in einem Topf, wäre die
 * Verwechslung nur noch eine Frage der Zeit.
 */
export const KNOWLEDGE_TOPIC_UST1TG = 'ust1tg-steuerschuldnerschaft';

/**
 * Neun Aussagen zur Bescheinigung USt 1 TG — und keine einzige darüber, was
 * das für einen bestimmten Auftrag bedeutet.
 *
 * **Was hier bewusst fehlt.**
 *
 * Die 10-Prozent-Betrachtung zur Nachhaltigkeit. Sie ist fachlich real, aber
 * sie verlangt den gesamten Unternehmensumsatz eines Bezugszeitraums —
 * Angaben, die OfficeTakt nicht kennt. Ein Assistent, der die Zahl kennt und
 * ein einzelnes Dokument vor sich hat, rechnet sie früher oder später an
 * diesem Dokument nach und erklärt jemanden zum nachhaltig bauleistenden
 * Unternehmer. Das wäre eine Einzelfallentscheidung mit Steuerfolgen.
 *
 * Ebenso fehlen alle Sätze der Form „damit rechnen Sie ohne Umsatzsteuer ab".
 * Die Bescheinigung betrifft **ein** Tatbestandsmerkmal unter mehreren; ob
 * bei einem konkreten Umsatz die Steuerschuldnerschaft greift, steht in
 * keiner dieser Quellen und hängt am Einzelfall.
 */
const UST1TG_STATEMENTS: readonly KnowledgeStatement[] = [
  amtlich(
    'stmt-ustg13b-abs2-nr4-bauleistungen',
    KNOWLEDGE_TOPIC_UST1TG,
    'tax_rule',
    QUELLE_USTG_13B.id,
    '§ 13b Absatz 2 Nummer 4 UStG erfasst Bauleistungen einschliesslich Werklieferungen und sonstiger Leistungen im Zusammenhang mit Grundstücken, die der Herstellung, Instandsetzung, Instandhaltung, Änderung oder Beseitigung von Bauwerken dienen.',
    ['bauleistungen umsatzsteuer', 'reverse charge bauleistungen'],
  ),
  amtlich(
    'stmt-ustg13b-abs2-nr8-gebaeudereinigung',
    KNOWLEDGE_TOPIC_UST1TG,
    'tax_rule',
    QUELLE_USTG_13B.id,
    '§ 13b Absatz 2 Nummer 8 UStG erfasst das Reinigen von Gebäuden und Gebäudeteilen.',
  ),
  amtlich(
    'stmt-ustg13b-abs5-steuerschuldnerschaft',
    KNOWLEDGE_TOPIC_UST1TG,
    'tax_rule',
    QUELLE_USTG_13B.id,
    '§ 13b Absatz 5 UStG regelt, unter welchen Voraussetzungen in diesen Fällen der Leistungsempfänger die Steuer schuldet und nicht der Leistende.',
  ),
  amtlich(
    'stmt-ustg13b-nachhaltigkeit',
    KNOWLEDGE_TOPIC_UST1TG,
    'tax_rule',
    QUELLE_USTG_13B.id,
    'Das Gesetz knüpft dabei unter anderem daran an, dass der Leistungsempfänger ein Unternehmer ist, der nachhaltig entsprechende Leistungen erbringt.',
  ),
  amtlich(
    'stmt-ustg13b-bescheinigung-indiz',
    KNOWLEDGE_TOPIC_UST1TG,
    'tax_rule',
    QUELLE_USTG_13B.id,
    'Von diesem Merkmal ist auszugehen, wenn dem Leistungsempfänger das zuständige Finanzamt eine im Zeitpunkt der Ausführung des Umsatzes gültige entsprechende Bescheinigung erteilt hat.',
  ),
  amtlich(
    'stmt-ustg13b-drei-jahre',
    KNOWLEDGE_TOPIC_UST1TG,
    'tax_rule',
    QUELLE_USTG_13B.id,
    'Diese Bescheinigung ist nach dem Gesetz auf längstens drei Jahre befristet.',
  ),
  amtlich(
    'stmt-ustg13b-widerruf-zukunft',
    KNOWLEDGE_TOPIC_UST1TG,
    'tax_rule',
    QUELLE_USTG_13B.id,
    'Sie kann nach dem Gesetz nur mit Wirkung für die Zukunft widerrufen oder zurückgenommen werden.',
  ),
  amtlich(
    'stmt-bmf-muster-ust1tg',
    KNOWLEDGE_TOPIC_UST1TG,
    'form_or_application',
    QUELLE_BMF_UST1TG.id,
    'Das amtliche Muster dieser Bescheinigung trägt die Bezeichnung USt 1 TG und heisst „Bescheinigung für Zwecke der Steuerschuldnerschaft des Leistungsempfängers bei Bauleistungen und / oder Gebäudereinigungsleistungen".',
    ['ust 1 tg'],
  ),
  amtlich(
    'stmt-bmf-muster-stand',
    KNOWLEDGE_TOPIC_UST1TG,
    'form_or_application',
    QUELLE_BMF_UST1TG.id,
    'Das Bundesministerium der Finanzen hat das aktuelle Muster dieser Bescheinigung mit Schreiben vom 10. April 2026 neu bekannt gegeben.',
  ),
];

/**
 * DOKUMENT-FACHWISSEN-01I3 — das Thema der Ansässigkeitsbescheinigung USt 1 TS.
 *
 * Wieder ein eigenes Thema, obwohl dieselbe Vorschrift dahintersteht wie bei
 * der USt 1 TG. Genau deshalb: Beide berufen sich auf § 13b UStG, beide kommen
 * vom Finanzamt, beide betreffen die Umsatzsteuer — und sie weisen völlig
 * Verschiedenes nach. Die eine, dass der Empfänger nachhaltig Bauleistungen
 * erbringt; die andere, dass der Leistende im Inland ansässig ist. In einem
 * Topf wären sie nach kurzer Zeit nicht mehr zu trennen.
 */
export const KNOWLEDGE_TOPIC_UST1TS = 'ust1ts-ansaessigkeit';

/**
 * Sieben Aussagen zur Ansässigkeitsbescheinigung — und keine darüber, wo ein
 * bestimmtes Unternehmen ansässig ist.
 *
 * **Was hier bewusst fehlt: eine Höchstdauer.**
 *
 * Die USt 1 TG ist nach dem Gesetz auf längstens drei Jahre befristet. Für die
 * USt 1 TS steht in § 13b Absatz 7 nichts dergleichen. Diese Frist von der
 * einen Bescheinigung auf die andere zu übertragen wäre die naheliegendste
 * und eine der gefährlichsten Verwechslungen dieser Familie — und sie würde
 * sich hinter einer echten Quellenangabe verstecken. Was nicht belegt ist,
 * steht nicht im Bestand.
 *
 * Ebenso fehlt jeder Satz der Art „damit ist Ihr Unternehmen im Inland
 * ansässig". Die Bescheinigung wirkt nach dem Gesetz im **Zweifelsfall** als
 * Nachweis; ob sie für einen bestimmten Umsatz trägt, hängt am Einzelfall.
 */
const UST1TS_STATEMENTS: readonly KnowledgeStatement[] = [
  amtlich(
    'stmt-ustg13b-abs7-auslandsansaessig',
    KNOWLEDGE_TOPIC_UST1TS,
    'tax_rule',
    QUELLE_USTG_13B.id,
    '§ 13b Absatz 7 UStG bestimmt für die dort geregelten Fälle, wann ein Unternehmer als im Ausland oder im übrigen Gemeinschaftsgebiet ansässig gilt.',
    ['ansaessigkeit im inland', 'ansässigkeit im inland'],
  ),
  amtlich(
    'stmt-ustg13b-abs7-zeitpunkt',
    KNOWLEDGE_TOPIC_UST1TS,
    'tax_rule',
    QUELLE_USTG_13B.id,
    'Maßgebend ist der Zeitpunkt, in dem die Leistung ausgeführt wird.',
  ),
  amtlich(
    'stmt-ustg13b-abs7-betriebsstaette',
    KNOWLEDGE_TOPIC_UST1TS,
    'tax_rule',
    QUELLE_USTG_13B.id,
    'Hat der Unternehmer im Inland eine Betriebsstätte und führt er einen Umsatz nach § 13b Absatz 1 oder Absatz 2 Nummer 1 oder Nummer 5 aus, gilt er hinsichtlich dieses Umsatzes als im Ausland oder im übrigen Gemeinschaftsgebiet ansässig, wenn die Betriebsstätte an diesem Umsatz nicht beteiligt ist.',
    ['betriebsstaette', 'betriebsstätte'],
  ),
  amtlich(
    'stmt-ustg13b-abs7-zweifelsfall',
    KNOWLEDGE_TOPIC_UST1TS,
    'tax_rule',
    QUELLE_USTG_13B.id,
    'Ist es zweifelhaft, ob der Unternehmer diese Voraussetzungen erfüllt, schuldet der Leistungsempfänger die Steuer nur dann nicht, wenn ihm der Unternehmer durch eine Bescheinigung des zuständigen Finanzamts nachweist, dass er kein Unternehmer im Sinne der Sätze 1 und 2 ist.',
  ),
  amtlich(
    'stmt-ustg13b-abs7-ausstellendes-finanzamt',
    KNOWLEDGE_TOPIC_UST1TS,
    'authority_process',
    QUELLE_USTG_13B.id,
    'Diese Bescheinigung erteilt das nach den abgabenrechtlichen Vorschriften für die Besteuerung seiner Umsätze zuständige Finanzamt.',
  ),
  amtlich(
    'stmt-bmf-muster-ust1ts',
    KNOWLEDGE_TOPIC_UST1TS,
    'form_or_application',
    QUELLE_BMF_UST1TS.id,
    'Das amtliche Muster dieser Bescheinigung trägt die Bezeichnung USt 1 TS und heisst „Bescheinigung über die Ansässigkeit im Inland nach § 13b Absatz 7 Satz 5 UStG".',
    ['ust 1 ts'],
  ),
  amtlich(
    'stmt-bmf-muster-ust1ts-stand',
    KNOWLEDGE_TOPIC_UST1TS,
    'form_or_application',
    QUELLE_BMF_UST1TS.id,
    'Das Bundesministerium der Finanzen hat das aktuelle Muster dieser Bescheinigung mit Schreiben vom 10. April 2026 neu bekannt gegeben.',
  ),
];

/**
 * Der ausgelieferte Bestand: Handwerksbegriffe, Bauabzugsteuer, USt 1 TG, USt 1 TS.
 *
 * Erst hier zusammengesetzt, damit alle Teile vollständig definiert sind —
 * eine Liste, die sich selbst vor ihrer Entstehung liest, ist zur Laufzeit leer.
 */
export const DOMAIN_KNOWLEDGE_STATEMENTS: readonly KnowledgeStatement[] = Object.freeze([
  ...HANDWERK_STATEMENTS,
  ...BAUABZUGSTEUER_STATEMENTS,
  ...UST1TG_STATEMENTS,
  ...UST1TS_STATEMENTS,
]);

/**
 * Alle Themen, für die OfficeTakt belegtes Fachwissen führt. Mehr gibt es nicht.
 *
 * Der Abruf prüft jedes angefragte Thema gegen diese Liste. Ein Thema, das
 * hier fehlt, liefert nichts — auch dann, wenn irgendwo Aussagen dazu lägen.
 */
export const KNOWLEDGE_TOPICS_PRODUKTIV: readonly string[] = Object.freeze([
  KNOWLEDGE_TOPIC_BAUABZUGSTEUER,
  KNOWLEDGE_TOPIC_FREISTELLUNG,
  KNOWLEDGE_TOPIC_FREISTELLUNG_ANTRAG,
  KNOWLEDGE_TOPIC_FREISTELLUNG_GUELTIGKEIT,
  KNOWLEDGE_TOPIC_UST1TG,
  KNOWLEDGE_TOPIC_UST1TS,
]);

export function getDomainKnowledgeSource(id: string): KnowledgeSource | undefined {
  return DOMAIN_KNOWLEDGE_SOURCES.find((quelle) => quelle.id === id);
}

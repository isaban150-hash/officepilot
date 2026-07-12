import type { HandwerkKnowledgeId, HandwerkTermDefinition } from '../../types/handwerkKnowledge';
import type { ClassifiedDocumentKind } from '../../types/models';

export const HANDWERK_WORKFLOW_CHAIN: HandwerkKnowledgeId[] = [
  'werkvertrag',
  'leistungsverzeichnis',
  'aufmasz',
  'abschlagsrechnung',
  'schlussrechnung',
  'abnahme',
  'gewaehrleistung',
];

const HANDWERK_TERMS: HandwerkTermDefinition[] = [
  {
    id: 'werkvertrag',
    title: 'Werkvertrag',
    aliases: ['werkvertrag', 'werk vertrag', 'bauvertrag'],
    definition:
      'Vertrag zwischen Auftraggeber und Handwerksbetrieb über die Ausführung von Bau- oder Handwerksleistungen.',
    practicalNote:
      'Grundlage für den Auftrag: Leistungsumfang, Preise, Zahlungsmodalitäten und oft ein Leistungsverzeichnis.',
    relatedIds: ['leistungsverzeichnis', 'abschlagsrechnung', 'schlussrechnung'],
    documentKind: 'werkvertrag',
  },
  {
    id: 'angebot',
    title: 'Angebot',
    aliases: ['angebot', 'kostenvoranschlag', 'kva'],
    definition: 'Unverbindliche oder verbindliche Preis- und Leistungsofferte vor Vertragsabschluss.',
    practicalNote: 'Wird oft zum Werkvertrag oder Auftrag weitergeführt.',
    relatedIds: ['werkvertrag', 'leistungsverzeichnis'],
    documentKind: 'angebot',
  },
  {
    id: 'leistungsverzeichnis',
    title: 'Leistungsverzeichnis (LV)',
    aliases: ['leistungsverzeichnis', 'lv', 'positionsverzeichnis', 'boq'],
    definition: 'Strukturierte Auflistung aller Leistungspositionen mit Mengen, Einheiten und Preisen.',
    practicalNote: 'Basis für Aufmaß, Nachträge und Rechnungsstellung.',
    relatedIds: ['ep', 'gp', 'aufmasz', 'nachtrag'],
    documentKind: 'leistungsverzeichnis',
  },
  {
    id: 'aufmasz',
    title: 'Aufmaß',
    aliases: ['aufmaß', 'aufmass', 'mengenermittlung', 'mengenaufmaß'],
    definition: 'Ermittlung der tatsächlich ausgeführten Mengen auf der Baustelle.',
    practicalNote: 'Liefert die Grundlage für korrekte Abschlags- und Schlussrechnungen.',
    relatedIds: ['leistungsverzeichnis', 'abschlagsrechnung'],
  },
  {
    id: 'nachtrag',
    title: 'Nachtrag',
    aliases: ['nachtrag', 'mehrleistung', 'zusatzleistung', 'nachtragsangebot'],
    definition: 'Zusätzliche oder geänderte Leistung, die nicht im ursprünglichen Vertrag enthalten war.',
    practicalNote: 'Sollte schriftlich bestätigt und als Position im Auftrag nachgeführt werden.',
    relatedIds: ['leistungsverzeichnis', 'werkvertrag'],
    documentKind: 'nachtrag',
  },
  {
    id: 'abschlagsrechnung',
    title: 'Abschlagsrechnung',
    aliases: ['abschlagsrechnung', 'abschlag', 'teilabrechnung', 'hakedis'],
    definition: 'Zwischenrechnung über bereits erbrachte Leistungen während der Ausführung.',
    practicalNote: 'Wird bei längeren Projekten gestellt; Beträge werden in der Schlussrechnung verrechnet.',
    relatedIds: ['schlussrechnung', 'aufmasz'],
  },
  {
    id: 'schlussrechnung',
    title: 'Schlussrechnung',
    aliases: ['schlussrechnung', 'endabrechnung', 'schluss rechnung'],
    definition: 'Finale Rechnung nach Leistungsende; schließt den Auftrag ab.',
    practicalNote: 'Zieht bereits gestellte Abschläge ab und fakturiert offene Restmengen.',
    relatedIds: ['abschlagsrechnung', 'abnahme'],
  },
  {
    id: 'teilrechnung',
    title: 'Teilrechnung',
    aliases: ['teilrechnung', 'teil rechnung'],
    definition: 'Rechnung über einen Teil der vereinbarten Leistung, ohne zwingend Abschlagscharakter.',
    practicalNote: 'Unterscheidet sich vom Abschlag je nach vertraglicher Vereinbarung.',
    relatedIds: ['abschlagsrechnung'],
  },
  {
    id: 'materialrechnung',
    title: 'Materialrechnung',
    aliases: ['materialrechnung', 'materialeingang', 'eingangsrechnung material'],
    definition: 'Rechnung eines Lieferanten für geliefertes Material.',
    practicalNote: 'Muss dem richtigen Auftrag zugeordnet und ggf. an den Kunden weiterberechnet werden.',
    documentKind: 'eingangsrechnung',
  },
  {
    id: 'lieferschein',
    title: 'Lieferschein',
    aliases: ['lieferschein', 'lieferung', 'wareneingang'],
    definition: 'Beleg über gelieferte Waren oder Materialien ohne Zahlungsanspruch.',
    practicalNote: 'Dient als Nachweis für Materialmengen und -arten auf der Baustelle.',
    relatedIds: ['materialrechnung'],
    documentKind: 'lieferschein',
  },
  {
    id: 'stundenzettel',
    title: 'Stundenzettel',
    aliases: ['stundenzettel', 'stundennachweis', 'arbeitszeitnachweis'],
    definition: 'Nachweis geleisteter Arbeitsstunden von Mitarbeitern oder Subunternehmern.',
    practicalNote: 'Grundlage für Regiestunden oder Nachkalkulation.',
    documentKind: 'stundenzettel',
  },
  {
    id: 'bautagebuch',
    title: 'Bautagebuch',
    aliases: ['bautagebuch', 'baustellenprotokoll', 'tagesbericht'],
    definition: 'Tägliche Dokumentation des Baufortschritts, der Witterung und besonderer Vorkommnisse.',
    practicalNote: 'Wichtig bei Streitigkeiten, Verzögerungen und Nachtragsbegründungen.',
  },
  {
    id: 'abnahme',
    title: 'Abnahme',
    aliases: ['abnahme', 'abnahmeprotokoll', 'übergabe', 'fertigstellung'],
    definition: 'Formelle Übernahme der erbrachten Leistung durch den Auftraggeber.',
    practicalNote: 'Startet oft die Gewährleistungsfrist und ist Voraussetzung für die Schlussrechnung.',
    relatedIds: ['schlussrechnung', 'gewaehrleistung'],
    documentKind: 'abnahmeprotokoll',
  },
  {
    id: 'gewaehrleistung',
    title: 'Gewährleistung',
    aliases: ['gewährleistung', 'gewaehrleistung', 'mängelhaftung', 'garantie'],
    definition: 'Gesetzliche oder vertragliche Haftung für Mängel nach Abnahme.',
    practicalNote: 'Frist und Umfang stehen meist im Werkvertrag.',
    relatedIds: ['abnahme', 'werkvertrag'],
  },
  {
    id: 'vob',
    title: 'VOB',
    aliases: ['vob', 'vob/b', 'vob/c', 'vergabe- und vertragsordnung'],
    definition:
      'Vergabe- und Vertragsordnung für Bauleistungen – Regelwerk für öffentliche und viele private Bauaufträge.',
    practicalNote:
      'VOB/B regelt Vertragsgrundlagen, VOB/C die technischen Vertragsbedingungen für Bauleistungen.',
    relatedIds: ['leistungsverzeichnis', 'nachtrag'],
  },
  {
    id: 'ep',
    title: 'EP (Einheitspreis)',
    aliases: ['ep', 'einheitspreis', 'einheits preis'],
    definition: 'Preis pro Mengeneinheit einer Leistungsposition (z. B. €/m², €/m, €/Stk).',
    practicalNote: 'Menge × EP ergibt den Positionspreis im Leistungsverzeichnis.',
    relatedIds: ['leistungsverzeichnis', 'gp'],
  },
  {
    id: 'gp',
    title: 'GP (Gesamtpreis)',
    aliases: ['gp', 'gesamtpreis', 'pauschalposition'],
    definition: 'Fester Gesamtpreis für eine Position unabhängig von der genauen Menge.',
    practicalNote: 'Pauschalpreis-Positionen sind im LV oft als GP gekennzeichnet.',
    relatedIds: ['pauschalpreis', 'ep'],
  },
  {
    id: 'einheitspreis',
    title: 'Einheitspreis',
    aliases: ['einheitspreis'],
    definition: 'Siehe EP – Preis je Einheit einer Leistung.',
    practicalNote: 'Wird im LV neben Menge und Einheit angegeben.',
    relatedIds: ['ep'],
  },
  {
    id: 'pauschalpreis',
    title: 'Pauschalpreis',
    aliases: ['pauschalpreis', 'pauschal', 'festpreis'],
    definition: 'Pauschaler Gesamtpreis für eine definierte Leistung.',
    practicalNote: 'Häufig bei kleineren oder klar abgegrenzten Arbeitspaketen.',
    relatedIds: ['gp'],
  },
  {
    id: 'baustelleneinrichtung',
    title: 'Baustelleneinrichtung',
    aliases: ['baustelleneinrichtung', 'bse', 'baustellen einrichtung'],
    definition: 'Vorhalten von Geräten, Container, Strom, Wasser und Zufahrten auf der Baustelle.',
    practicalNote: 'Eigene LV-Position, oft zeitabhängig abgerechnet.',
  },
  {
    id: 'geruest',
    title: 'Gerüst',
    aliases: ['gerüst', 'geruest', 'fassadengerüst', 'arbeitsgerüst'],
    definition: 'Hilfsmittel für Arbeiten in der Höhe an Fassaden oder Dächern.',
    practicalNote: 'Auf- und Abbau sowie Vorhaltung sind separate LV-Positionen.',
  },
  {
    id: 'daemmung',
    title: 'Dämmung',
    aliases: ['dämmung', 'daemmung', 'wärmedämmung', 'wdvs'],
    definition: 'Material und Arbeit zur Reduzierung von Wärmeverlusten an Gebäudeteilen.',
    practicalNote: 'Mengen werden meist in m² (Dämmfläche) oder m³ (Dämmstärke) erfasst.',
  },
  {
    id: 'abdichtung',
    title: 'Abdichtung',
    aliases: ['abdichtung', 'dichtschlämme', 'bitumenabdichtung'],
    definition: 'Schutz von Bauteilen gegen eindringendes Wasser oder Feuchtigkeit.',
    practicalNote: 'Typisch bei Fundamenten, Flachdächern und Nassräumen.',
  },
  {
    id: 'unterkonstruktion',
    title: 'Unterkonstruktion',
    aliases: ['unterkonstruktion', 'uk', 'tragkonstruktion'],
    definition: 'Tragende oder ausrichtende Konstruktion unter einer sichtbaren Schicht.',
    practicalNote: 'Z. B. unter Fassadenplatten, Dachaufbauten oder Deckenverkleidungen.',
  },
  {
    id: 'attika',
    title: 'Attika',
    aliases: ['attika', 'attikablech'],
    definition: 'Aufkantung am Dachrand als Abschluss und Sicherung der Dachhaut.',
    practicalNote: 'Wird laufend in Metern (lm) im Aufmaß erfasst.',
  },
  {
    id: 'lichtkuppel',
    title: 'Lichtkuppel',
    aliases: ['lichtkuppel', 'lichtkasten', 'dachlicht'],
    definition: 'Durchlässiger Dachausbau zur Tageslichtnutzung im Gebäude.',
    practicalNote: 'Position meist in Stück (Stk) mit Anschlussabdichtung.',
  },
  {
    id: 'dachflaeche',
    title: 'Dachfläche',
    aliases: ['dachfläche', 'dachflaeche', 'dachflächen'],
    definition: 'Die zu bearbeitende oder einzudeckende Fläche eines Daches.',
    practicalNote: 'Grundlage für Eindeckung, Dämmung und Abdichtung in m².',
  },
  {
    id: 'fallrohr',
    title: 'Fallrohr',
    aliases: ['fallrohr', 'regenfallrohr', 'dachrinne fallrohr'],
    definition: 'Vertikales Rohr zur Ableitung von Regenwasser von der Dachrinne.',
    practicalNote: 'Wird in Metern (m) gemessen und montiert.',
  },
  {
    id: 'traufe',
    title: 'Traufe',
    aliases: ['traufe', 'dachtraufe'],
    definition: 'Seitlicher oder unterer Abschluss des Daches an der Regenrinne.',
    practicalNote: 'Länge in laufenden Metern (lm) für Blech- und Klempnerarbeiten.',
  },
  {
    id: 'ortgang',
    title: 'Ortgang',
    aliases: ['ortgang', 'giebelanschluss'],
    definition: 'Seitlicher Dachabschluss an der Giebelseite.',
    practicalNote: 'Anschlussblech und Eindeckung werden getrennt im LV geführt.',
  },
];

const TERM_BY_ID = new Map(HANDWERK_TERMS.map((term) => [term.id, term]));

const DOCUMENT_KIND_TO_TERM: Partial<Record<ClassifiedDocumentKind, HandwerkKnowledgeId>> = {
  werkvertrag: 'werkvertrag',
  angebot: 'angebot',
  leistungsverzeichnis: 'leistungsverzeichnis',
  nachtrag: 'nachtrag',
  lieferschein: 'lieferschein',
  stundenzettel: 'stundenzettel',
  abnahmeprotokoll: 'abnahme',
  eingangsrechnung: 'materialrechnung',
};

export function getHandwerkTermById(id: HandwerkKnowledgeId): HandwerkTermDefinition | undefined {
  return TERM_BY_ID.get(id);
}

export function getHandwerkTermForDocumentKind(
  kind: ClassifiedDocumentKind | undefined,
): HandwerkTermDefinition | undefined {
  if (!kind) return undefined;
  const termId = DOCUMENT_KIND_TO_TERM[kind];
  return termId ? getHandwerkTermById(termId) : undefined;
}

export function findHandwerkTermsInQuestion(question: string): HandwerkTermDefinition[] {
  const normalized = question.trim().toLowerCase();
  if (!normalized) return [];

  const matches: HandwerkTermDefinition[] = [];
  for (const term of HANDWERK_TERMS) {
    const hit = term.aliases.some((alias) => {
      const pattern = new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      return pattern.test(normalized);
    });
    if (hit) matches.push(term);
  }
  return matches;
}

export function isHandwerkKnowledgeQuestion(question: string): boolean {
  const q = question.trim();
  if (!q) return false;
  if (findHandwerkTermsInQuestion(q).length > 0) return true;
  return (
    /was ist|was bedeutet|erkläre|erklär|brauche ich|benötige ich|wann.*(rechnung|schluss|abschlag)|typischer ablauf|zusammenhang|workflow/i.test(
      q,
    ) && /werkvertrag|auftrag|lv|leistungsverzeichnis|rechnung|baustelle|handwerk|vob|nachtrag|aufmaß|aufmass/i.test(q)
  );
}

export function isHandwerkDefinitionQuestion(question: string): boolean {
  return /was ist|was bedeutet|erkläre|erklär|definiere/i.test(question.trim());
}

export function buildWorkflowChainText(): string {
  return HANDWERK_WORKFLOW_CHAIN.map((id) => getHandwerkTermById(id)?.title ?? id).join(' → ');
}

export function buildHandwerkGlossaryBlock(maxTerms = 12): string {
  const priority: HandwerkKnowledgeId[] = [
    'werkvertrag',
    'leistungsverzeichnis',
    'aufmasz',
    'abschlagsrechnung',
    'schlussrechnung',
    'nachtrag',
    'vob',
    'ep',
    'gp',
    'materialrechnung',
    'lieferschein',
    'gewaehrleistung',
  ];
  const lines = priority.slice(0, maxTerms).map((id) => {
    const term = getHandwerkTermById(id);
    if (!term) return '';
    return `${term.title}: ${term.definition}`;
  });
  return ['HANDWERKS-FACHWISSEN (Kurz):', ...lines.filter(Boolean), `Typischer Ablauf: ${buildWorkflowChainText()}`].join(
    '\n',
  );
}

export function buildTermAnswer(term: HandwerkTermDefinition): {
  title: string;
  summary: string;
  bullets: string[];
} {
  const bullets = [term.practicalNote];
  if (term.relatedIds?.length) {
    const related = term.relatedIds
      .map((id) => getHandwerkTermById(id)?.title)
      .filter(Boolean)
      .join(', ');
    if (related) bullets.push(`Zusammenhang: ${related}`);
  }
  return {
    title: term.title,
    summary: term.definition,
    bullets,
  };
}

export const HANDWERK_KNOWLEDGE_DETECT_PATTERNS: RegExp[] = [
  /werkvertrag|leistungsverzeichnis|\blv\b|\bep\b|\bgp\b|einheitspreis|pauschalpreis/i,
  /aufmaß|aufmass|nachtrag|abschlagsrechnung|schlussrechnung|teilrechnung/i,
  /materialrechnung|lieferschein|stundenzettel|bautagebuch|abnahme|gewährleistung|gewaehrleistung/i,
  /\bvob\b|vob\/b|vob\/c/i,
  /gerüst|geruest|dämmung|daemmung|abdichtung|unterkonstruktion|attika|lichtkuppel|dachfläche|fallrohr|traufe|ortgang/i,
  /baustelleneinrichtung|angebot/i,
];

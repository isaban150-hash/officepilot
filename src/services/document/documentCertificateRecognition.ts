/**
 * DOKUMENT-FACHWISSEN-01I1 — welche Bescheinigung ist das?
 *
 * **Warum das nötig ist.**
 *
 * Drei Dokumente vom Finanzamt, die fast dieselben Wörter benutzen — und
 * entgegengesetzte Wirkung haben:
 *
 *   Freistellungsbescheinigung (§ 48b EStG): Der Auftraggeber behält die
 *       Bauabzugsteuer **nicht** ein.
 *   USt 1 TG (§ 13b UStG): Der Leistungsempfänger **schuldet** die
 *       Umsatzsteuer.
 *   USt 1 TS (§ 13b Abs. 7 UStG): Der Leistende ist im Inland ansässig.
 *
 * „Bescheinigung", „Finanzamt", „Steuernummer", „gültig bis", „Bauleistungen"
 * stehen auf allen dreien. Wer danach entscheidet, entscheidet nichts. Deshalb
 * zählen hier nur die Merkmale, die **eine** dieser Arten kennzeichnen: die
 * amtliche Formularkennung, die Rechtsreferenz mit Gesetz, und der amtliche
 * Titel.
 *
 * **Was hier nicht passiert.**
 *
 * Keine Auslegung, keine Rechtsfolge, kein Fachwissen. Dieses Modul sagt
 * ausschliesslich, **was für ein Papier** vorliegt — nicht, was daraus folgt.
 * Und wenn die Merkmale sich widersprechen, sagt es gar nichts: Eine geratene
 * Bescheinigungsart ist schlimmer als eine offene Frage, weil auf ihr später
 * eine Steuerauskunft aufsetzt.
 *
 * Keine unscharfe OCR-Korrektur. Aus einem gelesenen „TG" wird hier niemals
 * ein „TS" — der Unterschied ist ein Buchstabe und zwei verschiedene Gesetze.
 */
import type {
  SemanticCertificate,
  SemanticCertificateType,
  SemanticLegalReference,
} from '../../types/documentSemanticCore';

/* ------------------------------------------------------------------ *
 * Normalisierung
 * ------------------------------------------------------------------ */

/** Kleinschreibung und einfache Abstände — mehr braucht es nicht. */
function normalisiere(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ');
}

const GESETZE: Record<string, string> = {
  estg: 'EStG',
  einkommensteuergesetz: 'EStG',
  ustg: 'UStG',
  umsatzsteuergesetz: 'UStG',
};

/**
 * Paragraf, Gesetz und — nur wenn er wirklich dasteht — der Absatz.
 *
 * Deckt die Schreibweisen ab, die in der Praxis vorkommen: „§ 48b EStG",
 * „§48b EStG", „§ 48 b EStG", „48b Einkommensteuergesetz", und dieselben mit
 * „Abs. 5", „Absatz 7" oder einem dazwischengeschobenen „Satz 5".
 *
 * Bewusst ein Ausdruck und keine Parserbibliothek: Was er nicht trifft, gilt
 * als nicht vorhanden — und ein nicht erkannter Paragraf führt nur dazu, dass
 * OfficeTakt vorsichtiger ist.
 */
const RECHTSREFERENZ =
  /§?\s*(\d{1,3})\s*([a-h])?\s*(?:abs(?:atz)?\.?\s*(\d{1,2})\s*)?(?:s(?:atz)?\.?\s*\d{1,2}\s*)?(estg|ustg|einkommensteuergesetz|umsatzsteuergesetz)/g;

export function readLegalReferences(text: string): SemanticLegalReference[] {
  const gefunden: SemanticLegalReference[] = [];
  const gesehen = new Set<string>();

  for (const treffer of normalisiere(text).matchAll(RECHTSREFERENZ)) {
    const gesetz = GESETZE[treffer[4] ?? ''];
    if (!gesetz) continue;
    const paragraph = `${treffer[1]}${treffer[2] ?? ''}`;
    const subsection = treffer[3];
    const schluessel = `${gesetz}|${paragraph}|${subsection ?? ''}`;
    if (gesehen.has(schluessel)) continue;
    gesehen.add(schluessel);
    gefunden.push({ law: gesetz, paragraph, ...(subsection ? { subsection } : {}) });
  }

  return gefunden;
}

/* ------------------------------------------------------------------ *
 * Formularkennung
 * ------------------------------------------------------------------ */

/**
 * „USt 1 TG" und „USt 1 TS" in den Schreibweisen, die aus einer Texterkennung
 * herauskommen: mit Abständen, ohne Abstände, mit getrennten Buchstaben.
 *
 * Das abschliessende `\b` ist wichtig: Ohne es fände „ust 1 tg" auch in
 * „USt 1 TGesamt" statt.
 */
const FORMULARKENNUNG = /\bust\s*\.?\s*1\s*t\s*([gs])\b/g;

export function readFormIds(text: string): string[] {
  const gefunden = new Set<string>();
  for (const treffer of normalisiere(text).matchAll(FORMULARKENNUNG)) {
    gefunden.add(treffer[1] === 'g' ? 'USt 1 TG' : 'USt 1 TS');
  }
  return [...gefunden];
}

/* ------------------------------------------------------------------ *
 * Starke Merkmale je Art
 * ------------------------------------------------------------------ */

const TITEL_FREISTELLUNG = /freistellungsbescheinigung/;
const TITEL_STEUERABZUG = /steuerabzug bei bauleistungen/;
const TITEL_STEUERSCHULDNERSCHAFT = /steuerschuldnerschaft des leistungsempf(ä|ae)ngers/;
const TITEL_ANSAESSIGKEIT = /ans(ä|ae)ssigkeit im inland/;

function hatReferenz(
  referenzen: readonly SemanticLegalReference[],
  law: string,
  paragraph: string,
  subsection?: string,
): boolean {
  return referenzen.some(
    (ref) =>
      ref.law === law &&
      ref.paragraph === paragraph &&
      (subsection === undefined || ref.subsection === subsection),
  );
}

/**
 * Die starken Merkmale je Art — und nur die.
 *
 * `§ 13b UStG` **ohne** Absatz steht absichtlich bei keiner der beiden
 * Umsatzsteuer-Bescheinigungen: Es trennt sie nicht, und ein Werkvertrag mit
 * Reverse-Charge-Hinweis trägt es ebenso. Erst der Absatz oder die
 * Formularkennung sagt, um welches Papier es geht.
 */
function starkeMerkmale(
  text: string,
  referenzen: readonly SemanticLegalReference[],
  formIds: readonly string[],
): Record<SemanticCertificateType, number> {
  const normal = normalisiere(text);
  return {
    construction_withholding_exemption:
      zaehle(TITEL_FREISTELLUNG.test(normal)) +
      zaehle(hatReferenz(referenzen, 'EStG', '48b')) +
      zaehle(TITEL_STEUERABZUG.test(normal)),
    reverse_charge_construction_status:
      zaehle(formIds.includes('USt 1 TG')) +
      zaehle(TITEL_STEUERSCHULDNERSCHAFT.test(normal)) +
      zaehle(hatReferenz(referenzen, 'UStG', '13b', '5')),
    domestic_establishment:
      zaehle(formIds.includes('USt 1 TS')) +
      zaehle(TITEL_ANSAESSIGKEIT.test(normal)) +
      zaehle(hatReferenz(referenzen, 'UStG', '13b', '7')),
  };
}

function zaehle(bedingung: boolean): number {
  return bedingung ? 1 : 0;
}

/* ------------------------------------------------------------------ *
 * Die Entscheidung
 * ------------------------------------------------------------------ */

/**
 * Erkennt die Bescheinigungsart, oder sagt ehrlich, dass sie offen ist.
 *
 * Die Stufen folgen dem bestehenden Evidenzmodell:
 *
 *   `detected`    — zwei starke Merkmale derselben Art stützen sich.
 *   `proposed`    — genau ein starkes Merkmal, und nichts widerspricht.
 *   `conflicting` — starke Merkmale **verschiedener** Arten. Hier wird nicht
 *                   gewichtet und nicht entschieden; wer zwischen § 48b und
 *                   § 13b würfelt, hat schon verloren.
 *   `uncertain`   — nur schwache Spuren wie ein Paragraf ohne Absatz.
 *
 * Gibt `undefined` zurück, wenn im Text nichts steht, das auf eine
 * Bescheinigung hindeutet — der Normalfall.
 */
export function recognizeCertificate(text: string): SemanticCertificate | undefined {
  if (!text?.trim()) return undefined;

  const legalReferences = readLegalReferences(text);
  const formIds = readFormIds(text);
  const merkmale = starkeMerkmale(text, legalReferences, formIds);

  const arten = (Object.keys(merkmale) as SemanticCertificateType[]).filter(
    (art) => merkmale[art] > 0,
  );
  const formId = formIds.length === 1 ? formIds[0] : undefined;
  const beleg = belegstelle(text, formIds, legalReferences);

  /* Widerspruch: mehrere Arten haben starke Merkmale. Nicht raten. */
  if (arten.length > 1) {
    return { legalReferences, ...(formId ? { formId } : {}), certainty: 'conflicting', ...beleg };
  }

  /* Auch zwei verschiedene Formularkennungen im selben Text sind ein Widerspruch. */
  if (formIds.length > 1) {
    return { legalReferences, certainty: 'conflicting', ...beleg };
  }

  if (arten.length === 1) {
    const art = arten[0]!;
    return {
      type: art,
      legalReferences,
      ...(formId ? { formId } : {}),
      certainty: merkmale[art] >= 2 ? 'detected' : 'proposed',
      ...beleg,
    };
  }

  /*
   * Kein starkes Merkmal. Eine Rechtsreferenz allein macht noch keine
   * Bescheinigung — ein Werkvertrag mit „§ 13b UStG" ist ein Vertrag.
   * Trotzdem wird die Spur festgehalten, damit sichtbar bleibt, worauf die
   * Zurückhaltung beruht.
   */
  if (legalReferences.length === 0) return undefined;
  return { legalReferences, certainty: 'uncertain', ...beleg };
}

/** Die Belegstelle: der Satz, in dem das stärkste Merkmal gefunden wurde. */
function belegstelle(
  text: string,
  formIds: readonly string[],
  referenzen: readonly SemanticLegalReference[],
): { evidence?: { snippet: string } } {
  const suchbegriffe = [
    ...formIds.map((id) => id.toLowerCase().replace(/\s+/g, '\\s*')),
    ...referenzen.map((ref) => `${ref.paragraph}\\s*${ref.law.toLowerCase()}`),
    'freistellungsbescheinigung',
  ];

  const normal = normalisiere(text);
  for (const begriff of suchbegriffe) {
    const treffer = normal.search(new RegExp(begriff));
    if (treffer < 0) continue;
    const start = Math.max(0, treffer - 60);
    return { evidence: { snippet: text.slice(start, start + 160).trim() } };
  }
  return {};
}

/* ------------------------------------------------------------------ *
 * Was die Erkennung für andere bedeutet
 * ------------------------------------------------------------------ */

/**
 * Ist die erkannte Art belastbar genug, um daraus etwas zu folgern?
 *
 * `conflicting` und `uncertain` sind es ausdrücklich nicht. Sie dürfen weder
 * eine Auskunft tragen noch eine andere blockieren — sie bedeuten schlicht,
 * dass OfficeTakt es nicht weiss.
 */
export function isCertificateTypeReliable(certificate: SemanticCertificate | undefined): boolean {
  if (!certificate?.type) return false;
  return certificate.certainty === 'detected' || certificate.certainty === 'proposed';
}

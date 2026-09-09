import { readFileSync } from 'node:fs';

/**
 * OFFICEPILOT-LOCAL-E2E-TESTWORLD-COMPANY-ALIGNMENT-01B — wer den Testworkspace
 * betreibt.
 *
 * Die Gold-Dokumente sind für eine bestimmte Betreiberfirma geschrieben. Läuft
 * der Testworkspace unter einer anderen Identität, hält OfficePilot ein
 * Vertragsdokument zu Recht für nicht betriebsrelevant und sperrt die
 * Auftragsannahme — genau daran ist der erste Vorgang-Versuch gescheitert.
 * Nicht am Produkt, sondern an einer falschen Annahme im Testaufbau.
 *
 * ⚠️ Die Grenze, auf der alles beruht:
 *
 * **Erlaubt** ist die Antwort auf „wer betreibt diesen Workspace?" — das sind
 * Stammdaten, so wie ein echter Betrieb sie einmal einträgt.
 *
 * **Nicht erlaubt** wäre die Antwort auf „was hat OfficePilot im Dokument
 * erkannt?". Relevanz, Klassifikation, Extraktion, Kunde und Vorgang entstehen
 * weiterhin ausschliesslich im Produktivcode aus echtem Dokumenttext.
 *
 * Die Firmenwerte stehen deshalb **nirgends** in diesem Modul: Sie werden zur
 * Laufzeit aus der Testwelt gelesen. `COMPANY-001.json` bleibt die einzige
 * Quelle; eine Kopie im Testcode würde beim nächsten Update lautlos veralten.
 */

const COMPANY_001_PATH = 'test-world/companies/COMPANY-001.json';

/**
 * Die Felder der Testwelt, die es in ein `CompanyProfile` schaffen.
 *
 * Bewusst eine geschlossene Struktur und kein beliebiges Objekt: Über diese
 * Schnittstelle sollen Betreiber-Stammdaten in den Testworkspace gelangen —
 * niemals Kunden, Vorgänge, Dokumente oder Rechnungen. Was hier nicht steht,
 * lässt sich auch nicht einschleusen.
 */
export interface WorkspaceCompanyIdentity {
  companyName: string;
  street: string;
  zip: string;
  city: string;
  country: string;
  phone: string;
  email: string;
  website: string;
  vatId: string;
  taxNumber: string;
  iban: string;
  bic: string;
  bankName: string;
}

/** Rohform der Testweltdatei — nur die Felder, die wir übernehmen. */
interface TestWorldCompanyFile {
  legalName?: string;
  street?: string;
  zip?: string;
  city?: string;
  country?: string;
  phone?: string;
  email?: string;
  website?: string;
  vatId?: string;
  taxNumber?: string;
  iban?: string;
  bic?: string;
  bankName?: string;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Liest COMPANY-001 und bildet sie auf die Felder ab, die `CompanyProfile`
 * tatsächlich kennt.
 *
 * `legalName` wird zu `companyName` — die Rechtsform ist die Identität, nach
 * der auch `checkCompanyRelevance` im Dokumenttext sucht. `tradeName`,
 * `commercialRegister`, `bgBauMemberNumber`, `sokaBauNumber`, `trades`,
 * `defaultBranchId`, `notes` und `id` haben in `CompanyProfile` keine
 * Entsprechung und werden **nicht** künstlich untergebracht.
 */
export function loadTestWorldOperatorCompany(
  path: string = COMPANY_001_PATH,
): WorkspaceCompanyIdentity {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as TestWorldCompanyFile;

  const identity: WorkspaceCompanyIdentity = {
    companyName: text(raw.legalName),
    street: text(raw.street),
    zip: text(raw.zip),
    city: text(raw.city),
    country: text(raw.country),
    phone: text(raw.phone),
    email: text(raw.email),
    website: text(raw.website),
    vatId: text(raw.vatId),
    taxNumber: text(raw.taxNumber),
    iban: text(raw.iban),
    bic: text(raw.bic),
    bankName: text(raw.bankName),
  };

  /*
   * Fail-closed statt still weiterlaufen: Ohne Firmennamen fände die
   * Relevanzprüfung keinen Anker, der Bestätigungsknopf bliebe gesperrt, und
   * der Test scheiterte an einer Stelle, die den wahren Grund verdeckt.
   * Die Meldung nennt bewusst nur den Feldnamen, nie einen Wert.
   */
  if (!identity.companyName.trim()) {
    throw new Error(
      `Die Testwelt-Betreiberfirma (${path}) liefert kein "legalName" — ohne Firmenname ist kein Testworld-Fachflow möglich.`,
    );
  }

  return identity;
}

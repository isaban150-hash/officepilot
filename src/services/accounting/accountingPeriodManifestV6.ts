/**
 * P1-KORREKTUR A04-WEISS-R2 — Abschlussmanifest Fassung 6.
 *
 * Fassung 5 band Geld-, Steuer-, Skonto-, Status-, Datums- und Kontierungswerte, aber nicht die steuerliche Aussage
 * eines Eingangsbelegs über seine Aufteilung und Abziehbarkeit. Änderte jemand nach dem Abschluss den Vorsteuerabzug
 * („voll“ → „keiner“/„teilweise“) oder die Aufteilungsart („belegt“ → „gemischt“), änderte sich `buchungen.csv`, die
 * Revision blieb aber gültig — nach erneuter Kontierungsbestätigung sogar ohne jeden Hinweis (WEISS-Reproduktion).
 *
 * Fassung 6 = Fassung 5 und je E-Zeile drei weitere Felder:
 *
 *   E|…Fassung-5-Felder…|<steueraufteilung>|<vorsteuerabzug>|<abziehbar>
 *
 *   steueraufteilung  belegt | gemischt | steuerfrei | offen | altbestand_pruefen   (Rechnungen: leer)
 *   vorsteuerabzug    voll | teilweise | keiner, leer ohne belegte Steuer           (Rechnungen: leer)
 *   abziehbar         Cent, nur bei „teilweise“; sonst leer
 *
 * Kopfzeile `v=6|…`, Fingerabdruck `p6:<sha256>`. Der Server bildet denselben Text aus seinen Tabellen
 * (`workspace_fc_abschluss_projektion6`, Migration `p1_a04_steueraufteilung_server`) und nimmt neue Revisionen nur
 * noch in Fassung 6 an. Bestehende Revisionen (Fassung 1–5) bleiben unverändert und werden weiter nach ihrer eigenen
 * Fassung geprüft; für sie sperren Client und Server eine nachträgliche Änderung dieser Merkmale (Korrekturweg:
 * Monat wieder öffnen, neue Revision).
 *
 * Fassung 5 (`accountingPeriodManifestV5.ts`) bleibt bytegleich — der Aufbau hier nutzt sie und ergänzt nur.
 */
import { buildPeriodManifestV5, kanonText } from './accountingPeriodManifestV5';
import { sha256Hex } from './sha256';
import { toCents } from '../invoiceMoney';
import type { MonatsmappeModel } from '../steuerberater/monatsmappeModelService';
import type { AccountingPeriodManifest, AccountingPeriodManifestEntry } from '../../types/accountingPeriod';
import type { AccountingAssignment } from '../../types/accounting';

const vergleiche = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function cent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  return String(toCents(value));
}

/** Abziehbarer Betrag: leer statt „-“, wenn es keinen gibt (der Server ebenso). */
function centOderLeer(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  return String(toCents(value));
}

export function buildPeriodManifestV6(
  model: MonatsmappeModel,
  assignments: readonly AccountingAssignment[],
  chartOfAccounts: string,
): AccountingPeriodManifest {
  const v5 = buildPeriodManifestV5(model, assignments, chartOfAccounts);
  const steuer = new Map(
    [...model.ausgangsrechnungen, ...model.eingangsbelege, ...model.stornos].map((beleg) => [
      `${beleg.belegart}:${beleg.id}`,
      beleg.steuerAbschluss,
    ]),
  );
  const entries: AccountingPeriodManifestEntry[] = v5.entries.map((entry) => {
    const merkmale = entry.sourceType === 'expense' ? steuer.get(`${entry.belegart}:${entry.sourceId}`) : undefined;
    return {
      ...entry,
      steueraufteilung: merkmale?.steueraufteilung ?? '',
      vorsteuerabzug: merkmale?.vorsteuerabzug ?? '',
      abziehbareVorsteuer: merkmale?.abziehbareVorsteuer ?? null,
    };
  });
  return { ...v5, fingerprintVersion: 6, entries };
}

export function buildPeriodCanonicalTextV6(manifest: AccountingPeriodManifest): string {
  const zeilen = [`v=6|month=${kanonText(manifest.monthKey)}|chart=${kanonText(manifest.chartOfAccounts)}`];
  const e = [...manifest.entries].sort(
    (a, b) => vergleiche(a.sourceType, b.sourceType) || vergleiche(a.sourceId, b.sourceId) || vergleiche(a.belegart ?? '', b.belegart ?? ''),
  );
  for (const x of e) {
    zeilen.push(
      [
        'E', x.sourceType, x.sourceId, x.belegart ?? '', x.datum, cent(x.brutto), cent(x.netto), cent(x.steuer),
        cent(x.skontoAbzug ?? 0), x.belegStatus, x.kontenrahmen ?? '', x.accountNumber, x.taxTreatment, x.assignmentStatus,
        x.bookingText, x.steueraufteilung ?? '', x.vorsteuerabzug ?? '', centOderLeer(x.abziehbareVorsteuer),
      ]
        .map(kanonText)
        .join('|'),
    );
  }
  const p = [...(manifest.payments ?? [])].sort((a, b) => vergleiche(a.sourceType, b.sourceType) || vergleiche(a.sourceId, b.sourceId) || vergleiche(a.paymentId, b.paymentId));
  for (const x of p) {
    zeilen.push(['P', x.sourceType, x.sourceId, x.paymentId, x.datum, cent(x.betrag), cent(x.skontoAbzug ?? 0), x.zahlungsart ?? ''].map(kanonText).join('|'));
  }
  const m = [...(manifest.employeePayments ?? [])].sort((a, b) => vergleiche(a.paymentId, b.paymentId) || vergleiche(a.art, b.art));
  for (const x of m) {
    zeilen.push(['M', x.paymentId, x.art, x.datum, cent(x.betrag), x.kind, x.method, x.status].map(kanonText).join('|'));
  }
  const o = [...(manifest.offenePosten ?? [])].sort((a, b) => vergleiche(a.belegart, b.belegart) || vergleiche(a.belegId, b.belegId));
  for (const x of o) {
    zeilen.push(['O', x.belegart, x.belegId, x.datum, cent(x.brutto), cent(x.bezahlt), cent(x.offen), x.faelligAm].map(kanonText).join('|'));
  }
  return zeilen.join('\n');
}

export function buildPeriodFingerprintV6(manifest: AccountingPeriodManifest): string {
  return `p6:${sha256Hex(buildPeriodCanonicalTextV6(manifest))}`;
}

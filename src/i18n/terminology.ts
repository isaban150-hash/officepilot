/**
 * Central OfficePilot terminology – canonical German with TR/BG explanations.
 */

export type TerminologyCategory = 'institution' | 'document' | 'finance' | 'handwerk';

export interface TerminologyEntry {
  id: string;
  category: TerminologyCategory;
  de: string;
  deExplain: string;
  tr: string;
  bg: string;
  preserveGermanName?: boolean;
}

export const OFFICEPILOT_TERMINOLOGY: TerminologyEntry[] = [
  { id: 'finanzamt', category: 'institution', de: 'Finanzamt', deExplain: 'Die deutsche Steuerbehörde für Ihren Betrieb.', tr: 'Finanzamt (Almanya vergi dairesi)', bg: 'Finanzamt (немска данъчна служба)', preserveGermanName: true },
  { id: 'krankenkasse', category: 'institution', de: 'Krankenkasse', deExplain: 'Die gesetzliche Krankenversicherung für Sie und Ihre Mitarbeiter.', tr: 'Krankenkasse (Almanya sağlık sigortası)', bg: 'Krankenkasse (немска здравна каса)', preserveGermanName: true },
  { id: 'aok', category: 'institution', de: 'AOK', deExplain: 'Eine große gesetzliche Krankenkasse in Deutschland.', tr: 'AOK (Almanya sağlık sigortası)', bg: 'AOK (немска здравна каса)', preserveGermanName: true },
  { id: 'bg_bau', category: 'institution', de: 'BG BAU', deExplain: 'Berufsgenossenschaft der Bauwirtschaft – Unfallversicherung und Beiträge.', tr: 'BG BAU (Almanya inşaat meslek sigortası)', bg: 'BG BAU (немска строителна професионална застраховка)', preserveGermanName: true },
  { id: 'soka_bau', category: 'institution', de: 'SOKA-BAU', deExplain: 'Sozialkasse der Bauwirtschaft.', tr: 'SOKA-BAU (Almanya inşaat sosyal kasası)', bg: 'SOKA-BAU (немска строителна социална каса)', preserveGermanName: true },
  { id: 'handwerkskammer', category: 'institution', de: 'Handwerkskammer', deExplain: 'Die Kammer für Handwerksbetriebe in Ihrer Region.', tr: 'Handwerkskammer (Almanya zanaat odası)', bg: 'Handwerkskammer (немска занаятна камара)', preserveGermanName: true },
  { id: 'ihk', category: 'institution', de: 'IHK', deExplain: 'Industrie- und Handelskammer.', tr: 'IHK (Almanya ticaret ve sanayi odası)', bg: 'IHK (немска индустриално-търговска камара)', preserveGermanName: true },
  { id: 'berufsgenossenschaft', category: 'institution', de: 'Berufsgenossenschaft', deExplain: 'Träger der gesetzlichen Unfallversicherung.', tr: 'Berufsgenossenschaft (Almanya meslek sigortası)', bg: 'Berufsgenossenschaft (немска професионална застраховка)', preserveGermanName: true },
  { id: 'zoll', category: 'institution', de: 'Zoll', deExplain: 'Die deutsche Zollbehörde.', tr: 'Zoll (Almanya gümrük idaresi)', bg: 'Zoll (немска митница)', preserveGermanName: true },
  { id: 'steuerberater', category: 'institution', de: 'Steuerberater', deExplain: 'Ihr Fachberater für Steuern und Buchhaltung.', tr: 'Steuerberater (Almanya mali müşavir)', bg: 'Steuerberater (немски данъчен консултант)', preserveGermanName: true },
  { id: 'eingangsrechnung', category: 'finance', de: 'Eingangsrechnung', deExplain: 'Rechnung von einem Lieferanten.', tr: 'Gelen fatura', bg: 'Входяща фактура' },
  { id: 'ausgangsrechnung', category: 'finance', de: 'Ausgangsrechnung', deExplain: 'Rechnung an einen Kunden.', tr: 'Giden fatura', bg: 'Изходяща фактура' },
  { id: 'abschlagsrechnung', category: 'finance', de: 'Abschlagsrechnung', deExplain: 'Zwischenrechnung während eines Auftrags.', tr: 'Hakediş faturası', bg: 'Междинна фактура' },
  { id: 'schlussrechnung', category: 'finance', de: 'Schlussrechnung', deExplain: 'Letzte Rechnung nach Auftragsabschluss.', tr: 'Kesin fatura', bg: 'Окончателна фактура' },
  { id: 'gutschrift', category: 'finance', de: 'Gutschrift', deExplain: 'Beleg mit Rückerstattung oder Erlass.', tr: 'Alacak dekontu', bg: 'Кредитно известие' },
  { id: 'mahnung', category: 'finance', de: 'Mahnung', deExplain: 'Schreiben wegen überfälliger Zahlung.', tr: 'İhtar', bg: 'Напомнително писмо' },
  { id: 'zahlungserinnerung', category: 'finance', de: 'Zahlungserinnerung', deExplain: 'Erinnerung vor einer Mahnung.', tr: 'Ödeme hatırlatması', bg: 'Предупредително напомняне' },
  { id: 'kontoauszug', category: 'finance', de: 'Kontoauszug', deExplain: 'Übersicht Ihrer Bankbuchungen.', tr: 'Banka ekstresi', bg: 'Банково извлечение' },
  { id: 'tankbeleg', category: 'finance', de: 'Tankbeleg', deExplain: 'Beleg für Kraftstoff.', tr: 'Yakıt fişi', bg: 'Бележка за гориво' },
  { id: 'hotelrechnung', category: 'finance', de: 'Hotelrechnung', deExplain: 'Rechnung für Hotelübernachtung.', tr: 'Otel faturası', bg: 'Хотелска фактура' },
  { id: 'materialrechnung', category: 'finance', de: 'Materialrechnung', deExplain: 'Rechnung für Material.', tr: 'Malzeme faturası', bg: 'Фактура за материали' },
  { id: 'werkvertrag', category: 'handwerk', de: 'Werkvertrag', deExplain: 'Vertrag über Handwerksleistungen.', tr: 'İş sözleşmesi (Werkvertrag)', bg: 'Договор за строителни работи (Werkvertrag)', preserveGermanName: true },
  { id: 'leistungsverzeichnis', category: 'handwerk', de: 'Leistungsverzeichnis', deExplain: 'Liste aller Leistungspositionen.', tr: 'Hizmet listesi (Leistungsverzeichnis)', bg: 'Количествена сметка (Leistungsverzeichnis)', preserveGermanName: true },
  { id: 'aufmasz', category: 'handwerk', de: 'Aufmaß', deExplain: 'Ermittlung ausgeführter Mengen.', tr: 'Metraj (Aufmaß)', bg: 'Обмер (Aufmaß)', preserveGermanName: true },
  { id: 'nachtrag', category: 'handwerk', de: 'Nachtrag', deExplain: 'Zusätzliche Leistung außerhalb des Vertrags.', tr: 'Ek iş (Nachtrag)', bg: 'Допълнителна работа (Nachtrag)', preserveGermanName: true },
  { id: 'abnahme', category: 'handwerk', de: 'Abnahme', deExplain: 'Formelle Übergabe der Leistung.', tr: 'Teslim alma (Abnahme)', bg: 'Приемане (Abnahme)', preserveGermanName: true },
  { id: 'gewaehrleistung', category: 'handwerk', de: 'Gewährleistung', deExplain: 'Zeitraum für Mängelbeseitigung.', tr: 'Garanti süresi (Gewährleistung)', bg: 'Гаранция (Gewährleistung)', preserveGermanName: true },
  { id: 'baustelle', category: 'handwerk', de: 'Baustelle', deExplain: 'Ort der Ausführung.', tr: 'Şantiye', bg: 'Строителен обект' },
  { id: 'auftraggeber', category: 'handwerk', de: 'Auftraggeber', deExplain: 'Kunde, der den Auftrag erteilt.', tr: 'İşveren', bg: 'Възложител' },
  { id: 'auftragnehmer', category: 'handwerk', de: 'Auftragnehmer', deExplain: 'Betrieb, der die Leistung erbringt.', tr: 'Yüklenici', bg: 'Изпълнител' },
];

const terminologyById = new Map(OFFICEPILOT_TERMINOLOGY.map((e) => [e.id, e]));

export function getTerminologyEntry(id: string): TerminologyEntry | undefined {
  return terminologyById.get(id);
}

export function getTerminologyLabel(id: string, lang: 'de' | 'tr' | 'bg'): string | undefined {
  const entry = terminologyById.get(id);
  if (!entry) return undefined;
  if (lang === 'de') return entry.de;
  if (lang === 'tr') return entry.tr;
  return entry.bg;
}

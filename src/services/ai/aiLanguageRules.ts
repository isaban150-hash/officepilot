import type { AppLanguage } from '../../types/models';

const LANGUAGE_INSTRUCTIONS: Record<AppLanguage, string> = {
  de: 'Antworte auf Deutsch in klarer Alltagssprache (Sie-Form).',
  tr: 'Türkçe yanıt verin. Alman kurum adlarını (Finanzamt, BG BAU, Krankenkasse, SOKA-BAU, Steuerberater) değiştirmeyin; gerekirse parantez içinde kısaca açıklayın.',
  bg: 'Отговаряйте на български. Запазете немските имена на институциите (Finanzamt, BG BAU, Krankenkasse, SOKA-BAU, Steuerberater); при нужда обяснете накратко в скоби.',
  ro: 'Răspundeți în română. Păstrați denumirile instituțiilor germane.',
  ru: 'Отвечайте на русском. Сохраняйте немецкие названия учреждений.',
};

export function buildAiLanguageInstruction(lang: AppLanguage = 'de'): string {
  return `ANTWORTSPRACHE:\n${LANGUAGE_INSTRUCTIONS[lang] ?? LANGUAGE_INSTRUCTIONS.de}`;
}

export function getAiResponseLanguageCode(lang: AppLanguage = 'de'): string {
  switch (lang) {
    case 'tr':
      return 'tr';
    case 'bg':
      return 'bg';
    case 'ro':
      return 'ro';
    case 'ru':
      return 'ru';
    default:
      return 'de';
  }
}

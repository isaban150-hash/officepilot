export type DocumentAiNature = 'test_or_sample' | 'unknown';

/** Conservative DE/TR/BG markers for test, sample, demo, or draft documents. */
const TEST_OR_SAMPLE_PATTERN =
  /(?:testdokument|testrechnung|musterrechnung|testdaten|test\b|muster\b|demo\b|entwurf\b|beispiel\b|keine\s+echte\s+forderung|nicht\s+zur\s+zahlung\s+bestimmt|fiktiv|örnek\s+fatura|test\s+fatura|örnek\s+belge|taslak\b|demo\s+fatura|gerçek\s+bir\s+alacak\s+değil|ödeme\s+için\s+değil|тестов\s+документ|тестова\s+фактура|образец\b|демо\b|чернова\b|пример\b|няма\s+истинско\s+вземане|не\s+е\s+за\s+плащане)/iu;

/**
 * Runtime-only document nature from title + recognized text.
 * Not persisted; no storage migration.
 */
export function detectDocumentNature(input: {
  title?: string | null;
  recognizedText?: string | null;
}): DocumentAiNature {
  const haystack = `${input.title ?? ''}\n${input.recognizedText ?? ''}`.trim();
  if (!haystack) return 'unknown';
  return TEST_OR_SAMPLE_PATTERN.test(haystack) ? 'test_or_sample' : 'unknown';
}

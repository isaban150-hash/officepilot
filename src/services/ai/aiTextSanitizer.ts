const SENSITIVE_VALUE_PATTERNS = [
  /\bDE\d{2}\s?(?:\d{4}\s?){4}\d{2,4}\b/gi,
  /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/gi,
  /\b\d{2,3}\/\d{3,5}\/\d{4,5}\b/g,
  /\bDE\d{9}\b/gi,
  /\bUSt[-\s]?Id\.?\s*Nr\.?\s*:?\s*DE\d{9}\b/gi,
  /\bSteuernummer\s*:?\s*[\d/]+\b/gi,
];

export function sanitizeAiText(text: string): string {
  let sanitized = text;
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[entfernt]');
  }
  return sanitized;
}

export function containsSensitiveFactKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return /iban|bic|steuernummer|ust|vat|bank/.test(normalized);
}

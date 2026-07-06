/** Rechtlich zu prüfende Entwurfsversionen – vor Kundenstart durch Anwalt aktualisieren. */
export const TERMS_VERSION = '1.0-draft';
export const PRIVACY_VERSION = '1.0-draft';
export const LICENSE_VERSION = '1.0-draft';

export const LEGAL_DRAFT_NOTICE = 'Entwurf – muss rechtlich geprüft werden.';

export const LEGAL_DOCUMENT_VERSIONS = {
  terms: TERMS_VERSION,
  privacy: PRIVACY_VERSION,
  license: LICENSE_VERSION,
} as const;

export const deIntakePreview = {
  'document.intakePreview.pendingNotice':
    'Dokument wurde verarbeitet, aber noch nicht dauerhaft gespeichert.',
  'document.intakePreview.savePermanently': 'Dauerhaft speichern',
  'document.intakePreview.discard': 'Nicht speichern',
} as const;

/** SCAN-OCR-EVIDENCE-01B2 — Belegstatus sichtbarer Dokumentfakten. */
export const deDocumentFacts = {
  'documentIntelligence.workspace.factStatusLabel': 'Angabe',
  'documentFacts.status.missingValue': 'Kein Wert erkannt',
  'documentFacts.status.unreadable': 'Nicht sicher erkannt',
  'documentFacts.status.ambiguous': 'Mehrdeutige Angabe – bitte prüfen',
  'documentFacts.status.partial': 'Nur teilweise prüfbar',
  'documentFacts.status.aiSuggestion': 'KI-Vorschlag – bitte prüfen',
} as const;

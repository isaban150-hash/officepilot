import type {
  AnalysisConfidence,
  ClassifiedDocumentKind,
  ContractActionId,
  ContractAnalysisInput,
  ContractAnalysisResult,
  ContractExtractedFields,
  ContractSuggestedAction,
  ContractType,
  DetectedOrderPosition,
  DetectedPaymentTerm,
  InboxItem,
  InboxPriority,
  RequiredDocument,
  SignaturePage,
  UploadDocumentKind,
} from '../types/models';

export const SAMPLE_WERKVERTRAG_TEXT = `
Werkvertrag

Auftraggeber: Müller Bau GmbH
Subunternehmer: Mustermann Sanitär GmbH
Bauvorhaben: Badezimmer-Sanierung Müller
Baustellenadresse: Hauptstr. 12, 10115 Berlin
Projektname: Projekt Müller-Bad
Leistungszeitraum: 01.05.2026 – 30.06.2026
Vertragsdatum: 15.03.2026
Auftragsnummer: AV-2026-0042
Bestellnummer: B-7712
Ansprechpartner: Herr Schmidt
Telefon: 030 1234567
E-Mail: schmidt@mueller-bau.de

Leistungsverzeichnis
Pos. | Beschreibung | Einheit | Menge | EP | GP
1 | Demontage Badewanne | Stk | 1 | 450,00 | 450,00
2 | Fliesenarbeiten Wand | m² | 28 | 65,00 | 1.820,00
3 | Sanitärinstallation | psch | 1 | 2.800,00 | 2.800,00

Zahlungsbedingungen: 14 Tage netto, 2 % Skonto bei Zahlung innerhalb 7 Tagen
Abschlagsrechnungen sind wöchentlich möglich. Schlussrechnung nach Abnahme.

Nachweise erforderlich:
Freistellungsbescheinigung, BG BAU Unbedenklichkeitsbescheinigung, SOKA-BAU, AOK, Betriebshaftpflicht

Unterschrift Auftraggeber
Ort, Datum: ___________
Unterschrift Auftragnehmer
`.trim();

export const SAMPLE_SUBUNTERNEHMERVERTRAG_TEXT = `
Subunternehmervertrag

Auftraggeber: Großbau AG
Nachunternehmer: Klempner Meier OHG
Bauvorhaben: Neubau Schule Nord
Baustelle: Schulweg 5, 80331 München
Vertragsdatum: 20.02.2026
Auftragsnummer: SU-2026-118

Pos. Beschreibung Einheit Menge Einzelpreis Gesamtpreis
1 Rohrleitungsarbeiten m 120 42,50 5.100,00
2 Heizungsanschluss Stk 4 380,00 1.520,00

Zahlungsziel: 30 Tage netto. Abschlagsrechnung möglich.

Freistellungsbescheinigung und BG BAU erforderlich.

Unterschrift Auftraggeber    Unterschrift Auftragnehmer
`.trim();

interface ContractTypeRule {
  type: ContractType;
  pattern: RegExp;
  confidence: AnalysisConfidence;
  reason: string;
}

const CONTRACT_TYPE_RULES: ContractTypeRule[] = [
  {
    type: 'subunternehmervertrag',
    pattern: /subunternehmervertrag|subunternehmer[\s-]?vertrag/i,
    confidence: 'high',
    reason: 'Bezeichnung „Subunternehmervertrag“ im Text gefunden',
  },
  {
    type: 'nachunternehmervertrag',
    pattern: /nachunternehmervertrag|nachunternehmer[\s-]?vertrag/i,
    confidence: 'high',
    reason: 'Bezeichnung „Nachunternehmervertrag“ im Text gefunden',
  },
  {
    type: 'werkvertrag',
    pattern: /werkvertrag|werk[\s-]?vertrag/i,
    confidence: 'high',
    reason: 'Bezeichnung „Werkvertrag“ im Text gefunden',
  },
  {
    type: 'bauvertrag',
    pattern: /bauvertrag|bau[\s-]?vertrag|vob[\s-]?vertrag/i,
    confidence: 'high',
    reason: 'Bezeichnung „Bauvertrag“ im Text gefunden',
  },
  {
    type: 'leistungsverzeichnis',
    pattern: /leistungsverzeichnis|\blv\b|pos\.\s*beschreibung\s+einheit/i,
    confidence: 'medium',
    reason: 'Leistungsverzeichnis oder Positionstabelle erkannt',
  },
  {
    type: 'auftrag',
    pattern: /kundenauftrag|auftragsbestätigung|auftrag\s+erteilt|auftragserteilung|bestellung/i,
    confidence: 'medium',
    reason: 'Auftrags- oder Bestellbegriffe erkannt',
  },
];

const NON_CONTRACT_PATTERNS: RegExp[] = [
  /^[\s\S]*rechnungsnummer[\s\S]*$/i,
  /zahlungserinnerung|mahnung/i,
  /kontoauszug|kontoumsätze/i,
  /^(?!.*(vertrag|auftrag|bauvorhaben|leistungsverzeichnis)).*\bbrief\b.*$/i,
];

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

function buildHaystack(input: ContractAnalysisInput): string {
  const dataText = input.recognizedData
    ? Object.entries(input.recognizedData)
        .filter(([key]) => !key.startsWith('_'))
        .map(([, value]) => value)
        .join('\n')
    : '';

  return normalizeText(
    [
      input.recognizedText,
      dataText,
      input.titleHint ?? '',
      input.senderHint ?? '',
      input.sourceFileName ?? '',
      input.kindHint ?? '',
    ].join('\n'),
  );
}

function isLikelyNonContract(haystack: string, kindHint?: string): boolean {
  const lower = haystack.toLowerCase();

  if (kindHint === 'materialrechnung' || kindHint === 'zahlungserinnerung' || kindHint === 'rechnung') {
    return true;
  }
  if (kindHint === 'brief' && !/vertrag|auftrag|bauvorhaben|leistungsverzeichnis/.test(lower)) {
    return true;
  }

  const hasContractSignal = /werkvertrag|bauvertrag|subunternehmer|nachunternehmer|leistungsverzeichnis|bauvorhaben|auftragsnummer|vertragsdatum/.test(
    lower,
  );
  const hasInvoiceSignal = /rechnungsnummer|rechnungsdatum|zahlungsziel.*rechnung|invoice\s*no/i.test(lower);

  if (hasInvoiceSignal && !hasContractSignal) return true;
  if (/zahlungserinnerung|mahnung/.test(lower) && !hasContractSignal) return true;
  if (/kontoauszug/.test(lower) && !hasContractSignal) return true;

  for (const pattern of NON_CONTRACT_PATTERNS) {
    if (pattern.test(haystack) && !hasContractSignal) return true;
  }

  return false;
}

function detectContractType(
  haystack: string,
  kindHint?: string,
): { type: ContractType | null; confidence: AnalysisConfidence; reason: string } {
  if (kindHint === 'auftrag') {
    return {
      type: 'auftrag',
      confidence: 'high',
      reason: 'Upload als Auftrag/Werkvertrag markiert',
    };
  }

  for (const rule of CONTRACT_TYPE_RULES) {
    if (rule.pattern.test(haystack)) {
      return { type: rule.type, confidence: rule.confidence, reason: rule.reason };
    }
  }

  if (/bauvorhaben|auftraggeber.*subunternehmer|vertragsdatum/i.test(haystack)) {
    return {
      type: 'werkvertrag',
      confidence: 'medium',
      reason: 'Typische Vertragsfelder (Bauvorhaben, Parteien, Vertragsdatum) erkannt',
    };
  }

  return { type: null, confidence: 'low', reason: 'Kein Vertragsmuster erkannt' };
}

function extractField(text: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]?.trim()) return match[1].trim().split('\n')[0].trim();
  }
  return undefined;
}

function extractContractFields(text: string, input: ContractAnalysisInput): ContractExtractedFields {
  const data = input.recognizedData ?? {};

  return {
    auftraggeber:
      extractField(text, [/Auftraggeber[:\s]+([^\n]+)/i, /Auftraggeberin[:\s]+([^\n]+)/i]) ??
      data.Kunde ??
      data.Auftraggeber,
    subunternehmer:
      extractField(text, [
        /Subunternehmer[:\s]+(.+)/i,
        /Nachunternehmer[:\s]+(.+)/i,
        /Auftragnehmer[:\s]+(.+)/i,
      ]) ?? data.Subunternehmer,
    bauvorhaben:
      extractField(text, [/Bauvorhaben[:\s]+(.+)/i]) ?? data.Leistung ?? data.Bauvorhaben,
    baustellenadresse:
      extractField(text, [/Baustellenadresse[:\s]+(.+)/i, /Baustelle[:\s]+(.+)/i]) ??
      data.Baustelle,
    projektname: extractField(text, [/Projektname[:\s]+(.+)/i, /Projekt[:\s]+(.+)/i]),
    leistungszeitraum:
      extractField(text, [/Leistungszeitraum[:\s]+(.+)/i, /Ausführungszeitraum[:\s]+(.+)/i]) ??
      data['Gewünschter Start'],
    vertragsdatum: extractField(text, [/Vertragsdatum[:\s]+(.+)/i, /Datum[:\s]+(\d{1,2}\.\d{1,2}\.\d{4})/i]),
    auftragsnummer: extractField(text, [/Auftragsnummer[:\s]+(.+)/i, /Auftrag\s*Nr\.?[:\s]+(.+)/i]),
    bestellnummer: extractField(text, [/Bestellnummer[:\s]+(.+)/i, /Bestell[\s-]?Nr\.?[:\s]+(.+)/i]),
    ansprechpartner:
      extractField(text, [/Ansprechpartner[:\s]+(.+)/i, /Ansprechpartnerin[:\s]+(.+)/i]) ??
      data.Ansprechpartner,
    telefon: extractField(text, [/Telefon[:\s]+(.+)/i, /Tel\.?[:\s]+(.+)/i]),
    email: extractField(text, [/E[\s-]?Mail[:\s]+(.+)/i, /Email[:\s]+(.+)/i]),
  };
}

function parseGermanAmount(value: string): number {
  const cleaned = value.replace(/\./g, '').replace(',', '.').replace(/[^\d.]/g, '');
  const parsed = parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function detectOrderPositions(text: string): DetectedOrderPosition[] {
  const positions: DetectedOrderPosition[] = [];
  const linePattern =
    /^(\d+)\s*[|]\s*(.+?)\s*[|]\s*(\S+)\s*[|]\s*([\d.,]+)\s*[|]\s*([\d.,]+)\s*[|]\s*([\d.,]+)\s*$/gm;
  let match: RegExpExecArray | null;

  while ((match = linePattern.exec(text)) !== null) {
    positions.push({
      positionNumber: match[1],
      description: match[2].trim(),
      unit: match[3].trim(),
      quantity: parseGermanAmount(match[4]),
      unitPrice: parseGermanAmount(match[5]),
      lineTotal: parseGermanAmount(match[6]),
    });
  }

  const altPattern =
    /^(\d+)\s+(.+?)\s+(Stk|m²|m2|m|psch|Std|h|LE)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)\s*$/gim;
  while ((match = altPattern.exec(text)) !== null) {
    if (positions.some((p) => p.positionNumber === match![1])) continue;
    positions.push({
      positionNumber: match[1],
      description: match[2].trim(),
      unit: match[3].trim(),
      quantity: parseGermanAmount(match[4]),
      unitPrice: parseGermanAmount(match[5]),
      lineTotal: parseGermanAmount(match[6]),
    });
  }

  return positions;
}

function detectPaymentTerms(text: string): DetectedPaymentTerm[] {
  const terms: DetectedPaymentTerm[] = [];

  const net14 = text.match(/14\s*tage\s*netto/i);
  if (net14) {
    terms.push({ type: 'net_days', label: '14 Tage netto', value: '14' });
  }

  const net30 = text.match(/30\s*tage\s*netto/i);
  if (net30) {
    terms.push({ type: 'net_days', label: '30 Tage netto', value: '30' });
  }

  const skonto = text.match(/(\d+)\s*%\s*skonto/i);
  if (skonto) {
    terms.push({ type: 'skonto', label: `${skonto[1]} % Skonto`, value: skonto[1] });
  }

  if (/abschlagsrechnung\s*(ist\s*)?(möglich|zulässig|vereinbart)/i.test(text)) {
    terms.push({ type: 'abschlag', label: 'Abschlagsrechnung möglich' });
  }

  if (/wöchentlich(e|en)?\s+abschläge|abschlagsrechnungen\s+sind\s+wöchentlich/i.test(text)) {
    terms.push({ type: 'weekly_abschlag', label: 'Wöchentliche Abschläge' });
  }

  if (/schlussrechnung/i.test(text)) {
    terms.push({ type: 'schlussrechnung', label: 'Schlussrechnung vorgesehen' });
  }

  const zahlungsziel = text.match(/zahlungsziel[:\s]+(.+)/i);
  if (zahlungsziel) {
    terms.push({ type: 'payment_due', label: 'Zahlungsziel', value: zahlungsziel[1].trim() });
  }

  return terms;
}

const REQUIRED_DOC_RULES: Array<{
  type: string;
  pattern: RegExp;
  priority: InboxPriority;
  reason: string;
}> = [
  {
    type: 'freistellungsbescheinigung',
    pattern: /freistellungsbescheinigung/i,
    priority: 'hoch',
    reason: 'Im Vertrag als Nachweis genannt',
  },
  {
    type: 'bg_bau',
    pattern: /bg[\s-]?bau|unbedenklichkeitsbescheinigung/i,
    priority: 'hoch',
    reason: 'BG-BAU-Nachweis im Vertrag gefordert',
  },
  {
    type: 'soka_bau',
    pattern: /soka[\s-]?bau/i,
    priority: 'hoch',
    reason: 'SOKA-BAU-Nachweis im Vertrag gefordert',
  },
  {
    type: 'aok',
    pattern: /\baok\b/i,
    priority: 'mittel',
    reason: 'AOK-Nachweis im Vertrag gefordert',
  },
  {
    type: 'versicherung',
    pattern: /betriebshaftpflicht|haftpflichtversicherung/i,
    priority: 'hoch',
    reason: 'Haftpflichtnachweis im Vertrag gefordert',
  },
  {
    type: 'handelsregister',
    pattern: /handelsregister/i,
    priority: 'mittel',
    reason: 'Handelsregisterauszug im Vertrag gefordert',
  },
  {
    type: 'gewerbeanmeldung',
    pattern: /gewerbeanmeldung|gewerbenachweis/i,
    priority: 'mittel',
    reason: 'Gewerbenachweis im Vertrag gefordert',
  },
];

function detectRequiredDocuments(text: string): RequiredDocument[] {
  const found: RequiredDocument[] = [];
  const seen = new Set<string>();

  for (const rule of REQUIRED_DOC_RULES) {
    if (rule.pattern.test(text) && !seen.has(rule.type)) {
      seen.add(rule.type);
      found.push({ type: rule.type, priority: rule.priority, reason: rule.reason });
    }
  }

  return found;
}

function detectSignaturePages(text: string): SignaturePage[] {
  const pages: SignaturePage[] = [];
  const lower = text.toLowerCase();

  if (/unterschrift\s+auftraggeber/i.test(text)) {
    pages.push({
      pageHint: 'Unterschrift Auftraggeber',
      description: 'Signaturfeld Auftraggeber erkannt',
    });
  }
  if (/unterschrift\s+auftragnehmer/i.test(text)) {
    pages.push({
      pageHint: 'Unterschrift Auftragnehmer',
      description: 'Signaturfeld Auftragnehmer erkannt',
    });
  }
  if (/ort,\s*datum|datum,\s*ort/i.test(text)) {
    pages.push({
      pageHint: 'Ort / Datum',
      description: 'Ort- und Datumsfeld für Unterschrift erkannt',
    });
  }

  if (pages.length === 0 && lower.includes('unterschrift')) {
    pages.push({
      pageHint: 'Unterschriftsseite',
      description: 'Unterschriftsfeld im Dokument erkannt',
    });
  }

  return pages;
}

function suggestContractActions(
  contractType: ContractType,
  requiredDocuments: RequiredDocument[],
): ContractSuggestedAction[] {
  const actions: ContractSuggestedAction[] = [
    { id: 'create_vorgang', labelKey: 'contract.action.createVorgang', variant: 'primary' },
    { id: 'import_positions', labelKey: 'contract.action.importPositions', variant: 'secondary' },
  ];

  if (requiredDocuments.some((doc) => doc.type === 'freistellungsbescheinigung')) {
    actions.push({
      id: 'send_freistellung',
      labelKey: 'contract.action.sendFreistellung',
      variant: 'outline',
    });
  }
  if (requiredDocuments.some((doc) => doc.type === 'bg_bau')) {
    actions.push({ id: 'check_bg_bau', labelKey: 'contract.action.checkBgBau', variant: 'outline' });
  }
  if (requiredDocuments.some((doc) => doc.type === 'aok')) {
    actions.push({ id: 'send_aok', labelKey: 'contract.action.sendAok', variant: 'outline' });
  }

  actions.push({ id: 'archive_contract', labelKey: 'contract.action.archiveContract', variant: 'outline' });

  if (contractType === 'leistungsverzeichnis') {
    return actions.filter((a) => a.id !== 'send_freistellung' || requiredDocuments.length > 0);
  }

  return actions;
}

export function analyzeContract(input: ContractAnalysisInput): ContractAnalysisResult {
  const haystack = buildHaystack(input);
  const kindHint = input.kindHint;

  if (!haystack.trim()) {
    return emptyResult('Kein erkennbarer Text vorhanden');
  }

  if (isLikelyNonContract(haystack, kindHint)) {
    return emptyResult('Dokument entspricht eher Rechnung, Mahnung oder Brief – kein Werkvertrag');
  }

  const detection = detectContractType(haystack, kindHint);
  if (!detection.type) {
    return emptyResult(detection.reason);
  }

  const fields = extractContractFields(haystack, input);
  const positions = detectOrderPositions(haystack);
  const paymentTerms = detectPaymentTerms(haystack);
  const requiredDocuments = detectRequiredDocuments(haystack);
  const signaturePages = detectSignaturePages(haystack);
  const suggestedActions = suggestContractActions(detection.type, requiredDocuments);

  let confidence = detection.confidence;
  if (positions.length > 0 || fields.bauvorhaben) {
    confidence = confidence === 'low' ? 'medium' : confidence;
  }
  if (positions.length >= 2 && fields.auftraggeber && fields.baustellenadresse) {
    confidence = 'high';
  }

  const signatureHint =
    signaturePages.length > 0
      ? 'Diese Seiten müssen wahrscheinlich unterschrieben werden.'
      : undefined;

  return {
    isContract: true,
    contractType: detection.type,
    confidence,
    reason: detection.reason,
    fields,
    positions,
    paymentTerms,
    requiredDocuments,
    signaturePages,
    suggestedActions,
    signatureHint,
  };
}

function emptyResult(reason: string): ContractAnalysisResult {
  return {
    isContract: false,
    contractType: null,
    confidence: 'low',
    reason,
    fields: {},
    positions: [],
    paymentTerms: [],
    requiredDocuments: [],
    signaturePages: [],
    suggestedActions: [],
  };
}

export function buildContractAnalysisInputFromInbox(item: InboxItem): ContractAnalysisInput {
  const vertragstext =
    item.recognizedData._vertragstext ??
    item.recognizedData.Vertragstext ??
    '';

  return {
    recognizedText: vertragstext,
    sourceFileName: item.sourceFileName,
    titleHint: item.title,
    senderHint: item.sender,
    kindHint: item.classifiedKind ?? (item.documentType === 'kundenauftrag' ? 'auftrag' : undefined),
    recognizedData: item.recognizedData,
  };
}

export function analyzeContractFromInbox(item: InboxItem): ContractAnalysisResult {
  return analyzeContract(buildContractAnalysisInputFromInbox(item));
}

export function resolveMockContractText(kind?: UploadDocumentKind | ClassifiedDocumentKind): string {
  if (kind === 'auftrag') return SAMPLE_WERKVERTRAG_TEXT;
  return '';
}

export function isContractAnalysisAction(id: ContractActionId): boolean {
  return [
    'create_vorgang',
    'import_positions',
    'send_freistellung',
    'check_bg_bau',
    'send_aok',
    'archive_contract',
  ].includes(id);
}

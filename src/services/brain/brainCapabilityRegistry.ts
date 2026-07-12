import type { BrainCapabilityId, BrainCapabilityStatus } from '../../types/brainOrchestration';
import { HANDWERK_KNOWLEDGE_DETECT_PATTERNS } from './handwerkKnowledgeRegistry';

export interface BrainCapabilityDefinition {
  id: BrainCapabilityId;
  status: BrainCapabilityStatus;
  labelKey: string;
  detectPatterns: RegExp[];
  /** Bestehende Service-Module, die diese Fähigkeit heute abdecken */
  serviceModules?: string[];
}

const PLANNED_CAPABILITIES: BrainCapabilityDefinition[] = [
  {
    id: 'weather',
    status: 'planned',
    labelKey: 'brain.capability.weather',
    detectPatterns: [/wetter|regen|temperatur|bauwetter/i],
  },
  {
    id: 'finanzamt',
    status: 'planned',
    labelKey: 'brain.capability.finanzamt',
    detectPatterns: [/finanzamt.*(frist|termin|anmeldung)|umsatzsteuervoranmeldung/i],
  },
  {
    id: 'bg_bau',
    status: 'planned',
    labelKey: 'brain.capability.bgBau',
    detectPatterns: [/bg\s*bau.*(melde|frist|beitrag)/i],
  },
  {
    id: 'insurance',
    status: 'planned',
    labelKey: 'brain.capability.insurance',
    detectPatterns: [/versicherung.*(schaden|meldung|police)/i],
  },
  {
    id: 'datev',
    status: 'planned',
    labelKey: 'brain.capability.datev',
    detectPatterns: [/datev|buchungsstapel|kontenrahmen/i],
  },
  {
    id: 'vob',
    status: 'planned',
    labelKey: 'brain.capability.vob',
    detectPatterns: [/vob\/b.*(frist|termin|mängel|abnahme)|vob\/c.*(technisch|leistung)/i],
  },
  {
    id: 'material_prices',
    status: 'planned',
    labelKey: 'brain.capability.materialPrices',
    detectPatterns: [/materialpreis|zementpreis|holzpreis|aktuell.*preis/i],
  },
  {
    id: 'subsidies',
    status: 'planned',
    labelKey: 'brain.capability.subsidies',
    detectPatterns: [/förderprogramm|kfw|bafa|zuschuss/i],
  },
  {
    id: 'web_research',
    status: 'planned',
    labelKey: 'brain.capability.webResearch',
    detectPatterns: [/im internet|online recherch|google|websuche/i],
  },
];

const ACTIVE_CAPABILITIES: BrainCapabilityDefinition[] = [
  {
    id: 'documents',
    status: 'active',
    labelKey: 'brain.capability.documents',
    detectPatterns: [/dokument|brief|eingang|archiv|freistellung|nachweis/i],
    serviceModules: ['documentClassificationService', 'contractIntelligenceService', 'documentAiService'],
  },
  {
    id: 'communication',
    status: 'active',
    labelKey: 'brain.capability.communication',
    detectPatterns: [/schreib|formulier|antwort|nachricht|mail|whatsapp/i],
    serviceModules: ['communicationOrchestrator', 'communicationAiService'],
  },
  {
    id: 'vorgaenge',
    status: 'active',
    labelKey: 'brain.capability.vorgaenge',
    detectPatterns: [/vorgang|auftrag|baustelle|projekt/i],
    serviceModules: ['vorgangService', 'vorgangAiService', 'intakeWorkflowService'],
  },
  {
    id: 'invoices',
    status: 'active',
    labelKey: 'brain.capability.invoices',
    detectPatterns: [/rechnung|zahlung|offen|überfällig|skonto/i],
    serviceModules: ['invoiceService', 'invoiceOverviewService', 'financeIntelligenceService', 'financeKnowledgeResolver'],
  },
  {
    id: 'tasks',
    status: 'active',
    labelKey: 'brain.capability.tasks',
    detectPatterns: [/aufgabe|todo|heute erledigen|frist/i],
    serviceModules: ['taskEngineService', 'pendingEngineService'],
  },
  {
    id: 'memory',
    status: 'active',
    labelKey: 'brain.capability.memory',
    detectPatterns: [/wo liegt|ablage|register|original/i],
    serviceModules: ['memoryQueryService', 'officePilotMemoryService'],
  },
  {
    id: 'knowledge',
    status: 'active',
    labelKey: 'brain.capability.knowledge',
    detectPatterns: [/wissen|merke|firmenwissen/i],
    serviceModules: ['knowledgeService'],
  },
  {
    id: 'construction_knowledge',
    status: 'active',
    labelKey: 'brain.capability.constructionKnowledge',
    detectPatterns: HANDWERK_KNOWLEDGE_DETECT_PATTERNS,
    serviceModules: [
      'handwerkKnowledgeRegistry',
      'handwerkKnowledgeResolver',
      'handwerkContextAdvisor',
    ],
  },
  {
    id: 'ocr',
    status: 'active',
    labelKey: 'brain.capability.ocr',
    detectPatterns: [/scan|ocr|texterkennung/i],
    serviceModules: ['ocrDocumentService', 'pdfOcrFallbackService'],
  },
  {
    id: 'intake',
    status: 'active',
    labelKey: 'brain.capability.intake',
    detectPatterns: [/upload|eingang.*prüf|dokument.*analys/i],
    serviceModules: ['documentIntakeService', 'intakeWorkflowService'],
  },
];

export const BRAIN_CAPABILITIES: BrainCapabilityDefinition[] = [
  ...ACTIVE_CAPABILITIES,
  ...PLANNED_CAPABILITIES,
];

export function detectPlannedCapability(question: string): BrainCapabilityDefinition | null {
  const normalized = question.trim();
  if (!normalized) return null;
  for (const capability of PLANNED_CAPABILITIES) {
    if (capability.detectPatterns.some((pattern) => pattern.test(normalized))) {
      return capability;
    }
  }
  return null;
}

export function detectActiveCapabilities(question: string): BrainCapabilityId[] {
  const normalized = question.trim();
  if (!normalized) return [];
  return ACTIVE_CAPABILITIES.filter((capability) =>
    capability.detectPatterns.some((pattern) => pattern.test(normalized)),
  ).map((capability) => capability.id);
}

export function getCapabilityById(id: BrainCapabilityId): BrainCapabilityDefinition | undefined {
  return BRAIN_CAPABILITIES.find((capability) => capability.id === id);
}

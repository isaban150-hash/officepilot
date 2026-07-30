import type { DocumentAreaId } from '../types/documentArea';
import { DOCUMENT_AREA_IDS } from '../types/documentArea';
import type {
  DocumentFilingDecisionDraft,
  DocumentFilingDecisionRecord,
  DocumentFilingScope,
  DocumentFilingSpecialty,
} from '../types/documentFilingDecision';
import type {
  ClassifiedDocumentKind,
  DigitalFolder,
  InboxItem,
  PaperFilingRule,
} from '../types/models';
import {
  getDocumentAreaLabelKey,
  resolveSuggestedDocumentAreaFromKind,
} from './documentAreaCatalog';
import { isCustomerDocumentKind } from './documentClassificationCatalog';
import { suggestDigitalFolder } from './documentClassificationService';
import { getInboxExtractedDocumentText } from './inboxDocumentText';
import { patchInboxItem } from './inboxService';
import {
  formatPaperFilingInstruction,
  getAllPaperFolders,
  resolvePaperFilingFromInbox,
} from './paperFolderService';
import type { AppLanguage } from '../types/models';

const WEAK_LABELS = new Set([
  '',
  '-',
  '—',
  'unbekannt',
  'allgemein',
  'neu',
  'unknown',
  'n/a',
  'na',
  'ohne',
  'keine',
  'absender nicht eindeutig erkannt.',
  'unbekannter absender',
]);

/** Same hotel signals as classification / BI — display only, no new kind. */
const HOTEL_PATTERN =
  /hotelrechnung|hotel[\s-]?bill|übernachtung|uebernachtung|frühstück|fruehstueck|tiefgarage|aufenthalt:/i;

export const FILING_DECISION_ARCHIVE_BLOCKED_MESSAGE =
  'Ablageentscheidung nicht bestätigt – bitte zuerst bestätigen.';

function meaningful(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return '';
  if (WEAK_LABELS.has(trimmed.toLowerCase())) return '';
  return trimmed;
}

function readRecognized(item: InboxItem, ...keys: string[]): string {
  for (const key of keys) {
    const value = meaningful(item.recognizedData?.[key]);
    if (value) return value;
  }
  return '';
}

export function isHotelExpenseDocument(item: InboxItem): boolean {
  if (item.filingDecision?.specialty === 'hotel_travel') return true;
  if (item.recognizedData?.detectionReasonKey === 'classification.detect.hotelrechnung') {
    return true;
  }
  const corpus = [
    item.title,
    item.sender,
    getInboxExtractedDocumentText(item),
    item.recognizedData?.dokumentart,
    item.recognizedData?.Dokumentart,
    item.recognizedData?.documentType,
  ]
    .filter(Boolean)
    .join('\n');
  return HOTEL_PATTERN.test(corpus);
}

export function resolveFilingCustomerLabel(
  item: InboxItem,
  scope: DocumentFilingScope,
): string {
  if (scope === 'company') return '';
  return (
    readRecognized(
      item,
      'kunde',
      'Kunde',
      'auftraggeber',
      'Auftraggeber',
      'customer',
      'empfaenger',
      'Empfänger',
    ) ||
    meaningful(item.sender) ||
    ''
  );
}

export function resolveFilingProjectLabel(
  item: InboxItem,
  scope: DocumentFilingScope,
): string {
  if (scope === 'company') return '';
  return (
    readRecognized(
      item,
      'bauvorhaben',
      'Bauvorhaben',
      'projekt',
      'Projekt',
      'projektname',
      'baustelle',
      'Baustelle',
    ) ||
    meaningful(item.vorgangTitle) ||
    ''
  );
}

export function resolveFilingScopeFromKind(
  kind: ClassifiedDocumentKind | undefined,
): DocumentFilingScope {
  return isCustomerDocumentKind(kind) ? 'customer' : 'company';
}

export function formatDigitalFolderBreadcrumb(path: string): string {
  return path
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' → ');
}

export function listCompanyFilingAreaIds(): readonly DocumentAreaId[] {
  return DOCUMENT_AREA_IDS;
}

function resolveDocumentKindLabelKey(
  item: InboxItem,
  specialty: DocumentFilingSpecialty | null,
): string {
  if (specialty === 'hotel_travel') return 'filingDecision.kind.hotelrechnung';
  if (item.classifiedKind) return `classifiedKind.${item.classifiedKind}`;
  return `docType.${item.documentType}`;
}

function resolveCompanyAreaLabelKey(
  specialty: DocumentFilingSpecialty | null,
  companyAreaId: DocumentAreaId,
): string {
  if (specialty === 'hotel_travel') return 'filingDecision.area.hotelTravel';
  return getDocumentAreaLabelKey(companyAreaId);
}

export function buildDocumentFilingDecisionDraft(
  item: InboxItem,
): DocumentFilingDecisionDraft {
  const recorded = item.filingDecision;
  const kind = item.classifiedKind;
  const hotel = isHotelExpenseDocument(item);
  const specialty: DocumentFilingSpecialty | null =
    recorded?.specialty ?? (hotel ? 'hotel_travel' : null);

  const scope =
    recorded?.scope ??
    (specialty === 'hotel_travel' ? 'company' : resolveFilingScopeFromKind(kind));

  const customerLabel =
    recorded?.customerLabel ?? resolveFilingCustomerLabel(item, scope);
  const projectLabel =
    recorded?.projectLabel ?? resolveFilingProjectLabel(item, scope);
  const companyAreaId =
    recorded?.companyAreaId ??
    resolveSuggestedDocumentAreaFromKind(kind, item.digitalFolder?.path);

  const documentKindLabelKey =
    recorded?.documentKindLabelKey ?? resolveDocumentKindLabelKey(item, specialty);
  const companyAreaLabelKey =
    recorded?.companyAreaLabelKey ??
    resolveCompanyAreaLabelKey(specialty, companyAreaId);

  const paperResolution = resolvePaperFilingFromInbox(item);
  const digitalFolder: DigitalFolder =
    recorded?.status === 'confirmed' && recorded.digitalPath
      ? {
          id: item.digitalFolder.id,
          name: recorded.digitalFolderName || item.digitalFolder.name,
          path: recorded.digitalPath,
        }
      : { ...item.digitalFolder };

  const paperFiling: PaperFilingRule | null = paperResolution.skipPhysicalFiling
    ? null
    : paperResolution.rule
      ? { ...paperResolution.rule }
      : item.paperFiling
        ? { ...item.paperFiling }
        : null;

  return {
    scope,
    customerLabel,
    projectLabel,
    companyAreaId,
    specialty,
    documentKindLabelKey,
    companyAreaLabelKey,
    digitalFolder,
    paperFiling,
    skipPhysicalFiling: paperResolution.skipPhysicalFiling,
    status: recorded?.status ?? 'proposed',
  };
}

export type FilingDecisionOverride = Partial<{
  scope: DocumentFilingScope;
  customerLabel: string;
  projectLabel: string;
  companyAreaId: DocumentAreaId;
  digitalPath: string;
  digitalFolderName: string;
  paperFolderId: string;
  paperRegister: string;
  skipPhysicalFiling: boolean;
}>;

/**
 * Apply UI overrides onto an existing draft.
 * Rebuilds digital folder from catalog only when customer/project/scope change
 * and the caller did not set digitalPath explicitly.
 */
export function rebuildFilingDecisionDraft(
  item: InboxItem,
  current: DocumentFilingDecisionDraft,
  overrides: FilingDecisionOverride = {},
): DocumentFilingDecisionDraft {
  const scope = overrides.scope ?? current.scope;
  let customerLabel =
    overrides.customerLabel !== undefined ? overrides.customerLabel : current.customerLabel;
  let projectLabel =
    overrides.projectLabel !== undefined ? overrides.projectLabel : current.projectLabel;

  if (overrides.scope === 'company') {
    if (overrides.customerLabel === undefined) customerLabel = '';
    if (overrides.projectLabel === undefined) projectLabel = '';
  } else if (overrides.scope === 'customer') {
    if (overrides.customerLabel === undefined) {
      customerLabel = resolveFilingCustomerLabel(item, 'customer');
    }
    if (overrides.projectLabel === undefined) {
      projectLabel = resolveFilingProjectLabel(item, 'customer');
    }
  }

  const companyAreaId = overrides.companyAreaId ?? current.companyAreaId;

  // Changing Fachbereich clears hotel specialty display override.
  let specialty = current.specialty;
  let documentKindLabelKey = current.documentKindLabelKey;
  let companyAreaLabelKey = current.companyAreaLabelKey;
  if (overrides.companyAreaId !== undefined && overrides.companyAreaId !== current.companyAreaId) {
    specialty = null;
    documentKindLabelKey = resolveDocumentKindLabelKey(item, null);
    companyAreaLabelKey = getDocumentAreaLabelKey(companyAreaId);
  } else if (overrides.scope === 'company' && current.specialty === 'hotel_travel') {
    specialty = 'hotel_travel';
    documentKindLabelKey = 'filingDecision.kind.hotelrechnung';
    companyAreaLabelKey = 'filingDecision.area.hotelTravel';
  } else if (specialty === 'hotel_travel' && scope === 'company') {
    documentKindLabelKey = 'filingDecision.kind.hotelrechnung';
    companyAreaLabelKey = 'filingDecision.area.hotelTravel';
  } else if (scope === 'company') {
    companyAreaLabelKey = getDocumentAreaLabelKey(companyAreaId);
  }

  const contextChanged =
    (overrides.customerLabel !== undefined && overrides.customerLabel !== current.customerLabel) ||
    (overrides.projectLabel !== undefined && overrides.projectLabel !== current.projectLabel) ||
    (overrides.scope !== undefined && overrides.scope !== current.scope);

  let digitalFolder = current.digitalFolder;
  if (overrides.digitalPath !== undefined || overrides.digitalFolderName !== undefined) {
    digitalFolder = {
      ...digitalFolder,
      ...(overrides.digitalPath !== undefined ? { path: overrides.digitalPath } : {}),
      ...(overrides.digitalFolderName !== undefined
        ? { name: overrides.digitalFolderName }
        : {}),
    };
  } else if (contextChanged && item.classifiedKind) {
    digitalFolder = suggestDigitalFolder(item.classifiedKind, {
      customer: customerLabel || undefined,
      vorgangTitle: projectLabel || undefined,
      sender: item.sender,
    });
  }

  let paperFiling = current.paperFiling;
  let skipPhysicalFiling = current.skipPhysicalFiling;
  if (overrides.skipPhysicalFiling === true) {
    skipPhysicalFiling = true;
    paperFiling = null;
  } else if (overrides.paperFolderId !== undefined || overrides.paperRegister !== undefined) {
    skipPhysicalFiling = false;
    const folderId = overrides.paperFolderId ?? paperFiling?.folderId ?? 'paper-sonstiges';
    const folder = getAllPaperFolders().find((entry) => entry.id === folderId);
    paperFiling = {
      folderId,
      register: overrides.paperRegister ?? paperFiling?.register ?? 'A',
      label: folder?.name ?? paperFiling?.label ?? folderId,
    };
  }

  const unchangedConfirmed =
    current.status === 'confirmed' &&
    scope === current.scope &&
    customerLabel === current.customerLabel &&
    projectLabel === current.projectLabel &&
    companyAreaId === current.companyAreaId &&
    specialty === current.specialty &&
    digitalFolder.path === current.digitalFolder.path &&
    digitalFolder.name === current.digitalFolder.name &&
    (paperFiling?.folderId ?? '') === (current.paperFiling?.folderId ?? '') &&
    (paperFiling?.register ?? '') === (current.paperFiling?.register ?? '') &&
    skipPhysicalFiling === current.skipPhysicalFiling;

  return {
    scope,
    customerLabel,
    projectLabel,
    companyAreaId,
    specialty,
    documentKindLabelKey,
    companyAreaLabelKey,
    digitalFolder,
    paperFiling,
    skipPhysicalFiling,
    status: unchangedConfirmed ? 'confirmed' : 'proposed',
  };
}

export function isDocumentFilingDecisionConfirmed(
  item: Pick<InboxItem, 'filingDecision'>,
): boolean {
  return item.filingDecision?.status === 'confirmed';
}

function toRecord(draft: DocumentFilingDecisionDraft): DocumentFilingDecisionRecord {
  return {
    status: 'confirmed',
    scope: draft.scope,
    customerLabel: draft.customerLabel || undefined,
    projectLabel: draft.projectLabel || undefined,
    companyAreaId: draft.companyAreaId,
    specialty: draft.specialty ?? undefined,
    documentKindLabelKey: draft.documentKindLabelKey,
    companyAreaLabelKey: draft.companyAreaLabelKey,
    digitalPath: draft.digitalFolder.path,
    digitalFolderName: draft.digitalFolder.name,
    paperFolderId: draft.paperFiling?.folderId,
    paperRegister: draft.paperFiling?.register,
    paperLabel: draft.paperFiling?.label,
    skipPhysicalFiling: draft.skipPhysicalFiling,
    confirmedAt: new Date().toISOString(),
  };
}

/**
 * Persist confirmed filing decision onto inbox (folders + filingDecision record).
 * Does not archive.
 */
export function confirmDocumentFilingDecision(
  inboxId: string,
  draft: DocumentFilingDecisionDraft,
): InboxItem | null {
  const paperPatch =
    draft.skipPhysicalFiling || !draft.paperFiling
      ? {}
      : {
          paperFiling: { ...draft.paperFiling },
        };

  return patchInboxItem(inboxId, {
    digitalFolder: { ...draft.digitalFolder },
    ...paperPatch,
    filingDecision: toRecord(draft),
    userModified: true,
    modifiedAt: new Date().toISOString(),
    isNewUpload: false,
  });
}

/**
 * Explicit confirm of the current proposal (user-driven). Never used as silent auto-confirm.
 */
export function confirmProposedDocumentFilingDecision(item: InboxItem): InboxItem | null {
  if (isDocumentFilingDecisionConfirmed(item)) return item;
  return confirmDocumentFilingDecision(item.id, buildDocumentFilingDecisionDraft(item));
}

export function formatFilingPaperHint(
  draft: DocumentFilingDecisionDraft,
  lang: AppLanguage,
  translate: (key: string) => string,
): string {
  if (draft.skipPhysicalFiling || !draft.paperFiling) {
    return translate('filingDecision.paper.skip');
  }
  return formatPaperFilingInstruction(draft.paperFiling, lang);
}

export function getFilingScopeLabelKey(
  scope: DocumentFilingScope,
): 'filingDecision.scope.customer' | 'filingDecision.scope.company' {
  return scope === 'customer'
    ? 'filingDecision.scope.customer'
    : 'filingDecision.scope.company';
}

export { getDocumentAreaLabelKey };

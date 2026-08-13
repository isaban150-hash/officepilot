import type { InboxItem, MaterialStandard, Vorgang, VorgangDraft } from '../types/models';
import { buildDocumentWorkTruthViewForInboxItem } from './documentWorkResultTruthOrchestration';
import { pickExternalCustomerName } from './customerOwnCompanyGuard';

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function trimMeaningful(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export type DraftTruthOverrideValues = Partial<Pick<VorgangDraft, 'customer' | 'title' | 'baustelle'>>;

export function resolveDraftTruthOverrides(item: InboxItem): DraftTruthOverrideValues | undefined {
  const truthView = buildDocumentWorkTruthViewForInboxItem({ item });
  const bi = truthView?.businessInterpretation;

  const overrides: DraftTruthOverrideValues = {};
  const customer = trimMeaningful(bi?.facts.parties.counterparty?.name);
  const title = trimMeaningful(bi?.facts.subject.project?.value)
    ?? trimMeaningful(bi?.facts.subject.subject?.value);
  const baustelle = trimMeaningful(bi?.facts.subject.site?.value);

  if (customer) overrides.customer = customer;
  if (title) overrides.title = title;
  if (baustelle) overrides.baustelle = baustelle;

  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

export function buildVorgangDraftFromInbox(
  item: InboxItem,
  defaultMaterial: MaterialStandard = 'unclear',
  truthOverrides?: DraftTruthOverrideValues,
): VorgangDraft {
  const leistung = item.recognizedData.Leistung;
  // Same source order as before — own-company candidates are skipped, not replaced.
  const kunde = pickExternalCustomerName([
    trimMeaningful(truthOverrides?.customer),
    item.recognizedData.Kunde,
    item.sender,
  ]);
  const baustelle = trimMeaningful(truthOverrides?.baustelle)
    ?? item.recognizedData.Baustelle
    ?? 'Unbekannte Baustelle';

  let title = trimMeaningful(truthOverrides?.title) ?? item.vorgangTitle?.trim();
  if (!title) {
    title = leistung?.trim() || item.title.replace(/^Gerade erfasst: /, '');
  }

  return {
    title,
    customer: kunde,
    baustelle,
    materialSource: defaultMaterial,
  };
}

export function findSimilarVorgaenge(draft: VorgangDraft, candidates: Vorgang[]): Vorgang[] {
  const customerNorm = normalize(draft.customer);
  const baustelleNorm = normalize(draft.baustelle);

  return candidates.filter((v) => {
    const sameCustomer = normalize(v.customer) === customerNorm;
    const sameBaustelle =
      normalize(v.baustelle) === baustelleNorm ||
      normalize(v.baustelle).includes(baustelleNorm) ||
      baustelleNorm.includes(normalize(v.baustelle));
    const titleOverlap =
      normalize(v.title).includes(normalize(draft.customer)) ||
      normalize(draft.title).includes(normalize(v.customer));

    return sameCustomer || (sameCustomer && sameBaustelle) || (sameBaustelle && titleOverlap);
  });
}

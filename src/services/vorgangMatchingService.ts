import type { InboxItem, MaterialStandard, Vorgang, VorgangDraft } from '../types/models';

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function buildVorgangDraftFromInbox(
  item: InboxItem,
  defaultMaterial: MaterialStandard = 'unclear',
): VorgangDraft {
  const leistung = item.recognizedData.Leistung;
  const kunde = item.recognizedData.Kunde ?? item.sender;
  const baustelle = item.recognizedData.Baustelle ?? 'Unbekannte Baustelle';

  let title = item.vorgangTitle?.trim();
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

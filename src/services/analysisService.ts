import { PAPER_FOLDERS } from '../data/mockData';
import type { PaperFolder, PaperFilingRule } from '../types/models';
import { getAllVorgaenge, getVorgangById } from './vorgangService';

export { getAllVorgaenge, getVorgangById };

export function getPaperFolderById(folderId: string): PaperFolder | undefined {
  return PAPER_FOLDERS.find((f) => f.id === folderId);
}

export function formatPaperFilingInstruction(rule: PaperFilingRule): string {
  const folder = getPaperFolderById(rule.folderId);
  const folderName = folder?.name ?? rule.label;
  return `Bitte Original abheften in: ${folderName} → Register ${rule.register}`;
}

export function getAllPaperFolders(): PaperFolder[] {
  return PAPER_FOLDERS;
}

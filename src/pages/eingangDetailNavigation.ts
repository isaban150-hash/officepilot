/**
 * Location state for /ablage/:id — reveal the existing archive-import surface.
 * ARCHIVE-TRUTH-UX-01 — no new import logic; UI reachability only.
 */
export type AblageDetailLocationState = {
  revealArchiveImport?: boolean;
};

export const ABLAGE_REVEAL_ARCHIVE_IMPORT_STATE: AblageDetailLocationState = {
  revealArchiveImport: true,
};

export function shouldRevealArchiveImportFromState(
  state: unknown,
): boolean {
  return Boolean(
    state &&
      typeof state === 'object' &&
      (state as AblageDetailLocationState).revealArchiveImport === true,
  );
}

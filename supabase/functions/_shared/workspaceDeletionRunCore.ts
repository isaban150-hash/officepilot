/**
 * EINRICHTUNG-01 (AP7; Vertrag 1.26, K3) — Ausführung fälliger Betriebslöschungen, Entscheidungen ohne Deno-APIs.
 *
 * Je Betrieb: `workspace_deletion_begin` (Sperre für genau diesen Lauf, Arbeitsliste allein aus storage.objects) →
 * Objekte der Arbeitsliste über die Storage-API löschen und jedes gelöschte vermerken → `workspace_deletion_execute`
 * (eine Transaktion; nur mit leerer Arbeitsliste und ohne Objekte unter dem Präfix). Scheitert ein Objekt mitten in der
 * Liste, bleibt der Auftrag `deleting` mit den Restobjekten; der nächste Lauf setzt fort. „Gelöscht“ gibt es nur mit
 * `completed`. Objektpfade aus einer Anfrage werden nie übernommen; zusätzlich gilt: nur Namen unter `<workspace_id>/`
 * ohne `..`.
 */
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const DELETION_BUCKETS = ['branding-assets', 'document-deliveries', 'email-attachments', 'inbound-email-attachments', 'workspace-files'] as const;
const REMOVE_CHUNK = 100;

export interface DeletionObject {
  bucket: string;
  name: string;
}

export type BeginResponse =
  | { ok: true; state: 'deleting'; objects: DeletionObject[] }
  | { ok: true; state: 'completed' }
  | { ok: false; code: string };

export interface WorkspaceDeletionRunDeps {
  due(limit: number): Promise<string[]>;
  begin(workspaceId: string, runner: string): Promise<BeginResponse>;
  removeObjects(bucket: string, names: string[]): Promise<{ removed: string[]; error?: string }>;
  mark(workspaceId: string, runner: string, objects: DeletionObject[]): Promise<void>;
  execute(workspaceId: string, runner: string): Promise<{ ok: boolean; state?: string; code?: string }>;
  fail(workspaceId: string, runner: string, code: string): Promise<void>;
  randomRunner(): string;
  log(entry: Record<string, string | number | boolean | null>): void;
}

export type WorkspaceDeletionResult = 'completed' | 'deleting' | 'locked' | 'not_due' | 'not_requested' | 'error';

/** Nur Objekte dieses Betriebs: Name unter `<workspace_id>/`, ohne `..`, in einem der fünf Buckets. */
export function isOwnDeletionObject(workspaceId: string, object: DeletionObject): boolean {
  return (
    (DELETION_BUCKETS as readonly string[]).includes(object.bucket) &&
    object.name.startsWith(`${workspaceId}/`) &&
    !object.name.split('/').some((part) => part === '..' || part === '.') &&
    !object.name.includes('\\')
  );
}

export async function runWorkspaceDeletion(workspaceId: string, deps: WorkspaceDeletionRunDeps): Promise<WorkspaceDeletionResult> {
  if (!UUID.test(workspaceId)) return 'error';
  const runner = deps.randomRunner();
  const begun = await deps.begin(workspaceId, runner);
  if (!begun.ok) {
    deps.log({ outcome: begun.code });
    if (begun.code === 'deletion_locked') return 'locked';
    if (begun.code === 'deletion_not_due') return 'not_due';
    if (begun.code === 'deletion_not_requested') return 'not_requested';
    return 'error';
  }
  if (begun.state === 'completed') return 'completed';

  const eigene = begun.objects.filter((object) => isOwnDeletionObject(workspaceId, object));
  if (eigene.length !== begun.objects.length) {
    // Die Arbeitsliste stammt aus storage.objects; ein fremder Name ist ein Fehler, kein Löschauftrag.
    await deps.fail(workspaceId, runner, 'worklist_foreign_object');
    deps.log({ outcome: 'worklist_foreign_object' });
    return 'error';
  }
  for (const bucket of DELETION_BUCKETS) {
    const namen = eigene.filter((object) => object.bucket === bucket).map((object) => object.name);
    for (let index = 0; index < namen.length; index += REMOVE_CHUNK) {
      const teil = namen.slice(index, index + REMOVE_CHUNK);
      const result = await deps.removeObjects(bucket, teil);
      const entfernt = result.removed.filter((name) => teil.includes(name));
      if (entfernt.length > 0) await deps.mark(workspaceId, runner, entfernt.map((name) => ({ bucket, name })));
      if (result.error || entfernt.length < teil.length) {
        await deps.fail(workspaceId, runner, result.error ?? 'storage_remove_incomplete');
        deps.log({ outcome: 'storage_remove_incomplete', bucket, remaining: teil.length - entfernt.length });
        return 'deleting';
      }
    }
  }

  const executed = await deps.execute(workspaceId, runner);
  if (executed.ok && executed.state === 'completed') {
    deps.log({ outcome: 'completed' });
    return 'completed';
  }
  await deps.fail(workspaceId, runner, executed.code ?? 'execute_failed');
  deps.log({ outcome: executed.code ?? 'execute_failed' });
  return executed.code === 'deletion_locked' ? 'locked' : 'deleting';
}

/** Ein Lauf: ein genannter Betrieb (Dienstweg, Tests) oder alle fälligen. Zusammenfassung ohne Geschäftsdaten. */
export async function runWorkspaceDeletionBatch(
  input: { workspaceId?: unknown },
  deps: WorkspaceDeletionRunDeps,
): Promise<{ ok: true; results: Record<WorkspaceDeletionResult, number> } | { ok: false; error: 'invalid_request' }> {
  const results: Record<WorkspaceDeletionResult, number> = { completed: 0, deleting: 0, locked: 0, not_due: 0, not_requested: 0, error: 0 };
  let ziele: string[];
  if (input.workspaceId !== undefined && input.workspaceId !== null) {
    if (typeof input.workspaceId !== 'string' || !UUID.test(input.workspaceId)) return { ok: false, error: 'invalid_request' };
    ziele = [input.workspaceId];
  } else {
    ziele = await deps.due(20);
  }
  for (const ziel of ziele) {
    try {
      results[await runWorkspaceDeletion(ziel, deps)] += 1;
    } catch {
      results.error += 1;
      deps.log({ outcome: 'run_exception' });
    }
  }
  return { ok: true, results };
}

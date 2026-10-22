import { resolveWorkspaceAccount, type StorageAccess, type StorageScope } from './storageScopeService';

/**
 * DOKUMENTE-01 N1 — Dateibytes liegen je Konto und Sicht wie der Zustand
 * (`workspace:<id>:account:<nutzer>:<sicht>`); ohne Konto der Altbereich
 * `workspace:<id>` aus der Zeit vor der Kontotrennung.
 */
export function buildDocumentBlobScopeKey(scope: StorageScope): string {
  switch (scope.type) {
    case 'guest':
      return 'guest';
    case 'user':
      return `user:${scope.userId}`;
    case 'workspace': {
      const account = resolveWorkspaceAccount(scope);
      return account
        ? `workspace:${scope.workspaceId}:account:${account.userId}:${account.access}`
        : `workspace:${scope.workspaceId}`;
    }
    default:
      return 'guest';
  }
}

export function buildDocumentBlobRecordId(scopeKey: string, fileRefId: string): string {
  return `${scopeKey}::${fileRefId}`;
}

export function parseDocumentBlobScopeKey(scopeKey: string): {
  type: 'guest' | 'user' | 'workspace';
  userId?: string;
  workspaceId?: string;
  access?: StorageAccess;
} {
  if (scopeKey === 'guest') {
    return { type: 'guest' };
  }
  if (scopeKey.startsWith('user:')) {
    return { type: 'user', userId: scopeKey.slice('user:'.length) };
  }
  if (scopeKey.startsWith('workspace:')) {
    const rest = scopeKey.slice('workspace:'.length);
    const konto = rest.match(/^([^:]+):account:([^:]+):(full|member)$/);
    if (konto) {
      return { type: 'workspace', workspaceId: konto[1], userId: konto[2], access: konto[3] as StorageAccess };
    }
    return { type: 'workspace', workspaceId: rest };
  }
  return { type: 'guest' };
}

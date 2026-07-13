import type { StorageScope } from './storageScopeService';

export function buildDocumentBlobScopeKey(scope: StorageScope): string {
  switch (scope.type) {
    case 'guest':
      return 'guest';
    case 'user':
      return `user:${scope.userId}`;
    case 'workspace':
      return `workspace:${scope.workspaceId}`;
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
} {
  if (scopeKey === 'guest') {
    return { type: 'guest' };
  }
  if (scopeKey.startsWith('user:')) {
    return { type: 'user', userId: scopeKey.slice('user:'.length) };
  }
  if (scopeKey.startsWith('workspace:')) {
    return { type: 'workspace', workspaceId: scopeKey.slice('workspace:'.length) };
  }
  return { type: 'guest' };
}

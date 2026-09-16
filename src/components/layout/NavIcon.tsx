import { Icon, type IconId } from '../ui/Icon';

/**
 * UIUX-FOUNDATION-01C — NavIcon ist nur noch ein Alias auf die kanonische
 * Icon-Registry (`ui/Icon`). Die alten Kennungen bleiben gültig, damit
 * bestehende Aufrufer und Tests weiterlaufen; neue Navigationsbereiche
 * verwenden direkt eine `IconId`.
 */
export type NavIconId =
  | 'home'
  | 'documents'
  | 'orders'
  | 'assistant'
  | 'tax'
  | 'more'
  | 'scan'
  | 'archive'
  | 'inbox'
  | 'invoice'
  | 'finance'
  | 'folder'
  | 'customers'
  | 'tasks'
  | 'messages'
  | 'knowledge';

const LEGACY_ALIAS: Partial<Record<NavIconId, IconId>> = {
  documents: 'inbox',
};

interface NavIconProps {
  id: NavIconId;
  className?: string;
}

export function NavIcon({ id, className = '' }: NavIconProps) {
  const iconId: IconId = LEGACY_ALIAS[id] ?? (id as IconId);
  return <Icon id={iconId} className={`nav-icon ${className}`.trim()} />;
}

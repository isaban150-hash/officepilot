export type KnowledgeScope = 'company' | 'customer' | 'vorgang' | 'contact';

export type KnowledgeCategory =
  | 'communication_preference'
  | 'material_preference'
  | 'scheduling'
  | 'pricing_history'
  | 'contact_log'
  | 'other';

export type KnowledgeSourceType = 'user' | 'note' | 'communication_event';

import type { SyncMeta } from './sync';

export interface KnowledgeFact {
  id: string;
  scope: KnowledgeScope;
  scopeId?: string;
  scopeLabel?: string;
  category: KnowledgeCategory;
  key: string;
  value: string;
  displayText: string;
  sourceType: KnowledgeSourceType;
  sourceId?: string;
  confirmedAt: string;
  createdAt: string;
  updatedAt?: string;
  active: boolean;
  sync?: SyncMeta;
}

export interface KnowledgeFactInput {
  scope: KnowledgeScope;
  scopeId?: string;
  scopeLabel?: string;
  category: KnowledgeCategory;
  key: string;
  value: string;
  displayText: string;
  sourceType?: KnowledgeSourceType;
  sourceId?: string;
  active?: boolean;
}

export const KNOWLEDGE_SCOPES: KnowledgeScope[] = ['company', 'customer', 'vorgang', 'contact'];

export const KNOWLEDGE_CATEGORIES: KnowledgeCategory[] = [
  'communication_preference',
  'material_preference',
  'scheduling',
  'pricing_history',
  'contact_log',
  'other',
];

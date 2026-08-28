/**
 * OFFICEPILOT-CUSTOMER-CLOUD-SERVER-03A-S1 — die Serverseite des Kundenstamms.
 *
 * Customer wird workspace-scoped Sync-Entität. Der Client folgt erst später;
 * diese Migration muss deshalb **rein additiv** sein und alte Clients
 * unverändert bedienen.
 *
 * **Das größte Risiko dieses Sprints:** Beide RPCs müssen vollständig neu
 * geschrieben werden, weil PostgreSQL keine partielle Funktionsänderung kennt.
 * Ein dabei vergessener Zweig legt den Vorgangs- oder Firmendaten-Sync still,
 * ohne dass irgendetwas anderes es bemerkt. Die Zweig- und Schlüsselmengen
 * werden deshalb **vollständig** geprüft, nicht stichprobenartig.
 *
 * **Was diese Tests können und was nicht:** Vitest hat keine Datenbank.
 * Geprüft wird die Struktur des SQL. Dass PostgreSQL sich zur Laufzeit so
 * verhält, steht erst beim Dry-Run fest — hier wird keine Laufzeitgarantie
 * behauptet.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = resolve(
  process.cwd(),
  'supabase/migrations/20250829120000_workspace_customers_cloud.sql',
);

const sql = (() => {
  try {
    return readFileSync(migrationPath, 'utf8');
  } catch {
    return '';
  }
})();

/** Rumpf ab der jeweiligen Funktionsdefinition bis zum nächsten `$$;`. */
function functionBody(marker: string): string {
  const start = sql.indexOf(marker);
  if (start < 0) return '';
  const end = sql.indexOf('$$;', start);
  return end < 0 ? sql.slice(start) : sql.slice(start, end);
}

const pullFunction = functionBody(
  'create or replace function public.pull_workspace_sync_state',
);
const upsertFunction = functionBody(
  'create or replace function public.upsert_workspace_sync_entity',
);

/** Die Schlüssel, die der Pull vor dieser Migration lieferte. */
const EXISTING_PULL_KEYS = [
  'workspace',
  'members',
  'settings',
  'setup',
  'company_profile',
  'vorgaenge',
];

/** Die Entity-Zweige, die der Upsert vor dieser Migration kannte. */
const EXISTING_UPSERT_BRANCHES = [
  'vorgang',
  'workspace',
  'workspace_settings',
  'company_setup',
  'company_profile',
];

describe('CUSTOMER-CLOUD-SQL-03A-S1 — Tabelle', () => {
  it('A: workspace_customers folgt dem workspace_vorgaenge-Muster', () => {
    expect(sql).toContain('create table if not exists public.workspace_customers');
    expect(sql).toContain('workspace_id uuid not null references public.workspaces (id) on delete cascade');
    expect(sql).toContain('customer_id text not null');
    expect(sql).toContain("payload jsonb not null default '{}'::jsonb");
    expect(sql).toContain('row_version bigint not null default 1');
    expect(sql).toContain('updated_at timestamptz not null default now()');
    expect(sql).toContain('updated_by uuid null references auth.users (id) on delete set null');
    expect(sql).toContain('primary key (workspace_id, customer_id)');
  });

  it('B: Tombstone-Felder sind vorhanden, obwohl es noch kein Löschen gibt', () => {
    /*
     * Sie jetzt anzulegen kostet nichts und erspart eine zweite Migration an
     * derselben RPC zu einem Zeitpunkt, an dem produktive Kundendaten in der
     * Tabelle liegen.
     */
    expect(sql).toContain('deleted boolean not null default false');
    expect(sql).toContain('deleted_at timestamptz null');
  });

  it('C: die Indizes entsprechen dem Vorgangs-Muster', () => {
    expect(sql).toContain('workspace_customers_workspace_id_idx');
    expect(sql).toContain('workspace_customers_workspace_active_idx');
    expect(sql).toContain('where deleted = false');
  });

  it('D: keine Unique-Regel auf fachlichen Kundendaten', () => {
    /*
     * Zwei gleichnamige Kunden mit verschiedenen IDs sind zwei Kunden. Kein
     * Feld in CustomerBilling kann Firmenidentität beweisen — es gibt weder
     * USt-ID noch Steuernummer.
     */
    const uniqueStatements = sql.match(/create unique index[^;]*;/gi) ?? [];
    expect(uniqueStatements).toEqual([]);
    for (const field of ['name', 'email', 'phone', 'street', 'zip', 'city']) {
      expect(sql).not.toContain(`unique (${field})`);
    }
  });

  it('E: der updated_at-Trigger nutzt die bestehende Funktion', () => {
    expect(sql).toContain('workspace_customers_set_updated_at');
    expect(sql).toContain('before update on public.workspace_customers');
    expect(sql).toContain('execute function public.set_workspace_updated_at()');
    // Die bestehende Funktion wird verwendet, nicht neu definiert.
    expect(sql).not.toContain('create or replace function public.set_workspace_updated_at');
  });

  it('F: RLS und Grants folgen dem bestehenden Sicherheitsmuster', () => {
    expect(sql).toContain('alter table public.workspace_customers enable row level security');
    expect(sql).toContain('workspace_customers_select_member');
    expect(sql).toContain('public.is_active_workspace_member(workspace_id)');
    expect(sql).toContain('revoke all on public.workspace_customers from public, anon');
    expect(sql).toContain('grant select on public.workspace_customers to authenticated');
    // Schreiben bleibt ausschliesslich der Security-Definer-RPC vorbehalten.
    expect(sql).not.toContain('grant insert on public.workspace_customers');
    expect(sql).not.toContain('grant update on public.workspace_customers');
    expect(sql).not.toContain('grant delete on public.workspace_customers');
  });
});

describe('CUSTOMER-CLOUD-SQL-03A-S1 — Pull-RPC', () => {
  it('G: alle bisherigen Rückgabeschlüssel bleiben erhalten', () => {
    expect(pullFunction).not.toBe('');
    for (const key of EXISTING_PULL_KEYS) {
      expect(pullFunction, key).toContain(`'${key}',`);
    }
  });

  it('H: customers kommt hinzu', () => {
    expect(pullFunction).toContain("'customers',");
    expect(pullFunction).toContain('from public.workspace_customers');
  });

  it('I: der Customer-Pull filtert Tombstones NICHT heraus', () => {
    /*
     * Der spätere Backfill vergleicht lokale IDs gegen alle remote IDs. Eine
     * gelöschte ID muss dabei als „remote vorhanden" gelten — sonst lädt ein
     * zweites Gerät den gelöschten Kunden wieder hoch. Der Vorgangs-Pull
     * filtert aus demselben Grund nicht.
     */
    const customersExpression = (() => {
      const start = pullFunction.indexOf("'customers',");
      if (start < 0) return '';
      const end = pullFunction.indexOf('::jsonb', start);
      return end < 0 ? pullFunction.slice(start) : pullFunction.slice(start, end);
    })();
    expect(customersExpression).not.toBe('');
    expect(customersExpression).not.toContain('deleted = false');
    expect(customersExpression).not.toContain('deleted is false');
    expect(customersExpression).not.toContain('not deleted');
  });

  it('J: die bestehenden Sicherheitsprüfungen bleiben stehen', () => {
    expect(pullFunction).toContain('auth.uid() is null');
    expect(pullFunction).toContain('public.is_active_workspace_member(p_workspace_id)');
  });
});

describe('CUSTOMER-CLOUD-SQL-03A-S1 — Upsert-RPC', () => {
  it('K: alle bisherigen Entity-Zweige bleiben erhalten', () => {
    expect(upsertFunction).not.toBe('');
    for (const branch of EXISTING_UPSERT_BRANCHES) {
      expect(upsertFunction, branch).toContain(`p_entity_type = '${branch}'`);
    }
    // Der Fallback für unbekannte Typen bleibt bestehen.
    expect(upsertFunction).toContain('Unbekannter Entity-Typ');
  });

  it('L: customer kommt als einziger neuer Zweig hinzu', () => {
    const branches = [...upsertFunction.matchAll(/p_entity_type = '([a-z_]+)'/g)].map(
      (match) => match[1],
    );
    expect(branches).toContain('customer');
    expect([...new Set(branches)].sort()).toEqual(
      [...EXISTING_UPSERT_BRANCHES, 'customer'].sort(),
    );
  });

  it('M: der Customer-Zweig folgt dem Vorgangs-Versionsmuster', () => {
    const customerBranch = (() => {
      const start = upsertFunction.indexOf("p_entity_type = 'customer'");
      if (start < 0) return '';
      const end = upsertFunction.indexOf('elsif', start + 1);
      return end < 0 ? upsertFunction.slice(start) : upsertFunction.slice(start, end);
    })();

    expect(customerBranch).not.toBe('');
    expect(customerBranch).toContain('public.can_write_workspace(p_workspace_id)');
    expect(customerBranch).toContain('for update');
    expect(customerBranch).toContain('Versionskonflikt customer');
    expect(customerBranch).toContain('row_version = row_version + 1');
    expect(customerBranch).toContain('auth.uid()');
    // Struktur und Berechtigung prüft der Server, nicht die Customer-Fachlogik.
    expect(customerBranch).not.toContain('lower(');
    expect(customerBranch).not.toContain('name');
  });
});

describe('CUSTOMER-CLOUD-SQL-03A-S1 — Additivität', () => {
  it('N: die Migration enthält keine destruktive Anweisung', () => {
    const forbidden = [
      /drop\s+table/i,
      /drop\s+column/i,
      /alter\s+table[^;]*drop\s/i,
      /truncate/i,
      /delete\s+from/i,
    ];
    for (const pattern of forbidden) {
      expect(sql, pattern.source).not.toMatch(pattern);
    }
  });

  it('O: bestehende Tabellen und Policies werden nicht angefasst', () => {
    for (const table of [
      'workspace_vorgaenge',
      'workspace_setup',
      'workspace_company_profiles',
      'workspace_invoices',
      'workspace_settings',
    ]) {
      expect(sql, table).not.toContain(`alter table public.${table}`);
      expect(sql, table).not.toContain(`drop policy if exists ${table}_select_member`);
    }
  });

  it('P: ausser den beiden RPCs wird keine Funktion ersetzt', () => {
    const replaced = [...sql.matchAll(/create or replace function public\.(\w+)/g)].map(
      (match) => match[1],
    );
    expect([...new Set(replaced)].sort()).toEqual([
      'pull_workspace_sync_state',
      'upsert_workspace_sync_entity',
    ]);
  });
});

-- STEUERBERATER-06B — Monatsabschluesse.
--
-- Ein Abschluss haelt fest, welcher Stand eines Monats geprueft wurde. Er ist
-- **kein Schloss**: Der Betrieb kann danach weiterhin stornieren, korrigieren
-- und zahlen — diese Workflows bleiben unberuehrt. Was der Abschluss leistet,
-- ist Wiedererkennung ueber den gespeicherten Fingerprint.
--
-- Bewusst **keine** Compliance-Zusage. Nirgends steht „festgeschrieben",
-- „GoBD" oder „rechtssicher"; dafuer fehlt die Grundlage, und ein Versprechen,
-- das die Software nicht einloest, ist schlimmer als keines.
--
-- **Revisionen werden angehaengt, nie ueberschrieben.** Wird ein Monat wieder
-- geoeffnet und erneut abgeschlossen, entsteht Revision 2; Revision 1 behaelt
-- Fingerprint und Manifest. Eine alte Revision nachtraeglich umzuschreiben
-- hiesse, den Nachweis zu faelschen — der Server laesst es deshalb nicht zu.
--
-- Was der Server prueft und was nicht, steht ausdruecklich in
-- `close_workspace_accounting_period`. Er prueft Struktur, Zugriff und den
-- Revisionsvertrag. Er kann die **fachliche** Bereitschaft nicht nachrechnen:
-- Rechnungen und Ausgaben liegen als JSON-Nutzlast, und die Monatszuordnung
-- samt Stornoregeln lebt im Client. Das ist eine Grenze, keine Luecke im
-- Entwurf — sie wird benannt statt kaschiert.
--
-- Kein Backfill: Kein bestehender Monat wird als abgeschlossen markiert.

create table if not exists public.workspace_accounting_period_closures (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  client_closure_id text not null,
  period_year integer not null,
  period_month integer not null,
  revision integer not null,
  fingerprint text not null,
  manifest jsonb not null default '{}'::jsonb,
  closed_at timestamptz not null,
  closed_by uuid null references auth.users (id) on delete set null,
  reopened_at timestamptz null,
  reopened_by uuid null references auth.users (id) on delete set null,
  reopen_reason text null,
  row_version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_accounting_period_closures_year_check
    check (period_year between 2000 and 2999),
  constraint workspace_accounting_period_closures_month_check
    check (period_month between 1 and 12),
  constraint workspace_accounting_period_closures_revision_check
    check (revision >= 1),
  constraint workspace_accounting_period_closures_fingerprint_check
    check (length(btrim(fingerprint)) > 0),
  constraint workspace_accounting_period_closures_client_id_unique
    unique (workspace_id, client_closure_id),
  constraint workspace_accounting_period_closures_revision_unique
    unique (workspace_id, period_year, period_month, revision)
);

/*
 * Hoechstens **eine** offene Revision je Monat. Eine wieder geoeffnete zaehlt
 * nicht mit: Genau dann darf eine neue entstehen.
 */
create unique index if not exists workspace_accounting_period_closures_active_unique
  on public.workspace_accounting_period_closures (workspace_id, period_year, period_month)
  where reopened_at is null;

create index if not exists workspace_accounting_period_closures_period_idx
  on public.workspace_accounting_period_closures (workspace_id, period_year, period_month, revision desc);

drop trigger if exists workspace_accounting_period_closures_set_updated_at
  on public.workspace_accounting_period_closures;
create trigger workspace_accounting_period_closures_set_updated_at
before update on public.workspace_accounting_period_closures
for each row execute function public.set_workspace_updated_at();

alter table public.workspace_accounting_period_closures enable row level security;

drop policy if exists workspace_accounting_period_closures_select_writer
  on public.workspace_accounting_period_closures;
create policy workspace_accounting_period_closures_select_writer
on public.workspace_accounting_period_closures for select to authenticated
using (public.can_write_workspace(workspace_id));

revoke all on public.workspace_accounting_period_closures from public, anon;
grant select on public.workspace_accounting_period_closures to authenticated;

/* -------------------------------------------------------------------------- */
/* Monat abschliessen                                                         */
/* -------------------------------------------------------------------------- */

create or replace function public.close_workspace_accounting_period(
  p_workspace_id uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_closure_id text;
  v_year integer;
  v_month integer;
  v_fingerprint text;
  v_manifest jsonb;
  v_active public.workspace_accounting_period_closures;
  v_next_revision integer;
  v_row public.workspace_accounting_period_closures;
begin
  if v_user_id is null then
    raise exception 'Nicht angemeldet';
  end if;
  if p_workspace_id is null then
    raise exception 'workspace_id fehlt';
  end if;
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  v_closure_id := nullif(trim(coalesce(p_payload->>'client_closure_id', '')), '');
  if v_closure_id is null then
    raise exception 'client_closure_id fehlt';
  end if;

  begin
    v_year := (p_payload->>'period_year')::integer;
    v_month := (p_payload->>'period_month')::integer;
  exception when others then
    raise exception 'period_invalid: Jahr oder Monat unlesbar' using errcode = 'P0001';
  end;
  if v_year is null or v_month is null
     or v_year < 2000 or v_year > 2999
     or v_month < 1 or v_month > 12 then
    raise exception 'period_invalid: % / %', coalesce(v_year, -1), coalesce(v_month, -1)
      using errcode = 'P0001';
  end if;

  /*
   * Der Fingerprint ist der Kern des Abschlusses. Ohne ihn liesse sich spaeter
   * nicht sagen, worauf er sich bezog — dann waere es doch nur ein Boolean.
   */
  v_fingerprint := nullif(trim(coalesce(p_payload->>'fingerprint', '')), '');
  if v_fingerprint is null then
    raise exception 'closure_without_fingerprint: fingerprint fehlt' using errcode = 'P0001';
  end if;

  v_manifest := coalesce(p_payload->'manifest', '{}'::jsonb);
  if jsonb_typeof(v_manifest) <> 'object' then
    raise exception 'closure_manifest_invalid: kein Objekt' using errcode = 'P0001';
  end if;
  if not (v_manifest ? 'entries') or jsonb_typeof(v_manifest->'entries') <> 'array' then
    raise exception 'closure_manifest_invalid: entries fehlen' using errcode = 'P0001';
  end if;
  /*
   * Das Manifest muss zu dem Monat gehoeren, der abgeschlossen wird. Ohne
   * diese Pruefung liesse sich der Stand eines fremden Monats als Nachweis
   * hinterlegen.
   */
  if nullif(v_manifest->>'monthKey', '') is distinct from
     (lpad(v_year::text, 4, '0') || '-' || lpad(v_month::text, 2, '0')) then
    raise exception 'closure_manifest_period_mismatch: % gehoert nicht zu %-%',
      coalesce(v_manifest->>'monthKey', '(fehlt)'), v_year, v_month
      using errcode = 'P0001';
  end if;

  select * into v_active
  from public.workspace_accounting_period_closures
  where workspace_id = p_workspace_id
    and period_year = v_year
    and period_month = v_month
    and reopened_at is null
  for update;

  if v_active.id is not null then
    /*
     * Es gibt bereits einen offenen Abschluss.
     *
     * Derselbe Stand noch einmal geschickt ist ein Replay — etwa nach einem
     * Verbindungsabbruch — und darf keine zweite Revision erzeugen. Ein
     * **anderer** Stand dagegen waere ein stilles Ueberschreiben der aktiven
     * Revision: Dafuer muss der Monat erst bewusst wieder geoeffnet werden.
     */
    if v_active.fingerprint = v_fingerprint then
      return jsonb_build_object(
        'revision', v_active.revision,
        'closed_at', v_active.closed_at,
        'row_version', v_active.row_version,
        'noop', true
      );
    end if;
    raise exception 'period_already_closed: Revision % ist offen; bitte zuerst wieder oeffnen',
      v_active.revision using errcode = 'P0001';
  end if;

  select coalesce(max(revision), 0) + 1 into v_next_revision
  from public.workspace_accounting_period_closures
  where workspace_id = p_workspace_id
    and period_year = v_year
    and period_month = v_month;

  insert into public.workspace_accounting_period_closures (
    workspace_id, client_closure_id, period_year, period_month, revision,
    fingerprint, manifest, closed_at, closed_by
  ) values (
    p_workspace_id, v_closure_id, v_year, v_month, v_next_revision,
    v_fingerprint, v_manifest, now(), v_user_id
  )
  returning * into v_row;

  return jsonb_build_object(
    'revision', v_row.revision,
    'closed_at', v_row.closed_at,
    'row_version', v_row.row_version,
    'noop', false
  );
end;
$$;

/* -------------------------------------------------------------------------- */
/* Monat wieder oeffnen                                                       */
/* -------------------------------------------------------------------------- */

create or replace function public.reopen_workspace_accounting_period(
  p_workspace_id uuid,
  p_period_year integer,
  p_period_month integer,
  p_reason text,
  p_expected_revision integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_active public.workspace_accounting_period_closures;
  v_row public.workspace_accounting_period_closures;
begin
  if v_user_id is null then
    raise exception 'Nicht angemeldet';
  end if;
  if p_workspace_id is null then
    raise exception 'workspace_id fehlt';
  end if;
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  select * into v_active
  from public.workspace_accounting_period_closures
  where workspace_id = p_workspace_id
    and period_year = p_period_year
    and period_month = p_period_month
    and reopened_at is null
  for update;

  if v_active.id is null then
    raise exception 'period_not_closed: kein offener Abschluss fuer %-%',
      p_period_year, p_period_month using errcode = 'P0001';
  end if;

  /*
   * Der Aufrufer nennt die Revision, die er wieder oeffnen will. Hat inzwischen
   * jemand anders geoeffnet und neu abgeschlossen, trifft er eine andere — und
   * soll das erfahren, statt still die falsche zu oeffnen.
   */
  if p_expected_revision is not null and v_active.revision <> p_expected_revision then
    raise exception 'Versionskonflikt: offene Revision ist %, erwartet %',
      v_active.revision, p_expected_revision;
  end if;

  update public.workspace_accounting_period_closures
  set reopened_at = now(),
      reopened_by = v_user_id,
      reopen_reason = nullif(trim(coalesce(p_reason, '')), ''),
      row_version = row_version + 1,
      updated_at = now()
  where id = v_active.id
  returning * into v_row;

  return jsonb_build_object(
    'revision', v_row.revision,
    'reopened_at', v_row.reopened_at,
    'row_version', v_row.row_version
  );
end;
$$;

/* -------------------------------------------------------------------------- */
/* Abschluesse lesen                                                          */
/* -------------------------------------------------------------------------- */

create or replace function public.pull_workspace_accounting_period_closures(p_workspace_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'Nicht angemeldet';
  end if;
  if p_workspace_id is null then
    raise exception 'workspace_id fehlt';
  end if;
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  return jsonb_build_object(
    'closures', coalesce((
      select jsonb_agg(jsonb_build_object(
        'client_closure_id', c.client_closure_id,
        'period_year', c.period_year,
        'period_month', c.period_month,
        'revision', c.revision,
        'fingerprint', c.fingerprint,
        'manifest', c.manifest,
        'closed_at', c.closed_at,
        'closed_by', c.closed_by,
        'reopened_at', c.reopened_at,
        'reopened_by', c.reopened_by,
        'reopen_reason', c.reopen_reason,
        'row_version', c.row_version
      ) order by c.period_year desc, c.period_month desc, c.revision desc)
      from public.workspace_accounting_period_closures c
      where c.workspace_id = p_workspace_id
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.close_workspace_accounting_period(uuid, jsonb) from public;
revoke all on function public.reopen_workspace_accounting_period(uuid, integer, integer, text, integer) from public;
revoke all on function public.pull_workspace_accounting_period_closures(uuid) from public;
grant execute on function public.close_workspace_accounting_period(uuid, jsonb) to authenticated;
grant execute on function public.reopen_workspace_accounting_period(uuid, integer, integer, text, integer) to authenticated;
grant execute on function public.pull_workspace_accounting_period_closures(uuid) to authenticated;

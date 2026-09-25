-- STEUERBERATER-06A — Kontierungen fuer die spaetere Steuerberateruebergabe.
--
-- Eine Kontierung liegt **neben** dem Beleg: Sie sagt, auf welches Sachkonto er
-- nach Meinung des Betriebs gehoert und ob das jemand bestaetigt hat. Sie
-- veraendert nichts am Beleg selbst — kein Betrag, kein Steuerbetrag, kein
-- Steuerstatus, keine Zahlung. Genau eine Kontierung je Beleg; der fachliche
-- Schluessel ist deshalb `(workspace_id, source_type, source_id)`.
--
-- Bewusst **keine** doppelte Buchfuehrung: kein Gegenkonto, kein Buchungssatz,
-- keine Festschreibung, kein Export. Das waeren Versprechen, die diese Schicht
-- nicht einloesen kann.
--
-- Zwei Regeln stehen serverseitig, weil sie den Kern des Workflows tragen:
--
--   1. **Bestaetigt nur mit Sachkonto.** Eine bestaetigte Kontierung ohne Konto
--      waere eine Zusage ohne Inhalt; der Steuerberater bekaeme eine gruene
--      Zeile und keine Buchung.
--   2. **Bestaetigt nur mit Zeitpunkt.** Ohne `confirmed_at` liesse sich
--      spaeter nicht sagen, wann jemand hingesehen hat — und genau das ist der
--      Zweck des Feldes.
--
-- Kein Backfill: Bestehende Belege bekommen hier **keine** Zeile und schon gar
-- keine bestaetigte. Wer nichts kontiert hat, hat nichts kontiert.
--
-- Der Kontenrahmen des Betriebs (SKR03/SKR04) liegt **nicht** hier, sondern in
-- `workspace_settings.settings` — freies JSONB ohne Schemakatalog, das dafuer
-- keine Migration braucht. Hier steht nur, welcher Rahmen beim Kontieren galt;
-- eingefroren, damit eine spaetere Umstellung alte Zuordnungen nicht umdeutet.

create table if not exists public.workspace_accounting_assignments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  client_assignment_id text not null,
  source_type text not null,
  source_id text not null,
  payload jsonb not null default '{}'::jsonb,
  deleted boolean not null default false,
  row_version bigint not null default 1,
  created_by uuid null references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_accounting_assignments_source_type_check
    check (source_type in ('expense', 'invoice')),
  constraint workspace_accounting_assignments_client_id_unique
    unique (workspace_id, client_assignment_id)
);

/*
 * Genau eine **aktive** Kontierung je Beleg. Ein Grabstein zaehlt nicht mit:
 * Wird eine Kontierung geloescht und spaeter neu angelegt, ist das derselbe
 * Beleg mit einer neuen Zuordnung — kein Konflikt.
 */
create unique index if not exists workspace_accounting_assignments_source_unique
  on public.workspace_accounting_assignments (workspace_id, source_type, source_id)
  where not deleted;

create index if not exists workspace_accounting_assignments_updated_idx
  on public.workspace_accounting_assignments (workspace_id, updated_at desc);

drop trigger if exists workspace_accounting_assignments_set_updated_at
  on public.workspace_accounting_assignments;
create trigger workspace_accounting_assignments_set_updated_at
before update on public.workspace_accounting_assignments
for each row execute function public.set_workspace_updated_at();

alter table public.workspace_accounting_assignments enable row level security;

drop policy if exists workspace_accounting_assignments_select_writer
  on public.workspace_accounting_assignments;
create policy workspace_accounting_assignments_select_writer
on public.workspace_accounting_assignments for select to authenticated
using (public.can_write_workspace(workspace_id));

revoke all on public.workspace_accounting_assignments from public, anon;
grant select on public.workspace_accounting_assignments to authenticated;

/* -------------------------------------------------------------------------- */
/* Pruefung des Kontierungs-Payloads                                          */
/* -------------------------------------------------------------------------- */

/*
 * Nur die Felder, die den Workflow tragen. Alles Uebrige bleibt Ganzdokument —
 * eine zu enge Pruefung waere ein zweites Schema, das mit dem Client
 * auseinanderlaufen kann.
 */
create or replace function public.validate_workspace_accounting_payload(p_payload jsonb)
returns void
language plpgsql
immutable
set search_path = public
as $$
declare
  v_status text;
  v_origin text;
  v_chart text;
  v_account text;
begin
  if jsonb_typeof(p_payload) <> 'object' then
    raise exception 'accounting_payload_invalid: kein Objekt' using errcode = 'P0001';
  end if;

  v_status := p_payload->>'status';
  if v_status is null
     or v_status not in ('needs_review', 'confirmed', 'needs_clarification') then
    raise exception 'accounting_status_invalid: %', coalesce(v_status, '(fehlt)')
      using errcode = 'P0001';
  end if;

  v_origin := p_payload->>'origin';
  if v_origin is null or v_origin not in ('suggested', 'manual') then
    raise exception 'accounting_origin_invalid: %', coalesce(v_origin, '(fehlt)')
      using errcode = 'P0001';
  end if;

  v_chart := p_payload->>'chartOfAccounts';
  if v_chart is null or v_chart not in ('SKR03', 'SKR04') then
    raise exception 'accounting_chart_invalid: %', coalesce(v_chart, '(fehlt)')
      using errcode = 'P0001';
  end if;

  if v_status = 'confirmed' then
    /*
     * Die beiden Regeln, die der Workflow braucht. Eine bestaetigte Kontierung
     * ohne Sachkonto waere eine gruene Zeile ohne Buchung; eine ohne Zeitpunkt
     * liesse sich spaeter nicht belegen.
     */
    v_account := nullif(trim(coalesce(p_payload->>'accountNumber', '')), '');
    if v_account is null then
      raise exception 'accounting_confirmed_without_account: Sachkonto fehlt'
        using errcode = 'P0001';
    end if;
    if nullif(trim(coalesce(p_payload->>'confirmedAt', '')), '') is null then
      raise exception 'accounting_confirmed_without_timestamp: confirmedAt fehlt'
        using errcode = 'P0001';
    end if;
  end if;
end;
$$;

revoke all on function public.validate_workspace_accounting_payload(jsonb) from public;

/* -------------------------------------------------------------------------- */
/* Kontierung anlegen / aendern / loeschen                                    */
/* -------------------------------------------------------------------------- */

create or replace function public.upsert_workspace_accounting_assignment(
  p_workspace_id uuid,
  p_payload jsonb,
  p_row_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_assignment_id text;
  v_source_type text;
  v_source_id text;
  v_deleted boolean;
  v_payload jsonb;
  v_existing public.workspace_accounting_assignments;
  v_row public.workspace_accounting_assignments;
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

  v_assignment_id := nullif(trim(coalesce(p_payload->>'client_assignment_id', '')), '');
  if v_assignment_id is null then
    raise exception 'client_assignment_id fehlt';
  end if;

  v_source_type := nullif(trim(coalesce(p_payload->>'source_type', '')), '');
  if v_source_type is null or v_source_type not in ('expense', 'invoice') then
    raise exception 'source_type ungueltig';
  end if;

  v_source_id := nullif(trim(coalesce(p_payload->>'source_id', '')), '');
  if v_source_id is null then
    raise exception 'source_id fehlt';
  end if;

  v_deleted := coalesce((p_payload->>'deleted')::boolean, false);
  v_payload := coalesce(p_payload->'payload', '{}'::jsonb);
  if jsonb_typeof(v_payload) <> 'object' then
    raise exception 'payload ungueltig';
  end if;
  v_payload := v_payload - 'sync';

  select * into v_existing
  from public.workspace_accounting_assignments
  where workspace_id = p_workspace_id
    and client_assignment_id = v_assignment_id
  for update;

  /*
   * Ein Grabstein traegt keine Kontierung und wird deshalb nicht geprueft —
   * sonst liesse sich eine fehlerhafte Altzeile nicht mehr entfernen.
   */
  if not v_deleted then
    perform public.validate_workspace_accounting_payload(v_payload);
  end if;

  if v_existing.id is null then
    if v_deleted then
      -- Grabstein fuer eine Zeile, die die Cloud nie sah: nichts anzulegen.
      return jsonb_build_object('row_version', 0, 'updated_at', now(), 'deleted', true, 'noop', true);
    end if;
    insert into public.workspace_accounting_assignments (
      workspace_id, client_assignment_id, source_type, source_id,
      payload, deleted, row_version, created_by
    ) values (
      p_workspace_id, v_assignment_id, v_source_type, v_source_id,
      v_payload, false, 1, v_user_id
    )
    returning * into v_row;
  else
    if v_existing.row_version <> coalesce(p_row_version, -1) then
      raise exception 'Versionskonflikt: Kontierung % hat Version %, erwartet %',
        v_assignment_id, v_existing.row_version, p_row_version;
    end if;
    if v_existing.deleted then
      raise exception 'Kontierung bereits geloescht';
    end if;
    /*
     * Der Beleg einer Kontierung wechselt nicht. Waere das erlaubt, koennte
     * eine bestaetigte Zuordnung stillschweigend auf einen anderen Beleg
     * zeigen — und niemand saehe es.
     */
    if not v_deleted
       and (v_existing.source_type <> v_source_type or v_existing.source_id <> v_source_id) then
      raise exception 'accounting_source_immutable: Beleg einer Kontierung ist unveraenderlich'
        using errcode = 'P0001';
    end if;

    if v_deleted then
      update public.workspace_accounting_assignments
      set deleted = true,
          row_version = row_version + 1,
          updated_at = now()
      where id = v_existing.id
      returning * into v_row;
    else
      update public.workspace_accounting_assignments
      set payload = v_payload,
          row_version = row_version + 1,
          updated_at = now()
      where id = v_existing.id
      returning * into v_row;
    end if;
  end if;

  return jsonb_build_object(
    'row_version', v_row.row_version,
    'updated_at', v_row.updated_at,
    'deleted', v_row.deleted
  );
end;
$$;

/* -------------------------------------------------------------------------- */
/* Kontierungen lesen                                                         */
/* -------------------------------------------------------------------------- */

create or replace function public.pull_workspace_accounting_assignments(p_workspace_id uuid)
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
    'assignments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'client_assignment_id', a.client_assignment_id,
        'source_type', a.source_type,
        'source_id', a.source_id,
        'payload', a.payload,
        'deleted', a.deleted,
        'row_version', a.row_version,
        'updated_at', a.updated_at
      ) order by a.updated_at desc)
      from public.workspace_accounting_assignments a
      where a.workspace_id = p_workspace_id
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.upsert_workspace_accounting_assignment(uuid, jsonb, bigint) from public;
revoke all on function public.pull_workspace_accounting_assignments(uuid) from public;
grant execute on function public.upsert_workspace_accounting_assignment(uuid, jsonb, bigint) to authenticated;
grant execute on function public.pull_workspace_accounting_assignments(uuid) to authenticated;

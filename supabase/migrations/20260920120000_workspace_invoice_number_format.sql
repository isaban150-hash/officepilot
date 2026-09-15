-- PRODUCT-BASIS-FIRMENPROFIL-EINSTELLUNGEN-01C -- Rechnungsnummernformat als
-- serverseitige, sequenz-nahe Workspace-Einstellung mit Jahres-Sperre.
--
-- Die Nummernvergabe bleibt unveraendert: workspace_invoice_sequences (je
-- Workspace/Jahr, FOR UPDATE, monoton, Unique auf invoice_number), vergeben
-- ausschliesslich in finalize_workspace_invoice. Neu ist nur, WIE die Nummer
-- aus (Jahr, Sequenz) gebildet wird:
--
--   workspace_invoice_number_formats  -- das Standardformat des Workspace
--                                        (owner/admin schreiben per RPC, Mitglieder lesen)
--   workspace_invoice_sequences.*     -- die je Jahr EINGEFRORENE Kopie
--                                        (number_prefix, year_in_number, number_padding,
--                                         format_locked_at)
--
-- Sperre: Das Format eines Jahres wird spaetestens mit der ersten vergebenen
-- Nummer dieses Jahres eingefroren (im selben Sperrbereich der Sequenzzeile).
-- 01C2: Das Standardformat bleibt aenderbar; es wirkt ausschliesslich auf Jahre
-- ohne Nummern (ein bereits benutztes Jahr behaelt seine eingefrorene Kopie).
-- Bestehende Jahre mit Nummern werden auf das historische Format YYYY-NNNN
-- fixiert. Keine bestehende Rechnungsnummer wird veraendert.
--
-- Format: [prefix]['-' wenn prefix][YYYY '-' wenn year_in_number][lpad(seq, padding)]
--   Beispiele: 2026-0001 / RE-2026-0001 / RE-0001

alter table public.workspace_invoice_sequences
  add column if not exists number_prefix text not null default '',
  add column if not exists year_in_number boolean not null default true,
  add column if not exists number_padding integer not null default 4,
  add column if not exists format_locked_at timestamptz null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'workspace_invoice_sequences_padding_check') then
    alter table public.workspace_invoice_sequences
      add constraint workspace_invoice_sequences_padding_check check (number_padding between 3 and 8);
  end if;
end $$;

-- Historische Jahre mit vergebenen Nummern: Legacy-Format YYYY-NNNN fixieren.
update public.workspace_invoice_sequences
set format_locked_at = coalesce(format_locked_at, updated_at, now())
where last_sequence > 0 and format_locked_at is null;

create table if not exists public.workspace_invoice_number_formats (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  number_prefix text not null default '',
  year_in_number boolean not null default true,
  number_padding integer not null default 4,
  row_version bigint not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid null references auth.users (id) on delete set null,
  constraint workspace_invoice_number_formats_padding_check check (number_padding between 3 and 8),
  constraint workspace_invoice_number_formats_prefix_check
    check (number_prefix = '' or (length(number_prefix) between 1 and 10 and number_prefix ~ ('^[A-Za-z0-9]+(-[A-Za-z0-9]+)*' || chr(36))))
);

drop trigger if exists workspace_invoice_number_formats_set_updated_at on public.workspace_invoice_number_formats;
create trigger workspace_invoice_number_formats_set_updated_at
before update on public.workspace_invoice_number_formats
for each row execute function public.set_workspace_updated_at();

alter table public.workspace_invoice_number_formats enable row level security;
drop policy if exists workspace_invoice_number_formats_select_member on public.workspace_invoice_number_formats;
create policy workspace_invoice_number_formats_select_member
on public.workspace_invoice_number_formats for select to authenticated
using (public.is_active_workspace_member(workspace_id));
revoke all on public.workspace_invoice_number_formats from public, anon;
grant select on public.workspace_invoice_number_formats to authenticated;

/* -------------------------------------------------------------------------- */
/* Validierung / Formatierung                                                 */
/* -------------------------------------------------------------------------- */

create or replace function public.validate_workspace_invoice_number_format(
  p_prefix text,
  p_year_in_number boolean,
  p_padding integer
)
returns text
language plpgsql
immutable
as $$
begin
  if p_prefix is null then
    raise exception 'Nummernformat ungueltig: prefix' using errcode = 'P0001';
  end if;
  if p_prefix <> '' and (
       length(p_prefix) > 10
       or p_prefix <> trim(p_prefix)
       or p_prefix !~ ('^[A-Za-z0-9]+(-[A-Za-z0-9]+)*' || chr(36))
  ) then
    raise exception 'Nummernformat ungueltig: prefix' using errcode = 'P0001';
  end if;
  if p_year_in_number is null then
    raise exception 'Nummernformat ungueltig: year_in_number' using errcode = 'P0001';
  end if;
  if p_padding is null or p_padding < 3 or p_padding > 8 then
    raise exception 'Nummernformat ungueltig: padding' using errcode = 'P0001';
  end if;
  return p_prefix;
end;
$$;

create or replace function public.build_workspace_invoice_number(
  p_prefix text,
  p_year_in_number boolean,
  p_padding integer,
  p_year integer,
  p_sequence integer
)
returns text
language sql
immutable
as $$
  select case when coalesce(p_prefix, '') <> '' then p_prefix || '-' else '' end
      || case when p_year_in_number then p_year::text || '-' else '' end
      || lpad(p_sequence::text, greatest(p_padding, length(p_sequence::text)), '0');
$$;

/*
 * Wird ausschliesslich aus finalize_workspace_invoice aufgerufen, nachdem die
 * Sequenzzeile mit FOR UPDATE gesperrt wurde. Erste Nummer eines Jahres:
 * Standardformat auf die Zeile kopieren und einfrieren. Danach: nur noch die
 * eingefrorene Kopie. Rueckgabe: die fertige Nummer.
 */
create or replace function public.format_workspace_invoice_number(
  p_workspace_id uuid,
  p_year integer,
  p_sequence integer
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seq public.workspace_invoice_sequences;
  v_fmt public.workspace_invoice_number_formats;
begin
  select * into v_seq from public.workspace_invoice_sequences
  where workspace_id = p_workspace_id and invoice_year = p_year;
  if v_seq.workspace_id is null then
    raise exception 'Nummernkreis nicht vorhanden';
  end if;

  if v_seq.format_locked_at is null then
    select * into v_fmt from public.workspace_invoice_number_formats where workspace_id = p_workspace_id;
    update public.workspace_invoice_sequences
    set number_prefix = coalesce(v_fmt.number_prefix, ''),
        year_in_number = coalesce(v_fmt.year_in_number, true),
        number_padding = coalesce(v_fmt.number_padding, 4),
        format_locked_at = now()
    where workspace_id = p_workspace_id and invoice_year = p_year
    returning * into v_seq;
  end if;

  return public.build_workspace_invoice_number(v_seq.number_prefix, v_seq.year_in_number, v_seq.number_padding, p_year, p_sequence);
end;
$$;

revoke all on function public.validate_workspace_invoice_number_format(text, boolean, integer) from public;
revoke all on function public.build_workspace_invoice_number(text, boolean, integer, integer, integer) from public;
revoke all on function public.format_workspace_invoice_number(uuid, integer, integer) from public;

/* -------------------------------------------------------------------------- */
/* Lesen / Setzen (owner/admin) mit Jahres-Sperre                              */
/* -------------------------------------------------------------------------- */

create or replace function public.get_workspace_invoice_number_format(p_workspace_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fmt public.workspace_invoice_number_formats;
  v_year integer := extract(year from timezone('utc', now()))::integer;
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet';
  end if;
  if not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;
  select * into v_fmt from public.workspace_invoice_number_formats where workspace_id = p_workspace_id;
  return jsonb_build_object(
    'prefix', coalesce(v_fmt.number_prefix, ''),
    'year_in_number', coalesce(v_fmt.year_in_number, true),
    'padding', coalesce(v_fmt.number_padding, 4),
    'row_version', coalesce(v_fmt.row_version, 0),
    'current_year', v_year,
    'effective_from_year', case when exists (
      select 1 from public.workspace_invoice_sequences s
      where s.workspace_id = p_workspace_id and s.invoice_year = v_year and s.format_locked_at is not null
    ) then v_year + 1 else v_year end,
    'locked_years', coalesce((
      select jsonb_agg(jsonb_build_object(
        'year', s.invoice_year,
        'prefix', s.number_prefix,
        'year_in_number', s.year_in_number,
        'padding', s.number_padding,
        'last_sequence', s.last_sequence
      ) order by s.invoice_year)
      from public.workspace_invoice_sequences s
      where s.workspace_id = p_workspace_id and s.format_locked_at is not null
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.set_workspace_invoice_number_format(
  p_workspace_id uuid,
  p_prefix text,
  p_year_in_number boolean,
  p_padding integer,
  p_row_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_year integer := extract(year from timezone('utc', now()))::integer;
  v_seq public.workspace_invoice_sequences;
  v_current bigint;
  v_row public.workspace_invoice_number_formats;
begin
  if v_user_id is null then
    raise exception 'Nicht angemeldet';
  end if;
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Keine Schreibberechtigung';
  end if;
  perform public.validate_workspace_invoice_number_format(p_prefix, p_year_in_number, p_padding);

  /*
   * Jahres-Sperre im selben Sperrbereich wie die Nummernvergabe: Die Sequenz-
   * zeile des laufenden Jahres wird angelegt/gesperrt, damit sich eine
   * parallel laufende erste Finalisierung dieses Jahres gegen die Aenderung
   * serialisiert (kein halber Zustand).
   *
   * 01C2 -- Jahresregel: Ein Jahr mit Nummern bleibt unveraenderlich, weil es
   * seine EINGEFRORENE Kopie traegt. Das Standardformat darf deshalb auch
   * waehrend eines gesperrten Jahres geaendert werden; es wirkt ausschliesslich
   * auf Jahre ohne Nummern (das naechste unbenutzte Jahr friert es bei seiner
   * ersten Nummer ein). `effective_from_year` benennt das erste Jahr, fuer das
   * die Einstellung gilt.
   */
  insert into public.workspace_invoice_sequences (workspace_id, invoice_year, last_sequence)
  values (p_workspace_id, v_year, 0)
  on conflict (workspace_id, invoice_year) do nothing;

  select * into v_seq from public.workspace_invoice_sequences
  where workspace_id = p_workspace_id and invoice_year = v_year
  for update;

  select row_version into v_current from public.workspace_invoice_number_formats
  where workspace_id = p_workspace_id for update;

  if v_current is null then
    insert into public.workspace_invoice_number_formats (workspace_id, number_prefix, year_in_number, number_padding, row_version, updated_by)
    values (p_workspace_id, p_prefix, p_year_in_number, p_padding, 1, v_user_id)
    returning * into v_row;
  else
    if p_row_version > 0 and p_row_version <> v_current then
      raise exception 'Versionskonflikt invoice_number_format:%', v_current using errcode = 'P0001';
    end if;
    update public.workspace_invoice_number_formats
    set number_prefix = p_prefix,
        year_in_number = p_year_in_number,
        number_padding = p_padding,
        row_version = row_version + 1,
        updated_by = v_user_id
    where workspace_id = p_workspace_id
    returning * into v_row;
  end if;

  return jsonb_build_object(
    'prefix', v_row.number_prefix,
    'year_in_number', v_row.year_in_number,
    'padding', v_row.number_padding,
    'row_version', v_row.row_version,
    'current_year', v_year,
    'current_year_locked', v_seq.format_locked_at is not null,
    'effective_from_year', case when v_seq.format_locked_at is not null then v_year + 1 else v_year end
  );
end;
$$;

revoke all on function public.get_workspace_invoice_number_format(uuid) from public;
revoke all on function public.set_workspace_invoice_number_format(uuid, text, boolean, integer, bigint) from public;
grant execute on function public.get_workspace_invoice_number_format(uuid) to authenticated;
grant execute on function public.set_workspace_invoice_number_format(uuid, text, boolean, integer, bigint) to authenticated;

/* -------------------------------------------------------------------------- */
/* finalize_workspace_invoice -- byteidentisch mit 20260912120000, bis auf     */
/* den Formataufruf (format_workspace_invoice_number(uuid, integer, integer)). */
/* -------------------------------------------------------------------------- */

create or replace function public.finalize_workspace_invoice(
  p_workspace_id uuid,
  p_vorgang_id text,
  p_client_invoice_id text,
  p_invoice jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_existing public.workspace_invoices;
  v_year integer;
  v_next_sequence integer;
  v_invoice_number text;
  v_invoice_type text;
  v_payload jsonb;
  v_normalized_incoming jsonb;
  v_normalized_existing jsonb;
  v_issue_date text;
  v_vorgang_id text;
  v_vorgang public.workspace_vorgaenge;
  v_current_amendment_sequence integer;
  v_expected_amendment_sequence integer;
  v_expected_camel jsonb;
  v_expected_snake jsonb;
  v_has_expected_camel boolean := false;
  v_has_expected_snake boolean := false;
  v_parsed_camel integer;
  v_parsed_snake integer;
  v_has_other_final boolean;
begin
  if v_user_id is null then
    raise exception 'Nicht angemeldet';
  end if;

  if p_workspace_id is null then
    raise exception 'workspace_id fehlt';
  end if;

  if not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  -- 01B2b (b): NULL heisst „kein Auftrag", '' heisst „kaputt".
  if p_vorgang_id is not null and nullif(trim(p_vorgang_id), '') is null then
    raise exception 'vorgang_id fehlt';
  end if;
  v_vorgang_id := nullif(trim(coalesce(p_vorgang_id, '')), '');

  if nullif(trim(coalesce(p_client_invoice_id, '')), '') is null then
    raise exception 'client_invoice_id fehlt';
  end if;

  if p_invoice is null or jsonb_typeof(p_invoice) <> 'object' then
    raise exception 'invoice payload fehlt';
  end if;

  if jsonb_typeof(coalesce(p_invoice->'positions', 'null'::jsonb)) <> 'array' then
    raise exception 'invoice positions fehlen';
  end if;

  v_invoice_type := nullif(trim(coalesce(p_invoice->>'type', '')), '');
  if v_invoice_type is null then
    raise exception 'invoice type fehlt';
  end if;

  /*
   * 01B2b (a) — der eine Zweig. Links die Rechnung ohne Auftrag, rechts der
   * unveraenderte Auftragspfad mit dem gemeinsamen Lock.
   */
  if v_vorgang_id is null then
    if v_invoice_type <> 'rechnung' then
      raise exception 'invoice_requires_vorgang_for_type';
    end if;
  else
    -- Shared lock with confirm_workspace_order_amendment (first).
    select *
    into v_vorgang
    from public.workspace_vorgaenge v
    where v.workspace_id = p_workspace_id
      and v.vorgang_id = v_vorgang_id
    for update;

    if not found or v_vorgang.deleted then
      raise exception 'Vorgang gehört nicht zum Workspace oder existiert nicht';
    end if;
  end if;

  /*
   * 01B2b-R1 — Laufzeitfund auf lokaler PostgreSQL: Der erste Lauf speichert
   * den Payload mit serverseitig kanonisiertem `date`/`issueDate`/`type`; der
   * Replay-Kandidat wurde bisher nur um `id`/`status` ergaenzt. Schickt der
   * Client kein `date`, fehlt es im Kandidaten, und ein bytegleicher zweiter
   * Aufruf scheiterte als „abweichender Rechnungsinhalt". Derselbe Fehler
   * steckt in jeder Vorgaengerfassung seit 03A.
   *
   * Der Kandidat wird deshalb mit derselben Ergaenzung gebildet wie der
   * Insert — seit R2 in `workspace_invoice_replay_candidate`, weil er fuer
   * einen datumslosen Request das Datum der gespeicherten Zeile braucht. Die
   * Insert-Regel hier bleibt: `issueDate` vor `date` vor UTC-heute. `date`
   * bleibt Teil der Invariante — ein anderes Rechnungsdatum ist eine andere
   * Rechnung.
   */
  v_issue_date := coalesce(
    nullif(trim(coalesce(p_invoice->>'issueDate', '')), ''),
    nullif(trim(coalesce(p_invoice->>'date', '')), ''),
    to_char(timezone('utc', now()), 'YYYY-MM-DD')
  );
  begin
    v_year := extract(year from v_issue_date::date)::integer;
  exception
    when others then
      v_year := extract(year from timezone('utc', now()))::integer;
  end;

  /*
   * 01B2b-R2 — der Replay-Kandidat entsteht in beiden Replay-Ausgaengen ueber
   * `workspace_invoice_replay_candidate`, weil er die gespeicherte Zeile
   * kennen muss: Ein datumsloser Request bekommt sein Datum von ihr, nicht
   * vom heutigen Tag. Hier steht deshalb keine zweite Definition.
   */

  select *
  into v_existing
  from public.workspace_invoices wi
  where wi.workspace_id = p_workspace_id
    and wi.client_invoice_id = trim(p_client_invoice_id)
  for update;

  if found then
    /*
     * 01B2b (c) — kein stilles Umhaengen. Die Rechnungsidentitaet bleibt
     * `workspace_id + client_invoice_id`; der Auftragsbezug ist eine
     * zusaetzliche Replay-Invariante und wandert nicht in den Payload.
     */
    if v_existing.vorgang_id is distinct from v_vorgang_id then
      raise exception 'Idempotenzkonflikt: abweichender Vorgangsbezug für client_invoice_id';
    end if;

    v_normalized_existing := public.normalize_workspace_invoice_payload_for_idempotency(v_existing.payload);
    v_normalized_incoming := public.workspace_invoice_replay_candidate(
      p_invoice, trim(p_client_invoice_id), v_invoice_type, v_existing.payload
    );
    if v_normalized_existing is distinct from v_normalized_incoming then
      raise exception 'Idempotenzkonflikt: abweichender Rechnungsinhalt für client_invoice_id';
    end if;

    return jsonb_build_object(
      'idempotent_replay', true,
      'invoice', v_existing.payload,
      'row', to_jsonb(v_existing)
    );
  end if;

  /*
   * 01D — Single-Final-Invoice-Guard.
   *
   * Steht bewusst **nach** dem Idempotenz-Replay: Ein Wiederholungslauf nach
   * verlorener Antwort traegt dieselbe `client_invoice_id` und muss den
   * bestehenden Erfolg zurueckbekommen, nicht diesen Fehler. Die eigene
   * Kennung ist deshalb ausdruecklich ausgenommen.
   *
   * Der Vorgang ist an dieser Stelle bereits gesperrt; die Pruefung ist damit
   * gegen parallele Transaktionen desselben Vorgangs serialisiert. Ohne
   * Vorgang wird dieser Zweig nie betreten — `schluss` ist dort abgewiesen.
   *
   * 01C — `cancelled_at is null`: Eine stornierte Schlussrechnung bleibt
   * historisch stehen, blockiert aber die notwendige Ersatzrechnung nicht
   * mehr. Der partielle Unique-Index traegt dieselbe Bedingung; beide
   * Definitionen von „wirksame Schlussrechnung" duerfen nie auseinanderlaufen.
   */
  if v_invoice_type = 'schluss' then
    select exists (
      select 1
      from public.workspace_invoices wi
      where wi.workspace_id = p_workspace_id
        and wi.vorgang_id = v_vorgang_id
        and wi.invoice_type = 'schluss'
        and wi.invoice_status in ('vorbereitet', 'versendet')
        and wi.cancelled_at is null
        and wi.client_invoice_id <> trim(p_client_invoice_id)
    )
    into v_has_other_final;

    if coalesce(v_has_other_final, false) then
      raise exception 'invoice_final_already_exists';
    end if;
  end if;

  -- New Schluss only: amendment revision must match client expectation (default 0).
  -- Meta fields must agree when both are present; invalid values → invoice_amendment_state_stale.
  -- Runs after idempotent replay and before sequence lock / invoice insert.
  if v_invoice_type = 'schluss' then
    select coalesce(max(a.sequence_no), 0)
    into v_current_amendment_sequence
    from public.workspace_order_amendments a
    where a.workspace_id = p_workspace_id
      and a.vorgang_id = v_vorgang_id;

    v_has_expected_camel :=
      (p_invoice ? 'expectedAmendmentSequence')
      and jsonb_typeof(p_invoice->'expectedAmendmentSequence') is distinct from 'null';
    v_has_expected_snake :=
      (p_invoice ? 'expected_amendment_sequence')
      and jsonb_typeof(p_invoice->'expected_amendment_sequence') is distinct from 'null';

    if v_has_expected_camel then
      v_expected_camel := p_invoice->'expectedAmendmentSequence';
      if jsonb_typeof(v_expected_camel) <> 'number' then
        raise exception 'invoice_amendment_state_stale';
      end if;
      if (v_expected_camel::text)::numeric < 0
         or (v_expected_camel::text)::numeric <> trunc((v_expected_camel::text)::numeric)
         or (v_expected_camel::text)::numeric > 2147483647 then
        raise exception 'invoice_amendment_state_stale';
      end if;
      v_parsed_camel := ((v_expected_camel::text)::numeric)::integer;
    end if;

    if v_has_expected_snake then
      v_expected_snake := p_invoice->'expected_amendment_sequence';
      if jsonb_typeof(v_expected_snake) <> 'number' then
        raise exception 'invoice_amendment_state_stale';
      end if;
      if (v_expected_snake::text)::numeric < 0
         or (v_expected_snake::text)::numeric <> trunc((v_expected_snake::text)::numeric)
         or (v_expected_snake::text)::numeric > 2147483647 then
        raise exception 'invoice_amendment_state_stale';
      end if;
      v_parsed_snake := ((v_expected_snake::text)::numeric)::integer;
    end if;

    if v_has_expected_camel and v_has_expected_snake then
      if v_parsed_camel is distinct from v_parsed_snake then
        raise exception 'invoice_amendment_state_stale';
      end if;
      v_expected_amendment_sequence := v_parsed_camel;
    elsif v_has_expected_camel then
      v_expected_amendment_sequence := v_parsed_camel;
    elsif v_has_expected_snake then
      v_expected_amendment_sequence := v_parsed_snake;
    else
      v_expected_amendment_sequence := 0;
    end if;

    if v_current_amendment_sequence is distinct from v_expected_amendment_sequence then
      raise exception 'invoice_amendment_state_stale';
    end if;
  end if;

  -- 01B2b-R1: v_issue_date und v_year sind oben, vor dem Replay, abgeleitet.

  /*
   * Ein gemeinsamer Nummernkreis fuer alle Rechnungen eines Workspace-Jahres.
   * Er kennt den Vorgang nicht und darf ihn nie kennenlernen — eine freie
   * Rechnung zaehlt genauso mit wie eine auftragsgebundene.
   */
  insert into public.workspace_invoice_sequences (workspace_id, invoice_year, last_sequence)
  values (p_workspace_id, v_year, 0)
  on conflict (workspace_id, invoice_year) do nothing;

  select s.last_sequence
  into v_next_sequence
  from public.workspace_invoice_sequences s
  where s.workspace_id = p_workspace_id
    and s.invoice_year = v_year
  for update;

  if v_next_sequence is null then
    raise exception 'Nummernkreis konnte nicht gesperrt werden';
  end if;

  v_next_sequence := v_next_sequence + 1;
  /*
   * FIRMENPROFIL-01C -- Format des Nummernkreises: beim ersten Vergeben eines
   * Jahres wird das Workspace-Standardformat auf der (hier bereits gesperrten)
   * Sequenzzeile eingefroren; danach zaehlt nur noch die eingefrorene Kopie.
   */
  v_invoice_number := public.format_workspace_invoice_number(p_workspace_id, v_year, v_next_sequence);

  v_payload := public.normalize_workspace_invoice_payload_for_idempotency(p_invoice)
    || jsonb_build_object(
      'id', trim(p_client_invoice_id),
      'number', v_invoice_number,
      'invoiceSequenceNumber', v_next_sequence,
      'type', v_invoice_type,
      'status', 'vorbereitet',
      'date', v_issue_date,
      'issueDate', coalesce(nullif(trim(coalesce(p_invoice->>'issueDate', '')), ''), v_issue_date)
    );

  begin
    insert into public.workspace_invoices (
      workspace_id,
      vorgang_id,
      client_invoice_id,
      invoice_number,
      invoice_year,
      invoice_sequence_number,
      invoice_type,
      invoice_status,
      payload,
      row_version,
      updated_by
    )
    values (
      p_workspace_id,
      v_vorgang_id,
      trim(p_client_invoice_id),
      v_invoice_number,
      v_year,
      v_next_sequence,
      v_invoice_type,
      'vorbereitet',
      v_payload,
      1,
      v_user_id
    )
    returning * into v_existing;
  exception
    when unique_violation then
      select *
      into v_existing
      from public.workspace_invoices wi
      where wi.workspace_id = p_workspace_id
        and wi.client_invoice_id = trim(p_client_invoice_id);

      if not found then
        /*
         * 01D — Backstop des partiellen Unique-Index.
         *
         * Die eigene Kennung existiert nicht, trotzdem kollidierte der Insert:
         * Bei einer Schlussrechnung kann das nur die Single-Final-Invariante
         * sein. Statt einer rohen Constraint-Meldung derselbe benennbare
         * Fehler wie oben — sonst waere der Race-Ausgang fuer den Aufrufer
         * ununterscheidbar von einem beliebigen Datenbankfehler.
         */
        if v_invoice_type = 'schluss' then
          raise exception 'invoice_final_already_exists';
        end if;
        raise;
      end if;

      -- 01B2b (c) — dieselbe Replay-Invariante auch im Race-Ausgang.
      if v_existing.vorgang_id is distinct from v_vorgang_id then
        raise exception 'Idempotenzkonflikt: abweichender Vorgangsbezug für client_invoice_id';
      end if;

      -- 01B2b-R2: dieselbe Kandidatenfunktion wie im regulaeren Replay.
      v_normalized_existing := public.normalize_workspace_invoice_payload_for_idempotency(v_existing.payload);
      v_normalized_incoming := public.workspace_invoice_replay_candidate(
        p_invoice, trim(p_client_invoice_id), v_invoice_type, v_existing.payload
      );
      if v_normalized_existing is distinct from v_normalized_incoming then
        raise exception 'Idempotenzkonflikt: abweichender Rechnungsinhalt für client_invoice_id';
      end if;

      return jsonb_build_object(
        'idempotent_replay', true,
        'invoice', v_existing.payload,
        'row', to_jsonb(v_existing)
      );
  end;

  update public.workspace_invoice_sequences
  set last_sequence = v_next_sequence
  where workspace_id = p_workspace_id
    and invoice_year = v_year
    and last_sequence = v_next_sequence - 1;

  if not found then
    raise exception 'Nummernkreis konnte nicht erhöht werden';
  end if;

  return jsonb_build_object(
    'idempotent_replay', false,
    'invoice', v_existing.payload,
    'row', to_jsonb(v_existing)
  );
end;
$$;

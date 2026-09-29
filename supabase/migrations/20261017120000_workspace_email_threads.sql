-- E-MAIL 07F-01A — Antworten und Gesprächsverläufe (Threads).
--
-- Keine zweite Mailwelt: `workspace_email_messages` (07D/07E) bekommt eine
-- eigene, providerneutrale OfficeTakt-Thread-Identität und die RFC-Bezüge.
--
--   thread_id            eigene Thread-Kennung (stabil, providerunabhängig)
--   reply_to_message_id  beantwortete Nachricht (Eltern), falls bekannt
--   rfc_message_id       Message-ID normalisiert (ohne <>, klein):
--                          eingehend aus internet_message_id,
--                          ausgehend aus der vom Versanddienst gelieferten ID
--                          (Brevo liefert die RFC-Message-ID) — nie erfunden
--   in_reply_to          Message-ID der beantworteten Nachricht (normalisiert)
--   references_ids       References-Kette (normalisiert, jüngste zuletzt, max. 30)
--   reply_to_addresses   Reply-To eingehender Mail (für den Antwortempfänger)
--
-- Thread-Zuordnung eingehender Mail (`email_resolve_thread`), in dieser Reihenfolge:
--   1. In-Reply-To → bekannte Message-ID im Workspace,
--   2. References → bekannte Message-ID (jüngste zuerst),
--   3. Microsoft conversationId nur unterstützend: gleiches Postfach UND der
--      Absender ist bereits Teilnehmer dieses Verlaufs,
--   4. sonst ein neuer Verlauf. Der Betreff wird NIE zur Zuordnung benutzt.
-- Deduplizierung (07E, unverändert) und Thread-Zuordnung sind getrennt: eine
-- Nachricht wird eindeutig dedupliziert und trotzdem korrekt eingeordnet.
-- Kommt eine Antwort vor ihrem Original an, führt das spätere Original beide
-- Verläufe zusammen (nur über Message-ID-Bezug).
--
-- Antwort aus OfficeTakt (`create_workspace_email_message` mit
-- p_reply_to_message_id): gleicher Verlauf wie das Original, In-Reply-To und
-- References aus dem Original. Versand unverändert über `send-email` (Claim,
-- Rate-Limit, Anhänge, Absender-Snapshot). Nichts sendet automatisch.
--
-- Eingehende Antwort auf eine OfficeTakt-Mail (Bezug per Message-ID): ohne
-- eigene eindeutige Zuordnung übernimmt sie Kunde/Vorgang des beantworteten
-- Verlaufs (assignment_source 'auto_thread') — nie über Betreff oder Namen.
--
-- Setzt 20261014120000 (07E) voraus. Bestehende Migrationen bleiben unverändert.

-- ---------------------------------------------------------------------------
-- 1. Spalten
-- ---------------------------------------------------------------------------

alter table public.workspace_email_messages
  add column if not exists thread_id uuid null,
  add column if not exists reply_to_message_id uuid null references public.workspace_email_messages (id) on delete set null,
  add column if not exists rfc_message_id text null,
  add column if not exists in_reply_to text null,
  add column if not exists references_ids text[] not null default '{}',
  add column if not exists reply_to_addresses text[] not null default '{}';

alter table public.workspace_email_messages drop constraint if exists workspace_email_messages_thread_refs_check;
alter table public.workspace_email_messages add constraint workspace_email_messages_thread_refs_check check (
  cardinality(references_ids) <= 30
  and cardinality(reply_to_addresses) <= 10
  and (rfc_message_id is null or length(rfc_message_id) <= 998)
  and (in_reply_to is null or length(in_reply_to) <= 998)
  and reply_to_message_id is distinct from id
);

-- ---------------------------------------------------------------------------
-- 2. Normalisierung (identisch zu _shared/emailThreadRules.ts)
-- ---------------------------------------------------------------------------

create or replace function public.email_normalize_message_id(p_value text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when v is null or v = '' or length(v) > 900 or v ~ '[[:space:]<>]' or position('@' in v) = 0 then null
    else lower(v)
  end
  from (select btrim(regexp_replace(regexp_replace(btrim(coalesce(p_value, '')), '^<+', ''), '>+$', '')) as v) x;
$$;

-- Liste normalisieren: ohne Dubletten, Reihenfolge bleibt, jüngste `p_max` Einträge.
create or replace function public.email_normalize_message_id_list(p_values text[], p_max integer default 30)
returns text[]
language sql
immutable
set search_path = public
as $$
  select coalesce(array_agg(id order by first_pos), '{}')
  from (
    select id, first_pos
    from (
      select id, min(pos) as first_pos
      from (
        select public.email_normalize_message_id(value) as id, pos
        from unnest(coalesce(p_values, '{}'::text[])) with ordinality as t(value, pos)
      ) n
      where id is not null
      group by id
    ) d
    order by first_pos desc
    limit greatest(coalesce(p_max, 30), 0)
  ) kept;
$$;

grant execute on function public.email_normalize_message_id(text) to authenticated, service_role;
grant execute on function public.email_normalize_message_id_list(text[], integer) to authenticated, service_role;

-- rfc_message_id wird immer aus der Quelle abgeleitet (eingehend: Kopfzeile,
-- ausgehend: ID des Versanddienstes) — nie vom Client gesetzt.
create or replace function public.email_message_set_rfc_id()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.rfc_message_id := case
    when new.direction = 'inbound' then public.email_normalize_message_id(new.internet_message_id)
    else public.email_normalize_message_id(new.provider_message_id)
  end;
  return new;
end;
$$;

drop trigger if exists workspace_email_messages_rfc_id on public.workspace_email_messages;
create trigger workspace_email_messages_rfc_id
before insert or update of internet_message_id, provider_message_id, direction, rfc_message_id on public.workspace_email_messages
for each row execute function public.email_message_set_rfc_id();

revoke all on function public.email_message_set_rfc_id() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Bestand übernehmen: jede Nachricht eigener Verlauf, Neuversuche beim Original
-- ---------------------------------------------------------------------------

update public.workspace_email_messages
set rfc_message_id = case
      when direction = 'inbound' then public.email_normalize_message_id(internet_message_id)
      else public.email_normalize_message_id(provider_message_id)
    end
where rfc_message_id is null;

update public.workspace_email_messages set thread_id = id where thread_id is null;

with recursive chain as (
  select m.id, m.id as root_id
  from public.workspace_email_messages m
  where m.retry_of_message_id is null
  union all
  select c.id, chain.root_id
  from public.workspace_email_messages c
  join chain on c.retry_of_message_id = chain.id
)
update public.workspace_email_messages m
set thread_id = chain.root_id
from chain
where m.id = chain.id and m.thread_id is distinct from chain.root_id;

alter table public.workspace_email_messages alter column thread_id set default gen_random_uuid();
alter table public.workspace_email_messages alter column thread_id set not null;

create index if not exists workspace_email_messages_thread_idx
  on public.workspace_email_messages (workspace_id, thread_id);
create index if not exists workspace_email_messages_rfc_idx
  on public.workspace_email_messages (workspace_id, rfc_message_id)
  where rfc_message_id is not null;
create index if not exists workspace_email_messages_in_reply_to_idx
  on public.workspace_email_messages (workspace_id, in_reply_to)
  where in_reply_to is not null;
create index if not exists workspace_email_messages_references_idx
  on public.workspace_email_messages using gin (references_ids);

-- Zuordnung über den Verlauf ist eine eigene, nachvollziehbare Quelle.
alter table public.workspace_email_messages drop constraint if exists workspace_email_messages_assignment_source_check;
alter table public.workspace_email_messages add constraint workspace_email_messages_assignment_source_check check (
  assignment_source is null or assignment_source in ('auto_sender', 'auto_reference', 'auto_thread', 'manual')
);
alter table public.workspace_email_assignment_events drop constraint if exists workspace_email_assignment_events_source_check;
alter table public.workspace_email_assignment_events add constraint workspace_email_assignment_events_source_check
  check (source in ('auto_sender', 'auto_reference', 'auto_thread', 'manual', 'import'));

-- ---------------------------------------------------------------------------
-- 4. Thread-Zuordnung eingehender Mail (nie über den Betreff)
-- ---------------------------------------------------------------------------

create or replace function public.email_resolve_thread(
  p_workspace_id uuid,
  p_in_reply_to text,
  p_references text[],
  p_connection_id uuid,
  p_provider_thread_id text,
  p_from_address text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_in_reply_to text := public.email_normalize_message_id(p_in_reply_to);
  v_references text[] := public.email_normalize_message_id_list(p_references, 30);
  v_from text := lower(btrim(coalesce(p_from_address, '')));
  v_provider_thread text := nullif(btrim(coalesce(p_provider_thread_id, '')), '');
  v_ref text;
  v_hit record;
  i integer;
begin
  -- 1. In-Reply-To
  if v_in_reply_to is not null then
    select m.id, m.thread_id into v_hit
    from public.workspace_email_messages m
    where m.workspace_id = p_workspace_id and m.rfc_message_id = v_in_reply_to
    order by m.created_at, m.id
    limit 1;
    if v_hit.id is not null then
      return jsonb_build_object('thread_id', v_hit.thread_id, 'parent_id', v_hit.id, 'source', 'in_reply_to');
    end if;
  end if;

  -- 2. References (jüngste zuerst)
  if cardinality(v_references) > 0 then
    for i in reverse cardinality(v_references)..1 loop
      v_ref := v_references[i];
      select m.id, m.thread_id into v_hit
      from public.workspace_email_messages m
      where m.workspace_id = p_workspace_id and m.rfc_message_id = v_ref
      order by m.created_at, m.id
      limit 1;
      if v_hit.id is not null then
        return jsonb_build_object('thread_id', v_hit.thread_id, 'parent_id', v_hit.id, 'source', 'references');
      end if;
    end loop;
  end if;

  -- 3. Microsoft conversationId: nur gleiches Postfach UND Absender ist Teilnehmer des Verlaufs.
  if v_provider_thread is not null and p_connection_id is not null and v_from <> '' then
    select m.id, m.thread_id into v_hit
    from public.workspace_email_messages m
    where m.workspace_id = p_workspace_id and m.direction = 'inbound'
      and m.mailbox_connection_id = p_connection_id and m.provider_thread_id = v_provider_thread
      and exists (
        select 1 from public.workspace_email_messages t
        where t.workspace_id = p_workspace_id and t.thread_id = m.thread_id
          and (t.from_address = v_from or (t.direction = 'outbound' and v_from = any (t.to_recipients || t.cc_recipients)))
      )
    order by m.received_at desc nulls last, m.id
    limit 1;
    if v_hit.id is not null then
      return jsonb_build_object('thread_id', v_hit.thread_id, 'parent_id', null, 'source', 'provider_thread');
    end if;
  end if;

  return jsonb_build_object('thread_id', gen_random_uuid(), 'parent_id', null, 'source', 'new');
end;
$$;

revoke all on function public.email_resolve_thread(uuid, text, text[], uuid, text, text) from public, anon, authenticated;
grant execute on function public.email_resolve_thread(uuid, text, text[], uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Import eingehender Mail (07E) + Verlauf
-- ---------------------------------------------------------------------------
-- Unverändert gegenüber 07E bis auf: Verlaufsdaten speichern, Thread zuordnen,
-- Zuordnung aus dem beantworteten Verlauf übernehmen, spätes Original führt zusammen.

create or replace function public.import_workspace_inbound_email(
  p_connection_id uuid,
  p_lease_token uuid,
  p_message jsonb,
  p_attachments jsonb,
  p_skipped_attachments jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_connection public.workspace_mailbox_connections;
  v_provider_message_id text := nullif(btrim(coalesce(p_message->>'provider_message_id', '')), '');
  v_internet_message_id text := nullif(btrim(coalesce(p_message->>'internet_message_id', '')), '');
  v_existing public.workspace_email_messages;
  v_assignment jsonb;
  v_row public.workspace_email_messages;
  v_attachment jsonb;
  v_position integer := 0;
  v_received timestamptz;
  v_in_reply_to text := public.email_normalize_message_id(p_message->>'in_reply_to');
  v_references text[];
  v_reply_to text[];
  v_thread jsonb;
  v_parent public.workspace_email_messages;
  v_thread_id uuid;
begin
  select * into v_connection from public.workspace_mailbox_connections where id = p_connection_id;
  if v_connection.id is null or v_connection.sync_lease_token is distinct from p_lease_token or v_connection.sync_lease_until <= now() then
    raise exception 'Sync-Lease ungueltig';
  end if;
  if v_provider_message_id is null or length(v_provider_message_id) > 512 then
    raise exception 'provider_message_id ungueltig';
  end if;
  if v_internet_message_id is not null and length(v_internet_message_id) > 998 then
    v_internet_message_id := null;
  end if;

  -- Deduplizierung: Provider-Kennung dieses Postfachs, dann Message-ID im Workspace.
  select * into v_existing from public.workspace_email_messages
  where workspace_id = v_connection.workspace_id and direction = 'inbound'
    and mailbox_connection_id = v_connection.id and provider_message_id = v_provider_message_id;
  if v_existing.id is null and v_internet_message_id is not null then
    select * into v_existing from public.workspace_email_messages
    where workspace_id = v_connection.workspace_id and direction = 'inbound'
      and lower(internet_message_id) = lower(v_internet_message_id);
  end if;
  if v_existing.id is not null then
    delete from public.workspace_mailbox_import_failures where connection_id = v_connection.id and provider_message_id = v_provider_message_id;
    return jsonb_build_object('outcome', 'duplicate', 'message_id', v_existing.id);
  end if;

  begin
    v_received := (p_message->>'received_at')::timestamptz;
  exception when others then
    v_received := now();
  end;

  -- 07F-01A: Verlaufsdaten (nur normalisierte Message-IDs / gültige Adressen).
  v_references := public.email_normalize_message_id_list(
    coalesce((select array_agg(x) from jsonb_array_elements_text(case when jsonb_typeof(p_message->'references') = 'array' then p_message->'references' else '[]'::jsonb end) as t(x)), '{}'),
    30
  );
  v_reply_to := coalesce((
    select array_agg(a order by o) from (
      select distinct on (lower(btrim(x))) lower(btrim(x)) as a, o
      from jsonb_array_elements_text(case when jsonb_typeof(p_message->'reply_to') = 'array' then p_message->'reply_to' else '[]'::jsonb end) with ordinality as t(x, o)
      where length(btrim(x)) <= 254 and lower(btrim(x)) ~ '^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]{2,}$'
      order by lower(btrim(x)), o
    ) r
  ), '{}');
  if cardinality(v_reply_to) > 10 then
    v_reply_to := v_reply_to[1:10];
  end if;

  v_thread := public.email_resolve_thread(
    v_connection.workspace_id, v_in_reply_to, v_references, v_connection.id,
    p_message->>'provider_thread_id', p_message->>'from_address'
  );
  v_thread_id := (v_thread->>'thread_id')::uuid;
  if v_thread->>'parent_id' is not null then
    select * into v_parent from public.workspace_email_messages where id = (v_thread->>'parent_id')::uuid;
  end if;

  v_assignment := public.email_inbound_resolve_assignment(v_connection.workspace_id, p_message->>'from_address', p_message->>'subject');
  -- Antwort auf einen zugeordneten Verlauf (Bezug per Message-ID): dessen Kunde/Vorgang,
  -- sofern die eigene Erkennung nichts Eindeutiges liefert und beide noch existieren.
  if v_assignment->>'status' = 'needs_review' and v_parent.id is not null and v_parent.customer_id is not null
     and exists (select 1 from public.workspace_customers c where c.workspace_id = v_connection.workspace_id and c.customer_id = v_parent.customer_id and not c.deleted)
     and (v_parent.vorgang_id is null or exists (select 1 from public.workspace_vorgaenge v where v.workspace_id = v_connection.workspace_id and v.vorgang_id = v_parent.vorgang_id and not v.deleted)) then
    v_assignment := jsonb_build_object('status', 'assigned', 'source', 'auto_thread', 'customer_id', v_parent.customer_id, 'vorgang_id', v_parent.vorgang_id, 'suggested_vorgang_id', null);
  end if;

  insert into public.workspace_email_messages (
    workspace_id, client_message_id, direction, provider, provider_message_id, mailbox_connection_id,
    internet_message_id, provider_thread_id, from_address, from_name,
    to_recipients, cc_recipients, bcc_recipients, subject, body_text, has_html,
    status, received_at, imported_at, skipped_attachments,
    customer_id, vorgang_id, assignment_status, assignment_source, suggested_vorgang_id,
    thread_id, reply_to_message_id, in_reply_to, references_ids, reply_to_addresses
  ) values (
    v_connection.workspace_id,
    'in:' || v_connection.id::text || ':' || md5(v_provider_message_id),
    'inbound', v_connection.provider_type, v_provider_message_id, v_connection.id,
    v_internet_message_id, left(nullif(btrim(coalesce(p_message->>'provider_thread_id', '')), ''), 512),
    left(lower(nullif(btrim(coalesce(p_message->>'from_address', '')), '')), 254), left(nullif(btrim(coalesce(p_message->>'from_name', '')), ''), 200),
    coalesce((select array_agg(left(lower(btrim(x)), 254)) from jsonb_array_elements_text(coalesce(p_message->'to', '[]'::jsonb)) as t(x) where btrim(x) <> ''), '{}'),
    coalesce((select array_agg(left(lower(btrim(x)), 254)) from jsonb_array_elements_text(coalesce(p_message->'cc', '[]'::jsonb)) as t(x) where btrim(x) <> ''), '{}'),
    '{}',
    left(coalesce(p_message->>'subject', ''), 998),
    left(coalesce(p_message->>'body_text', ''), 200000),
    coalesce((p_message->>'has_html')::boolean, false),
    'received', v_received, now(),
    coalesce(p_skipped_attachments, '[]'::jsonb),
    v_assignment->>'customer_id', v_assignment->>'vorgang_id', v_assignment->>'status', v_assignment->>'source', v_assignment->>'suggested_vorgang_id',
    v_thread_id, v_parent.id, v_in_reply_to, v_references, v_reply_to
  )
  returning * into v_row;

  -- Spätes Original: Verläufe, die sich per Message-ID auf diese Nachricht beziehen, zusammenführen.
  -- row_version bleibt unberührt (Versand-Claim und Zuordnung arbeiten optimistisch darauf).
  if v_row.rfc_message_id is not null then
    update public.workspace_email_messages m
    set thread_id = v_row.thread_id
    where m.workspace_id = v_row.workspace_id and m.thread_id <> v_row.thread_id
      and m.thread_id in (
        select c.thread_id from public.workspace_email_messages c
        where c.workspace_id = v_row.workspace_id and c.id <> v_row.id
          and (c.in_reply_to = v_row.rfc_message_id or v_row.rfc_message_id = any (c.references_ids))
      );
    update public.workspace_email_messages m
    set reply_to_message_id = v_row.id
    where m.workspace_id = v_row.workspace_id and m.id <> v_row.id and m.reply_to_message_id is null
      and m.in_reply_to = v_row.rfc_message_id;
  end if;

  for v_attachment in select value from jsonb_array_elements(coalesce(p_attachments, '[]'::jsonb)) loop
    v_position := v_position + 1;
    if public.email_attachment_workspace_id(v_attachment->>'storage_path') is distinct from v_connection.workspace_id then
      raise exception 'Anhang: Speicherpfad ungueltig';
    end if;
    if split_part(split_part(v_attachment->>'storage_path', '/', 2), '.', 1) <> lower(v_attachment->>'sha256') then
      raise exception 'Anhang: Pruefwert passt nicht zum Pfad';
    end if;
    if public.email_attachment_mime_for_extension(split_part(split_part(v_attachment->>'storage_path', '/', 2), '.', 2)) is distinct from v_attachment->>'mime_type' then
      raise exception 'Anhang: Dateityp nicht erlaubt';
    end if;
    insert into public.workspace_email_message_attachments (
      message_id, workspace_id, position, filename, original_filename, mime_type, size_bytes, sha256, storage_path, storage_bucket
    ) values (
      v_row.id, v_connection.workspace_id, v_position,
      left(v_attachment->>'filename', 150), left(v_attachment->>'original_filename', 500), v_attachment->>'mime_type',
      (v_attachment->>'size_bytes')::bigint, lower(v_attachment->>'sha256'), v_attachment->>'storage_path', 'inbound-email-attachments'
    );
  end loop;

  insert into public.workspace_email_assignment_events (workspace_id, message_id, customer_id, vorgang_id, source)
  values (v_connection.workspace_id, v_row.id, v_row.customer_id, v_row.vorgang_id, coalesce(v_row.assignment_source, 'import'));

  delete from public.workspace_mailbox_import_failures where connection_id = v_connection.id and provider_message_id = v_provider_message_id;
  return jsonb_build_object('outcome', 'imported', 'message_id', v_row.id, 'assignment_status', v_row.assignment_status, 'thread_source', v_thread->>'source');
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Freie E-Mail / Antwort anlegen (07D + optional beantwortete Nachricht)
-- ---------------------------------------------------------------------------
-- Unverändert gegenüber 07D bis auf p_reply_to_message_id: gleicher Verlauf wie
-- das Original, In-Reply-To/References aus dem Original, Teil der Idempotenz.
-- Die alte Signatur (ohne Antwortbezug) wird ersetzt; Aufrufe ohne den neuen
-- Parameter funktionieren unverändert (Standardwert null).

drop function if exists public.create_workspace_email_message(uuid, text, text[], text[], text[], text, text, jsonb, text, text, text);

create or replace function public.create_workspace_email_message(
  p_workspace_id uuid,
  p_client_message_id text,
  p_to text[],
  p_cc text[],
  p_bcc text[],
  p_subject text,
  p_body_text text,
  p_attachments jsonb,
  p_provider text,
  p_customer_id text default null,
  p_vorgang_id text default null,
  p_reply_to_message_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_client_id text := nullif(btrim(coalesce(p_client_message_id, '')), '');
  v_to text[];
  v_cc text[];
  v_bcc text[];
  v_subject text := btrim(coalesce(p_subject, ''));
  v_body text := coalesce(p_body_text, '');
  v_provider text := nullif(btrim(coalesce(p_provider, '')), '');
  v_customer_id text := nullif(btrim(coalesce(p_customer_id, '')), '');
  v_vorgang_id text := nullif(btrim(coalesce(p_vorgang_id, '')), '');
  v_vorgang_customer_id text;
  v_company jsonb;
  v_sender_name text;
  v_reply_to text;
  v_existing public.workspace_email_messages;
  v_row public.workspace_email_messages;
  v_parent public.workspace_email_messages;
  v_attachment jsonb;
  v_count integer := 0;
  v_total bigint := 0;
  v_path text;
  v_sha text;
  v_ext text;
  v_mime text;
  v_filename text;
  v_size bigint;
  v_object_size text;
  v_shas text[] := '{}';
  v_existing_shas text[];
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
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Keine Schreibberechtigung';
  end if;
  if v_client_id is null or length(v_client_id) > 128 then
    raise exception 'client_message_id ungueltig';
  end if;

  -- 07F-01A: beantwortete Nachricht muss zu diesem Workspace gehören.
  if p_reply_to_message_id is not null then
    select * into v_parent from public.workspace_email_messages
    where id = p_reply_to_message_id and workspace_id = p_workspace_id;
    if v_parent.id is null then
      raise exception 'Beantwortete Nachricht nicht gefunden';
    end if;
  end if;

  -- Empfaenger: normalisiert, gueltig, ohne Dubletten ueber TO/CC/BCC hinweg.
  v_to := public.email_message_normalize_recipients(p_to, 'An');
  v_cc := public.email_message_normalize_recipients(p_cc, 'Cc');
  v_bcc := public.email_message_normalize_recipients(p_bcc, 'Bcc');
  v_cc := coalesce((select array_agg(x order by o) from unnest(v_cc) with ordinality as t(x, o) where not (x = any (v_to))), '{}');
  v_bcc := coalesce((select array_agg(x order by o) from unnest(v_bcc) with ordinality as t(x, o) where not (x = any (v_to)) and not (x = any (v_cc))), '{}');
  if cardinality(v_to) < 1 then
    raise exception 'An: mindestens ein Empfaenger erforderlich';
  end if;
  if cardinality(v_to) > 20 or cardinality(v_to) + cardinality(v_cc) + cardinality(v_bcc) > 30 then
    raise exception 'Zu viele Empfaenger';
  end if;

  if v_subject = '' or length(v_subject) > 255 then
    raise exception 'subject ungueltig';
  end if;
  if btrim(v_body) = '' or length(v_body) > 20000 then
    raise exception 'body_text ungueltig';
  end if;
  if v_provider is null or v_provider not in ('brevo', 'stub') then
    raise exception 'provider ungueltig';
  end if;

  -- Kontext: nur echte Kennungen dieses Workspaces; Kunde und Vorgang muessen zusammenpassen.
  if v_customer_id is not null and not exists (
    select 1 from public.workspace_customers c
    where c.workspace_id = p_workspace_id and c.customer_id = v_customer_id and not c.deleted
  ) then
    raise exception 'customer_id gehoert nicht zum Workspace';
  end if;
  if v_vorgang_id is not null then
    select nullif(btrim(coalesce(v.payload->>'customerId', '')), '') into v_vorgang_customer_id
    from public.workspace_vorgaenge v
    where v.workspace_id = p_workspace_id and v.vorgang_id = v_vorgang_id and not v.deleted;
    if not found then
      raise exception 'vorgang_id gehoert nicht zum Workspace';
    end if;
    if v_vorgang_customer_id is not null then
      if v_customer_id is not null and v_customer_id <> v_vorgang_customer_id then
        raise exception 'Kunde passt nicht zum Vorgang';
      end if;
      if v_customer_id is null and exists (
        select 1 from public.workspace_customers c
        where c.workspace_id = p_workspace_id and c.customer_id = v_vorgang_customer_id and not c.deleted
      ) then
        -- Der Vorgang bestimmt den Kunden.
        v_customer_id := v_vorgang_customer_id;
      end if;
    end if;
  end if;

  -- Anhaenge: Metadaten pruefen und Existenz/Groesse im privaten Bucket bestaetigen.
  if p_attachments is not null and jsonb_typeof(p_attachments) <> 'array' then
    raise exception 'attachments ungueltig';
  end if;
  for v_attachment in select value from jsonb_array_elements(coalesce(p_attachments, '[]'::jsonb)) loop
    v_count := v_count + 1;
    if v_count > 10 then
      raise exception 'Zu viele Anhaenge';
    end if;
    v_path := btrim(coalesce(v_attachment->>'storage_path', ''));
    v_sha := lower(btrim(coalesce(v_attachment->>'sha256', '')));
    v_filename := btrim(coalesce(v_attachment->>'filename', ''));
    v_mime := btrim(coalesce(v_attachment->>'mime_type', ''));
    begin
      v_size := (v_attachment->>'size_bytes')::bigint;
    exception when others then
      raise exception 'Anhang: Groesse ungueltig';
    end;
    if public.email_attachment_workspace_id(v_path) is distinct from p_workspace_id then
      raise exception 'Anhang: Speicherpfad ungueltig';
    end if;
    if v_sha !~ '^[0-9a-f]{64}$' or split_part(split_part(v_path, '/', 2), '.', 1) <> v_sha then
      raise exception 'Anhang: Pruefwert passt nicht zum Pfad';
    end if;
    v_ext := split_part(split_part(v_path, '/', 2), '.', 2);
    if public.email_attachment_mime_for_extension(v_ext) is distinct from v_mime then
      raise exception 'Anhang: Dateityp nicht erlaubt';
    end if;
    if v_filename = '' or length(v_filename) > 150 or v_filename ~ '[/\\:*?"<>|[:cntrl:]]' or left(v_filename, 1) = '.'
       or lower(v_filename) !~ ('\.' || v_ext || '$') then
      raise exception 'Anhang: Dateiname ungueltig';
    end if;
    if v_size is null or v_size <= 0 or v_size > 4194304 then
      raise exception 'Anhang: Datei zu gross';
    end if;
    v_total := v_total + v_size;
    if v_total > 10485760 then
      raise exception 'Anhaenge zusammen zu gross';
    end if;
    select o.metadata->>'size' into v_object_size
    from storage.objects o
    where o.bucket_id = 'email-attachments' and o.name = v_path;
    if not found then
      raise exception 'Anhang nicht gefunden';
    end if;
    if v_object_size is not null and v_object_size::bigint <> v_size then
      raise exception 'Anhang: Groesse passt nicht';
    end if;
    v_shas := array_append(v_shas, v_sha);
  end loop;

  -- Idempotenz: dieselbe Absicht -> dieselbe Nachricht; abweichende Absicht -> Konflikt.
  select * into v_existing
  from public.workspace_email_messages
  where workspace_id = p_workspace_id and client_message_id = v_client_id
  for update;
  if v_existing.id is not null then
    select coalesce(array_agg(a.sha256 order by a.position), '{}') into v_existing_shas
    from public.workspace_email_message_attachments a where a.message_id = v_existing.id;
    if v_existing.retry_of_message_id is not null
       or v_existing.to_recipients <> v_to
       or v_existing.cc_recipients <> v_cc
       or v_existing.bcc_recipients <> v_bcc
       or v_existing.subject <> v_subject
       or v_existing.body_text <> v_body
       or v_existing_shas <> v_shas
       or v_existing.customer_id is distinct from v_customer_id
       or v_existing.vorgang_id is distinct from v_vorgang_id
       or v_existing.reply_to_message_id is distinct from p_reply_to_message_id then
      raise exception 'Idempotenzkonflikt: client_message_id mit abweichendem Inhalt';
    end if;
    return jsonb_build_object('outcome', 'replayed', 'message', public.email_message_to_jsonb(v_existing));
  end if;

  -- Absender-Snapshot aus den Kommunikations-Einstellungen bzw. dem Firmenprofil.
  select payload into v_company from public.workspace_company_profiles where workspace_id = p_workspace_id;
  v_sender_name := nullif(btrim(coalesce(v_company->>'senderDisplayName', '')), '');
  if v_sender_name is null then
    v_sender_name := nullif(btrim(concat_ws(' ', nullif(btrim(coalesce(v_company->>'companyName', '')), ''), nullif(btrim(coalesce(v_company->>'legalForm', '')), ''))), '');
  end if;
  v_reply_to := lower(nullif(btrim(coalesce(v_company->>'replyToEmail', '')), ''));
  if v_reply_to is not null and (length(v_reply_to) > 254 or v_reply_to !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$') then
    raise exception 'Absender: Antwortadresse ungueltig';
  end if;
  if v_reply_to is null then
    v_reply_to := lower(nullif(btrim(coalesce(v_company->>'email', '')), ''));
  end if;
  if v_sender_name is null or v_reply_to is null or v_reply_to !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then
    raise exception 'Absenderdaten unvollstaendig';
  end if;

  perform public.email_message_assert_rate_limit(p_workspace_id, v_user_id, cardinality(v_to) + cardinality(v_cc) + cardinality(v_bcc));

  insert into public.workspace_email_messages (
    workspace_id, client_message_id, customer_id, vorgang_id,
    to_recipients, cc_recipients, bcc_recipients, subject, body_text,
    sender_name, reply_to_email, provider, status, requested_by,
    thread_id, reply_to_message_id, in_reply_to, references_ids
  ) values (
    p_workspace_id, v_client_id, v_customer_id, v_vorgang_id,
    v_to, v_cc, v_bcc, v_subject, v_body,
    left(v_sender_name, 120), v_reply_to, v_provider, 'queued', v_user_id,
    coalesce(v_parent.thread_id, gen_random_uuid()),
    v_parent.id,
    v_parent.rfc_message_id,
    case when v_parent.id is null then '{}'::text[]
         else public.email_normalize_message_id_list(v_parent.references_ids || coalesce(v_parent.rfc_message_id, ''), 30) end
  )
  returning * into v_row;

  v_count := 0;
  for v_attachment in select value from jsonb_array_elements(coalesce(p_attachments, '[]'::jsonb)) loop
    v_count := v_count + 1;
    insert into public.workspace_email_message_attachments (
      message_id, workspace_id, position, filename, mime_type, size_bytes, sha256, storage_path
    ) values (
      v_row.id, p_workspace_id, v_count,
      btrim(v_attachment->>'filename'), btrim(v_attachment->>'mime_type'),
      (v_attachment->>'size_bytes')::bigint, lower(btrim(v_attachment->>'sha256')), btrim(v_attachment->>'storage_path')
    );
  end loop;

  return jsonb_build_object('outcome', 'created', 'message', public.email_message_to_jsonb(v_row));
end;
$$;

revoke all on function public.create_workspace_email_message(uuid, text, text[], text[], text[], text, text, jsonb, text, text, text, uuid) from public, anon;
grant execute on function public.create_workspace_email_message(uuid, text, text[], text[], text[], text, text, jsonb, text, text, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Neuversuch (07D): bleibt im Verlauf des Originals
-- ---------------------------------------------------------------------------
-- Unverändert gegenüber 07D bis auf die Übernahme von Verlauf und Antwortbezug.

create or replace function public.retry_workspace_email_message(
  p_workspace_id uuid,
  p_client_message_id text,
  p_retry_of_message_id uuid,
  p_confirm_uncertain_retry boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_client_id text := nullif(btrim(coalesce(p_client_message_id, '')), '');
  v_existing public.workspace_email_messages;
  v_previous public.workspace_email_messages;
  v_row public.workspace_email_messages;
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
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Keine Schreibberechtigung';
  end if;
  if v_client_id is null or length(v_client_id) > 128 then
    raise exception 'client_message_id ungueltig';
  end if;
  if p_retry_of_message_id is null then
    raise exception 'retry_of_message_id fehlt';
  end if;

  select * into v_existing
  from public.workspace_email_messages
  where workspace_id = p_workspace_id and client_message_id = v_client_id;
  if v_existing.id is not null then
    if v_existing.retry_of_message_id is distinct from p_retry_of_message_id then
      raise exception 'Idempotenzkonflikt: client_message_id mit abweichendem Inhalt';
    end if;
    return jsonb_build_object('outcome', 'replayed', 'message', public.email_message_to_jsonb(v_existing));
  end if;

  -- Sperre auf dem Vorgaenger: zwei Tabs koennen nicht gleichzeitig je einen Neuversuch anlegen.
  select * into v_previous
  from public.workspace_email_messages
  where id = p_retry_of_message_id and workspace_id = p_workspace_id
  for update;
  if v_previous.id is null then
    raise exception 'retry_of_message_id nicht gefunden';
  end if;
  if v_previous.status = 'unknown' then
    if not coalesce(p_confirm_uncertain_retry, false) then
      raise exception 'Erneuter Versand nicht moeglich: Versandstatus unklar';
    end if;
  elsif v_previous.status <> 'failed' then
    raise exception 'Erneuter Versand nur nach Fehlschlag';
  end if;
  if exists (select 1 from public.workspace_email_messages c where c.retry_of_message_id = v_previous.id) then
    raise exception 'Neuversuch zu diesem Versuch wurde bereits angelegt';
  end if;

  perform public.email_message_assert_rate_limit(
    p_workspace_id, v_user_id,
    cardinality(v_previous.to_recipients) + cardinality(v_previous.cc_recipients) + cardinality(v_previous.bcc_recipients)
  );

  insert into public.workspace_email_messages (
    workspace_id, client_message_id, customer_id, vorgang_id,
    to_recipients, cc_recipients, bcc_recipients, subject, body_text,
    sender_name, reply_to_email, provider, status, requested_by,
    retry_of_message_id, attempt_number,
    thread_id, reply_to_message_id, in_reply_to, references_ids
  ) values (
    p_workspace_id, v_client_id, v_previous.customer_id, v_previous.vorgang_id,
    v_previous.to_recipients, v_previous.cc_recipients, v_previous.bcc_recipients, v_previous.subject, v_previous.body_text,
    v_previous.sender_name, v_previous.reply_to_email, v_previous.provider, 'queued', v_user_id,
    v_previous.id, v_previous.attempt_number + 1,
    v_previous.thread_id, v_previous.reply_to_message_id, v_previous.in_reply_to, v_previous.references_ids
  )
  returning * into v_row;

  insert into public.workspace_email_message_attachments (
    message_id, workspace_id, position, filename, mime_type, size_bytes, sha256, storage_path
  )
  select v_row.id, a.workspace_id, a.position, a.filename, a.mime_type, a.size_bytes, a.sha256, a.storage_path
  from public.workspace_email_message_attachments a
  where a.message_id = v_previous.id
  order by a.position;

  return jsonb_build_object('outcome', 'created', 'message', public.email_message_to_jsonb(v_row));
end;
$$;

revoke all on function public.retry_workspace_email_message(uuid, text, uuid, boolean) from public;
grant execute on function public.retry_workspace_email_message(uuid, text, uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Verlauf lesen (eingehend + ausgehend, älteste zuerst)
-- ---------------------------------------------------------------------------

create or replace function public.get_workspace_email_thread(p_workspace_id uuid, p_message_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_thread uuid;
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet';
  end if;
  if p_workspace_id is null or p_message_id is null then
    raise exception 'workspace_id/message_id fehlt';
  end if;
  if not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;
  select thread_id into v_thread from public.workspace_email_messages where id = p_message_id and workspace_id = p_workspace_id;
  if v_thread is null then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(public.email_message_to_jsonb(m) order by coalesce(m.received_at, m.provider_accepted_at, m.sending_started_at, m.created_at), m.created_at, m.id)
    from public.workspace_email_messages m
    where m.id in (
      select x.id
      from public.workspace_email_messages x
      where x.workspace_id = p_workspace_id and x.thread_id = v_thread
      order by coalesce(x.received_at, x.provider_accepted_at, x.sending_started_at, x.created_at) desc, x.created_at desc, x.id
      limit 200
    )
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.get_workspace_email_thread(uuid, uuid) from public, anon;
grant execute on function public.get_workspace_email_thread(uuid, uuid) to authenticated;

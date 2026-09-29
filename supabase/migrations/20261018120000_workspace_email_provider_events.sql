-- E-MAIL 07F-01B — Provider-Zustellstatus (Zustellung, Verzögerung, Bounces,
-- Abweisung, Spam-Beschwerde) für freie E-Mail (07D/07F) UND Dokumentversand
-- (07B) — EINE gemeinsame Event-Infrastruktur.
--
-- Versandstatus und Zustellstatus sind getrennt:
--   * `status` bleibt die Wahrheit des eigenen Versandwegs (queued → sending →
--     provider_accepted | failed | unknown) inkl. Claim, Neuversuch und
--     row_version — unverändert.
--   * `delivery_state` ist die normalisierte Rückmeldung des E-Mail-Dienstes
--     NACH der Übergabe:
--       accepted   Dienst hat die Nachricht angenommen („request")
--       deferred   Zustellung verzögert (deferred, soft_bounce) — der Dienst
--                  versucht es selbst weiter; OfficeTakt sendet nie zusätzlich
--       delivered  vom Empfängerserver angenommen — NICHT gelesen/geöffnet
--       bounced    dauerhaft nicht zugestellt (hard_bounce)
--       rejected   vom Dienst abgewiesen (blocked, invalid_email, error)
--       complained Spam-Beschwerde des Empfängers
--     Öffnen/Klicken (Tracking) ist KEIN Zustellstatus: wird nie gespeichert
--     und nie angezeigt.
--
-- Reihenfolge-unabhängig (out-of-order): ein Ereignis wirkt nur, wenn sein Rang
-- höher ist als der aktuelle (accepted 1 < deferred 2 < delivered 3 <
-- bounced/rejected 4 < complained 5). So stuft ein spätes „request" ein
-- „delivered" nie zurück; ein späterer Bounce/eine Beschwerde gilt dagegen.
--
-- Zuordnung ausschließlich über die Message-ID des Dienstes (normalisiert,
-- identisch zu 07F-01A), nie über Betreff, Empfänger, Zeitfenster oder Namen.
-- Kein Treffer → nur protokolliert (ohne Workspace, für niemanden lesbar);
-- mehrere Treffer → nicht angewendet. Kommt ein Ereignis vor dem Speichern der
-- Message-ID an, wird es beim Speichern nachträglich zugeordnet.
--
-- Deduplizierung: (provider, dedupe_key) eindeutig — derselbe Webhook wirkt
-- genau einmal. Gespeichert werden nur Ereignistyp, normalisierter Zustand,
-- Zeitpunkt und ein kurzer, bereinigter Grund — keine Empfängeradresse, kein
-- Betreff, kein Roh-Payload.
--
-- Status-Updates legen keine Nachricht an und ändern weder thread_id,
-- Antwortbezug, Message-ID noch row_version (Versand-Claim bleibt unberührt).
--
-- Setzt 20261017120000 (07F-01A) voraus. Bestehende Migrationen bleiben unverändert.

-- ---------------------------------------------------------------------------
-- 1. Zustellstatus an beiden Versandtabellen
-- ---------------------------------------------------------------------------

alter table public.workspace_email_messages
  add column if not exists delivery_state text null,
  add column if not exists delivery_state_at timestamptz null,
  add column if not exists delivery_reason text null;

alter table public.workspace_email_messages drop constraint if exists workspace_email_messages_delivery_state_check;
alter table public.workspace_email_messages add constraint workspace_email_messages_delivery_state_check check (
  (delivery_state is null or (direction = 'outbound' and delivery_state in ('accepted', 'deferred', 'delivered', 'bounced', 'rejected', 'complained')))
  and (delivery_reason is null or length(delivery_reason) <= 32)
);

alter table public.workspace_document_deliveries
  add column if not exists delivery_state text null,
  add column if not exists delivery_state_at timestamptz null,
  add column if not exists delivery_reason text null;

alter table public.workspace_document_deliveries drop constraint if exists workspace_document_deliveries_delivery_state_check;
alter table public.workspace_document_deliveries add constraint workspace_document_deliveries_delivery_state_check check (
  (delivery_state is null or delivery_state in ('accepted', 'deferred', 'delivered', 'bounced', 'rejected', 'complained'))
  and (delivery_reason is null or length(delivery_reason) <= 32)
);

-- Zuordnung über die normalisierte Message-ID des Dienstes (ohne Workspace-Bezug im Webhook).
create index if not exists workspace_email_messages_outbound_rfc_idx
  on public.workspace_email_messages (rfc_message_id)
  where direction = 'outbound' and rfc_message_id is not null;
create index if not exists workspace_document_deliveries_rfc_idx
  on public.workspace_document_deliveries (public.email_normalize_message_id(provider_message_id))
  where provider_message_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Ereignis-Protokoll (dedupliziert, ohne Inhalte)
-- ---------------------------------------------------------------------------

create table if not exists public.workspace_email_provider_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  dedupe_key text not null,
  provider_message_id text not null,
  event_type text not null,
  normalized_state text not null,
  reason text null,
  event_at timestamptz not null,
  received_at timestamptz not null default now(),
  workspace_id uuid null references public.workspaces (id) on delete cascade,
  email_message_id uuid null references public.workspace_email_messages (id) on delete cascade,
  document_delivery_id uuid null references public.workspace_document_deliveries (id) on delete cascade,
  outcome text not null,
  constraint workspace_email_provider_events_dedupe_unique unique (provider, dedupe_key),
  constraint workspace_email_provider_events_provider_check check (provider in ('brevo')),
  constraint workspace_email_provider_events_dedupe_check check (dedupe_key ~ '^[0-9a-f]{64}$'),
  constraint workspace_email_provider_events_message_check check (length(provider_message_id) between 3 and 900),
  constraint workspace_email_provider_events_type_check check (event_type ~ '^[a-z_]{2,32}$'),
  constraint workspace_email_provider_events_state_check check (normalized_state in ('accepted', 'deferred', 'delivered', 'bounced', 'rejected', 'complained')),
  constraint workspace_email_provider_events_reason_check check (reason is null or length(reason) <= 200),
  constraint workspace_email_provider_events_outcome_check check (outcome in ('applied', 'ignored_older', 'unmatched', 'ambiguous')),
  constraint workspace_email_provider_events_target_check check (
    (outcome in ('unmatched', 'ambiguous') and workspace_id is null and email_message_id is null and document_delivery_id is null)
    or (outcome in ('applied', 'ignored_older') and workspace_id is not null
        and ((email_message_id is not null)::int + (document_delivery_id is not null)::int) = 1)
  )
);

create index if not exists workspace_email_provider_events_message_idx on public.workspace_email_provider_events (email_message_id, event_at) where email_message_id is not null;
create index if not exists workspace_email_provider_events_delivery_idx on public.workspace_email_provider_events (document_delivery_id, event_at) where document_delivery_id is not null;
create index if not exists workspace_email_provider_events_unmatched_idx on public.workspace_email_provider_events (provider, provider_message_id) where outcome = 'unmatched';

alter table public.workspace_email_provider_events enable row level security;
revoke all on table public.workspace_email_provider_events from public, anon, authenticated;
drop policy if exists workspace_email_provider_events_select_member on public.workspace_email_provider_events;
create policy workspace_email_provider_events_select_member
on public.workspace_email_provider_events for select to authenticated
using (workspace_id is not null and public.is_active_workspace_member(workspace_id));
grant select on table public.workspace_email_provider_events to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Rang, Zuordnung, Anwendung
-- ---------------------------------------------------------------------------

create or replace function public.email_delivery_state_rank(p_state text)
returns integer
language sql
immutable
set search_path = public
as $$
  select case p_state
    when 'accepted' then 1
    when 'deferred' then 2
    when 'delivered' then 3
    when 'bounced' then 4
    when 'rejected' then 4
    when 'complained' then 5
    else 0
  end;
$$;

-- Ein protokolliertes Ereignis zuordnen und (nur bei höherem Rang) anwenden.
-- Zugeordnet wird ausschließlich über die normalisierte Message-ID und nur an
-- tatsächlich übergebene Nachrichten desselben Dienstes.
create or replace function public.email_provider_apply_event(p_event_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event public.workspace_email_provider_events;
  v_email_ids uuid[];
  v_delivery_ids uuid[];
  v_target_ws uuid;
  v_current text;
  v_outcome text;
begin
  select * into v_event from public.workspace_email_provider_events where id = p_event_id for update;
  if v_event.id is null then
    return 'missing';
  end if;

  select coalesce(array_agg(m.id), '{}') into v_email_ids
  from public.workspace_email_messages m
  where m.direction = 'outbound' and m.provider = v_event.provider
    and m.rfc_message_id = v_event.provider_message_id and m.status = 'provider_accepted';
  select coalesce(array_agg(d.id), '{}') into v_delivery_ids
  from public.workspace_document_deliveries d
  where d.provider = v_event.provider and d.provider_message_id is not null
    and public.email_normalize_message_id(d.provider_message_id) = v_event.provider_message_id
    and d.status in ('provider_accepted', 'delivered', 'bounced', 'complained');

  if cardinality(v_email_ids) + cardinality(v_delivery_ids) = 0 then
    update public.workspace_email_provider_events set outcome = 'unmatched', workspace_id = null, email_message_id = null, document_delivery_id = null where id = v_event.id;
    return 'unmatched';
  end if;
  if cardinality(v_email_ids) + cardinality(v_delivery_ids) > 1 then
    update public.workspace_email_provider_events set outcome = 'ambiguous', workspace_id = null, email_message_id = null, document_delivery_id = null where id = v_event.id;
    return 'ambiguous';
  end if;

  if cardinality(v_email_ids) = 1 then
    select workspace_id, delivery_state into v_target_ws, v_current from public.workspace_email_messages where id = v_email_ids[1] for update;
    if public.email_delivery_state_rank(v_event.normalized_state) > public.email_delivery_state_rank(v_current) then
      -- Nur Zustellfelder: kein row_version, kein Thread, kein Antwortbezug, keine Message-ID.
      update public.workspace_email_messages
      set delivery_state = v_event.normalized_state, delivery_state_at = v_event.event_at, delivery_reason = left(v_event.event_type, 32)
      where id = v_email_ids[1];
      v_outcome := 'applied';
    else
      v_outcome := 'ignored_older';
    end if;
    update public.workspace_email_provider_events set outcome = v_outcome, workspace_id = v_target_ws, email_message_id = v_email_ids[1], document_delivery_id = null where id = v_event.id;
    return v_outcome;
  end if;

  select workspace_id, delivery_state into v_target_ws, v_current from public.workspace_document_deliveries where id = v_delivery_ids[1] for update;
  if public.email_delivery_state_rank(v_event.normalized_state) > public.email_delivery_state_rank(v_current) then
    update public.workspace_document_deliveries
    set delivery_state = v_event.normalized_state, delivery_state_at = v_event.event_at, delivery_reason = left(v_event.event_type, 32)
    where id = v_delivery_ids[1];
    v_outcome := 'applied';
  else
    v_outcome := 'ignored_older';
  end if;
  update public.workspace_email_provider_events set outcome = v_outcome, workspace_id = v_target_ws, email_message_id = null, document_delivery_id = v_delivery_ids[1] where id = v_event.id;
  return v_outcome;
end;
$$;

-- Webhook-Einstieg (nur service_role / Edge Function email-provider-webhook).
create or replace function public.record_email_provider_event(
  p_provider text,
  p_dedupe_key text,
  p_provider_message_id text,
  p_event_type text,
  p_normalized_state text,
  p_reason text,
  p_event_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_message_id text := public.email_normalize_message_id(p_provider_message_id);
  v_id uuid;
  v_outcome text;
begin
  if p_provider is distinct from 'brevo' then
    raise exception 'provider ungueltig';
  end if;
  if v_message_id is null then
    raise exception 'message_id ungueltig';
  end if;
  if p_event_at is null or p_event_at > now() + interval '1 day' or p_event_at < now() - interval '400 days' then
    raise exception 'event_at ungueltig';
  end if;

  insert into public.workspace_email_provider_events (provider, dedupe_key, provider_message_id, event_type, normalized_state, reason, event_at, outcome)
  -- Grund: E-Mail-Adressen maskiert, Steuerzeichen entfernt, gekürzt (zusätzlich zur Bereinigung in der Function).
  values (p_provider, lower(p_dedupe_key), v_message_id, p_event_type, p_normalized_state,
    left(nullif(btrim(regexp_replace(regexp_replace(coalesce(p_reason, ''), '[^[:space:]<>"''(),;:]+@[^[:space:]<>"''(),;:]+', '<adresse>', 'g'), '[[:cntrl:]]+', ' ', 'g')), ''), 200),
    p_event_at, 'unmatched')
  on conflict (provider, dedupe_key) do nothing
  returning id into v_id;
  if v_id is null then
    return jsonb_build_object('outcome', 'duplicate');
  end if;

  v_outcome := public.email_provider_apply_event(v_id);

  -- Nie zugeordnete Ereignisse nicht unbegrenzt aufbewahren.
  delete from public.workspace_email_provider_events
  where outcome in ('unmatched', 'ambiguous') and received_at < now() - interval '30 days';

  return jsonb_build_object('outcome', v_outcome);
end;
$$;

-- Ereignis vor der gespeicherten Message-ID (Webhook schneller als der Versandabschluss):
-- beim Speichern der ID werden offene Ereignisse dieser ID nachträglich zugeordnet.
create or replace function public.email_provider_rematch_after_accept()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id text;
  v_event uuid;
begin
  if tg_table_name = 'workspace_email_messages' then
    if new.direction <> 'outbound' or new.status <> 'provider_accepted' then
      return null;
    end if;
    v_id := new.rfc_message_id;
  else
    v_id := public.email_normalize_message_id(new.provider_message_id);
  end if;
  if v_id is null then
    return null;
  end if;
  for v_event in
    select e.id from public.workspace_email_provider_events e
    where e.provider = new.provider and e.provider_message_id = v_id and e.outcome = 'unmatched'
    order by e.event_at, e.received_at
  loop
    perform public.email_provider_apply_event(v_event);
  end loop;
  return null;
end;
$$;

drop trigger if exists workspace_email_messages_provider_rematch on public.workspace_email_messages;
create trigger workspace_email_messages_provider_rematch
after update of provider_message_id, status on public.workspace_email_messages
for each row execute function public.email_provider_rematch_after_accept();

drop trigger if exists workspace_document_deliveries_provider_rematch on public.workspace_document_deliveries;
create trigger workspace_document_deliveries_provider_rematch
after update of provider_message_id, status on public.workspace_document_deliveries
for each row execute function public.email_provider_rematch_after_accept();

-- ---------------------------------------------------------------------------
-- 4. Zustellverlauf lesen (Mitglieder; nur zugeordnete Ereignisse)
-- ---------------------------------------------------------------------------

create or replace function public.list_workspace_email_delivery_events(
  p_workspace_id uuid,
  p_email_message_id uuid default null,
  p_document_delivery_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet';
  end if;
  if p_workspace_id is null or not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;
  if (p_email_message_id is null) = (p_document_delivery_id is null) then
    raise exception 'genau eine Nachricht angeben';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('state', e.normalized_state, 'event_at', e.event_at, 'applied', e.outcome = 'applied') order by e.event_at, e.received_at)
    from public.workspace_email_provider_events e
    where e.workspace_id = p_workspace_id
      and e.outcome in ('applied', 'ignored_older')
      and ((p_email_message_id is not null and e.email_message_id = p_email_message_id)
        or (p_document_delivery_id is not null and e.document_delivery_id = p_document_delivery_id))
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Rechte
-- ---------------------------------------------------------------------------

revoke all on function public.email_provider_apply_event(uuid) from public, anon, authenticated, service_role;
revoke all on function public.email_provider_rematch_after_accept() from public, anon, authenticated;
revoke all on function public.record_email_provider_event(text, text, text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.record_email_provider_event(text, text, text, text, text, text, timestamptz) to service_role;
revoke all on function public.list_workspace_email_delivery_events(uuid, uuid, uuid) from public, anon;
grant execute on function public.list_workspace_email_delivery_events(uuid, uuid, uuid) to authenticated;
grant execute on function public.email_delivery_state_rank(text) to authenticated, service_role;

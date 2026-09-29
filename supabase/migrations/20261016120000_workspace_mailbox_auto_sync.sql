-- E-MAIL 07E-AUTO-SYNC 01A — serverseitiger automatischer Postfachabruf.
--
-- Architektur (keine neue Sync-Logik — der bestehende Abruf wird wiederverwendet):
--   pg_cron (alle 10 Minuten) → `mailbox_auto_sync_dispatch()` → pg_net POST an
--   die Edge Function `mailbox-auto-sync` → je fälligem Postfach derselbe
--   `runInboundSync` wie „Jetzt abrufen" (Lease, Cursor, Token-Refresh,
--   Ordner-Schutz, idempotenter Import).
--
--   * Aufruf-Absicherung: zufälliges Scheduler-Geheimnis, erzeugt in dieser
--     Migration und nur im Supabase Vault gespeichert. Die Function prüft es
--     per `mailbox_auto_sync_secret_valid` (nur service_role). Es verlässt die
--     Datenbank nur im Header des pg_net-Aufrufs.
--   * Parallelität: unverändert der Lease aus `claim_workspace_mailbox_sync`;
--     automatischer und manueller Abruf können nie gleichzeitig laufen.
--   * Backoff: `consecutive_failures` zählt Fehlversuche in Folge (auch
--     manuelle); der Scheduler wartet danach exponentiell länger (bis 6 h).
--     Retry-After des Anbieters wirkt wie bisher über `next_attempt_at`.
--     „Neu verbinden" (error_category reauthorize) wird automatisch nie
--     erneut versucht — kein Disconnect.
--   * OAuth-State-Bereinigung: stündlich die vorhandene
--     `purge_expired_workspace_mailbox_oauth_states()` (nur abgelaufene States).

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- ---------------------------------------------------------------------------
-- 1. Fehlversuche in Folge (Grundlage für den Scheduler-Backoff)
-- ---------------------------------------------------------------------------

alter table public.workspace_mailbox_connections
  add column if not exists consecutive_failures integer not null default 0;

alter table public.workspace_mailbox_connections drop constraint if exists workspace_mailbox_connections_failures_check;
alter table public.workspace_mailbox_connections add constraint workspace_mailbox_connections_failures_check
  check (consecutive_failures >= 0);

-- Unverändert gegenüber 07E bis auf `consecutive_failures` (Erfolg/Trennen → 0, Fehler → +1).
create or replace function public.finish_workspace_mailbox_sync(
  p_connection_id uuid,
  p_lease_token uuid,
  p_status text,
  p_error_category text default null,
  p_error_code text default null,
  p_safe_message text default null,
  p_retry_after_seconds integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.workspace_mailbox_connections;
begin
  if p_status not in ('connected', 'error', 'disconnected') then
    raise exception 'status ungueltig';
  end if;
  update public.workspace_mailbox_connections
  set status = p_status,
      last_successful_sync_at = case when p_status = 'connected' then now() else last_successful_sync_at end,
      error_category = case when p_status = 'connected' then null else p_error_category end,
      error_code = case when p_status = 'connected' then null else left(p_error_code, 64) end,
      safe_error_message = case when p_status = 'connected' then null else left(p_safe_message, 300) end,
      next_attempt_at = case when p_retry_after_seconds is not null and p_retry_after_seconds > 0 then now() + make_interval(secs => least(p_retry_after_seconds, 86400)) else null end,
      consecutive_failures = case when p_status = 'error' then least(consecutive_failures + 1, 1000) else 0 end,
      sync_lease_token = null, sync_lease_until = null,
      updated_at = now(), row_version = row_version + 1
  where id = p_connection_id and sync_lease_token = p_lease_token
  returning * into v_row;
  if v_row.id is null then
    raise exception 'Sync-Lease ungueltig';
  end if;
  return to_jsonb(v_row) - 'sync_lease_token';
end;
$$;

-- Neu verbinden (OAuth bestätigt das Konto erneut) beginnt ohne alte Fehlerserie.
create or replace function public.mailbox_connection_reset_failures()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.account_verified_at is distinct from old.account_verified_at then
    new.consecutive_failures := 0;
  end if;
  return new;
end;
$$;

drop trigger if exists workspace_mailbox_connections_reset_failures on public.workspace_mailbox_connections;
create trigger workspace_mailbox_connections_reset_failures
before update on public.workspace_mailbox_connections
for each row execute function public.mailbox_connection_reset_failures();

-- ---------------------------------------------------------------------------
-- 2. Kandidaten für den Scheduler (nur service_role, keine Inhalte)
-- ---------------------------------------------------------------------------
-- Liefert nur Steuerdaten: keine Adresse, kein Ordner, kein Cursor, kein Token.
-- Die Auswahl (fällig/übersprungen) trifft `classifyAutoSyncCandidate` in der
-- Edge Function; getrennte Postfächer werden hier bereits ausgeschlossen.
create or replace function public.list_workspace_mailbox_auto_sync_candidates(p_limit integer default 200)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x.sort_key), '[]'::jsonb)
  from (
    select
      c.id,
      c.provider_type,
      c.auth_mode,
      c.status,
      c.error_category,
      (cr.connection_id is not null) as has_credential,
      (c.sync_lease_until is not null and c.sync_lease_until > now()) as lease_active,
      c.next_attempt_at,
      c.last_attempt_at,
      c.consecutive_failures,
      coalesce(c.last_attempt_at, 'epoch'::timestamptz) as sort_key
    from public.workspace_mailbox_connections c
    left join public.workspace_mailbox_credentials cr on cr.connection_id = c.id
    where c.status <> 'disconnected'
    order by coalesce(c.last_attempt_at, 'epoch'::timestamptz), c.id
    limit least(greatest(coalesce(p_limit, 200), 1), 1000)
  ) x;
$$;

-- ---------------------------------------------------------------------------
-- 3. Scheduler-Geheimnis (nur Vault) und Prüfung
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'officetakt_mailbox_auto_sync_secret') then
    perform vault.create_secret(
      replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
      'officetakt_mailbox_auto_sync_secret',
      'E-MAIL 07E-AUTO-SYNC: Aufruf-Geheimnis pg_cron → Edge Function mailbox-auto-sync'
    );
  end if;
  -- Ziel-URL der Function je Umgebung; lokal/andere Projekte per vault.update_secret überschreiben.
  if not exists (select 1 from vault.secrets where name = 'officetakt_mailbox_auto_sync_url') then
    perform vault.create_secret(
      'https://ngsbqldjwugapfijpvqu.supabase.co/functions/v1/mailbox-auto-sync',
      'officetakt_mailbox_auto_sync_url',
      'E-MAIL 07E-AUTO-SYNC: Ziel-URL der Edge Function mailbox-auto-sync'
    );
  end if;
end;
$$;

create or replace function public.mailbox_auto_sync_secret_valid(p_secret text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, vault
as $$
declare
  v_secret text;
begin
  if p_secret is null or length(p_secret) < 32 or length(p_secret) > 256 then
    return false;
  end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'officetakt_mailbox_auto_sync_secret';
  return v_secret is not null and length(v_secret) >= 32 and v_secret = p_secret;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Auslöser für pg_cron
-- ---------------------------------------------------------------------------
-- Ruft die Function nur auf, wenn überhaupt ein nicht getrenntes Postfach mit
-- Zugangsdaten existiert (sonst kein Function-Aufruf). Antwort landet in
-- net._http_response (nur Zähler, keine Inhalte).
create or replace function public.mailbox_auto_sync_dispatch()
returns bigint
language plpgsql
security definer
set search_path = public, vault, extensions
as $$
declare
  v_url text;
  v_secret text;
begin
  if not exists (
    select 1 from public.workspace_mailbox_connections c
    join public.workspace_mailbox_credentials cr on cr.connection_id = c.id
    where c.status <> 'disconnected'
  ) then
    return null;
  end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'officetakt_mailbox_auto_sync_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'officetakt_mailbox_auto_sync_secret';
  if v_url is null or v_secret is null or v_url !~ '^https?://' then
    return null;
  end if;
  return net.http_post(
    url := v_url,
    body := jsonb_build_object('trigger', 'cron'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-officetakt-scheduler', v_secret),
    timeout_milliseconds := 150000
  );
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'list_workspace_mailbox_auto_sync_candidates(integer)',
    'mailbox_auto_sync_secret_valid(text)'
  ] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('revoke all on function public.%s from anon', f);
    execute format('revoke all on function public.%s from authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;

-- Nur der Datenbank-Eigentümer (pg_cron) löst aus — kein Client, keine Function.
revoke all on function public.mailbox_auto_sync_dispatch() from public, anon, authenticated, service_role;
revoke all on function public.mailbox_connection_reset_failures() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Zeitpläne (pg_cron; gleicher Name = Aktualisierung statt Duplikat)
-- ---------------------------------------------------------------------------

select cron.schedule('officetakt-mailbox-auto-sync', '*/10 * * * *', 'select public.mailbox_auto_sync_dispatch()');
select cron.schedule('officetakt-mailbox-oauth-state-purge', '17 * * * *', 'select public.purge_expired_workspace_mailbox_oauth_states()');

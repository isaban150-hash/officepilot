-- E-MAIL-07E-MSA / 07E-PF — providerneutrale Postfach-Grundlage + delegiertes
-- OAuth (umgesetzt: Microsoft, auch persönliche Konten wie @hotmail.de /
-- @outlook.com; vorbereitet: Google Gmail; später: anbieterunabhängiger
-- Mail-Eingang).
--
-- Provider-Register `mailbox_provider_types`: EINE Stelle beschreibt, welche
-- Anbieter es gibt, welche Anmeldearten und Quellarten (Ordner/Label) sie
-- kennen, ob OAuth-Start freigegeben ist und ob sie abgerufen (pull) oder
-- beliefert (push) werden. Neue Anbieter = neue Zeile, kein neuer
-- CHECK-Wildwuchs in den allgemeinen Tabellen.
--   * microsoft_graph — application (Firmenmandant, App-only, wie 07E) oder
--                       delegated (Nutzer meldet sich selbst an), Quelle: Ordner.
--   * google_gmail    — delegated, Quelle: Label. OAuth-Start NOCH GESPERRT
--                       (kein Google-Adapter, keine Restricted-Scope-Produktion).
--   * inbound_channel — späterer anbieterunabhängiger Mail-Eingang (push),
--                       ohne OAuth. Noch gesperrt.
--   * imap, stub      — wie 07E.
--
-- Quelle neutral: `mailbox_source_kind` ('folder' | 'label') +
-- `mailbox_source_name` + `mailbox_source_id`. Eine delegierte Verbindung liest
-- nie „das ganze Postfach": Quelle und Import-Untergrenze sind Pflicht.
-- `provider_account_subject` hält die stabile Konto-Kennung (OIDC `sub`/`oid`):
-- meldet sich beim Neuverbinden unter derselben Adresse ein ANDERES Konto an,
-- wird nicht still überschrieben, sondern eine Bestätigung verlangt.
--
-- OAuth-Startzustand (providerneutral): nur der SHA-256 des `state`, genau
-- einmal verwendbar, mit Ablaufzeit; PKCE-Verifier und Nonce bleiben
-- serverseitig (keine Grants, RLS ohne Policy). Tokens nur im Supabase Vault.
-- Abgelaufene Zustände und vorläufige Secrets räumt
-- `purge_expired_workspace_mailbox_oauth_states` auf (service_role; ein
-- periodischer Aufruf ist ein eigener, späterer Schritt).
--
-- 07E-MSA-FIX1 — Systemordner-Schutz: `allowed_source_names` im Register
-- begrenzt delegierte Quellen (Testphase Microsoft: nur „OfficeTakt-Test");
-- erzwungen beim OAuth-Start und bei jeder Verbindungsänderung. NULL = später
-- frei wählbar (Firmenkunden). Systemordner sperrt zusätzlich der Server-
-- Adapter per stabiler Graph-Ordner-ID vor jedem Abruf.
--
-- Setzt 20261014120000 voraus. Nur lokal.

-- ---------------------------------------------------------------------------
-- 1. Provider-Register
-- ---------------------------------------------------------------------------

create table if not exists public.mailbox_provider_types (
  provider_type text primary key,
  auth_modes text[] not null default '{}',
  source_kinds text[] not null default '{}',
  channel_kind text not null default 'pull',
  oauth_start_enabled boolean not null default false,
  -- 07E-MSA-FIX1: erlaubte Quellnamen für delegierte Verbindungen (NULL = frei wählbar).
  allowed_source_names text[] null,
  description text not null default '',
  constraint mailbox_provider_types_key_check check (provider_type ~ '^[a-z][a-z0-9_]{1,40}$'),
  constraint mailbox_provider_types_auth_modes_check check (auth_modes <@ array['application', 'delegated']::text[]),
  constraint mailbox_provider_types_source_kinds_check check (source_kinds <@ array['folder', 'label']::text[]),
  constraint mailbox_provider_types_channel_check check (channel_kind in ('pull', 'push')),
  -- OAuth-Start nur für Anbieter mit delegierter Anmeldung.
  constraint mailbox_provider_types_oauth_check check (not oauth_start_enabled or 'delegated' = any (auth_modes))
);
alter table public.mailbox_provider_types enable row level security;
revoke all on table public.mailbox_provider_types from public, anon, authenticated;

insert into public.mailbox_provider_types (provider_type, auth_modes, source_kinds, channel_kind, oauth_start_enabled, description) values
  ('microsoft_graph', array['application', 'delegated'], array['folder'], 'pull', true, 'Microsoft Graph (Microsoft 365 und persönliche Microsoft-Konten)'),
  ('google_gmail', array['delegated'], array['label'], 'pull', false, 'Google Gmail (vorbereitet, OAuth-Start gesperrt)'),
  ('inbound_channel', array[]::text[], array[]::text[], 'push', false, 'Anbieterunabhängiger Mail-Eingang (vorbereitet)'),
  ('imap', array[]::text[], array['folder'], 'pull', false, 'IMAP (vorbereitet)'),
  ('stub', array[]::text[], array[]::text[], 'pull', false, 'Test-Provider')
on conflict (provider_type) do nothing;

-- 07E-MSA-FIX1: Testphase — delegiertes Microsoft liest ausschließlich „OfficeTakt-Test".
update public.mailbox_provider_types set allowed_source_names = array['OfficeTakt-Test']
where provider_type = 'microsoft_graph';

-- Erlaubter Quellname? (ohne Groß-/Kleinschreibung, Leerraum an den Rändern egal)
create or replace function public.mailbox_source_name_allowed(p_provider_type text, p_source_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select t.allowed_source_names is null
        or exists (select 1 from unnest(t.allowed_source_names) a where lower(btrim(a)) = lower(btrim(coalesce(p_source_name, ''))))
    from public.mailbox_provider_types t where t.provider_type = p_provider_type
  ), false);
$$;
revoke all on function public.mailbox_source_name_allowed(text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Verbindung: Register statt Konstantenliste, neutrale Quelle, Konto-Kennung
-- ---------------------------------------------------------------------------

alter table public.workspace_mailbox_connections
  add column if not exists auth_mode text null,
  add column if not exists mailbox_source_kind text null,
  add column if not exists mailbox_source_name text null,
  add column if not exists mailbox_source_id text null,
  add column if not exists import_from timestamptz null,
  add column if not exists account_verified_at timestamptz null,
  add column if not exists provider_account_subject text null;

-- Bestehende Graph-Verbindungen (07E) sind App-only.
update public.workspace_mailbox_connections set auth_mode = 'application'
where provider_type = 'microsoft_graph' and auth_mode is null;

alter table public.workspace_mailbox_connections drop constraint if exists workspace_mailbox_connections_provider_check;
alter table public.workspace_mailbox_connections drop constraint if exists workspace_mailbox_connections_provider_fk;
alter table public.workspace_mailbox_connections add constraint workspace_mailbox_connections_provider_fk
  foreign key (provider_type) references public.mailbox_provider_types (provider_type);

alter table public.workspace_mailbox_connections drop constraint if exists workspace_mailbox_connections_source_check;
alter table public.workspace_mailbox_connections add constraint workspace_mailbox_connections_source_check check (
  (mailbox_source_name is null or (length(btrim(mailbox_source_name)) between 1 and 100 and mailbox_source_name !~ '[[:cntrl:]]'))
  and (mailbox_source_kind is null or mailbox_source_kind in ('folder', 'label'))
  and (mailbox_source_name is null or mailbox_source_kind is not null)
  and (provider_account_subject is null or length(provider_account_subject) between 1 and 255)
);

-- Anmeldeart/Quellart passend zum Register; delegiert nie ohne Quelle + Untergrenze.
create or replace function public.mailbox_connection_validate_provider()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_provider public.mailbox_provider_types;
begin
  select * into v_provider from public.mailbox_provider_types where provider_type = new.provider_type;
  if v_provider.provider_type is null then
    return new; -- Fremdschlüssel meldet den Fehler.
  end if;
  if cardinality(v_provider.auth_modes) = 0 then
    if new.auth_mode is not null then
      raise exception 'mailbox_auth_mode_invalid: % kennt keine Anmeldeart', new.provider_type;
    end if;
  elsif new.auth_mode is null or not (new.auth_mode = any (v_provider.auth_modes)) then
    raise exception 'mailbox_auth_mode_invalid: % erlaubt %', new.provider_type, v_provider.auth_modes;
  end if;
  if new.mailbox_source_kind is not null and not (new.mailbox_source_kind = any (v_provider.source_kinds)) then
    raise exception 'mailbox_source_kind_invalid: % erlaubt %', new.provider_type, v_provider.source_kinds;
  end if;
  if new.auth_mode = 'delegated' and (new.mailbox_source_kind is null or new.mailbox_source_name is null or new.import_from is null) then
    raise exception 'mailbox_source_required: delegierte Verbindung braucht Quelle und Import-Untergrenze';
  end if;
  if new.auth_mode = 'delegated' and not public.mailbox_source_name_allowed(new.provider_type, new.mailbox_source_name) then
    raise exception 'mailbox_source_not_allowed: % erlaubt als Quelle nur %', new.provider_type, v_provider.allowed_source_names;
  end if;
  return new;
end;
$$;

drop trigger if exists workspace_mailbox_connections_validate_provider on public.workspace_mailbox_connections;
create trigger workspace_mailbox_connections_validate_provider
before insert or update of provider_type, auth_mode, mailbox_source_kind, mailbox_source_name, import_from
on public.workspace_mailbox_connections
for each row execute function public.mailbox_connection_validate_provider();

-- Eingehende Mails: Provider kommt beim Import aus der (registrierten)
-- Verbindung; hier nur noch Format statt zweiter Konstantenliste.
alter table public.workspace_email_messages drop constraint if exists workspace_email_messages_provider_check;
alter table public.workspace_email_messages add constraint workspace_email_messages_provider_check check (
  (direction = 'outbound' and provider in ('brevo', 'stub'))
  or (direction = 'inbound' and provider ~ '^[a-z][a-z0-9_]{1,40}$')
);

-- ---------------------------------------------------------------------------
-- 3. OAuth-Startzustände (nur Server, providerneutral)
-- ---------------------------------------------------------------------------

create table if not exists public.workspace_mailbox_oauth_states (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  provider_type text not null references public.mailbox_provider_types (provider_type),
  auth_mode text not null default 'delegated',
  state_hash text not null,
  code_verifier text not null,
  nonce text not null,
  expected_address text not null,
  source_kind text not null,
  source_name text not null,
  import_from timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz null,
  detected_address text null,
  detected_subject text null,
  pending_reason text null,
  pending_secret_id uuid null,
  pending_until timestamptz null,
  outcome text null,
  created_at timestamptz not null default now(),
  constraint workspace_mailbox_oauth_states_hash_unique unique (state_hash),
  constraint workspace_mailbox_oauth_states_hash_check check (state_hash ~ '^[0-9a-f]{64}$'),
  constraint workspace_mailbox_oauth_states_auth_mode_check check (auth_mode = 'delegated'),
  constraint workspace_mailbox_oauth_states_outcome_check check (outcome is null or outcome in ('connected', 'confirm_required', 'confirmed', 'cancelled', 'failed')),
  constraint workspace_mailbox_oauth_states_pending_reason_check check (pending_reason is null or pending_reason in ('address_mismatch', 'account_changed')),
  constraint workspace_mailbox_oauth_states_address_check check (expected_address ~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' and length(expected_address) <= 254),
  constraint workspace_mailbox_oauth_states_source_check check (
    source_kind in ('folder', 'label') and length(btrim(source_name)) between 1 and 100 and source_name !~ '[[:cntrl:]]'
  )
);
create index if not exists workspace_mailbox_oauth_states_user_idx on public.workspace_mailbox_oauth_states (user_id, created_at desc);
create index if not exists workspace_mailbox_oauth_states_expiry_idx on public.workspace_mailbox_oauth_states (expires_at);
alter table public.workspace_mailbox_oauth_states enable row level security;
revoke all on table public.workspace_mailbox_oauth_states from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Hilfen: Secret löschen, Verbindung anlegen/aktualisieren, Aufräumen
-- ---------------------------------------------------------------------------

create or replace function public.mailbox_delete_vault_secret(p_secret_id uuid)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
begin
  if p_secret_id is not null then
    delete from vault.secrets where id = p_secret_id;
  end if;
end;
$$;

create or replace function public.mailbox_upsert_delegated_connection(
  p_state public.workspace_mailbox_oauth_states,
  p_address text,
  p_subject text,
  p_credential text,
  p_pending_secret_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_connection public.workspace_mailbox_connections;
  v_secret text;
begin
  select * into v_connection from public.workspace_mailbox_connections
  where workspace_id = p_state.workspace_id and provider_type = p_state.provider_type and mailbox_address = p_address;

  if v_connection.id is null then
    insert into public.workspace_mailbox_connections (
      workspace_id, provider_type, auth_mode, mailbox_address, display_name, status,
      mailbox_source_kind, mailbox_source_name, import_from, account_verified_at, provider_account_subject, created_by
    ) values (
      p_state.workspace_id, p_state.provider_type, 'delegated', p_address, null, 'connected',
      p_state.source_kind, p_state.source_name, p_state.import_from, now(), nullif(p_subject, ''), p_state.user_id
    )
    returning * into v_connection;
  else
    update public.workspace_mailbox_connections
    set auth_mode = 'delegated',
        status = 'connected',
        -- Andere Quelle oder neuer Zeitraum: neuer Delta-/History-Stand (Dubletten verhindert der Import).
        sync_cursor = case when mailbox_source_name is distinct from p_state.source_name or mailbox_source_kind is distinct from p_state.source_kind
                             or import_from is distinct from p_state.import_from then null else sync_cursor end,
        mailbox_source_id = case when mailbox_source_name is distinct from p_state.source_name or mailbox_source_kind is distinct from p_state.source_kind
                                 then null else mailbox_source_id end,
        mailbox_source_kind = p_state.source_kind,
        mailbox_source_name = p_state.source_name,
        import_from = p_state.import_from,
        account_verified_at = now(),
        provider_account_subject = coalesce(nullif(p_subject, ''), provider_account_subject),
        error_category = null, error_code = null, safe_error_message = null,
        next_attempt_at = null, sync_lease_token = null, sync_lease_until = null,
        updated_at = now(), row_version = row_version + 1
    where id = v_connection.id
    returning * into v_connection;
  end if;

  v_secret := p_credential;
  if v_secret is null and p_pending_secret_id is not null then
    select decrypted_secret into v_secret from vault.decrypted_secrets where id = p_pending_secret_id;
  end if;
  if coalesce(v_secret, '') = '' then
    raise exception 'Zugangsdaten fehlen';
  end if;
  perform public.set_workspace_mailbox_credential(v_connection.id, v_secret);
  perform public.mailbox_delete_vault_secret(p_pending_secret_id);
  return v_connection.id;
end;
$$;

-- Abgelaufene OAuth-Zustände und vorläufige (unbestätigte) Zugänge entfernen.
--   * Unbestätigte Zugänge werden SOFORT nach Ablauf der Bestätigungsfrist aus
--     dem Vault gelöscht (Zustand bleibt als „failed" bis zur Löschung).
--   * Zustände werden gelöscht, sobald Start- bzw. Bestätigungsfrist länger
--     als `p_retention` vorbei ist. Nie gelöscht: laufende Zustände vor Ablauf.
create or replace function public.purge_expired_workspace_mailbox_oauth_states(p_retention interval default interval '1 hour')
returns jsonb
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_retention interval := greatest(coalesce(p_retention, interval '1 hour'), interval '0');
  v_secrets integer := 0;
  v_states integer := 0;
  v_row record;
begin
  for v_row in
    select id, pending_secret_id from public.workspace_mailbox_oauth_states
    where pending_secret_id is not null and pending_until < now()
    for update
  loop
    perform public.mailbox_delete_vault_secret(v_row.pending_secret_id);
    update public.workspace_mailbox_oauth_states
    set pending_secret_id = null, outcome = case when outcome = 'confirm_required' then 'failed' else outcome end
    where id = v_row.id;
    v_secrets := v_secrets + 1;
  end loop;

  for v_row in
    select id, pending_secret_id from public.workspace_mailbox_oauth_states
    where greatest(expires_at, coalesce(pending_until, expires_at)) < now() - v_retention
    for update
  loop
    perform public.mailbox_delete_vault_secret(v_row.pending_secret_id);
    delete from public.workspace_mailbox_oauth_states where id = v_row.id;
    v_states := v_states + 1;
  end loop;
  return jsonb_build_object('pending_secrets_deleted', v_secrets, 'states_deleted', v_states);
end;
$$;

revoke all on function public.mailbox_delete_vault_secret(uuid) from public, anon, authenticated;
revoke all on function public.mailbox_upsert_delegated_connection(public.workspace_mailbox_oauth_states, text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.mailbox_connection_validate_provider() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Server-RPCs (Edge Functions mailbox-oauth-start / -callback, service_role)
-- ---------------------------------------------------------------------------

create or replace function public.create_workspace_mailbox_oauth_state(
  p_workspace_id uuid,
  p_user_id uuid,
  p_provider_type text,
  p_state_hash text,
  p_code_verifier text,
  p_nonce text,
  p_expected_address text,
  p_source_kind text,
  p_source_name text,
  p_import_from timestamptz,
  p_ttl_seconds integer default 600
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_provider public.mailbox_provider_types;
  v_id uuid;
begin
  if not public.workspace_user_can_write(p_workspace_id, p_user_id) then
    raise exception 'Keine Schreibberechtigung';
  end if;
  select * into v_provider from public.mailbox_provider_types where provider_type = p_provider_type;
  if v_provider.provider_type is null or not v_provider.oauth_start_enabled then
    raise exception 'provider_not_available: %', coalesce(p_provider_type, '-');
  end if;
  if not (p_source_kind = any (v_provider.source_kinds)) then
    raise exception 'mailbox_source_kind_invalid: % erlaubt %', p_provider_type, v_provider.source_kinds;
  end if;
  if not public.mailbox_source_name_allowed(p_provider_type, p_source_name) then
    raise exception 'mailbox_source_not_allowed: % erlaubt als Quelle nur %', p_provider_type, v_provider.allowed_source_names;
  end if;
  if coalesce(length(p_code_verifier), 0) < 43 or coalesce(length(p_nonce), 0) < 16 then
    raise exception 'PKCE/Nonce ungueltig';
  end if;
  -- Aufräumen nebenbei (ein periodischer Aufruf folgt separat).
  perform public.purge_expired_workspace_mailbox_oauth_states();

  insert into public.workspace_mailbox_oauth_states (
    workspace_id, user_id, provider_type, state_hash, code_verifier, nonce, expected_address, source_kind, source_name, import_from, expires_at
  ) values (
    p_workspace_id, p_user_id, p_provider_type, lower(p_state_hash), p_code_verifier, p_nonce, lower(btrim(p_expected_address)), p_source_kind, btrim(p_source_name),
    coalesce(p_import_from, now()), now() + make_interval(secs => least(greatest(coalesce(p_ttl_seconds, 600), 60), 900))
  )
  returning id into v_id;
  return v_id;
end;
$$;

-- Genau einmal verwendbar: der erste gültige Aufruf verbraucht den Zustand.
create or replace function public.consume_workspace_mailbox_oauth_state(p_state_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.workspace_mailbox_oauth_states;
begin
  update public.workspace_mailbox_oauth_states
  set consumed_at = now()
  where state_hash = lower(coalesce(p_state_hash, '')) and consumed_at is null and expires_at > now()
  returning * into v_row;
  if v_row.id is not null then
    return jsonb_build_object('ok', true, 'state', to_jsonb(v_row) - 'state_hash');
  end if;
  select * into v_row from public.workspace_mailbox_oauth_states where state_hash = lower(coalesce(p_state_hash, ''));
  if v_row.id is null then
    return jsonb_build_object('ok', false, 'reason', 'unknown');
  end if;
  if v_row.consumed_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'consumed');
  end if;
  return jsonb_build_object('ok', false, 'reason', 'expired');
end;
$$;

create or replace function public.complete_workspace_mailbox_oauth(
  p_state_id uuid,
  p_detected_address text,
  p_detected_subject text,
  p_credential text
)
returns jsonb
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_state public.workspace_mailbox_oauth_states;
  v_detected text := lower(btrim(coalesce(p_detected_address, '')));
  v_subject text := nullif(btrim(coalesce(p_detected_subject, '')), '');
  v_known_subject text;
  v_reason text;
  v_connection_id uuid;
  v_pending uuid;
begin
  select * into v_state from public.workspace_mailbox_oauth_states where id = p_state_id for update;
  if v_state.id is null or v_state.consumed_at is null or v_state.outcome is not null then
    raise exception 'OAuth-Zustand ungueltig';
  end if;
  if v_state.consumed_at < now() - interval '15 minutes' then
    raise exception 'OAuth-Zustand abgelaufen';
  end if;
  if not public.workspace_user_can_write(v_state.workspace_id, v_state.user_id) then
    update public.workspace_mailbox_oauth_states set outcome = 'failed' where id = v_state.id;
    raise exception 'Keine Schreibberechtigung';
  end if;
  if v_detected !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' or length(v_detected) > 254 then
    update public.workspace_mailbox_oauth_states set outcome = 'failed' where id = v_state.id;
    raise exception 'Kontoadresse ungueltig';
  end if;
  if v_subject is not null and length(v_subject) > 255 then
    update public.workspace_mailbox_oauth_states set outcome = 'failed' where id = v_state.id;
    raise exception 'Kontokennung ungueltig';
  end if;
  if coalesce(p_credential, '') = '' then
    raise exception 'Zugangsdaten fehlen';
  end if;

  select provider_account_subject into v_known_subject from public.workspace_mailbox_connections
  where workspace_id = v_state.workspace_id and provider_type = v_state.provider_type and mailbox_address = v_detected;

  if v_detected <> v_state.expected_address then
    v_reason := 'address_mismatch';
  elsif v_known_subject is not null and v_subject is distinct from v_known_subject then
    -- Gleiche Adresse, aber ein anderes Konto (z. B. neu vergebene Adresse): nicht still übernehmen.
    v_reason := 'account_changed';
  end if;

  if v_reason is null then
    v_connection_id := public.mailbox_upsert_delegated_connection(v_state, v_detected, v_subject, p_credential, null);
    update public.workspace_mailbox_oauth_states set outcome = 'connected', detected_address = v_detected, detected_subject = v_subject where id = v_state.id;
    return jsonb_build_object('outcome', 'connected', 'connection_id', v_connection_id);
  end if;

  -- Nichts verbinden. Zugang nur vorläufig im Vault, kurz befristet.
  v_pending := vault.create_secret(p_credential, 'mailbox-oauth-pending-' || v_state.id::text, 'OfficeTakt: Postfach-Bestätigung ausstehend');
  update public.workspace_mailbox_oauth_states
  set outcome = 'confirm_required', detected_address = v_detected, detected_subject = v_subject, pending_reason = v_reason,
      pending_secret_id = v_pending, pending_until = now() + interval '15 minutes'
  where id = v_state.id;
  return jsonb_build_object('outcome', 'confirm_required', 'state_id', v_state.id, 'reason', v_reason);
end;
$$;

-- Nach Ablauf verworfen: aufräumen ohne Verbindung.
create or replace function public.fail_workspace_mailbox_oauth(p_state_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.workspace_mailbox_oauth_states set outcome = 'failed'
  where id = p_state_id and outcome is null;
end;
$$;

-- Quell-Kennung (Ordner-/Label-ID) nach erster Auflösung merken (nur Server, nur mit Lease).
create or replace function public.set_workspace_mailbox_source_id(p_connection_id uuid, p_lease_token uuid, p_source_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.workspace_mailbox_connections
  set mailbox_source_id = left(p_source_id, 512), updated_at = now()
  where id = p_connection_id and sync_lease_token = p_lease_token and sync_lease_until > now();
end;
$$;

-- Rotiertes Refresh-Token speichern: nur während eines gültigen Abruf-Leases
-- und nur, wenn noch ein Zugang existiert (nach „Trennen" entsteht keiner neu).
create or replace function public.rotate_workspace_mailbox_credential(p_connection_id uuid, p_lease_token uuid, p_secret text)
returns boolean
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_secret uuid;
begin
  if coalesce(p_secret, '') = '' then
    raise exception 'Zugangsdaten fehlen';
  end if;
  select c.vault_secret_id into v_secret
  from public.workspace_mailbox_credentials c
  join public.workspace_mailbox_connections m on m.id = c.connection_id
  where c.connection_id = p_connection_id and m.sync_lease_token = p_lease_token and m.sync_lease_until > now() and m.status <> 'disconnected'
  for update of c;
  if v_secret is null then
    return false;
  end if;
  perform vault.update_secret(v_secret, p_secret);
  update public.workspace_mailbox_credentials set updated_at = now() where connection_id = p_connection_id;
  return true;
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'create_workspace_mailbox_oauth_state(uuid, uuid, text, text, text, text, text, text, text, timestamptz, integer)',
    'consume_workspace_mailbox_oauth_state(text)',
    'complete_workspace_mailbox_oauth(uuid, text, text, text)',
    'fail_workspace_mailbox_oauth(uuid)',
    'set_workspace_mailbox_source_id(uuid, uuid, text)',
    'rotate_workspace_mailbox_credential(uuid, uuid, text)',
    'purge_expired_workspace_mailbox_oauth_states(interval)'
  ] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('revoke all on function public.%s from anon', f);
    execute format('revoke all on function public.%s from authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Client-RPCs: ausstehende Bestätigung, Trennen, Postfachliste
-- ---------------------------------------------------------------------------

create or replace function public.get_workspace_mailbox_oauth_pending(p_workspace_id uuid, p_state_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_state public.workspace_mailbox_oauth_states;
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet';
  end if;
  select * into v_state from public.workspace_mailbox_oauth_states
  where id = p_state_id and workspace_id = p_workspace_id and user_id = auth.uid();
  if v_state.id is null or v_state.outcome is distinct from 'confirm_required' or v_state.pending_until < now() then
    return null;
  end if;
  -- Nur Adressen, Quelle und Grund — nie Secret, Verifier, Nonce oder Konto-Kennung.
  return jsonb_build_object('state_id', v_state.id, 'provider_type', v_state.provider_type, 'reason', v_state.pending_reason,
    'expected_address', v_state.expected_address, 'detected_address', v_state.detected_address,
    'source_kind', v_state.source_kind, 'source_name', v_state.source_name, 'pending_until', v_state.pending_until);
end;
$$;

create or replace function public.confirm_workspace_mailbox_oauth_pending(p_workspace_id uuid, p_state_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_state public.workspace_mailbox_oauth_states;
  v_connection_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet';
  end if;
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Keine Schreibberechtigung';
  end if;
  select * into v_state from public.workspace_mailbox_oauth_states
  where id = p_state_id and workspace_id = p_workspace_id and user_id = auth.uid()
  for update;
  if v_state.id is null or v_state.outcome is distinct from 'confirm_required' or v_state.pending_secret_id is null then
    raise exception 'Keine ausstehende Bestaetigung';
  end if;
  if v_state.pending_until < now() then
    perform public.mailbox_delete_vault_secret(v_state.pending_secret_id);
    update public.workspace_mailbox_oauth_states set outcome = 'failed', pending_secret_id = null where id = v_state.id;
    raise exception 'Bestaetigung abgelaufen';
  end if;
  -- Bewusst bestätigtes (anderes) Konto: dessen Kennung gilt ab jetzt.
  v_connection_id := public.mailbox_upsert_delegated_connection(v_state, v_state.detected_address, v_state.detected_subject, null, v_state.pending_secret_id);
  update public.workspace_mailbox_oauth_states set outcome = 'confirmed', pending_secret_id = null where id = v_state.id;
  return jsonb_build_object('outcome', 'connected', 'connection_id', v_connection_id);
end;
$$;

create or replace function public.cancel_workspace_mailbox_oauth_pending(p_workspace_id uuid, p_state_id uuid)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_state public.workspace_mailbox_oauth_states;
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet';
  end if;
  select * into v_state from public.workspace_mailbox_oauth_states
  where id = p_state_id and workspace_id = p_workspace_id and user_id = auth.uid()
  for update;
  if v_state.id is null then
    return;
  end if;
  perform public.mailbox_delete_vault_secret(v_state.pending_secret_id);
  update public.workspace_mailbox_oauth_states set outcome = 'cancelled', pending_secret_id = null where id = v_state.id;
end;
$$;

-- Trennen: Zugang serverseitig löschen, Verbindung „nicht verbunden".
-- Bereits importierte E-Mails und Kundendaten bleiben unverändert.
create or replace function public.disconnect_workspace_mailbox_connection(p_workspace_id uuid, p_connection_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_secret uuid;
  v_row public.workspace_mailbox_connections;
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet';
  end if;
  if p_workspace_id is null or not public.can_write_workspace(p_workspace_id) then
    raise exception 'Keine Schreibberechtigung';
  end if;
  select vault_secret_id into v_secret from public.workspace_mailbox_credentials c
  join public.workspace_mailbox_connections m on m.id = c.connection_id
  where c.connection_id = p_connection_id and m.workspace_id = p_workspace_id;
  delete from public.workspace_mailbox_credentials
  where connection_id = p_connection_id
    and exists (select 1 from public.workspace_mailbox_connections m where m.id = p_connection_id and m.workspace_id = p_workspace_id);
  perform public.mailbox_delete_vault_secret(v_secret);
  update public.workspace_mailbox_connections
  set status = 'disconnected', sync_cursor = null, mailbox_source_id = null, sync_lease_token = null, sync_lease_until = null,
      next_attempt_at = null, error_category = null, error_code = null, safe_error_message = null,
      updated_at = now(), row_version = row_version + 1
  where id = p_connection_id and workspace_id = p_workspace_id
  returning * into v_row;
  if v_row.id is null then
    raise exception 'Postfach nicht gefunden';
  end if;
  return jsonb_build_object('id', v_row.id, 'status', v_row.status);
end;
$$;

-- Postfachliste: Anmeldeart, Quelle, Import-Untergrenze (weiter ohne Cursor,
-- Lease, Secrets und ohne Konto-Kennung).
create or replace function public.list_workspace_mailbox_connections(p_workspace_id uuid)
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
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', c.id, 'provider_type', c.provider_type, 'auth_mode', c.auth_mode, 'mailbox_address', c.mailbox_address, 'display_name', c.display_name,
      'mailbox_source_kind', c.mailbox_source_kind, 'mailbox_source_name', c.mailbox_source_name,
      'import_from', c.import_from, 'account_verified_at', c.account_verified_at,
      'status', c.status, 'last_successful_sync_at', c.last_successful_sync_at, 'last_attempt_at', c.last_attempt_at,
      'next_attempt_at', c.next_attempt_at, 'error_category', c.error_category, 'error_code', c.error_code, 'safe_error_message', c.safe_error_message,
      'has_credentials', exists (select 1 from public.workspace_mailbox_credentials k where k.connection_id = c.id)
    ) order by c.created_at)
    from public.workspace_mailbox_connections c
    where c.workspace_id = p_workspace_id
  ), '[]'::jsonb);
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'get_workspace_mailbox_oauth_pending(uuid, uuid)',
    'confirm_workspace_mailbox_oauth_pending(uuid, uuid)',
    'cancel_workspace_mailbox_oauth_pending(uuid, uuid)',
    'disconnect_workspace_mailbox_connection(uuid, uuid)'
  ] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('revoke all on function public.%s from anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end;
$$;

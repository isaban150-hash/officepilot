-- EINRICHTUNG-01 / AP6 -- Firmenprofil, Vorlagen und Antwortadresse (Katalog Teil 2 Fassung 2 vom 24.10.2026,
-- Vertraege 1.18 bis 1.22; Entscheidung E18; Korrekturgruppe K4).
--
--   * Firmenprofil: neue Schema-3-Felder (Angebotsgueltigkeit, Einleitung und Schluss fuer Angebote und Auftraege,
--     Anrede und Gruss fuer Briefe, Kommunikationssprache) im Server-Katalog mit introduced_in = 3 -- Schreiber mit
--     Schema 1 und 2 bewahren sie. Pruefung geaenderter Werte per Trigger: Anzeigename (display_name_invalid),
--     Textgrenzen 2000, Gueltigkeit 1..365, Sprache de/tr/bg. Altwerte bleiben speicherbar.
--   * Antwortadresse (E18, K4): Zustand je Betrieb mit Aenderungsstand, Bestaetigungen nur als Token-Hash (72 h,
--     erneut fruehestens nach 10 min, hoechstens 5 je Tag), Versuchslimit, unveraenderliche Pruefspur. Versandwege
--     bestimmen die Antwortadresse bei jedem Versand neu (resolve_workspace_reply_to): bestaetigte Antwortadresse,
--     sonst bestaetigte Anmelde-E-Mail des aktuellen Inhabers, sonst reply_to_unavailable.
--   * upsert_workspace_sync_entity ist WOERTLICH die Fassung aus 20261127130000_einrichtung01_profil_schema3.sql; geaendert ist nur der Feldkatalog
--     des Zweigs company_profile (8 neue Eintraege). Erzeugt mit
--     pruefunterlagen/einrichtung-01/werkzeug/ap6/erzeuge-ap6-migration.mjs; Gleichstand mit der laufenden Datenbank
--     gleich; Diff-Beleg im Pruefordner.
--   * Kein Rumpf einer FINANZ-CORE-01A- oder DOKUMENTE-01-RPC wird geaendert. Kein Backfill.
--
-- NUR VORBEREITET (Z-F2): Anwendung auf bestehende Datenbanken erst nach gesonderter Freigabe. Nicht remote anwenden
-- (Gesamtveroeffentlichung RELEASE-01).

/* ======================================================================== */
/* 1. Firmenprofil: Pruefung geaenderter Werte (1.19, 1.21, E-04, E-05)     */
/* ======================================================================== */

/*
 * Geprueft wird nur ein Wert, der sich mit diesem Schreibvorgang aendert: Ein aelterer, gespeicherter Wert, der eine
 * neue Regel verletzt, blockiert keine anderen Aenderungen (Altbestand bleibt speicherbar). Ein Verstoss bricht den
 * Schreibvorgang atomar ab; der bestehende Stand bleibt.
 *
 *   senderDisplayName  hoechstens 120 Codepunkte, ohne Zeilenumbruch und Steuerzeichen, ohne < > " @ (keine
 *                      E-Mail-Adresse) -> 'Firmenprofil ungueltig: display_name_invalid'
 *   Fusszeile, Hinweis steuerfrei, Einleitung/Schluss (Angebot, Auftrag), Anrede, Gruss: hoechstens 2000 Codepunkte
 *   offerValidityDays  ganze Zahl 1..365
 *   communicationLanguage de, tr oder bg
 */
create or replace function public.einrichtung01_company_profile_changes_check()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_old jsonb := case when tg_op = 'UPDATE' then coalesce(old.payload, '{}'::jsonb) else '{}'::jsonb end;
  v_new jsonb := coalesce(new.payload, '{}'::jsonb);
  v_key text;
  v_text text;
  v_value jsonb;
begin
  if v_new ? 'senderDisplayName' and jsonb_typeof(v_new->'senderDisplayName') <> 'null'
     and (v_old->'senderDisplayName') is distinct from (v_new->'senderDisplayName') then
    v_text := v_new->>'senderDisplayName';
    if jsonb_typeof(v_new->'senderDisplayName') <> 'string'
       or length(btrim(v_text)) > 120
       or v_text ~ ('[' || chr(1) || '-' || chr(31) || chr(127) || chr(8232) || chr(8233) || ']')
       or v_text ~ '[<>"@]' then
      raise exception 'Firmenprofil ungueltig: display_name_invalid' using errcode = 'P0001';
    end if;
  end if;

  foreach v_key in array array['invoiceFooterNotes', 'taxFreeNotice', 'offerIntroText', 'offerClosingText',
                                'orderIntroText', 'orderClosingText', 'letterSalutation', 'letterClosing'] loop
    if v_new ? v_key and jsonb_typeof(v_new->v_key) <> 'null'
       and (v_old->v_key) is distinct from (v_new->v_key) then
      if jsonb_typeof(v_new->v_key) <> 'string' or length(v_new->>v_key) > 2000 then
        raise exception 'Firmenprofil ungueltig: %', v_key using errcode = 'P0001';
      end if;
    end if;
  end loop;

  if v_new ? 'offerValidityDays' and jsonb_typeof(v_new->'offerValidityDays') <> 'null'
     and (v_old->'offerValidityDays') is distinct from (v_new->'offerValidityDays') then
    v_value := v_new->'offerValidityDays';
    if jsonb_typeof(v_value) <> 'number'
       or (v_value #>> '{}') !~ ('^[0-9]{1,3}' || chr(36))
       or (v_value #>> '{}')::integer not between 1 and 365 then
      raise exception 'Firmenprofil ungueltig: offerValidityDays' using errcode = 'P0001';
    end if;
  end if;

  if v_new ? 'communicationLanguage' and jsonb_typeof(v_new->'communicationLanguage') <> 'null'
     and (v_old->'communicationLanguage') is distinct from (v_new->'communicationLanguage') then
    if jsonb_typeof(v_new->'communicationLanguage') <> 'string'
       or (v_new->>'communicationLanguage') not in ('de', 'tr', 'bg') then
      raise exception 'Firmenprofil ungueltig: communicationLanguage' using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.einrichtung01_company_profile_changes_check() from public, anon, authenticated, service_role;

drop trigger if exists einrichtung01_company_profile_changes_check on public.workspace_company_profiles;
create trigger einrichtung01_company_profile_changes_check
  before insert or update of payload on public.workspace_company_profiles
  for each row execute function public.einrichtung01_company_profile_changes_check();

/* ======================================================================== */
/* 2. Antwortadresse: Zustand, Bestaetigungen, Versuche, Pruefspur (E18, K4) */
/* ======================================================================== */

/*
 * Je Betrieb der Stand der Antwortadresse: die aktuelle (normalisierte) Adresse aus dem Firmenprofil, ihr
 * Aenderungsstand (revision, bei jeder Aenderung erhoeht) und die zuletzt bestaetigte Fassung. Gueltig ist eine
 * Bestaetigung nur fuer genau diese Adresse in genau diesem Aenderungsstand.
 */
create table if not exists public.workspace_reply_to_state (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  address text,
  revision bigint not null default 0,
  confirmed_revision bigint,
  confirmed_address text,
  confirmed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint workspace_reply_to_state_address_normalized check (address is null or address = lower(btrim(address)))
);
alter table public.workspace_reply_to_state enable row level security;
revoke all on public.workspace_reply_to_state from public, anon, authenticated, service_role;

/*
 * Bestaetigungen: nur der SHA-256 des Tokens (256 Bit Zufall, erzeugt in der Edge Function), gebunden an Zweck,
 * Betrieb, Adresse und Aenderungsstand; 72 Stunden gueltig. Aendern und „erneut senden“ machen aeltere unwirksam.
 */
create table if not exists public.workspace_reply_to_tokens (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  purpose text not null default 'reply_to_confirm' check (purpose = 'reply_to_confirm'),
  address text not null,
  revision bigint not null,
  token_hash text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  sent_at timestamptz,
  superseded_at timestamptz,
  confirmed_at timestamptz,
  constraint workspace_reply_to_tokens_hash_format check (token_hash ~ ('^[0-9a-f]{64}' || chr(36))),
  constraint workspace_reply_to_tokens_expiry check (expires_at > created_at)
);
create unique index if not exists workspace_reply_to_tokens_hash on public.workspace_reply_to_tokens (token_hash);
create index if not exists workspace_reply_to_tokens_workspace on public.workspace_reply_to_tokens (workspace_id, created_at desc);
alter table public.workspace_reply_to_tokens enable row level security;
revoke all on public.workspace_reply_to_tokens from public, anon, authenticated, service_role;

-- Fehlversuche je Herkunftsschluessel (Hash, gebildet in der Edge Function); Schutz gegen Raten zusaetzlich zur Entropie.
create table if not exists public.reply_to_confirm_attempts (
  id bigint generated always as identity primary key,
  attempt_key text not null,
  attempted_at timestamptz not null default now()
);
create index if not exists reply_to_confirm_attempts_window on public.reply_to_confirm_attempts (attempt_key, attempted_at);
alter table public.reply_to_confirm_attempts enable row level security;
revoke all on public.reply_to_confirm_attempts from public, anon, authenticated, service_role;

-- Pruefspur der Antwortadresse (unveraenderlich wie die Team-Pruefspur, Vertrag 1.9). Eigener Name: die Tabelle
-- workspace_communication_events gehoert dem Kommunikationsverlauf (S2) und bleibt unberuehrt.
create table if not exists public.workspace_reply_to_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  actor_user_id uuid,
  action text not null check (action in ('reply_to_confirmation_sent', 'reply_to_confirmed')),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists workspace_reply_to_events_workspace on public.workspace_reply_to_events (workspace_id, created_at desc);
alter table public.workspace_reply_to_events enable row level security;
revoke all on public.workspace_reply_to_events from public, anon, authenticated, service_role;
drop trigger if exists einrichtung01_audit_immutable on public.workspace_reply_to_events;
create trigger einrichtung01_audit_immutable before update or delete on public.workspace_reply_to_events
  for each row execute function public.einrichtung01_audit_immutable();

/* Maskierte Adresse fuer Antworten ohne Geschaeftsdaten: erster Buchstabe, „***“, Domain. */
create or replace function public.einrichtung01_mask_email(p_email text)
returns text
language sql
immutable
as $$
  select case
    when p_email is null or position('@' in p_email) < 2 then null
    else left(p_email, 1) || '***' || substr(p_email, position('@' in p_email))
  end;
$$;
revoke all on function public.einrichtung01_mask_email(text) from public, anon, authenticated, service_role;

/* Die aktuelle Antwortadresse des Profils (normalisiert) oder null. */
create or replace function public.einrichtung01_profile_reply_to(p_workspace_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select nullif(lower(btrim(coalesce(cp.payload->>'replyToEmail', ''))), '')
  from public.workspace_company_profiles cp
  where cp.workspace_id = p_workspace_id;
$$;
revoke all on function public.einrichtung01_profile_reply_to(uuid) from public, anon, authenticated, service_role;

/*
 * Zustand nachfuehren, sobald sich die Antwortadresse im Profil aendert (neu, geaendert, geloescht): neuer
 * Aenderungsstand, offene Bestaetigungen werden unwirksam. Eine bestaetigte Adresse ist nach einer Aenderung wieder
 * unbestaetigt (E-03.5).
 */
create or replace function public.einrichtung01_reply_to_state_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old text := case when tg_op = 'UPDATE' then nullif(lower(btrim(coalesce(old.payload->>'replyToEmail', ''))), '') else null end;
  v_new text := nullif(lower(btrim(coalesce(new.payload->>'replyToEmail', ''))), '');
begin
  if tg_op = 'UPDATE' and v_old is not distinct from v_new then
    return new;
  end if;
  insert into public.workspace_reply_to_state as s (workspace_id, address, revision, updated_at)
  values (new.workspace_id, v_new, 1, now())
  on conflict (workspace_id) do update
    set address = excluded.address, revision = s.revision + 1, updated_at = now();
  update public.workspace_reply_to_tokens
     set superseded_at = now()
   where workspace_id = new.workspace_id and superseded_at is null and confirmed_at is null;
  return new;
end;
$$;
revoke all on function public.einrichtung01_reply_to_state_sync() from public, anon, authenticated, service_role;

drop trigger if exists einrichtung01_reply_to_state_sync on public.workspace_company_profiles;
create trigger einrichtung01_reply_to_state_sync
  after insert or update of payload on public.workspace_company_profiles
  for each row execute function public.einrichtung01_reply_to_state_sync();

/*
 * Zustand fuer einen Betrieb sperren und mit dem Profil abgleichen (Profil vor der Migration gespeichert oder Zustand
 * fehlt): Ergebnis ist die gesperrte, aktuelle Zeile.
 */
create or replace function public.einrichtung01_reply_to_state_lock(p_workspace_id uuid)
returns public.workspace_reply_to_state
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state public.workspace_reply_to_state;
  v_profile text := public.einrichtung01_profile_reply_to(p_workspace_id);
begin
  insert into public.workspace_reply_to_state (workspace_id, address, revision)
  values (p_workspace_id, v_profile, 1)
  on conflict (workspace_id) do nothing;
  select * into v_state from public.workspace_reply_to_state where workspace_id = p_workspace_id for update;
  if v_state.address is distinct from v_profile then
    update public.workspace_reply_to_state
       set address = v_profile, revision = revision + 1, updated_at = now()
     where workspace_id = p_workspace_id
     returning * into v_state;
    update public.workspace_reply_to_tokens
       set superseded_at = now()
     where workspace_id = p_workspace_id and superseded_at is null and confirmed_at is null;
  end if;
  return v_state;
end;
$$;
revoke all on function public.einrichtung01_reply_to_state_lock(uuid) from public, anon, authenticated, service_role;

/*
 * Neue Bestaetigung ausgeben (Edge Function `confirm-reply-to`, Aktion „request“; nur service_role). Die Function hat das
 * Konto der anfragenden Person geprueft (auth.getUser) und reicht es als p_actor herein; hier gelten Rolle (owner,
 * admin), Freigabe, Sperre und Betriebslizenz (workspace_user_can_write). Erneut senden fruehestens nach 10 Minuten,
 * hoechstens 5-mal je Tag und Betrieb. Die Adresse muss die aktuelle des Profils sein (sonst address_mismatch: die
 * Profilaenderung hat den Server noch nicht erreicht).
 */
create or replace function public.reply_to_confirmation_issue(p_workspace_id uuid, p_actor uuid, p_token_hash text, p_address text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state public.workspace_reply_to_state;
  v_last timestamptz;
  v_count integer;
  v_expires timestamptz := now() + interval '72 hours';
  v_address text := lower(btrim(coalesce(p_address, '')));
begin
  if p_workspace_id is null or p_actor is null or p_token_hash is null
     or p_token_hash !~ ('^[0-9a-f]{64}' || chr(36)) then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  if not public.workspace_user_can_write(p_workspace_id, p_actor) then
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;
  perform 1 from public.workspaces w where w.id = p_workspace_id for share;
  v_state := public.einrichtung01_reply_to_state_lock(p_workspace_id);
  if v_state.address is null then
    return jsonb_build_object('ok', false, 'code', 'reply_to_missing');
  end if;
  if v_state.address <> v_address then
    return jsonb_build_object('ok', false, 'code', 'address_mismatch');
  end if;
  if v_state.confirmed_revision = v_state.revision and v_state.confirmed_address = v_state.address then
    return jsonb_build_object('ok', false, 'code', 'already_confirmed');
  end if;
  select max(t.created_at), count(*) filter (where t.created_at > now() - interval '24 hours')
    into v_last, v_count
    from public.workspace_reply_to_tokens t
   where t.workspace_id = p_workspace_id;
  if v_last is not null and v_last > now() - interval '10 minutes' then
    return jsonb_build_object('ok', false, 'code', 'resend_too_early', 'retry_after', v_last + interval '10 minutes');
  end if;
  if coalesce(v_count, 0) >= 5 then
    return jsonb_build_object('ok', false, 'code', 'resend_limit');
  end if;
  update public.workspace_reply_to_tokens
     set superseded_at = now()
   where workspace_id = p_workspace_id and superseded_at is null and confirmed_at is null;
  insert into public.workspace_reply_to_tokens (workspace_id, address, revision, token_hash, created_by, expires_at)
  values (p_workspace_id, v_state.address, v_state.revision, p_token_hash, p_actor, v_expires);
  return jsonb_build_object('ok', true, 'address', v_state.address, 'revision', v_state.revision, 'expires_at', v_expires);
end;
$$;

/* Versand angenommen: festhalten und in die Pruefspur. Versand gescheitert: die Bestaetigung zaehlt nicht (Rueckzug). */
create or replace function public.reply_to_confirmation_mark_sent(p_token_hash text, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token public.workspace_reply_to_tokens;
begin
  update public.workspace_reply_to_tokens
     set sent_at = now()
   where token_hash = p_token_hash and sent_at is null and superseded_at is null and confirmed_at is null
  returning * into v_token;
  if v_token.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  insert into public.workspace_reply_to_events (workspace_id, actor_user_id, action, details)
  values (v_token.workspace_id, p_actor, 'reply_to_confirmation_sent',
          jsonb_build_object('revision', v_token.revision, 'address', public.einrichtung01_mask_email(v_token.address)));
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.reply_to_confirmation_withdraw(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.workspace_reply_to_tokens
   where token_hash = p_token_hash and sent_at is null and confirmed_at is null;
  return jsonb_build_object('ok', true);
end;
$$;

/*
 * Bestaetigen (Aktion „confirm“; nur service_role; ohne Anmeldung der bestaetigenden Person). Bestaetigt wird nur, wenn
 * Zweck, Betrieb, Adresse und Aenderungsstand noch aktuell sind. Dieselbe, bereits wirksame Bestaetigung erneut ist
 * idempotent (kein zweiter Pruefspur-Eintrag). Ungueltige, abgelaufene, veraltete und fremde Tokens erhalten dieselbe
 * Antwort; jeder Fehlversuch zaehlt fuer das Versuchslimit (20 je Schluessel in 15 Minuten). Die Antwort enthaelt
 * hoechstens die maskierte Adresse — keinen Betriebsnamen, keine Sitzung, keinen Zugang.
 */
create or replace function public.reply_to_confirmation_confirm(p_token_hash text, p_attempt_key text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token public.workspace_reply_to_tokens;
  v_state public.workspace_reply_to_state;
  v_profile text;
  v_attempts integer;
  v_key text := nullif(btrim(coalesce(p_attempt_key, '')), '');
begin
  if v_key is not null then
    select count(*) into v_attempts
      from public.reply_to_confirm_attempts a
     where a.attempt_key = v_key and a.attempted_at > now() - interval '15 minutes';
    if v_attempts >= 20 then
      return jsonb_build_object('ok', false, 'code', 'rate_limited');
    end if;
  end if;

  if p_token_hash is not null and p_token_hash ~ ('^[0-9a-f]{64}' || chr(36)) then
    select * into v_token from public.workspace_reply_to_tokens t where t.token_hash = p_token_hash for update;
  end if;
  if v_token.id is null then
    if v_key is not null then
      insert into public.reply_to_confirm_attempts (attempt_key) values (v_key);
    end if;
    return jsonb_build_object('ok', false, 'code', 'invalid');
  end if;

  perform 1 from public.workspaces w where w.id = v_token.workspace_id for share;
  select * into v_state from public.workspace_reply_to_state s where s.workspace_id = v_token.workspace_id for update;
  v_profile := public.einrichtung01_profile_reply_to(v_token.workspace_id);

  if v_token.confirmed_at is not null
     and v_state.confirmed_revision = v_token.revision and v_state.confirmed_address = v_token.address
     and v_state.revision = v_token.revision and v_state.address = v_token.address
     and v_profile = v_token.address then
    return jsonb_build_object('ok', true, 'status', 'already_confirmed', 'address', public.einrichtung01_mask_email(v_token.address));
  end if;

  if v_token.confirmed_at is not null
     or v_token.superseded_at is not null
     or v_token.expires_at <= now()
     or v_token.purpose <> 'reply_to_confirm'
     or v_state.workspace_id is null
     or v_state.revision <> v_token.revision
     or v_state.address is distinct from v_token.address
     or v_profile is distinct from v_token.address then
    if v_key is not null then
      insert into public.reply_to_confirm_attempts (attempt_key) values (v_key);
    end if;
    return jsonb_build_object('ok', false, 'code', 'invalid');
  end if;

  update public.workspace_reply_to_tokens set confirmed_at = now() where id = v_token.id;
  update public.workspace_reply_to_state
     set confirmed_revision = v_token.revision, confirmed_address = v_token.address, confirmed_at = now(), updated_at = now()
   where workspace_id = v_token.workspace_id;
  insert into public.workspace_reply_to_events (workspace_id, actor_user_id, action, details)
  values (v_token.workspace_id, null, 'reply_to_confirmed',
          jsonb_build_object('revision', v_token.revision, 'address', public.einrichtung01_mask_email(v_token.address)));
  return jsonb_build_object('ok', true, 'status', 'confirmed', 'address', public.einrichtung01_mask_email(v_token.address));
end;
$$;

/*
 * Antwortadresse eines Versands (E18), bei jedem Versand neu bestimmt: die bestaetigte Antwortadresse des Betriebs, sonst
 * die bestaetigte Anmelde-E-Mail des aktuellen Inhabers (workspaces.owner_user_id -> auth.users.email mit
 * email_confirmed_at). Nie eine frei bearbeitbare Profil-, Firmen- oder Kundenadresse, nie die Adresse der sendenden
 * Person, nie eine Adresse aus der Anfrage. Fehlt beides: reply_to_unavailable (fail-closed).
 */
create or replace function public.einrichtung01_resolve_reply_to(p_workspace_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_state public.workspace_reply_to_state;
  v_profile text := public.einrichtung01_profile_reply_to(p_workspace_id);
  v_email text;
begin
  select * into v_state from public.workspace_reply_to_state s where s.workspace_id = p_workspace_id;
  if v_state.workspace_id is not null and v_profile is not null
     and v_state.address = v_profile
     and v_state.confirmed_revision = v_state.revision
     and v_state.confirmed_address = v_state.address then
    return jsonb_build_object('ok', true, 'email', v_state.address, 'source', 'confirmed_reply_to');
  end if;
  select nullif(lower(btrim(u.email)), '') into v_email
    from public.workspaces w
    join auth.users u on u.id = w.owner_user_id
   where w.id = p_workspace_id and u.email_confirmed_at is not null;
  if v_email is null then
    return jsonb_build_object('ok', false, 'code', 'reply_to_unavailable');
  end if;
  return jsonb_build_object('ok', true, 'email', v_email, 'source', 'owner_login');
end;
$$;
revoke all on function public.einrichtung01_resolve_reply_to(uuid) from public, anon, authenticated, service_role;

-- Versandwege mit Dienstrolle (send-document, send-email): Schreibrecht der sendenden Person prueft die Function vorher.
create or replace function public.resolve_workspace_reply_to(p_workspace_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select public.einrichtung01_resolve_reply_to(p_workspace_id);
$$;

-- Einladungsmail (Token der einladenden Person): dieselbe Regel, nur fuer Inhaber und Admins des Einladungsbetriebs.
create or replace function public.resolve_workspace_reply_to_for_invitation(p_invitation_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_workspace uuid;
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet' using errcode = '42501';
  end if;
  select i.workspace_id into v_workspace from public.workspace_invitations i where i.id = p_invitation_id;
  if v_workspace is null then
    raise exception 'team_target_invalid: Einladung nicht gefunden' using errcode = '42501';
  end if;
  -- Zentrale Regel (Stufen 1-6, Vertrag 1.1) mit Schreibrolle: wie beim Einladen selbst.
  perform public.assert_workspace_write_access(v_workspace, true);
  return public.einrichtung01_resolve_reply_to(v_workspace);
end;
$$;

/*
 * Stand fuer die Seite „E-Mail-Absender und Vorlagen“ (Inhaber und Admins): Adresse, bestaetigt oder nicht, letzte
 * Bestaetigungsmail, fruehester neuer Versand, Rueckfall (maskierte Anmelde-E-Mail des Inhabers).
 */
create or replace function public.get_workspace_reply_to_status(p_workspace_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_state public.workspace_reply_to_state;
  v_profile text;
  v_last timestamptz;
  v_count integer;
  v_open boolean;
  v_resolved jsonb;
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet' using errcode = '42501';
  end if;
  -- Stufen 1-4 der zentralen Regel (Vertrag 1.1): Sitzung, Sperre, Freigabe; die Mitgliedschaft prueft die Rollenabfrage.
  if not public.workspace_session_active() then
    raise exception 'session_not_active: Die Sitzung ist beendet' using errcode = '42501';
  end if;
  if public.workspace_account_blocked(auth.uid()) then
    raise exception 'account_blocked: Konto ist gesperrt' using errcode = '42501';
  end if;
  if not public.workspace_account_approved(auth.uid()) then
    raise exception 'account_not_approved: Konto ist nicht freigegeben' using errcode = '42501';
  end if;
  -- Die Rolle zaehlt, nicht das Schreibrecht: Im Nur-Lesen-Betrieb sehen Inhaber und Admins den Stand weiter.
  if not exists (
    select 1 from public.workspace_members wm
     where wm.workspace_id = p_workspace_id and wm.user_id = auth.uid()
       and wm.status = 'active' and wm.role in ('owner', 'admin')
  ) then
    raise exception 'workspace_forbidden_role: Keine Schreibberechtigung' using errcode = '42501';
  end if;
  v_profile := public.einrichtung01_profile_reply_to(p_workspace_id);
  select * into v_state from public.workspace_reply_to_state s where s.workspace_id = p_workspace_id;
  select max(t.created_at), count(*) filter (where t.created_at > now() - interval '24 hours'),
         bool_or(t.superseded_at is null and t.confirmed_at is null and t.expires_at > now() and t.sent_at is not null)
    into v_last, v_count, v_open
    from public.workspace_reply_to_tokens t
   where t.workspace_id = p_workspace_id;
  v_resolved := public.einrichtung01_resolve_reply_to(p_workspace_id);
  return jsonb_build_object(
    'address', v_profile,
    'confirmed', coalesce(v_profile is not null and v_state.workspace_id is not null and v_state.address = v_profile
                 and v_state.confirmed_revision = v_state.revision and v_state.confirmed_address = v_state.address, false),
    'pending', coalesce(v_open, false),
    'last_sent_at', v_last,
    'can_resend_at', case when v_last is null then null else v_last + interval '10 minutes' end,
    'sends_today', coalesce(v_count, 0),
    'effective_source', v_resolved->>'source',
    'effective_masked', public.einrichtung01_mask_email(v_resolved->>'email'),
    'unavailable', coalesce((v_resolved->>'ok')::boolean, false) = false
  );
end;
$$;

revoke all on function public.reply_to_confirmation_issue(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.reply_to_confirmation_mark_sent(text, uuid) from public, anon, authenticated;
revoke all on function public.reply_to_confirmation_withdraw(text) from public, anon, authenticated;
revoke all on function public.reply_to_confirmation_confirm(text, text) from public, anon, authenticated;
revoke all on function public.resolve_workspace_reply_to(uuid) from public, anon, authenticated;
grant execute on function public.reply_to_confirmation_issue(uuid, uuid, text, text) to service_role;
grant execute on function public.reply_to_confirmation_mark_sent(text, uuid) to service_role;
grant execute on function public.reply_to_confirmation_withdraw(text) to service_role;
grant execute on function public.reply_to_confirmation_confirm(text, text) to service_role;
grant execute on function public.resolve_workspace_reply_to(uuid) to service_role;

revoke all on function public.resolve_workspace_reply_to_for_invitation(uuid) from public, anon;
revoke all on function public.get_workspace_reply_to_status(uuid) from public, anon;
grant execute on function public.resolve_workspace_reply_to_for_invitation(uuid) to authenticated;
grant execute on function public.get_workspace_reply_to_status(uuid) to authenticated;

/* ======================================================================== */
/* 3. Feldkatalog des Firmenprofils (Schema 3, introduced_in = 3)          */
/* ======================================================================== */

create or replace function public.upsert_workspace_sync_entity(
  p_workspace_id uuid,
  p_entity_type text,
  p_payload jsonb,
  p_row_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_version bigint;
  v_result jsonb;
  v_vorgang_id text;
  v_customer_id text;
  -- BRIEFE-01B: nur fuer den business_letter-Zweig.
  v_letter_id text;
  v_letter_customer_id text;
  v_letter_vorgang_id text;
  v_letter_status text;
  v_letter_payload jsonb;
  v_row_letter public.workspace_business_letters;
  -- ANGEBOT->AUFTRAG-02B: nur fuer den vorgang-Zweig.
  v_incoming_vorgang jsonb;
  v_key text;
  v_offer_result_vid text;
  -- EINGANG-01C-2: nur fuer den vorgang-Zweig.
  v_request_vorgang_number boolean;
  v_vorgang_number text;
  -- ANGEBOT-01B: nur fuer den offer-Zweig.
  v_offer_id text;
  v_offer_customer_id text;
  v_offer_status text;
  v_offer_payload jsonb;
  v_row_offer public.workspace_offers;
  v_offer_archive text;
  -- CLOUD-DURABILITY-01B: nur fuer den vorgang_note-Zweig.
  v_note_id text;
  v_note_vorgang_id text;
  v_note_payload jsonb;
  -- CLOUD-DURABILITY-01C: nur fuer den task-Zweig.
  v_task_id text;
  v_task_payload jsonb;
  v_task_status text;
  v_task_dedupe text;
  v_task_auto boolean;
  v_canonical public.workspace_tasks;
  -- SYNC-DURABILITY-HARDENING-01G: der gespeicherte Stand fuer den Version-0-Vertrag.
  v_row_vorgang public.workspace_vorgaenge;
  v_row_customer public.workspace_customers;
  v_row_note public.workspace_vorgang_notes;
  v_row_task public.workspace_tasks;
  v_incoming jsonb;
  -- CLOUD-DURABILITY-01D: nur fuer den dunning_documentation-Zweig.
  v_dun_id text;
  v_dun_invoice_id text;
  v_dun_vorgang_id text;
  v_dun_kind text;
  v_dun_documented_at date;
  v_dun_delivery text;
  v_dun_payload jsonb;
  v_dun_existing public.workspace_invoice_dunning_documentations;
  v_deleted boolean;
  -- BRANDING-01E-0 / FIRMENPROFIL-01B: nur fuer den company_profile-Zweig.
  v_existing_profile jsonb;
  v_incoming_profile jsonb;
  v_incoming_schema integer;
  v_field record;
  /* BANKABGLEICH-V1 BLOCK 2B: nur fuer die beiden Bank-Zweige. */
  v_bank_account_id text;
  v_bank_account_payload jsonb;
  v_bank_transaction_id text;
  v_bank_transaction_payload jsonb;
  v_row_bank_account public.workspace_bank_accounts;
  v_row_bank_transaction public.workspace_bank_transactions;
  /* CLOUD-SYNC S1: nur fuer den paper_register_entry-Zweig. */
  v_paper_entry_id text;
  v_paper_document_id text;
  v_paper_payload jsonb;
  v_row_paper public.workspace_paper_register_entries;
  /* CLOUD-SYNC S2: nur fuer den communication_event-Zweig. */
  v_comm_event_id text;
  v_comm_payload jsonb;
  v_comm_context jsonb;
  v_comm_context_type text;
  v_comm_event_type text;
  v_comm_event_at timestamptz;
  v_row_comm public.workspace_communication_events;
  /* CLOUD-SYNC S3: nur fuer den knowledge_fact-Zweig. */
  v_fact_id text;
  v_fact_payload jsonb;
  v_fact_scope text;
  v_row_fact public.workspace_knowledge_facts;
  /* CLOUD-SYNC S5: nur fuer den invoice_draft-Zweig. */
  v_draft_id text;
  v_draft_payload jsonb;
  v_draft_vorgang_id text;
  v_draft_type text;
  v_draft_slot_owner text;
  v_row_draft public.workspace_invoice_drafts;
  /* CLOUD-SYNC S6: nur fuer die Zweige order_draft und order_amendment_draft. */
  v_order_draft_id text;
  v_order_draft_payload jsonb;
  v_row_order_draft public.workspace_order_drafts;
  v_amend_draft_id text;
  v_amend_draft_vorgang_id text;
  v_amend_draft_payload jsonb;
  v_row_amend_draft public.workspace_order_amendment_drafts;
  v_amend_draft_vorgang public.workspace_vorgaenge;
begin
  /*
   * SYNC-DURABILITY-HARDENING-01G4 -- kein dritter Zustand.
   *
   * Alle folgenden Zweige vergleichen `p_row_version`. Waere der Wert `NULL`,
   * ergaebe jeder dieser Vergleiche `NULL` und damit nicht wahr -- die Zeile
   * wuerde ungeprueft ueberschrieben. Eine fehlende Angabe ist keine bestaetigte
   * Serverversion, also gilt sie hier als unbestaetigt.
   */
  p_row_version := coalesce(p_row_version, 0);

  if auth.uid() is null then
    raise exception 'Nicht angemeldet';
  end if;

  if not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  if p_entity_type = 'vorgang' then
    if not public.can_write_workspace(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_vorgang_id := coalesce(nullif(trim(p_payload->>'vorgang_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_vorgang_id is null then
      raise exception 'vorgang_id fehlt';
    end if;

    v_deleted := coalesce((p_payload->>'deleted')::boolean, false);
    -- EINGANG-01C-2: der Nummernwunsch zaehlt nur als ausdrueckliches JSON-true auf Push-Ebene.
    v_request_vorgang_number := coalesce(
      jsonb_typeof(p_payload->'request_vorgang_number') = 'boolean'
        and (p_payload->>'request_vorgang_number')::boolean,
      false
    );

    select v.* into v_row_vorgang
    from public.workspace_vorgaenge v
    where v.workspace_id = p_workspace_id and v.vorgang_id = v_vorgang_id
    for update;
    v_current_version := v_row_vorgang.row_version;

    /*
     * SYNC-DURABILITY-HARDENING-01G — Version 0 bei vorhandener Zeile.
     *
     * `p_row_version = 0` heisst ausschliesslich: Dieser Client hat **keine**
     * bestaetigte Serverversion. Bisher umging dieser Wert die Versionspruefung
     * vollstaendig und durfte deshalb eine neuere Fassung oder einen Grabstein
     * ueberschreiben. Zulaessig ist er jetzt nur noch in zwei Faellen: Es gibt
     * keine Zeile (CREATE), oder der Inhalt ist identisch — dann ist es die
     * Wiederholung eines Schreibvorgangs, dessen Bestaetigung verloren ging, und
     * die Zeile wird unveraendert zurueckgegeben.
     */
    if v_current_version is not null and p_row_version <= 0 then
      v_incoming := coalesce(p_payload->'payload', p_payload, '{}'::jsonb);
      -- 01G2 -- beide Seiten wollen dasselbe: geloescht.
      if v_row_vorgang.deleted and v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_vorgang_id,
          'row_version', v_row_vorgang.row_version,
          'payload', to_jsonb(v_row_vorgang),
          'deleted', true,
          'replayed', true
        );
      end if;
      if v_row_vorgang.deleted and not v_deleted then
        raise exception 'Versionskonflikt vorgang:%', v_current_version using errcode = 'P0001';
      end if;
      /*
       * EINGANG-01C-2 -- die Vorgangsnummer schreibt der Server selbst in den
       * Payload. Ein sonst identischer Replay ohne sie ist dieselbe Absicht;
       * eine abweichende mitgesendete Nummer ist dagegen kein Replay.
       */
      if (v_row_vorgang.payload - 'vorgangNumber') = (v_incoming - 'vorgangNumber' - 'request_vorgang_number')
         and (not (v_incoming ? 'vorgangNumber') or v_incoming->>'vorgangNumber' is not distinct from v_row_vorgang.vorgang_number)
         and v_row_vorgang.deleted = v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_vorgang_id,
          'row_version', v_row_vorgang.row_version,
          'payload', to_jsonb(v_row_vorgang),
          'deleted', v_row_vorgang.deleted,
          'replayed', true
        );
      end if;
      raise exception 'Versionskonflikt vorgang:%', v_current_version using errcode = 'P0001';
    end if;

    if v_current_version is null then
      -- ANGEBOT->AUFTRAG-02B: Auftragsherkunft und -nummer vergibt nur accept_workspace_offer.
      v_incoming_vorgang := coalesce(p_payload->'payload', p_payload, '{}'::jsonb);
      if (not v_deleted) and (v_incoming_vorgang ? 'sourceOfferId' or v_incoming_vorgang ? 'orderNumber') then
        raise exception 'Auftragsnummer und Herkunft nur ueber accept_workspace_offer oder create_workspace_order' using errcode = 'P0001';
      end if;

      -- EINGANG-01C-2: Eine Vorgangsnummer vergibt ausschliesslich der Server.
      if v_incoming_vorgang ? 'vorgangNumber' then
        raise exception 'Vorgangsnummer vergibt ausschliesslich der Server' using errcode = 'P0001';
      end if;
      v_incoming_vorgang := v_incoming_vorgang - 'request_vorgang_number';
      /*
       * Nur auf ausdruecklichen Wunsch und nie fuer einen Grabstein. Ein
       * Erst-Upload ohne Wunsch -- Altbestand, Provisioning -- bleibt ohne
       * Nummer: kein Backfill. Vergabe und Einfuegen teilen die Transaktion;
       * scheitert das Einfuegen, rollt auch der Zaehler zurueck.
       */
      v_vorgang_number := null;
      if v_request_vorgang_number and not v_deleted then
        v_vorgang_number := public.allocate_workspace_vorgang_number(p_workspace_id);
        v_incoming_vorgang := v_incoming_vorgang || jsonb_build_object('vorgangNumber', v_vorgang_number);
      end if;

      insert into public.workspace_vorgaenge (
        workspace_id,
        vorgang_id,
        payload,
        row_version,
        deleted,
        deleted_at,
        updated_by,
        vorgang_number
      )
      values (
        p_workspace_id,
        v_vorgang_id,
        v_incoming_vorgang,
        1,
        v_deleted,
        case when v_deleted then now() else null end,
        auth.uid(),
        v_vorgang_number
      )
      returning to_jsonb(public.workspace_vorgaenge.*) into v_result;
    else
      -- CREATE-RETRY-CONFLICT-02: `0` ist jetzt die Erwartung "Zeile fehlt".
      if p_row_version <> v_current_version then
        raise exception 'Versionskonflikt vorgang:%', v_current_version using errcode = 'P0001';
      end if;

      /*
       * ANGEBOT->AUFTRAG-02B / AUFTRAG-02C -- Serverwahrheit fuer Auftraege.
       *
       * Ohne Auftragsnummer: Der Payload darf weder Herkunft noch Nummer
       * tragen (die setzen nur accept_workspace_offer und
       * create_workspace_order). Mit Auftragsnummer -- aus Angebot oder
       * manuell -- gilt fuer beide dasselbe Regelwerk: Die
       * kaufmaennischen Snapshot-Felder sind write-once, und Herkunft, Nummer,
       * Datum werden aus den Spalten bzw. dem gespeicherten Payload erzwungen --
       * ein abweichender Client-Wert erreicht die Zeile nie.
       */
      v_incoming_vorgang := coalesce(p_payload->'payload', p_payload, v_row_vorgang.payload);
      if not v_deleted then
        -- AUFTRAG-02C: Die Frage ist "bestaetigter eigener Auftrag?", nicht "aus Angebot?".
        if v_row_vorgang.order_number is null then
          if v_incoming_vorgang ? 'sourceOfferId' or v_incoming_vorgang ? 'orderNumber' then
            raise exception 'Auftragsnummer und Herkunft nur ueber accept_workspace_offer oder create_workspace_order' using errcode = 'P0001';
          end if;
        else
          foreach v_key in array array['contractConfirmation', 'taxStatus', 'paymentTermsText', 'introText', 'closingText', 'contractTotals', 'customerId', 'customerBilling'] loop
            if v_row_vorgang.payload ? v_key and (v_row_vorgang.payload -> v_key) is distinct from (v_incoming_vorgang -> v_key) then
              raise exception 'Auftrag: % ist festgeschrieben', v_key using errcode = 'P0001';
            end if;
          end loop;
          -- Operativer Plan: nur Hauptsnapshot + bestaetigte Nachtraege (executedQuantity bleibt frei).
          perform public.assert_workspace_order_positions_frozen(
            p_workspace_id, v_vorgang_id, v_row_vorgang.payload->'contractConfirmation', v_incoming_vorgang->'orderPositions');
          if (v_incoming_vorgang ? 'sourceOfferId' and v_incoming_vorgang->>'sourceOfferId' is distinct from v_row_vorgang.source_offer_id)
             or (v_incoming_vorgang ? 'orderNumber' and v_incoming_vorgang->>'orderNumber' is distinct from v_row_vorgang.order_number) then
            raise exception 'Auftragsherkunft und Auftragsnummer koennen nicht geaendert werden' using errcode = 'P0001';
          end if;
          v_incoming_vorgang := v_incoming_vorgang || jsonb_strip_nulls(jsonb_build_object(
            'sourceOfferId', v_row_vorgang.source_offer_id,
            'orderNumber', v_row_vorgang.order_number,
            'sourceOfferNumber', v_row_vorgang.payload->'sourceOfferNumber',
            'orderDate', v_row_vorgang.payload->'orderDate'
          ));
        end if;

        /*
         * EINGANG-01C-2 -- unabhaengig vom Auftrag: Die Spalte ist die Wahrheit,
         * der Payload ihr Abbild. Ohne Nummer darf der Client keine setzen; mit
         * Nummer darf er sie weder aendern noch entfernen -- ein alter Stand
         * ohne Feld bekommt sie zurueckgeschrieben.
         */
        v_incoming_vorgang := v_incoming_vorgang - 'request_vorgang_number';
        if v_row_vorgang.vorgang_number is null then
          if v_incoming_vorgang ? 'vorgangNumber' then
            raise exception 'Vorgangsnummer vergibt ausschliesslich der Server' using errcode = 'P0001';
          end if;
        else
          if v_incoming_vorgang ? 'vorgangNumber'
             and v_incoming_vorgang->>'vorgangNumber' is distinct from v_row_vorgang.vorgang_number then
            raise exception 'Vorgangsnummer kann nicht geaendert werden' using errcode = 'P0001';
          end if;
          v_incoming_vorgang := v_incoming_vorgang || jsonb_build_object('vorgangNumber', v_row_vorgang.vorgang_number);
        end if;
      end if;

      update public.workspace_vorgaenge
      set
        payload = case when v_deleted then payload else v_incoming_vorgang end,
        deleted = v_deleted,
        deleted_at = case when v_deleted then coalesce(deleted_at, now()) else null end,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id and vorgang_id = v_vorgang_id
      returning to_jsonb(public.workspace_vorgaenge.*) into v_result;
    end if;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_vorgang_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result,
      'deleted', (v_result->>'deleted')::boolean
    );

  elsif p_entity_type = 'customer' then
    /*
     * PRODUCT-FOUNDATION-03A-S1 -- strukturgleich zum Vorgangs-Zweig.
     *
     * Der Server prueft Berechtigung und Sync-Struktur, NICHT die
     * Customer-Fachlogik. Eigenfirmen-Guard, Namensvergleich und
     * Dublettenerkennung bleiben ausschliesslich im Client: der Guard braucht
     * das lokale Firmenprofil, das serverseitig gar nicht auswertbar ist.
     *
     * `deleted`/`deleted_at` werden bereits nach dem Vorgangs-Protokoll
     * behandelt, obwohl es noch keine Loeschfunktion gibt. Kein Client erzeugt
     * in diesem Stand `deleted = true`; die Semantik steht aber bereit, ohne
     * dass spaeter eine zweite Migration dieselbe RPC erneut anfassen muss.
     */
    if not public.can_write_workspace(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_customer_id := coalesce(nullif(trim(p_payload->>'customer_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_customer_id is null then
      raise exception 'customer_id fehlt';
    end if;

    v_deleted := coalesce((p_payload->>'deleted')::boolean, false);

    select c.* into v_row_customer
    from public.workspace_customers c
    where c.workspace_id = p_workspace_id and c.customer_id = v_customer_id
    for update;
    v_current_version := v_row_customer.row_version;

    -- 01G — siehe Vorgangs-Zweig: Version 0 ueberschreibt keine vorhandene Zeile.
    if v_current_version is not null and p_row_version <= 0 then
      v_incoming := coalesce(p_payload->'payload', p_payload, '{}'::jsonb);
      -- 01G2 -- beide Seiten wollen dasselbe: geloescht.
      if v_row_customer.deleted and v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_customer_id,
          'row_version', v_row_customer.row_version,
          'payload', to_jsonb(v_row_customer),
          'deleted', true,
          'replayed', true
        );
      end if;
      if v_row_customer.deleted and not v_deleted then
        raise exception 'Versionskonflikt customer:%', v_current_version using errcode = 'P0001';
      end if;
      if v_row_customer.payload = v_incoming and v_row_customer.deleted = v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_customer_id,
          'row_version', v_row_customer.row_version,
          'payload', to_jsonb(v_row_customer),
          'deleted', v_row_customer.deleted,
          'replayed', true
        );
      end if;
      raise exception 'Versionskonflikt customer:%', v_current_version using errcode = 'P0001';
    end if;

    if v_current_version is null then
      insert into public.workspace_customers (
        workspace_id,
        customer_id,
        payload,
        row_version,
        deleted,
        deleted_at,
        updated_by
      )
      values (
        p_workspace_id,
        v_customer_id,
        coalesce(p_payload->'payload', p_payload, '{}'::jsonb),
        1,
        v_deleted,
        case when v_deleted then now() else null end,
        auth.uid()
      )
      returning to_jsonb(public.workspace_customers.*) into v_result;
    else
      -- CREATE-RETRY-CONFLICT-02: `0` ist jetzt die Erwartung "Zeile fehlt".
      if p_row_version <> v_current_version then
        raise exception 'Versionskonflikt customer:%', v_current_version using errcode = 'P0001';
      end if;

      update public.workspace_customers
      set
        payload = case when v_deleted then payload else coalesce(p_payload->'payload', p_payload, payload) end,
        deleted = v_deleted,
        deleted_at = case when v_deleted then coalesce(deleted_at, now()) else null end,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id and customer_id = v_customer_id
      returning to_jsonb(public.workspace_customers.*) into v_result;
    end if;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_customer_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result,
      'deleted', (v_result->>'deleted')::boolean
    );

  elsif p_entity_type = 'business_letter' then
    /*
     * BRIEFE-01B — ausgehendes Geschaeftsschreiben.
     *
     * Schreibrecht wie bei Notizen und Aufgaben: Ein Brief ist normale
     * Bueroarbeit, keine Eigentuemerhandlung. Der Versionsvertrag ist
     * unveraendert der aus 01G -- einschliesslich der Regel, dass eine
     * unbestaetigte Version (<= 0) nur anlegen oder eine inhaltsgleiche
     * Wiederholung sein darf.
     */
    if not public.workspace_user_can_intake(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_letter_id := coalesce(nullif(trim(p_payload->>'letter_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_letter_id is null then
      raise exception 'letter_id fehlt';
    end if;

    v_letter_payload := coalesce(p_payload->'payload', '{}'::jsonb);
    v_letter_customer_id := nullif(trim(coalesce(p_payload->>'customer_id', v_letter_payload->>'customerId')), '');
    v_letter_vorgang_id := nullif(trim(coalesce(p_payload->>'vorgang_id', v_letter_payload->>'vorgangId')), '');
    v_letter_status := coalesce(nullif(trim(p_payload->>'status'), ''), nullif(trim(v_letter_payload->>'status'), ''), 'draft');
    v_deleted := coalesce((p_payload->>'deleted')::boolean, false);

    if v_letter_status not in ('draft', 'finalized') then
      raise exception 'Brief ungueltig: status' using errcode = 'P0001';
    end if;

    if not v_deleted then
      if jsonb_typeof(v_letter_payload->'subject') <> 'string' or length(trim(v_letter_payload->>'subject')) = 0 then
        raise exception 'Brief ungueltig: subject' using errcode = 'P0001';
      end if;
      if length(v_letter_payload->>'subject') > 300 then
        raise exception 'Brief ungueltig: subject zu lang' using errcode = 'P0001';
      end if;
      if jsonb_typeof(v_letter_payload->'body') <> 'string' or length(trim(v_letter_payload->>'body')) = 0 then
        raise exception 'Brief ungueltig: body' using errcode = 'P0001';
      end if;
      if length(v_letter_payload->>'body') > 50000 then
        raise exception 'Brief ungueltig: body zu lang' using errcode = 'P0001';
      end if;
    end if;

    select l.* into v_row_letter
    from public.workspace_business_letters l
    where l.workspace_id = p_workspace_id and l.client_letter_id = v_letter_id
    for update;
    v_current_version := v_row_letter.row_version;

    /*
     * SYNC-DURABILITY-HARDENING-01G — unbestaetigte Version bei vorhandener
     * Zeile. Wortgleich zu den uebrigen Zweigen: Anlegen ist erlaubt, eine
     * inhaltsgleiche Wiederholung wird unveraendert zurueckgegeben, alles
     * andere ist ein Konflikt.
     */
    if v_current_version is not null and p_row_version <= 0 then
      v_incoming := coalesce(p_payload->'payload', p_payload, '{}'::jsonb);

      if v_deleted and v_row_letter.deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_letter_id,
          'row_version', v_row_letter.row_version,
          'payload', v_row_letter.payload,
          'deleted', v_row_letter.deleted,
          'replayed', true
        );
      end if;

      if (not v_deleted) and (not v_row_letter.deleted) and v_row_letter.payload = v_incoming then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_letter_id,
          'row_version', v_row_letter.row_version,
          'payload', v_row_letter.payload,
          'deleted', v_row_letter.deleted,
          'replayed', true
        );
      end if;

      raise exception 'Versionskonflikt business_letter:%', v_current_version using errcode = 'P0001';
    end if;

    if v_current_version is null then
      insert into public.workspace_business_letters (
        workspace_id,
        client_letter_id,
        client_customer_id,
        client_vorgang_id,
        status,
        payload,
        row_version,
        deleted,
        deleted_at,
        created_by,
        updated_by
      )
      values (
        p_workspace_id,
        v_letter_id,
        v_letter_customer_id,
        v_letter_vorgang_id,
        v_letter_status,
        case when v_deleted then '{}'::jsonb else v_letter_payload end,
        1,
        v_deleted,
        case when v_deleted then now() else null end,
        auth.uid(),
        auth.uid()
      )
      returning to_jsonb(public.workspace_business_letters.*) into v_result;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt business_letter:%', v_current_version using errcode = 'P0001';
      end if;

      /*
       * BRIEFE-01B -- ein fertiggestellter Brief ist ein Beleg.
       *
       * Die Unveraenderlichkeit darf nicht am Client haengen: Wer den Aufruf
       * nachbaut, koennte sonst Betreff, Text, Datum, Empfaenger oder den
       * eingefrorenen Absender-Schnappschuss nachtraeglich umschreiben -- und
       * das Dokument hiesse morgen etwas anderes als das, was der Empfaenger
       * bekommen hat. Deshalb steht der Guard hier, nicht nur im Fachdienst.
       *
       * Erlaubt bleiben ausdruecklich:
       *   * der Uebergang draft -> finalized (die Zeile ist dann noch draft),
       *   * die wortgleiche Wiederholung eines Schreibvorgangs, dessen
       *     Bestaetigung verloren ging -- sie aendert nichts,
       *   * der Grabstein: Loeschen ist kein Umschreiben, und der Loeschweg
       *     muss dem uebrigen Sync-Vertrag folgen.
       *
       * `documentId` bleibt vom Vergleich ausgenommen: Es benennt die spaeter
       * erzeugte Archivdatei, gehoert aber nicht zum fachlichen Inhalt des
       * Schreibens.
       */
      if v_row_letter.status = 'finalized' and not v_row_letter.deleted and not v_deleted then
        if v_letter_status <> 'finalized' then
          raise exception 'Brief ist fertiggestellt und kann nicht zurueckgesetzt werden'
            using errcode = 'P0001';
        end if;
        if (v_row_letter.payload - 'documentId') is distinct from (v_letter_payload - 'documentId') then
          raise exception 'Brief ist fertiggestellt und kann nicht mehr geaendert werden'
            using errcode = 'P0001';
        end if;
      end if;

      /*
       * Grabstein: Der Fachinhalt bleibt stehen, ebenso die Bezuege zu Kunde
       * und Auftrag -- sie sind die Ordnung, ueber die ein zweites Geraet den
       * Grabstein zuordnet.
       */
      update public.workspace_business_letters
      set
        payload = case when v_deleted then payload else coalesce(v_letter_payload, payload) end,
        client_customer_id = coalesce(v_letter_customer_id, client_customer_id),
        client_vorgang_id = coalesce(v_letter_vorgang_id, client_vorgang_id),
        status = case when v_deleted then status else v_letter_status end,
        deleted = v_deleted,
        deleted_at = case when v_deleted then coalesce(deleted_at, now()) else null end,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id and client_letter_id = v_letter_id
      returning to_jsonb(public.workspace_business_letters.*) into v_result;
    end if;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_letter_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result->'payload',
      'deleted', (v_result->>'deleted')::boolean
    );

  elsif p_entity_type = 'offer' then
    /*
     * ANGEBOT-01B -- eigenes Angebot.
     *
     * Schreibrecht wie bei Briefen: normale Bueroarbeit, `workspace_user_can_intake`.
     * Versionsvertrag unveraendert aus 01G. Zusaetzlich:
     *   * Die Freigabe (Entwurf -> Nummer) laeuft NICHT hier, sondern nur ueber
     *     `finalize_workspace_offer`. Ein Client, der einen Entwurf mit einem
     *     anderen Status oder einer Nummer schreibt, wird abgewiesen.
     *   * Ein freigegebenes Angebot ist ein Beleg: Der eingefrorene Inhalt darf
     *     sich nicht aendern. Erlaubt sind nur die Zustandsfelder (status,
     *     sentAt, decidedAt, archiveDocumentId, resultingVorgangId, updatedAt)
     *     -- und nur entlang der erlaubten Uebergaenge.
     */
    if not public.workspace_user_can_intake(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_offer_id := coalesce(nullif(trim(p_payload->>'offer_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_offer_id is null then
      raise exception 'offer_id fehlt';
    end if;

    v_offer_payload := coalesce(p_payload->'payload', '{}'::jsonb);
    v_offer_customer_id := nullif(trim(coalesce(p_payload->>'customer_id', v_offer_payload->>'customerId')), '');
    v_offer_status := coalesce(nullif(trim(p_payload->>'status'), ''), nullif(trim(v_offer_payload->>'status'), ''), 'entwurf');
    v_deleted := coalesce((p_payload->>'deleted')::boolean, false);

    if v_offer_status not in ('entwurf', 'freigegeben', 'versendet', 'angenommen', 'abgelehnt', 'storniert', 'ersetzt') then
      raise exception 'Angebot ungueltig: status' using errcode = 'P0001';
    end if;

    select o.* into v_row_offer
    from public.workspace_offers o
    where o.workspace_id = p_workspace_id and o.client_offer_id = v_offer_id
    for update;
    v_current_version := v_row_offer.row_version;

    if v_current_version is not null and p_row_version <= 0 then
      v_incoming := coalesce(p_payload->'payload', p_payload, '{}'::jsonb);

      if v_deleted and v_row_offer.deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_offer_id,
          'row_version', v_row_offer.row_version,
          'payload', v_row_offer.payload,
          'deleted', v_row_offer.deleted,
          'replayed', true
        );
      end if;

      if (not v_deleted) and (not v_row_offer.deleted) and v_row_offer.payload = v_incoming then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_offer_id,
          'row_version', v_row_offer.row_version,
          'payload', v_row_offer.payload,
          'deleted', v_row_offer.deleted,
          'replayed', true
        );
      end if;

      raise exception 'Versionskonflikt offer:%', v_current_version using errcode = 'P0001';
    end if;

    if v_current_version is null then
      -- Neu anlegen darf nur ein Entwurf ohne Nummer: Nummern vergibt die Freigabe.
      if (not v_deleted) and (v_offer_status <> 'entwurf' or v_offer_payload ? 'offerNumber') then
        raise exception 'Freigabe nur ueber finalize_workspace_offer' using errcode = 'P0001';
      end if;

      insert into public.workspace_offers (
        workspace_id,
        client_offer_id,
        client_customer_id,
        status,
        payload,
        row_version,
        deleted,
        deleted_at,
        created_by,
        updated_by
      )
      values (
        p_workspace_id,
        v_offer_id,
        v_offer_customer_id,
        case when v_deleted then 'entwurf' else v_offer_status end,
        case when v_deleted then '{}'::jsonb else v_offer_payload end,
        1,
        v_deleted,
        case when v_deleted then now() else null end,
        auth.uid(),
        auth.uid()
      )
      returning to_jsonb(public.workspace_offers.*) into v_result;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt offer:%', v_current_version using errcode = 'P0001';
      end if;

      if (not v_deleted) and (not v_row_offer.deleted) then
        if v_row_offer.status = 'entwurf' then
          -- Ein Entwurf bleibt Entwurf: Freigabe und Nummer nur ueber die RPC.
          if v_offer_status <> 'entwurf' or v_offer_payload ? 'offerNumber' then
            raise exception 'Freigabe nur ueber finalize_workspace_offer' using errcode = 'P0001';
          end if;
        else
          -- Beleg: nur Zustandsfelder duerfen sich aendern, und nur vorwaerts.
          if (v_row_offer.payload - 'status' - 'sentAt' - 'decidedAt' - 'archiveDocumentId' - 'resultingVorgangId' - 'updatedAt')
             is distinct from
             (v_offer_payload - 'status' - 'sentAt' - 'decidedAt' - 'archiveDocumentId' - 'resultingVorgangId' - 'updatedAt') then
            raise exception 'Angebot ist freigegeben und kann nicht mehr geaendert werden' using errcode = 'P0001';
          end if;
          if v_offer_status <> v_row_offer.status then
            -- ANGEBOT->AUFTRAG-02B: Annahme nur atomar mit dem Auftrag.
            if v_offer_status = 'angenommen' then
              raise exception 'Annahme nur ueber accept_workspace_offer' using errcode = 'P0001';
            end if;
            if not (
              (v_row_offer.status = 'freigegeben' and v_offer_status in ('versendet', 'abgelehnt', 'storniert', 'ersetzt'))
              or (v_row_offer.status = 'versendet' and v_offer_status in ('abgelehnt', 'storniert', 'ersetzt'))
            ) then
              raise exception 'Statuswechsel % -> % ist nicht erlaubt', v_row_offer.status, v_offer_status using errcode = 'P0001';
            end if;
          end if;
          -- ANGEBOT->AUFTRAG-02B: resultingVorgangId ist Serverwahrheit (write-once, nur ueber die RPC).
          v_offer_result_vid := nullif(trim(coalesce(v_offer_payload->>'resultingVorgangId', '')), '');
          if v_offer_result_vid is distinct from nullif(trim(coalesce(v_row_offer.payload->>'resultingVorgangId', '')), '') then
            raise exception 'Auftragsbezug eines Angebots nur ueber accept_workspace_offer' using errcode = 'P0001';
          end if;
          -- Die Serverwahrheit ueber Nummer und Fingerabdruck bleibt, was sie ist.
          v_offer_payload := v_offer_payload || jsonb_build_object(
            'offerNumber', v_row_offer.offer_number,
            'offerSequenceNumber', v_row_offer.offer_sequence_number,
            'contentFingerprint', v_row_offer.content_fingerprint
          );
        end if;
      end if;

      /*
       * ANGEBOT-01B (Pre-Acceptance) -- Archiv-Invariante, serverseitig.
       * Die Ablage ist write-once und darf nur auf ein Dokument desselben
       * Workspaces zeigen, das als eigenes Angebot (classifiedKind = angebot)
       * genau dieses Angebot referenziert (linkedOfferId). Ein Entwurf hat
       * keine Ablage; ein Fremddokument oder das Dokument eines anderen
       * Angebots wird abgewiesen.
       */
      if not v_deleted then
        v_offer_archive := nullif(trim(coalesce(v_offer_payload->>'archiveDocumentId', '')), '');
        if v_offer_archive is distinct from nullif(trim(coalesce(v_row_offer.payload->>'archiveDocumentId', '')), '') then
          if v_row_offer.status = 'entwurf' then
            raise exception 'Ein Entwurf hat keine Archivablage' using errcode = 'P0001';
          end if;
          if nullif(trim(coalesce(v_row_offer.payload->>'archiveDocumentId', '')), '') is not null then
            raise exception 'Archivdokument eines Angebots kann nicht gewechselt werden' using errcode = 'P0001';
          end if;
          if v_offer_archive is not null and not exists (
            select 1 from public.workspace_documents d
            where d.workspace_id = p_workspace_id
              and d.client_document_id = v_offer_archive
              and d.deleted = false
              and d.payload->>'classifiedKind' = 'angebot'
              and d.payload->>'linkedOfferId' = v_offer_id
          ) then
            raise exception 'Archivdokument gehoert nicht zu diesem Angebot' using errcode = 'P0001';
          end if;
          if v_offer_archive is not null and exists (
            select 1 from public.workspace_offers o2
            where o2.workspace_id = p_workspace_id
              and o2.client_offer_id <> v_offer_id
              and o2.payload->>'archiveDocumentId' = v_offer_archive
          ) then
            raise exception 'Archivdokument ist bereits einem anderen Angebot zugeordnet' using errcode = 'P0001';
          end if;
        end if;
      end if;

      -- Loeschen: nur Entwuerfe. Ein Beleg wird storniert, nicht entfernt.
      if v_deleted and v_row_offer.status <> 'entwurf' then
        raise exception 'Ein freigegebenes Angebot kann nicht geloescht werden' using errcode = 'P0001';
      end if;

      update public.workspace_offers
      set
        payload = case when v_deleted then payload else coalesce(v_offer_payload, payload) end,
        client_customer_id = coalesce(v_offer_customer_id, client_customer_id),
        status = case when v_deleted then status else v_offer_status end,
        deleted = v_deleted,
        deleted_at = case when v_deleted then coalesce(deleted_at, now()) else null end,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id and client_offer_id = v_offer_id
      returning to_jsonb(public.workspace_offers.*) into v_result;
    end if;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_offer_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result->'payload',
      'deleted', (v_result->>'deleted')::boolean
    );

  elsif p_entity_type = 'vorgang_note' then
    /*
     * CLOUD-DURABILITY-CORE-01B -- Vorgangsnotizen.
     *
     * Berechtigung bewusst NICHT `can_write_workspace` (Inhaber/Admin):
     * Die Notiz entsteht heute in `VorgangDetailPage` ueber `addVorgangNote`
     * ohne jede Rollenpruefung -- jedes aktive Mitglied darf sie lokal
     * schreiben. `can_write_workspace` wuerde genau diese Mitglieder beim
     * ersten Push aussperren und ihre Notizen dauerhaft in der Outbox
     * haengen lassen. Verwendet wird deshalb die vorhandene Funktion
     * `workspace_user_can_intake` -- dieselbe Berechtigung, die schon fuer
     * Eingang und Dokumente den Satz "aktives Mitglied" ausdrueckt.
     *
     * SELECT: jedes aktive Mitglied (`is_active_workspace_member`, Policy
     * unten) -- lokal sieht jedes Mitglied alle Notizen eines Vorgangs, die
     * Cloud darf daran nichts verengen.
     * INSERT/UPDATE/TOMBSTONE: jedes aktive Mitglied
     * (`workspace_user_can_intake`), ausschliesslich ueber diese
     * Security-Definer-RPC.
     *
     * Serverseitig wird nur die Sync-Struktur geprueft, keine Fachlogik:
     * Notiz-ID, Vorgangsbezug und ein Textkoerper in vertretbarer Laenge.
     */
    if not public.workspace_user_can_intake(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_note_id := coalesce(nullif(trim(p_payload->>'note_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_note_id is null then
      raise exception 'note_id fehlt';
    end if;

    v_note_payload := coalesce(p_payload->'payload', '{}'::jsonb);
    v_note_vorgang_id := coalesce(
      nullif(trim(p_payload->>'vorgang_id'), ''),
      nullif(trim(v_note_payload->>'vorgangId'), '')
    );
    v_deleted := coalesce((p_payload->>'deleted')::boolean, false);

    -- Guard: der Vorgangsbezug ist die Ordnung dieser Tabelle und darf nur am
    -- Grabstein fehlen -- dort wird kein Fachinhalt mitgeschickt.
    if v_note_vorgang_id is null and not v_deleted then
      raise exception 'vorgang_id fehlt';
    end if;

    if not v_deleted then
      if jsonb_typeof(v_note_payload->'body') <> 'string' or length(trim(v_note_payload->>'body')) = 0 then
        raise exception 'Notiz ungueltig: body' using errcode = 'P0001';
      end if;
      if length(v_note_payload->>'body') > 20000 then
        raise exception 'Notiz ungueltig: body zu lang' using errcode = 'P0001';
      end if;
    end if;

    select n.* into v_row_note
    from public.workspace_vorgang_notes n
    where n.workspace_id = p_workspace_id and n.client_note_id = v_note_id
    for update;
    v_current_version := v_row_note.row_version;

    /*
     * 01G — Version 0 gegen eine vorhandene Notiz.
     *
     * Der Grabsteinfall ist hier der wichtigste: Eine geloeschte Notiz durfte
     * bisher von einem unbestaetigten Schreibvorgang wiederbelebt werden. Jetzt
     * gilt auch fuer sie: identischer Inhalt = Wiederholung, alles andere =
     * Konflikt.
     */
    if v_current_version is not null and p_row_version <= 0 then
      if v_row_note.deleted and not v_deleted then
        raise exception 'Versionskonflikt vorgang_note:%', v_current_version using errcode = 'P0001';
      end if;
      /*
       * 01G2 -- derselbe Loeschvorgang, im Produkt beobachtet.
       *
       * Wird eine nie bestaetigte Notiz geloescht und geht die Antwort
       * verloren, schickt der Wiederanlauf den **vollen** Fachinhalt mit
       * `deleted = true`; die Serverzeile traegt aber `payload = {}`, weil ein
       * Grabstein beim Einfuegen keinen Inhalt speichert. Ein reiner
       * Inhaltsvergleich hielt das faelschlich fuer einen Konflikt -- der
       * Sendeauftrag blieb dauerhaft blockiert (im Browser reproduziert).
       *
       * Beide Seiten wollen dasselbe: geloescht. Das ist ein sicherer Replay.
       */
      if v_row_note.deleted and v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_note_id,
          'row_version', v_row_note.row_version,
          'payload', to_jsonb(v_row_note),
          'deleted', true,
          'replayed', true
        );
      end if;
      if v_row_note.payload = v_note_payload and v_row_note.deleted = v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_note_id,
          'row_version', v_row_note.row_version,
          'payload', to_jsonb(v_row_note),
          'deleted', v_row_note.deleted,
          'replayed', true
        );
      end if;
      raise exception 'Versionskonflikt vorgang_note:%', v_current_version using errcode = 'P0001';
    end if;

    if v_current_version is null then
      insert into public.workspace_vorgang_notes (
        workspace_id,
        client_note_id,
        client_vorgang_id,
        payload,
        row_version,
        deleted,
        deleted_at,
        created_by,
        updated_by
      )
      values (
        p_workspace_id,
        v_note_id,
        v_note_vorgang_id,
        case when v_deleted then '{}'::jsonb else v_note_payload end,
        1,
        v_deleted,
        case when v_deleted then now() else null end,
        auth.uid(),
        auth.uid()
      )
      returning to_jsonb(public.workspace_vorgang_notes.*) into v_result;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt vorgang_note:%', v_current_version using errcode = 'P0001';
      end if;

      /*
       * Grabstein: der Fachinhalt bleibt unveraendert stehen (wie im
       * Vorgangs-Zweig), der Vorgangsbezug ebenso -- er ist die einzige
       * Ordnung, ueber die ein zweites Geraet den Grabstein zuordnet.
       */
      update public.workspace_vorgang_notes
      set
        payload = case when v_deleted then payload else coalesce(v_note_payload, payload) end,
        client_vorgang_id = coalesce(v_note_vorgang_id, client_vorgang_id),
        deleted = v_deleted,
        deleted_at = case when v_deleted then coalesce(deleted_at, now()) else null end,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id and client_note_id = v_note_id
      returning to_jsonb(public.workspace_vorgang_notes.*) into v_result;
    end if;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_note_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result,
      'deleted', (v_result->>'deleted')::boolean
    );

  elsif p_entity_type = 'task' then
    /*
     * CLOUD-DURABILITY-CORE-01C -- Aufgaben.
     *
     * Berechtigung wie bei den Vorgangsnotizen und aus demselben Grund:
     * Aufgaben entstehen heute ohne jede Rollenpruefung -- die Engine legt sie
     * beim blossen Oeffnen der Aufgabenseite an, und jedes aktive Mitglied darf
     * sie erledigen. `can_write_workspace` (Inhaber/Admin) wuerde genau diese
     * Mitglieder aussperren und ihre Aufgaben dauerhaft in der Outbox halten.
     *
     * SELECT: jedes aktive Mitglied (Policy unten).
     * CREATE/UPDATE/Statuswechsel/TOMBSTONE: jedes aktive Mitglied
     * (`workspace_user_can_intake`), ausschliesslich ueber diese RPC.
     */
    if not public.workspace_user_can_intake(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_task_id := coalesce(nullif(trim(p_payload->>'task_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_task_id is null then
      raise exception 'task_id fehlt';
    end if;

    v_task_payload := coalesce(p_payload->'payload', '{}'::jsonb);
    v_deleted := coalesce((p_payload->>'deleted')::boolean, false);
    v_task_status := coalesce(nullif(trim(p_payload->>'status'), ''), nullif(trim(v_task_payload->>'status'), ''), 'open');
    v_task_dedupe := coalesce(p_payload->>'dedupe_key', '');
    v_task_auto := coalesce((p_payload->>'auto_created')::boolean, false);

    -- Guards: nur Sync-Struktur, keine Fachlogik.
    if v_task_status not in ('open', 'in_progress', 'done', 'archived') then
      raise exception 'Aufgabe ungueltig: status' using errcode = 'P0001';
    end if;
    if not v_deleted then
      if jsonb_typeof(v_task_payload->'title') <> 'string' or length(trim(v_task_payload->>'title')) = 0 then
        raise exception 'Aufgabe ungueltig: title' using errcode = 'P0001';
      end if;
      if length(v_task_payload->>'title') > 500 then
        raise exception 'Aufgabe ungueltig: title zu lang' using errcode = 'P0001';
      end if;
    end if;

    /*
     * Idempotenz fuer konkurrierende automatische Aufgaben.
     *
     * Zwei Geraete, die offline dieselbe automatische Aufgabe erzeugen, senden
     * zwei verschiedene `client_task_id` mit demselben `dedupe_key`. Der zweite
     * Push darf weder eine zweite Zeile anlegen noch an der Eindeutigkeit
     * sterben: Er ist fachlich ein Replay. Der Server gibt dann die bereits
     * vorhandene kanonische Zeile zurueck und markiert die Antwort mit
     * `deduped`; der Client uebernimmt sie und verwirft seine eigene Kennung.
     *
     * Die Pruefung gilt fuer jeden Write, der in einer aktiven automatischen
     * Aufgabe endet -- auch fuer ein Wiederoeffnen, das sonst am Index
     * scheitern wuerde. Manuelle Aufgaben (`auto_created = false`) und Aufgaben
     * ohne Dedupe-Identitaet (leerer Schluessel) sind ausgenommen.
     */
    if v_task_auto and v_task_dedupe <> '' and not v_deleted and v_task_status in ('open', 'in_progress') then
      select t.* into v_canonical
      from public.workspace_tasks t
      where t.workspace_id = p_workspace_id
        and t.dedupe_key = v_task_dedupe
        and t.auto_created
        and not t.deleted
        and t.status in ('open', 'in_progress')
        and t.client_task_id <> v_task_id
      order by t.created_at, t.client_task_id
      limit 1
      for update;

      if found then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_canonical.client_task_id,
          'requested_entity_id', v_task_id,
          'row_version', v_canonical.row_version,
          'payload', to_jsonb(v_canonical),
          'deleted', false,
          -- Zusatzfeld, rueckwaertskompatibel: aeltere Clients lesen es nicht.
          'deduped', true
        );
      end if;
    end if;

    select t.* into v_row_task
    from public.workspace_tasks t
    where t.workspace_id = p_workspace_id and t.client_task_id = v_task_id
    for update;
    v_current_version := v_row_task.row_version;

    /*
     * 01G — Version 0 gegen eine vorhandene Aufgabe. Der Dedupe-Zweig oben ist
     * davon unberuehrt: Er beantwortet den fachlichen Wiederholungsfall zweier
     * Geraete und kommt vor dieser Pruefung.
     */
    if v_current_version is not null and p_row_version <= 0 then
      if v_row_task.deleted and not v_deleted then
        raise exception 'Versionskonflikt task:%', v_current_version using errcode = 'P0001';
      end if;
      -- 01G2 -- derselbe Loeschvorgang, siehe Notiz-Zweig.
      if v_row_task.deleted and v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_task_id,
          'row_version', v_row_task.row_version,
          'payload', to_jsonb(v_row_task),
          'deleted', true,
          'replayed', true
        );
      end if;
      if v_row_task.payload = v_task_payload
         and v_row_task.deleted = v_deleted
         and v_row_task.status = v_task_status then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_task_id,
          'row_version', v_row_task.row_version,
          'payload', to_jsonb(v_row_task),
          'deleted', v_row_task.deleted,
          'replayed', true
        );
      end if;
      raise exception 'Versionskonflikt task:%', v_current_version using errcode = 'P0001';
    end if;

    if v_current_version is null then
      insert into public.workspace_tasks (
        workspace_id,
        client_task_id,
        status,
        dedupe_key,
        auto_created,
        payload,
        row_version,
        deleted,
        deleted_at,
        created_by,
        updated_by
      )
      values (
        p_workspace_id,
        v_task_id,
        v_task_status,
        v_task_dedupe,
        v_task_auto,
        case when v_deleted then '{}'::jsonb else v_task_payload end,
        1,
        v_deleted,
        case when v_deleted then now() else null end,
        auth.uid(),
        auth.uid()
      )
      returning to_jsonb(public.workspace_tasks.*) into v_result;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt task:%', v_current_version using errcode = 'P0001';
      end if;

      update public.workspace_tasks
      set
        payload = case when v_deleted then payload else coalesce(v_task_payload, payload) end,
        status = v_task_status,
        dedupe_key = v_task_dedupe,
        auto_created = v_task_auto,
        deleted = v_deleted,
        deleted_at = case when v_deleted then coalesce(deleted_at, now()) else null end,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id and client_task_id = v_task_id
      returning to_jsonb(public.workspace_tasks.*) into v_result;
    end if;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_task_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result,
      'deleted', (v_result->>'deleted')::boolean
    );

  elsif p_entity_type = 'dunning_documentation' then
    /*
     * CLOUD-DURABILITY-CORE-01D -- Nachweis einer uebergebenen
     * Zahlungserinnerung oder Mahnung.
     *
     * Berechtigung wie bei Notizen und Aufgaben und aus demselben Grund: Das
     * Produkt kennt fuer das Dokumentieren keinerlei Rollenpruefung -- weder in
     * `DunningDocumentationPanel` noch in `dunningDocumentationService`. Jedes
     * aktive Mitglied darf es heute, und `can_write_workspace` (Inhaber/Admin)
     * wuerde genau diese Mitglieder beim ersten Push aussperren.
     *
     * SELECT: jedes aktive Mitglied (Policy unten).
     * CREATE und Wiederholung: jedes aktive Mitglied
     * (`workspace_user_can_intake`), ausschliesslich ueber diese RPC.
     *
     * **Append-only.** Es gibt kein Bearbeiten und kein Loeschen; entsprechend
     * kennt dieser Zweig keinen Update-Pfad und die Tabelle keine
     * Grabsteinspalten. Ein erneuter Push derselben Kennung ist ein Replay und
     * gibt die vorhandene Zeile unveraendert zurueck -- der Nachweis bleibt
     * genau so stehen, wie er festgehalten wurde.
     */
    if not public.workspace_user_can_intake(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_dun_id := coalesce(nullif(trim(p_payload->>'documentation_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_dun_id is null then
      raise exception 'documentation_id fehlt';
    end if;

    v_dun_payload := coalesce(p_payload->'payload', '{}'::jsonb);
    v_dun_invoice_id := coalesce(nullif(trim(p_payload->>'invoice_id'), ''), nullif(trim(v_dun_payload->>'invoiceId'), ''));
    v_dun_vorgang_id := nullif(trim(coalesce(p_payload->>'vorgang_id', v_dun_payload->>'vorgangId', '')), '');
    v_dun_kind := coalesce(nullif(trim(p_payload->>'kind'), ''), nullif(trim(v_dun_payload->>'kind'), ''));
    v_dun_delivery := coalesce(nullif(trim(p_payload->>'delivery_method'), ''), nullif(trim(v_dun_payload->>'deliveryMethod'), ''));

    -- Guards: nur Sync-Struktur und die Identitaetsfelder, keine Fachlogik.
    if v_dun_invoice_id is null then
      raise exception 'invoice_id fehlt';
    end if;
    if v_dun_kind is null or v_dun_kind not in ('payment_reminder', 'dunning_notice') then
      raise exception 'Mahnnachweis ungueltig: kind' using errcode = 'P0001';
    end if;
    if v_dun_delivery is null then
      raise exception 'Mahnnachweis ungueltig: delivery_method' using errcode = 'P0001';
    end if;
    begin
      v_dun_documented_at := (coalesce(nullif(trim(p_payload->>'documented_at'), ''), v_dun_payload->>'documentedAt'))::date;
    exception when others then
      raise exception 'Mahnnachweis ungueltig: documented_at' using errcode = 'P0001';
    end;
    if v_dun_documented_at is null then
      raise exception 'Mahnnachweis ungueltig: documented_at' using errcode = 'P0001';
    end if;

    /*
     * Wiederholung derselben Kennung: unveraendert zurueckgeben.
     *
     * Ein Nachweis wird nicht fortgeschrieben. Ein zweiter Push entsteht durch
     * einen wiederholten Sendeversuch oder einen Backfill, nicht durch eine
     * Aenderung -- und darf den festgehaltenen Inhalt niemals ueberschreiben.
     */
    select d.* into v_dun_existing
    from public.workspace_invoice_dunning_documentations d
    where d.workspace_id = p_workspace_id and d.client_documentation_id = v_dun_id
    for update;

    if found then
      return jsonb_build_object(
        'entity_type', p_entity_type,
        'entity_id', v_dun_existing.client_documentation_id,
        'row_version', v_dun_existing.row_version,
        'payload', to_jsonb(v_dun_existing),
        'deleted', false
      );
    end if;

    /*
     * Fachliche Identitaet aus dem Produkt: `documentDunningDelivery` weist
     * eine zweite Bestaetigung derselben Uebergabe ab -- gleiche Rechnung,
     * gleicher Auftragsbezug, gleiche Art, gleiches Datum, gleicher Weg -- und
     * meldet `alreadyDocumented`. Zwei Geraete, die offline dasselbe
     * festhalten, senden zwei Kennungen fuer denselben Vorgang; der zweite
     * Push ist deshalb ein fachliches Replay und bekommt die vorhandene Zeile
     * zurueck. Die Notiz gehoert bewusst nicht zur Identitaet -- lokal war sie
     * es nie.
     */
    select d.* into v_dun_existing
    from public.workspace_invoice_dunning_documentations d
    where d.workspace_id = p_workspace_id
      and d.client_invoice_id = v_dun_invoice_id
      and coalesce(d.client_vorgang_id, '') = coalesce(v_dun_vorgang_id, '')
      and d.kind = v_dun_kind
      and d.documented_at = v_dun_documented_at
      and d.delivery_method = v_dun_delivery
    order by d.created_at, d.client_documentation_id
    limit 1
    for update;

    if found then
      return jsonb_build_object(
        'entity_type', p_entity_type,
        'entity_id', v_dun_existing.client_documentation_id,
        'requested_entity_id', v_dun_id,
        'row_version', v_dun_existing.row_version,
        'payload', to_jsonb(v_dun_existing),
        'deleted', false,
        'deduped', true
      );
    end if;

    insert into public.workspace_invoice_dunning_documentations (
      workspace_id,
      client_documentation_id,
      client_invoice_id,
      client_vorgang_id,
      kind,
      documented_at,
      delivery_method,
      payload,
      row_version,
      created_by,
      updated_by
    )
    values (
      p_workspace_id,
      v_dun_id,
      v_dun_invoice_id,
      v_dun_vorgang_id,
      v_dun_kind,
      v_dun_documented_at,
      v_dun_delivery,
      v_dun_payload,
      1,
      auth.uid(),
      auth.uid()
    )
    returning to_jsonb(public.workspace_invoice_dunning_documentations.*) into v_result;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_dun_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result,
      'deleted', false
    );

  elsif p_entity_type = 'workspace' then
    if not public.can_write_workspace(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    select w.version into v_current_version from public.workspaces w where w.id = p_workspace_id for update;
    if v_current_version is null then
      raise exception 'Workspace nicht gefunden';
    end if;
    if p_row_version > 0 and p_row_version <> v_current_version then
      raise exception 'Versionskonflikt workspace:%', v_current_version using errcode = 'P0001';
    end if;

    update public.workspaces
    set
      name = coalesce(nullif(trim(p_payload->>'name'), ''), name),
      version = version + 1
    where id = p_workspace_id
    returning to_jsonb(public.workspaces.*) into v_result;

    return jsonb_build_object('entity_type', p_entity_type, 'row_version', (v_result->>'version')::bigint, 'payload', v_result);

  elsif p_entity_type = 'workspace_settings' then
    if not public.can_write_workspace(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    select ws.version into v_current_version from public.workspace_settings ws where ws.workspace_id = p_workspace_id for update;
    if v_current_version is null then
      insert into public.workspace_settings (workspace_id, settings, version, updated_by)
      values (p_workspace_id, coalesce(p_payload->'settings', '{}'::jsonb), 1, auth.uid())
      returning to_jsonb(public.workspace_settings.*) into v_result;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt workspace_settings:%', v_current_version using errcode = 'P0001';
      end if;
      update public.workspace_settings
      set
        settings = coalesce(p_payload->'settings', settings),
        version = version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id
      returning to_jsonb(public.workspace_settings.*) into v_result;
    end if;

    return jsonb_build_object('entity_type', p_entity_type, 'row_version', (v_result->>'version')::bigint, 'payload', v_result);

  elsif p_entity_type = 'company_setup' then
    if not public.can_write_workspace(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    select s.row_version into v_current_version from public.workspace_setup s where s.workspace_id = p_workspace_id for update;
    if v_current_version is null then
      insert into public.workspace_setup (workspace_id, payload, setup_version, row_version, updated_by)
      values (
        p_workspace_id,
        coalesce(p_payload->'payload', p_payload, '{}'::jsonb),
        coalesce((p_payload->>'setup_version')::integer, 1),
        1,
        auth.uid()
      )
      returning to_jsonb(public.workspace_setup.*) into v_result;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt company_setup:%', v_current_version using errcode = 'P0001';
      end if;
      update public.workspace_setup
      set
        payload = coalesce(p_payload->'payload', p_payload, payload),
        setup_version = coalesce((p_payload->>'setup_version')::integer, setup_version),
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id
      returning to_jsonb(public.workspace_setup.*) into v_result;
    end if;

    return jsonb_build_object('entity_type', p_entity_type, 'row_version', (v_result->>'row_version')::bigint, 'payload', v_result);

  elsif p_entity_type = 'company_profile' then
    if not public.can_write_workspace(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    select cp.row_version, cp.payload into v_current_version, v_existing_profile
    from public.workspace_company_profiles cp
    where cp.workspace_id = p_workspace_id
    for update;

    /*
     * 01B3 -- profile_schema_version: fehlend = 0 (Altclient); sonst nur
     * plausible, bekannte Werte 0..3 (EINRICHTUNG-01: 3 = Patch). Ein hoeherer
     * oder negativer Wert koennte die Preserve-/Loeschsemantik aushebeln und
     * wird abgewiesen.
     */
    if p_payload ? 'profile_schema_version'
       and (jsonb_typeof(p_payload->'profile_schema_version') <> 'number'
            or (p_payload->>'profile_schema_version') !~ ('^[0-9]{1,3}' || chr(36))
            or (p_payload->>'profile_schema_version')::integer > 3) then
      raise exception 'Firmenprofil ungueltig: profile_schema_version' using errcode = 'P0001';
    end if;
    v_incoming_schema := coalesce(nullif(p_payload->>'profile_schema_version', '')::integer, 0);

    if v_current_version is null then
      v_incoming_profile := coalesce(p_payload->'payload', p_payload, '{}'::jsonb);
      if v_incoming_schema >= 3 then
        -- EINRICHTUNG-01 (EIN-06) -- Schema 3 ist ein Patch, hier auf ein noch leeres Profil.
        v_incoming_profile := public.apply_workspace_company_profile_patch('{}'::jsonb, p_payload->'payload');
      elsif jsonb_typeof(v_incoming_profile) = 'object' and v_incoming_schema >= 2 then
        -- explizites null eines wissenden Clients = nicht gesetzt
        for v_field in select * from (values ('defaultTaxStatus'), ('currency'), ('replyToEmail'), ('senderDisplayName')) as catalog(key) loop
          if jsonb_typeof(v_incoming_profile -> v_field.key) = 'null' then
            v_incoming_profile := v_incoming_profile - v_field.key;
          end if;
        end loop;
      end if;
      perform public.validate_workspace_company_profile_payload(v_incoming_profile);
      insert into public.workspace_company_profiles (workspace_id, payload, row_version, updated_by)
      values (p_workspace_id, v_incoming_profile, 1, auth.uid())
      returning to_jsonb(public.workspace_company_profiles.*) into v_result;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt company_profile:%', v_current_version using errcode = 'P0001';
      end if;

      v_incoming_profile := coalesce(p_payload->'payload', p_payload, v_existing_profile);

      if v_incoming_schema >= 3 then
        /*
         * EINRICHTUNG-01 (EIN-06, Vertrag 1.10) -- Schema 3 ist ein Patch auf den
         * bestehenden Stand: fehlend = unveraendert, null = Loeschen eines
         * optionalen Feldes, Pflichtfelder werden nicht leer, Steuernummer und
         * USt-IdNr. nicht beide. Ein Verstoss weist den Write ab, der Stand bleibt.
         */
        v_incoming_profile := public.apply_workspace_company_profile_patch(v_existing_profile, p_payload->'payload');
      elsif jsonb_typeof(v_incoming_profile) = 'object' then
        /*
         * PRODUCT-BASIS-FIRMENPROFIL-01B -- schema-versionierter Altclient-Schutz.
         *
         * Der Katalog nennt jedes Profilfeld, das nach der ersten Ganzdokument-
         * Fassung eingefuehrt wurde, mit der Schema-Version seiner Einfuehrung.
         * Ein Client sendet seine Schema-Version mit (fehlend = 0, alle Clients
         * vor 01B). Regel je Feld:
         *
         *   Client-Version <  Einfuehrungsversion und Feld fehlt im Payload
         *     -> der Client kennt das Feld nachweislich nicht: bestehenden Wert bewahren
         *   Client-Version >= Einfuehrungsversion
         *     -> der Client kennt das Feld: fehlend oder null = bewusstes Loeschen
         *
         * Kein Deep-Merge, kein pauschales Konservieren: Alles, was nicht im
         * Katalog steht, wird weiterhin vollstaendig ersetzt. Ein neues Feld
         * braucht genau einen Eintrag hier und eine erhoehte Version im Client.
         *
         * EINRICHTUNG-01 (EIN-06) -- Version 3 traegt die Felder nach, die nach der
         * ersten Fassung ohne Eintrag eingefuehrt wurden; Schema 1 und 2 bewahren sie.
         */
        for v_field in
          select * from (values
            ('defaultTaxStatus', 2),
            ('currency', 2),
            ('replyToEmail', 2),
            ('senderDisplayName', 2),
            ('accountHolder', 3),
            ('countryCode', 3),
            ('defaultIntroText', 3),
            ('defaultClosingText', 3),
            ('defaultInvoiceEmailSubject', 3),
            ('defaultInvoiceEmailBody', 3),
            ('defaultOfferEmailSubject', 3),
            ('defaultOfferEmailBody', 3),
            ('defaultLetterEmailSubject', 3),
            ('defaultLetterEmailBody', 3),
            ('emailSignature', 3),
            ('registrationAuthority', 3),
            ('registrationNumber', 3),
            ('offerValidityDays', 3),
            ('offerIntroText', 3),
            ('offerClosingText', 3),
            ('orderIntroText', 3),
            ('orderClosingText', 3),
            ('letterSalutation', 3),
            ('letterClosing', 3),
            ('communicationLanguage', 3)
          ) as catalog(key, introduced_in)
        loop
          if v_incoming_schema < v_field.introduced_in
             and not (v_incoming_profile ? v_field.key)
             and (v_existing_profile ? v_field.key) then
            v_incoming_profile := jsonb_set(
              v_incoming_profile,
              array[v_field.key],
              v_existing_profile -> v_field.key,
              true
            );
          elsif v_incoming_schema >= v_field.introduced_in
             and jsonb_typeof(v_incoming_profile -> v_field.key) = 'null' then
            -- explizites null eines wissenden Clients = Loeschen: Schluessel entfernen
            v_incoming_profile := v_incoming_profile - v_field.key;
          end if;
        end loop;

        /*
         * BRANDING-01E-0 -- Altclient-Schutz fuer `branding` bleibt unveraendert
         * (Asset-Referenz ist unveraenderlich; null ist kein Loeschsignal):
         * uebernommen wird nur ein echtes JSON-Objekt, sonst wird ein
         * vorhandenes Branding bewahrt. Kein Deep-Merge.
         */
        if jsonb_typeof(v_incoming_profile->'branding') is distinct from 'object'
           and jsonb_typeof(v_existing_profile->'branding') = 'object' then
          v_incoming_profile := jsonb_set(
            v_incoming_profile,
            '{branding}',
            v_existing_profile->'branding',
            true
          );
        end if;
      end if;

      /*
       * 01B3 -- Validierung des **endgueltigen** Dokuments (nach Preserve und
       * Loeschsemantik): Ein ungueltiger Wert bricht den Write atomar ab, der
       * bestehende Stand bleibt unveraendert (kein Teilupdate).
       */
      perform public.validate_workspace_company_profile_payload(v_incoming_profile);

      update public.workspace_company_profiles
      set
        payload = v_incoming_profile,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id
      returning to_jsonb(public.workspace_company_profiles.*) into v_result;
    end if;

    return jsonb_build_object('entity_type', p_entity_type, 'row_version', (v_result->>'row_version')::bigint, 'payload', v_result);

  elsif p_entity_type = 'bank_account' then
    /*
     * BANKABGLEICH-V1 BLOCK 2B -- das Konto, unter dem Kontoauszuege liegen.
     *
     * Berechtigung wie bei Vorgangsnotizen und Aufgaben und aus demselben
     * Grund: Ein Konto entsteht heute beilaeufig beim ersten Import, ohne
     * jede Rollenpruefung. `can_write_workspace` (Inhaber/Admin) wuerde
     * genau die Mitglieder aussperren, die den Auszug einlesen, und ihre
     * Konten dauerhaft in der Outbox halten.
     *
     * Kein Banking: kein Zugang, kein Saldo, kein Anbieter. Nur die stabile
     * Identitaet, unter der Bewegungen aufbewahrt werden.
     */
    if not public.workspace_user_can_intake(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_bank_account_id := coalesce(nullif(trim(p_payload->>'account_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_bank_account_id is null then
      raise exception 'account_id fehlt';
    end if;

    v_bank_account_payload := coalesce(p_payload->'payload', '{}'::jsonb);
    v_deleted := coalesce((p_payload->>'deleted')::boolean, false);

    /*
     * Loeschen ist in Block 2B fachlich nicht vorgesehen -- weder die
     * Oberflaeche noch der Store bieten es an. Ein Grabstein kann hier also
     * nur aus einem Fehler stammen, und ein Konto mit Bewegungen darf wegen
     * `on delete restrict` ohnehin nicht verschwinden. Lieber laut ablehnen
     * als still eine Loeschsemantik erfinden, die niemand entworfen hat.
     */
    if v_deleted then
      raise exception 'Bankkonten koennen nicht geloescht werden' using errcode = 'P0001';
    end if;

    /* Der Anzeigename ist Pflicht, die Kontokennung ausdruecklich nicht. */
    if jsonb_typeof(v_bank_account_payload->'displayName') <> 'string'
      or length(trim(v_bank_account_payload->>'displayName')) = 0 then
      raise exception 'Bankkonto ungueltig: displayName' using errcode = 'P0001';
    end if;
    if length(v_bank_account_payload->>'displayName') > 200 then
      raise exception 'Bankkonto ungueltig: displayName zu lang' using errcode = 'P0001';
    end if;

    select a.* into v_row_bank_account
    from public.workspace_bank_accounts a
    where a.workspace_id = p_workspace_id and a.client_account_id = v_bank_account_id
    for update;
    v_current_version := v_row_bank_account.row_version;

    /* CREATE-RETRY-CONFLICT-02: `0` heisst "diese Zeile darf noch nicht existieren". */
    if v_current_version is not null and p_row_version <= 0 then
      if v_row_bank_account.payload = v_bank_account_payload then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_bank_account_id,
          'row_version', v_row_bank_account.row_version,
          'payload', to_jsonb(v_row_bank_account),
          'deleted', false,
          'replayed', true
        );
      end if;
      raise exception 'Versionskonflikt bank_account:%', v_current_version using errcode = 'P0001';
    end if;

    if v_current_version is null then
      insert into public.workspace_bank_accounts (
        workspace_id,
        client_account_id,
        display_name,
        identifier,
        payload,
        row_version,
        created_by,
        updated_by
      )
      values (
        p_workspace_id,
        v_bank_account_id,
        trim(v_bank_account_payload->>'displayName'),
        coalesce(nullif(trim(v_bank_account_payload->>'identifier'), ''), ''),
        v_bank_account_payload,
        1,
        auth.uid(),
        auth.uid()
      )
      returning to_jsonb(public.workspace_bank_accounts.*) into v_result;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt bank_account:%', v_current_version using errcode = 'P0001';
      end if;

      /*
       * Umbenennen ist ein Update derselben Zeile, keine neue.
       * `client_account_id` bleibt unberuehrt -- sie ist die Identitaet, an
       * der die Entdopplung der Bewegungen haengt.
       */
      update public.workspace_bank_accounts
      set
        display_name = trim(v_bank_account_payload->>'displayName'),
        identifier = coalesce(nullif(trim(v_bank_account_payload->>'identifier'), ''), identifier),
        payload = v_bank_account_payload,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id and client_account_id = v_bank_account_id
      returning to_jsonb(public.workspace_bank_accounts.*) into v_result;
    end if;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_bank_account_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result,
      'deleted', false
    );

  elsif p_entity_type = 'bank_transaction' then
    /*
     * BANKABGLEICH-V1 BLOCK 2B -- eine importierte Bankbewegung.
     *
     * Sie ist ein **Nachweis**, keine Zahlung: kein invoice_id, kein
     * expense_id, kein payment_id, kein Abgleichstatus. Dieser Zweig ruft
     * keine Zahlungsfunktion auf und beruehrt keinen Zahlungsstatus.
     */
    if not public.workspace_user_can_intake(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_bank_transaction_id := coalesce(nullif(trim(p_payload->>'transaction_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_bank_transaction_id is null then
      raise exception 'transaction_id fehlt';
    end if;

    v_bank_transaction_payload := coalesce(p_payload->'payload', '{}'::jsonb);
    v_deleted := coalesce((p_payload->>'deleted')::boolean, false);

    /* Wie beim Konto: Block 2B kennt kein Loeschen von Bankbewegungen. */
    if v_deleted then
      raise exception 'Bankbewegungen koennen nicht geloescht werden' using errcode = 'P0001';
    end if;

    /* Die Felder, an denen die Entdopplung haengt, muessen dastehen. */
    if coalesce(nullif(trim(v_bank_transaction_payload->>'accountKey'), ''), '') = '' then
      raise exception 'Bankbewegung ungueltig: accountKey' using errcode = 'P0001';
    end if;
    if coalesce(nullif(trim(v_bank_transaction_payload->>'fingerprint'), ''), '') = '' then
      raise exception 'Bankbewegung ungueltig: fingerprint' using errcode = 'P0001';
    end if;
    if jsonb_typeof(v_bank_transaction_payload->'amountCents') <> 'number'
      or (v_bank_transaction_payload->>'amountCents')::bigint = 0 then
      raise exception 'Bankbewegung ungueltig: amountCents' using errcode = 'P0001';
    end if;
    if coalesce((v_bank_transaction_payload->>'occurrence')::integer, 0) < 1 then
      raise exception 'Bankbewegung ungueltig: occurrence' using errcode = 'P0001';
    end if;

    /*
     * Das Konto muss serverseitig existieren, **bevor** seine Bewegung
     * geschrieben wird. Bewusst eine eigene, sprechende Pruefung statt der
     * rohen Fremdschluesselmeldung: Der Client soll erkennen koennen, dass
     * nur die Reihenfolge stimmen muss -- und es wird hier ausdruecklich
     * **kein** Konto angelegt. Das Konto ist eine eigene Entitaet mit
     * eigenem Push.
     */
    if not exists (
      select 1 from public.workspace_bank_accounts a
      where a.workspace_id = p_workspace_id
        and a.client_account_id = trim(v_bank_transaction_payload->>'accountKey')
    ) then
      raise exception 'Bankkonto fehlt: %', trim(v_bank_transaction_payload->>'accountKey') using errcode = 'P0001';
    end if;

    select t.* into v_row_bank_transaction
    from public.workspace_bank_transactions t
    where t.workspace_id = p_workspace_id and t.client_transaction_id = v_bank_transaction_id
    for update;
    v_current_version := v_row_bank_transaction.row_version;

    if v_current_version is not null and p_row_version <= 0 then
      if v_row_bank_transaction.payload = v_bank_transaction_payload then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_bank_transaction_id,
          'row_version', v_row_bank_transaction.row_version,
          'payload', to_jsonb(v_row_bank_transaction),
          'deleted', false,
          'replayed', true
        );
      end if;
      raise exception 'Versionskonflikt bank_transaction:%', v_current_version using errcode = 'P0001';
    end if;

    if v_current_version is null then
      insert into public.workspace_bank_transactions (
        workspace_id,
        client_transaction_id,
        account_key,
        import_id,
        file_name,
        imported_at,
        booking_date,
        value_date,
        amount_cents,
        currency,
        counterparty,
        counterparty_iban,
        purpose,
        bank_reference,
        fingerprint,
        occurrence,
        payload,
        row_version,
        created_by,
        updated_by
      )
      values (
        p_workspace_id,
        v_bank_transaction_id,
        trim(v_bank_transaction_payload->>'accountKey'),
        coalesce(nullif(trim(v_bank_transaction_payload->>'importId'), ''), ''),
        coalesce(nullif(trim(v_bank_transaction_payload->>'fileName'), ''), ''),
        coalesce((v_bank_transaction_payload->>'importedAt')::timestamptz, now()),
        (v_bank_transaction_payload->>'bookingDate')::date,
        nullif(trim(coalesce(v_bank_transaction_payload->>'valueDate', '')), '')::date,
        (v_bank_transaction_payload->>'amountCents')::bigint,
        nullif(trim(coalesce(v_bank_transaction_payload->>'currency', '')), ''),
        nullif(trim(coalesce(v_bank_transaction_payload->>'counterparty', '')), ''),
        nullif(trim(coalesce(v_bank_transaction_payload->>'counterpartyIban', '')), ''),
        nullif(trim(coalesce(v_bank_transaction_payload->>'purpose', '')), ''),
        nullif(trim(coalesce(v_bank_transaction_payload->>'bankReference', '')), ''),
        trim(v_bank_transaction_payload->>'fingerprint'),
        (v_bank_transaction_payload->>'occurrence')::integer,
        v_bank_transaction_payload,
        1,
        auth.uid(),
        auth.uid()
      )
      returning to_jsonb(public.workspace_bank_transactions.*) into v_result;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt bank_transaction:%', v_current_version using errcode = 'P0001';
      end if;

      /*
       * Eine Bankbewegung ist ein Nachweis und aendert sich fachlich nicht.
       * Der Update-Pfad existiert fuer den Wiederanlauf eines nicht
       * bestaetigten Pushes -- nicht, um einen Kontoauszug umzuschreiben.
       * Kontoschluessel, Fingerabdruck und laufende Nummer bleiben deshalb
       * bewusst stehen: Sie sind die Identitaet, an der die Entdopplung
       * haengt.
       */
      update public.workspace_bank_transactions
      set
        payload = v_bank_transaction_payload,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id and client_transaction_id = v_bank_transaction_id
      returning to_jsonb(public.workspace_bank_transactions.*) into v_result;
    end if;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_bank_transaction_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result,
      'deleted', false
    );

  elsif p_entity_type = 'paper_register_entry' then
    /*
     * CLOUD-SYNC S1 -- der Papierablage-Haken eines Dokuments.
     *
     * Rechte wie beim Dokument, zu dem der Eintrag gehoert (Kopfkommentar
     * der Migration): anlegen jedes aktive Mitglied, aendern nur
     * Inhaber/Admin oder wer die Zeile angelegt hat, Grabstein nur
     * Inhaber/Admin.
     *
     * Serverseitig wird nur die Sync-Struktur geprueft, keine Fachlogik:
     * Eintrag-ID, Dokumentbezug, Ordnerangaben, der Haken als Wahrheitswert
     * und eine vertretbare Groesse.
     */
    if not public.workspace_user_can_intake(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_paper_entry_id := coalesce(nullif(trim(p_payload->>'entry_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_paper_entry_id is null then
      raise exception 'entry_id fehlt';
    end if;

    v_paper_payload := coalesce(p_payload->'payload', '{}'::jsonb);
    v_paper_document_id := coalesce(
      nullif(trim(p_payload->>'document_id'), ''),
      nullif(trim(v_paper_payload->>'documentId'), '')
    );
    v_deleted := coalesce((p_payload->>'deleted')::boolean, false);

    -- Wie beim Dokument selbst: Grabsteine setzen nur Inhaber und Admin.
    if v_deleted and not public.can_write_workspace(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    -- Der Dokumentbezug darf nur am Grabstein fehlen.
    if v_paper_document_id is null and not v_deleted then
      raise exception 'document_id fehlt';
    end if;

    /*
     * coalesce um jsonb_typeof: Fehlt ein Feld, liefert jsonb_typeof NULL,
     * und ein Vergleich mit NULL waere nie wahr -- die Pruefung liefe ins
     * Leere.
     */
    if not v_deleted then
      if coalesce(jsonb_typeof(v_paper_payload->'physicalFiled'), '') <> 'boolean' then
        raise exception 'Papierablage ungueltig: physicalFiled' using errcode = 'P0001';
      end if;
      if coalesce(jsonb_typeof(v_paper_payload->'folderId'), '') <> 'string'
        or coalesce(jsonb_typeof(v_paper_payload->'register'), '') <> 'string' then
        raise exception 'Papierablage ungueltig: Ordner' using errcode = 'P0001';
      end if;
      if length(v_paper_payload::text) > 20000 then
        raise exception 'Papierablage ungueltig: zu gross' using errcode = 'P0001';
      end if;
    end if;

    select e.* into v_row_paper
    from public.workspace_paper_register_entries e
    where e.workspace_id = p_workspace_id and e.client_entry_id = v_paper_entry_id
    for update;
    v_current_version := v_row_paper.row_version;

    if v_current_version is not null then
      /*
       * Eine fremde Zeile aendern nur Inhaber und Admin -- dieselbe Regel wie
       * am Dokument. Sie steht vor dem Replay, damit auch eine Wiederholung
       * keine Zeile zurueckgibt, die der Aufrufer nicht lesen darf.
       */
      if not public.can_write_workspace(p_workspace_id)
        and v_row_paper.created_by is distinct from auth.uid() then
        raise exception 'Keine Schreibberechtigung';
      end if;
      -- P1 MITARBEITERZAHLUNGEN: Der Eintrag eines geschuetzten Belegs gehoert
      -- nur Inhaber und Admin, auch als Wiederholung.
      if not public.can_write_workspace(p_workspace_id)
        and public.workspace_document_is_restricted(p_workspace_id, v_row_paper.client_document_id) then
        raise exception 'Keine Schreibberechtigung';
      end if;
      -- Ein Eintrag wechselt nie sein Dokument.
      if v_paper_document_id is not null
        and v_row_paper.client_document_id is not null
        and v_row_paper.client_document_id <> v_paper_document_id then
        raise exception 'Papierablage ungueltig: document_id' using errcode = 'P0001';
      end if;
    end if;

    /*
     * 01G/01G2 -- unbestaetigte Version bei vorhandener Zeile, wortgleich zu
     * den Vorgangsnotizen: identischer Inhalt ist eine Wiederholung, beide
     * Seiten geloescht ebenfalls, alles andere ist ein Konflikt.
     */
    if v_current_version is not null and p_row_version <= 0 then
      if v_row_paper.deleted and not v_deleted then
        raise exception 'Versionskonflikt paper_register_entry:%', v_current_version using errcode = 'P0001';
      end if;
      if v_row_paper.deleted and v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_paper_entry_id,
          'row_version', v_row_paper.row_version,
          'payload', to_jsonb(v_row_paper),
          'deleted', true,
          'replayed', true
        );
      end if;
      if v_row_paper.payload = v_paper_payload and v_row_paper.deleted = v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_paper_entry_id,
          'row_version', v_row_paper.row_version,
          'payload', to_jsonb(v_row_paper),
          'deleted', v_row_paper.deleted,
          'replayed', true
        );
      end if;
      raise exception 'Versionskonflikt paper_register_entry:%', v_current_version using errcode = 'P0001';
    end if;

    if v_current_version is null then
      insert into public.workspace_paper_register_entries (
        workspace_id,
        client_entry_id,
        client_document_id,
        payload,
        row_version,
        deleted,
        deleted_at,
        created_by,
        updated_by
      )
      values (
        p_workspace_id,
        v_paper_entry_id,
        v_paper_document_id,
        case when v_deleted then '{}'::jsonb else v_paper_payload end,
        1,
        v_deleted,
        case when v_deleted then now() else null end,
        auth.uid(),
        auth.uid()
      )
      returning to_jsonb(public.workspace_paper_register_entries.*) into v_result;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt paper_register_entry:%', v_current_version using errcode = 'P0001';
      end if;

      /*
       * Kein Wiederbeleben: Der Grabstein gehoert zu einem geloeschten
       * Dokument. Auch mit passender Version wird er nicht wieder aktiv.
       */
      if v_row_paper.deleted and not v_deleted then
        raise exception 'Versionskonflikt paper_register_entry:%', v_current_version using errcode = 'P0001';
      end if;

      /*
       * Grabstein: Der Fachinhalt bleibt stehen, ebenso der Dokumentbezug --
       * er ist die Ordnung, ueber die ein zweites Geraet den Grabstein
       * zuordnet.
       */
      update public.workspace_paper_register_entries
      set
        payload = case when v_deleted then payload else coalesce(v_paper_payload, payload) end,
        client_document_id = coalesce(client_document_id, v_paper_document_id),
        deleted = v_deleted,
        deleted_at = case when v_deleted then coalesce(deleted_at, now()) else null end,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id and client_entry_id = v_paper_entry_id
      returning to_jsonb(public.workspace_paper_register_entries.*) into v_result;
    end if;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_paper_entry_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result,
      'deleted', (v_result->>'deleted')::boolean
    );

  elsif p_entity_type = 'communication_event' then
    /*
     * CLOUD-SYNC S2 -- ein Ereignis im Kommunikationsverlauf.
     *
     * Append-only wie der Mahnnachweis: Es gibt keinen Update-Pfad und kein
     * Loeschen. Eine vorhandene Kennung wird unveraendert zurueckgegeben --
     * das Ereignis bleibt genau so stehen, wie es festgehalten wurde.
     * `p_row_version` spielt hier deshalb keine Rolle.
     *
     * Serverseitig wird nur die Sync-Struktur geprueft, keine Fachlogik:
     * Kennung, Kontextart, Ereignisart, Ereigniszeit und eine vertretbare
     * Groesse. Art und Kontext werden als Form geprueft, nicht gegen eine
     * feste Liste -- sie tragen keine Serverlogik.
     */
    if not public.workspace_user_can_intake(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_comm_event_id := coalesce(nullif(trim(p_payload->>'event_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_comm_event_id is null then
      raise exception 'event_id fehlt';
    end if;

    -- Loeschen gibt es fuer Kommunikationsereignisse nicht. Laut statt erfunden.
    if coalesce((p_payload->>'deleted')::boolean, false) then
      raise exception 'Kommunikationsereignisse koennen nicht geloescht werden' using errcode = 'P0001';
    end if;

    v_comm_payload := coalesce(p_payload->'payload', '{}'::jsonb);
    v_comm_context := coalesce(v_comm_payload->'contextRef', '{}'::jsonb);
    v_comm_context_type := coalesce(nullif(trim(p_payload->>'context_type'), ''), nullif(trim(v_comm_context->>'type'), ''));
    v_comm_event_type := coalesce(nullif(trim(p_payload->>'event_type'), ''), nullif(trim(v_comm_payload->>'type'), ''));

    if v_comm_context_type is null or v_comm_context_type !~ '^[a-z_]{1,40}$' then
      raise exception 'Kommunikationsereignis ungueltig: contextRef' using errcode = 'P0001';
    end if;
    if v_comm_event_type is null or v_comm_event_type !~ '^[a-z_]{1,60}$' then
      raise exception 'Kommunikationsereignis ungueltig: type' using errcode = 'P0001';
    end if;
    begin
      v_comm_event_at := coalesce(nullif(trim(p_payload->>'event_at'), ''), v_comm_payload->>'timestamp')::timestamptz;
    exception when others then
      raise exception 'Kommunikationsereignis ungueltig: timestamp' using errcode = 'P0001';
    end;
    if v_comm_event_at is null then
      raise exception 'Kommunikationsereignis ungueltig: timestamp' using errcode = 'P0001';
    end if;
    if length(v_comm_payload::text) > 20000 then
      raise exception 'Kommunikationsereignis ungueltig: zu gross' using errcode = 'P0001';
    end if;

    select e.* into v_row_comm
    from public.workspace_communication_events e
    where e.workspace_id = p_workspace_id and e.client_event_id = v_comm_event_id
    for update;

    if found then
      /*
       * Wiederholung derselben Kennung. Eine fremde Zeile bekommen nur Inhaber
       * und Admin zurueck -- sonst laese ein Mitglied ueber ein Replay, was es
       * im Abzug nicht sehen darf.
       */
      if not public.can_write_workspace(p_workspace_id)
        and v_row_comm.created_by is distinct from auth.uid() then
        raise exception 'Keine Schreibberechtigung';
      end if;
      -- P1 MITARBEITERZAHLUNGEN: Ereignisse zu einem geschuetzten Beleg gibt
      -- die Wiederholung nur Inhaber und Admin zurueck.
      if not public.can_write_workspace(p_workspace_id)
        and public.workspace_communication_context_is_restricted(p_workspace_id, v_row_comm.context_type, v_row_comm.context_id) then
        raise exception 'Keine Schreibberechtigung';
      end if;
      return jsonb_build_object(
        'entity_type', p_entity_type,
        'entity_id', v_row_comm.client_event_id,
        'row_version', v_row_comm.row_version,
        'payload', to_jsonb(v_row_comm),
        'deleted', false,
        'replayed', true
      );
    end if;

    insert into public.workspace_communication_events (
      workspace_id,
      client_event_id,
      context_type,
      context_id,
      context_vorgang_id,
      event_type,
      event_at,
      payload,
      row_version,
      created_by,
      updated_by
    )
    values (
      p_workspace_id,
      v_comm_event_id,
      v_comm_context_type,
      coalesce(nullif(trim(p_payload->>'context_id'), ''), nullif(trim(v_comm_context->>'id'), '')),
      coalesce(nullif(trim(p_payload->>'context_vorgang_id'), ''), nullif(trim(v_comm_context->>'vorgangId'), '')),
      v_comm_event_type,
      v_comm_event_at,
      v_comm_payload,
      1,
      auth.uid(),
      auth.uid()
    )
    returning to_jsonb(public.workspace_communication_events.*) into v_result;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_comm_event_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result,
      'deleted', false
    );

  elsif p_entity_type = 'knowledge_fact' then
    /*
     * CLOUD-SYNC S3 -- ein bestaetigter Wissenseintrag.
     *
     * Rechte wie bei den Vorgangsnotizen: Das Produkt kennt fuer das Anlegen,
     * Aendern und Loeschen von Wissen keine Rollenpruefung; jedes aktive
     * Mitglied darf es (`workspace_user_can_intake`), ausschliesslich ueber
     * diese RPC.
     *
     * Serverseitig wird nur die Sync-Struktur geprueft, keine Fachlogik:
     * Kennung, Scope als Form, Schluessel, Wert, Anzeigetext, das
     * Aktiv-Kennzeichen als Wahrheitswert und eine vertretbare Groesse.
     */
    if not public.workspace_user_can_intake(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_fact_id := coalesce(nullif(trim(p_payload->>'fact_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_fact_id is null then
      raise exception 'fact_id fehlt';
    end if;

    v_fact_payload := coalesce(p_payload->'payload', '{}'::jsonb);
    v_fact_scope := coalesce(nullif(trim(p_payload->>'scope'), ''), nullif(trim(v_fact_payload->>'scope'), ''));
    v_deleted := coalesce((p_payload->>'deleted')::boolean, false);

    if not v_deleted then
      if v_fact_scope is null or v_fact_scope !~ '^[a-z_]{1,40}$' then
        raise exception 'Wissen ungueltig: scope' using errcode = 'P0001';
      end if;
      if coalesce(jsonb_typeof(v_fact_payload->'key'), '') <> 'string' or length(trim(v_fact_payload->>'key')) = 0 then
        raise exception 'Wissen ungueltig: key' using errcode = 'P0001';
      end if;
      if coalesce(jsonb_typeof(v_fact_payload->'value'), '') <> 'string' or length(trim(v_fact_payload->>'value')) = 0 then
        raise exception 'Wissen ungueltig: value' using errcode = 'P0001';
      end if;
      if coalesce(jsonb_typeof(v_fact_payload->'displayText'), '') <> 'string'
        or length(trim(v_fact_payload->>'displayText')) = 0 then
        raise exception 'Wissen ungueltig: displayText' using errcode = 'P0001';
      end if;
      if coalesce(jsonb_typeof(v_fact_payload->'active'), '') <> 'boolean' then
        raise exception 'Wissen ungueltig: active' using errcode = 'P0001';
      end if;
      if length(v_fact_payload::text) > 20000 then
        raise exception 'Wissen ungueltig: zu gross' using errcode = 'P0001';
      end if;
    end if;

    select f.* into v_row_fact
    from public.workspace_knowledge_facts f
    where f.workspace_id = p_workspace_id and f.client_fact_id = v_fact_id
    for update;
    v_current_version := v_row_fact.row_version;

    /*
     * 01G/01G2 -- unbestaetigte Version bei vorhandener Zeile, wortgleich zu
     * den Vorgangsnotizen: identischer Inhalt ist eine Wiederholung, beide
     * Seiten geloescht ebenfalls, alles andere ist ein Konflikt.
     */
    if v_current_version is not null and p_row_version <= 0 then
      if v_row_fact.deleted and not v_deleted then
        raise exception 'Versionskonflikt knowledge_fact:%', v_current_version using errcode = 'P0001';
      end if;
      if v_row_fact.deleted and v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_fact_id,
          'row_version', v_row_fact.row_version,
          'payload', to_jsonb(v_row_fact),
          'deleted', true,
          'replayed', true
        );
      end if;
      if v_row_fact.payload = v_fact_payload and v_row_fact.deleted = v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_fact_id,
          'row_version', v_row_fact.row_version,
          'payload', to_jsonb(v_row_fact),
          'deleted', v_row_fact.deleted,
          'replayed', true
        );
      end if;
      raise exception 'Versionskonflikt knowledge_fact:%', v_current_version using errcode = 'P0001';
    end if;

    if v_current_version is null then
      insert into public.workspace_knowledge_facts (
        workspace_id,
        client_fact_id,
        scope,
        scope_id,
        category,
        active,
        payload,
        row_version,
        deleted,
        deleted_at,
        created_by,
        updated_by
      )
      values (
        p_workspace_id,
        v_fact_id,
        v_fact_scope,
        nullif(trim(v_fact_payload->>'scopeId'), ''),
        nullif(trim(v_fact_payload->>'category'), ''),
        case when v_deleted then false else coalesce((v_fact_payload->>'active')::boolean, true) end,
        case when v_deleted then '{}'::jsonb else v_fact_payload end,
        1,
        v_deleted,
        case when v_deleted then now() else null end,
        auth.uid(),
        auth.uid()
      )
      returning to_jsonb(public.workspace_knowledge_facts.*) into v_result;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt knowledge_fact:%', v_current_version using errcode = 'P0001';
      end if;

      /*
       * Kein Wiederbeleben: Das Produkt kennt kein Wiederherstellen eines
       * geloeschten Eintrags -- ein neuer Eintrag bekommt eine neue Kennung.
       */
      if v_row_fact.deleted and not v_deleted then
        raise exception 'Versionskonflikt knowledge_fact:%', v_current_version using errcode = 'P0001';
      end if;

      /* Grabstein: der Fachinhalt bleibt als Nachweis stehen. */
      update public.workspace_knowledge_facts
      set
        payload = case when v_deleted then payload else coalesce(v_fact_payload, payload) end,
        scope = case when v_deleted then scope else coalesce(v_fact_scope, scope) end,
        scope_id = case when v_deleted then scope_id else nullif(trim(v_fact_payload->>'scopeId'), '') end,
        category = case when v_deleted then category else coalesce(nullif(trim(v_fact_payload->>'category'), ''), category) end,
        active = case when v_deleted then false else coalesce((v_fact_payload->>'active')::boolean, active) end,
        deleted = v_deleted,
        deleted_at = case when v_deleted then coalesce(deleted_at, now()) else null end,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id and client_fact_id = v_fact_id
      returning to_jsonb(public.workspace_knowledge_facts.*) into v_result;
    end if;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_fact_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result,
      'deleted', (v_result->>'deleted')::boolean
    );

  elsif p_entity_type = 'invoice_draft' then
    /*
     * CLOUD-SYNC S5 -- der fachliche Kern eines Rechnungsentwurfs.
     *
     * Rechte wie beim Vorbereiten einer Rechnung im Produkt: jedes aktive
     * Mitglied (`workspace_user_can_intake`). Die finanzielle Freigabe bleibt
     * R1 in `finalize_workspace_invoice` -- hier wird nie finalisiert.
     *
     * Versionsvertrag wortgleich zu 01G/S3. Zusaetzlich: keine
     * Rechnungsnummer, keine ableitbaren oder geraetelokalen Felder, kein
     * Slotwechsel, hoechstens ein aktiver Entwurf je Slot, und ein
     * verworfener oder finalisierter Entwurf wird weder geaendert noch
     * wiederbelebt.
     */
    if not public.workspace_user_can_intake(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_draft_id := coalesce(nullif(trim(p_payload->>'draft_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_draft_id is null then
      raise exception 'draft_id fehlt';
    end if;

    v_draft_type := nullif(trim(coalesce(p_payload->>'invoice_type', '')), '');
    if v_draft_type is null
       or v_draft_type not in ('rechnung', 'abschlag', 'teilrechnung', 'schluss', 'gutschrift', 'storno') then
      raise exception 'Rechnungsentwurf ungueltig: invoice_type' using errcode = 'P0001';
    end if;

    /* NULL heisst „ohne Auftrag" und gilt nur fuer die normale Rechnung; '' ist kein Bezug. */
    if p_payload ? 'vorgang_id' and jsonb_typeof(p_payload->'vorgang_id') not in ('null', 'string') then
      raise exception 'Rechnungsentwurf ungueltig: vorgang_id' using errcode = 'P0001';
    end if;
    v_draft_vorgang_id := case
      when jsonb_typeof(p_payload->'vorgang_id') = 'string' then p_payload->>'vorgang_id'
      else null
    end;
    if v_draft_vorgang_id is not null
       and (length(trim(v_draft_vorgang_id)) = 0 or v_draft_vorgang_id <> trim(v_draft_vorgang_id)) then
      raise exception 'Rechnungsentwurf ungueltig: vorgang_id' using errcode = 'P0001';
    end if;
    if v_draft_vorgang_id is null and v_draft_type <> 'rechnung' then
      raise exception 'Rechnungsentwurf ungueltig: vorgang_id' using errcode = 'P0001';
    end if;

    v_draft_payload := coalesce(p_payload->'payload', '{}'::jsonb);
    v_deleted := coalesce((p_payload->>'deleted')::boolean, false);

    if not v_deleted then
      if jsonb_typeof(v_draft_payload) <> 'object' then
        raise exception 'Rechnungsentwurf ungueltig: payload' using errcode = 'P0001';
      end if;
      if v_draft_payload->>'id' is distinct from v_draft_id then
        raise exception 'Rechnungsentwurf ungueltig: id' using errcode = 'P0001';
      end if;
      if v_draft_payload->>'type' is distinct from v_draft_type then
        raise exception 'Rechnungsentwurf ungueltig: Rechnungsart' using errcode = 'P0001';
      end if;
      if coalesce(v_draft_payload->'vorgangId', 'null'::jsonb)
         is distinct from coalesce(to_jsonb(v_draft_vorgang_id), 'null'::jsonb) then
        raise exception 'Rechnungsentwurf ungueltig: vorgangId' using errcode = 'P0001';
      end if;
      if jsonb_typeof(v_draft_payload->'positions') is distinct from 'array' then
        raise exception 'Rechnungsentwurf ungueltig: Positionen' using errcode = 'P0001';
      end if;
      /* Keine Rechnungsnummer: sie entsteht ausschliesslich in finalize_workspace_invoice. */
      if v_draft_payload ?| array['number', 'invoiceNumber', 'invoiceSequenceNumber', 'invoiceNumberPreview'] then
        raise exception 'Rechnungsentwurf ungueltig: Rechnungsnummer' using errcode = 'P0001';
      end if;
      /* Ableitbares wird nicht dupliziert, Geraetelokales reist nie. */
      if v_draft_payload ?| array['previousAbschlagDeductions', 'draftRawJson', 'draftSha256', 'finalization',
                                  'preparationRawJson', 'preparationSha256', 'approvalContext', 'revision', 'status'] then
        raise exception 'Rechnungsentwurf ungueltig: lokale oder abgeleitete Felder' using errcode = 'P0001';
      end if;
      if exists (
        select 1
        from jsonb_array_elements(v_draft_payload->'positions') p
        where jsonb_typeof(p) <> 'object'
           or p ?| array['plannedQuantity', 'executedQuantity', 'billedQuantity', 'openQuantity']
      ) then
        raise exception 'Rechnungsentwurf ungueltig: abgeleitete Mengen' using errcode = 'P0001';
      end if;
      if jsonb_typeof(v_draft_payload->'companySnapshot') = 'object'
         and (v_draft_payload->'companySnapshot') ? 'logoDataUrl' then
        raise exception 'Rechnungsentwurf ungueltig: logoDataUrl' using errcode = 'P0001';
      end if;
      if length(v_draft_payload::text) > 262144 then
        raise exception 'Rechnungsentwurf ungueltig: zu gross' using errcode = 'P0001';
      end if;
    end if;

    select d.* into v_row_draft
    from public.workspace_invoice_drafts d
    where d.workspace_id = p_workspace_id and d.client_draft_id = v_draft_id
    for update;
    v_current_version := v_row_draft.row_version;

    /* Ein Entwurf wechselt nie seinen Slot. */
    if v_current_version is not null
       and (v_row_draft.vorgang_id is distinct from v_draft_vorgang_id
            or v_row_draft.invoice_type <> v_draft_type) then
      raise exception 'Rechnungsentwurf ungueltig: Slot' using errcode = 'P0001';
    end if;

    /*
     * 01G/01G2 -- unbestaetigte Version bei vorhandener Zeile, wie bei S3:
     * identischer Inhalt ist eine Wiederholung, beide Seiten verworfen
     * ebenfalls, alles andere ist ein Konflikt. Ein finalisierter Entwurf ist
     * nie die Wiederholung eines Schreibvorgangs.
     */
    if v_current_version is not null and p_row_version <= 0 then
      if v_row_draft.deleted and v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_draft_id,
          'row_version', v_row_draft.row_version,
          'payload', to_jsonb(v_row_draft),
          'deleted', true,
          'replayed', true
        );
      end if;
      if v_row_draft.status = 'active' and not v_row_draft.deleted and not v_deleted
         and v_row_draft.payload = v_draft_payload then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_draft_id,
          'row_version', v_row_draft.row_version,
          'payload', to_jsonb(v_row_draft),
          'deleted', false,
          'replayed', true
        );
      end if;
      raise exception 'Versionskonflikt invoice_draft:%', v_current_version using errcode = 'P0001';
    end if;

    if v_current_version is null then
      begin
        insert into public.workspace_invoice_drafts (
          workspace_id,
          client_draft_id,
          vorgang_id,
          invoice_type,
          status,
          payload,
          row_version,
          deleted,
          deleted_at,
          created_by,
          updated_by
        )
        values (
          p_workspace_id,
          v_draft_id,
          v_draft_vorgang_id,
          v_draft_type,
          'active',
          case when v_deleted then '{}'::jsonb else v_draft_payload end,
          1,
          v_deleted,
          case when v_deleted then now() else null end,
          auth.uid(),
          auth.uid()
        )
        returning to_jsonb(public.workspace_invoice_drafts.*) into v_result;
      exception
        when unique_violation then
          /*
           * Zwei Ursachen, beide ein ausdruecklicher Konflikt: Der Slot gehoert
           * bereits einem anderen aktiven Entwurf -- typischerweise zwei
           * offline angelegte Entwuerfe fuer denselben Vorgang --, oder derselbe
           * Entwurf wurde gleichzeitig angelegt. Nichts wird zusammengefuehrt
           * oder ueberschrieben.
           */
          select d.client_draft_id into v_draft_slot_owner
          from public.workspace_invoice_drafts d
          where d.workspace_id = p_workspace_id
            and coalesce(d.vorgang_id, '') = coalesce(v_draft_vorgang_id, '')
            and d.invoice_type = v_draft_type
            and d.status = 'active'
            and not d.deleted
            and d.client_draft_id <> v_draft_id
          limit 1;
          if v_draft_slot_owner is not null then
            raise exception 'Versionskonflikt invoice_draft_slot:%', v_draft_slot_owner using errcode = 'P0001';
          end if;
          raise exception 'Versionskonflikt invoice_draft:0' using errcode = 'P0001';
      end;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt invoice_draft:%', v_current_version using errcode = 'P0001';
      end if;
      /* Ein zweites Verwerfen desselben Grabsteins aendert nichts. */
      if v_row_draft.deleted and v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_draft_id,
          'row_version', v_row_draft.row_version,
          'payload', to_jsonb(v_row_draft),
          'deleted', true,
          'replayed', true
        );
      end if;
      /*
       * Kein Wiederbeleben und keine Aenderung nach dem Ende: Verworfen bleibt
       * verworfen, finalisiert bleibt finalisiert -- auch mit passender Version.
       * Wer weiterarbeiten will, beginnt einen neuen Entwurf mit neuer Kennung.
       */
      if v_row_draft.deleted or v_row_draft.status <> 'active' then
        raise exception 'Versionskonflikt invoice_draft:%', v_current_version using errcode = 'P0001';
      end if;

      update public.workspace_invoice_drafts
      set
        payload = case when v_deleted then payload else v_draft_payload end,
        deleted = v_deleted,
        deleted_at = case when v_deleted then coalesce(deleted_at, now()) else null end,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id and client_draft_id = v_draft_id
      returning to_jsonb(public.workspace_invoice_drafts.*) into v_result;
    end if;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_draft_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result,
      'deleted', (v_result->>'deleted')::boolean
    );

  elsif p_entity_type = 'order_draft' then
    /*
     * CLOUD-SYNC S6 -- der Auftragsentwurf.
     *
     * Rechte wie beim Bearbeiten im Produkt: Das Speichern eines Entwurfs
     * prueft keine Rolle (`workspace_user_can_intake`); erst die verbindliche
     * Anlage prueft `can_write_workspace` -- in create_workspace_order,
     * unveraendert. Hier wird nie ein Auftrag angelegt.
     *
     * Versionsvertrag wortgleich zu S5. Zusaetzlich: keine Auftrags- oder
     * Vorgangsnummer und kein eingefrorener Stand im Inhalt, keine
     * Workspace-Angabe (der Workspace ist der Scope dieser Zeile), nichts
     * Geraetelokales; ein verworfener oder verbrauchter Entwurf wird weder
     * geaendert noch wiederbelebt, und eine Kennung, die bereits ein Vorgang
     * ist, wird kein neuer Entwurf.
     */
    if not public.workspace_user_can_intake(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_order_draft_id := coalesce(nullif(trim(p_payload->>'draft_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_order_draft_id is null then
      raise exception 'draft_id fehlt';
    end if;

    v_order_draft_payload := coalesce(p_payload->'payload', '{}'::jsonb);
    v_deleted := coalesce((p_payload->>'deleted')::boolean, false);

    if not v_deleted then
      if jsonb_typeof(v_order_draft_payload) <> 'object' then
        raise exception 'Auftragsentwurf ungueltig: payload' using errcode = 'P0001';
      end if;
      if v_order_draft_payload->>'id' is distinct from v_order_draft_id then
        raise exception 'Auftragsentwurf ungueltig: id' using errcode = 'P0001';
      end if;
      if jsonb_typeof(v_order_draft_payload->'customerBilling') is distinct from 'object' then
        raise exception 'Auftragsentwurf ungueltig: Rechnungsanschrift' using errcode = 'P0001';
      end if;
      if jsonb_typeof(v_order_draft_payload->'positions') is distinct from 'array' then
        raise exception 'Auftragsentwurf ungueltig: Positionen' using errcode = 'P0001';
      end if;
      if exists (
        select 1
        from jsonb_array_elements(v_order_draft_payload->'positions') p
        where jsonb_typeof(p) <> 'object' or nullif(trim(coalesce(p->>'id', '')), '') is null
      ) then
        raise exception 'Auftragsentwurf ungueltig: Positionen' using errcode = 'P0001';
      end if;
      /* Nummern und eingefrorener Stand entstehen ausschliesslich in create_workspace_order. */
      if v_order_draft_payload ?| array['orderNumber', 'vorgangNumber', 'contractConfirmation', 'orderPositions',
                                        'orderDate', 'contractTotals'] then
        raise exception 'Auftragsentwurf ungueltig: Auftragsdaten' using errcode = 'P0001';
      end if;
      /* Der Workspace ist der Scope dieser Zeile; Geraetelokales reist nie. */
      if v_order_draft_payload ?| array['workspaceId', 'sync', 'conflict', 'status'] then
        raise exception 'Auftragsentwurf ungueltig: lokale Felder' using errcode = 'P0001';
      end if;
      if length(v_order_draft_payload::text) > 262144 then
        raise exception 'Auftragsentwurf ungueltig: zu gross' using errcode = 'P0001';
      end if;
    end if;

    select d.* into v_row_order_draft
    from public.workspace_order_drafts d
    where d.workspace_id = p_workspace_id and d.client_draft_id = v_order_draft_id
    for update;
    v_current_version := v_row_order_draft.row_version;

    /*
     * 01G/01G2 -- unbestaetigte Version bei vorhandener Zeile, wie bei S5:
     * identischer Inhalt ist eine Wiederholung, beide Seiten verworfen
     * ebenfalls, alles andere ist ein Konflikt. Ein verbrauchter Entwurf ist
     * nie die Wiederholung eines Schreibvorgangs.
     */
    if v_current_version is not null and p_row_version <= 0 then
      if v_row_order_draft.deleted and v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_order_draft_id,
          'row_version', v_row_order_draft.row_version,
          'payload', to_jsonb(v_row_order_draft),
          'deleted', true,
          'replayed', true
        );
      end if;
      if v_row_order_draft.status = 'active' and not v_row_order_draft.deleted and not v_deleted
         and v_row_order_draft.payload = v_order_draft_payload then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_order_draft_id,
          'row_version', v_row_order_draft.row_version,
          'payload', to_jsonb(v_row_order_draft),
          'deleted', false,
          'replayed', true
        );
      end if;
      raise exception 'Versionskonflikt order_draft:%', v_current_version using errcode = 'P0001';
    end if;

    if v_current_version is null then
      /*
       * Eine Kennung, die bereits ein Vorgang ist, ist ein erledigter Entwurf --
       * auch ohne eigene Zeile (Anlage vor S6 oder ohne Bindung). Sie wird
       * nicht als neuer Entwurf angelegt.
       */
      if not v_deleted and exists (
        select 1 from public.workspace_vorgaenge v
        where v.workspace_id = p_workspace_id and v.vorgang_id = v_order_draft_id
      ) then
        raise exception 'Versionskonflikt order_draft:0' using errcode = 'P0001';
      end if;
      begin
        insert into public.workspace_order_drafts (
          workspace_id,
          client_draft_id,
          status,
          payload,
          row_version,
          deleted,
          deleted_at,
          created_by,
          updated_by
        )
        values (
          p_workspace_id,
          v_order_draft_id,
          'active',
          case when v_deleted then '{}'::jsonb else v_order_draft_payload end,
          1,
          v_deleted,
          case when v_deleted then now() else null end,
          auth.uid(),
          auth.uid()
        )
        returning to_jsonb(public.workspace_order_drafts.*) into v_result;
      exception
        when unique_violation then
          -- Derselbe Entwurf wurde gleichzeitig angelegt: ein Konflikt, kein Ueberschreiben.
          raise exception 'Versionskonflikt order_draft:0' using errcode = 'P0001';
      end;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt order_draft:%', v_current_version using errcode = 'P0001';
      end if;
      /* Ein zweites Verwerfen desselben Grabsteins aendert nichts. */
      if v_row_order_draft.deleted and v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_order_draft_id,
          'row_version', v_row_order_draft.row_version,
          'payload', to_jsonb(v_row_order_draft),
          'deleted', true,
          'replayed', true
        );
      end if;
      /*
       * Kein Wiederbeleben und keine Aenderung nach dem Ende: Verworfen bleibt
       * verworfen, verbraucht bleibt verbraucht -- auch mit passender Version.
       * Wer weiterarbeiten will, beginnt einen neuen Entwurf mit neuer Kennung.
       */
      if v_row_order_draft.deleted or v_row_order_draft.status <> 'active' then
        raise exception 'Versionskonflikt order_draft:%', v_current_version using errcode = 'P0001';
      end if;

      update public.workspace_order_drafts
      set
        payload = case when v_deleted then '{}'::jsonb else v_order_draft_payload end,
        deleted = v_deleted,
        deleted_at = case when v_deleted then coalesce(deleted_at, now()) else null end,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id and client_draft_id = v_order_draft_id
      returning to_jsonb(public.workspace_order_drafts.*) into v_result;
    end if;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_order_draft_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result,
      'deleted', (v_result->>'deleted')::boolean
    );

  elsif p_entity_type = 'order_amendment_draft' then
    /*
     * CLOUD-SYNC S6 -- der Nachtragsentwurf.
     *
     * Rechte wie im Produkt: Vorbereiten und Bearbeiten eines Nachtrags prueft
     * keine Rolle (`workspace_user_can_intake`). Die Bestaetigung bleibt
     * unveraendert in confirm_workspace_order_amendment.
     *
     * Ein Nachtragsentwurf gehoert genau einem bestaetigten Auftrag und
     * wechselt ihn nie. Keine Sequenz, kein Fingerprint, keine Intent- oder
     * Bestaetigungsdaten: Die Sequenz entsteht erst bei der Bestaetigung,
     * Intent und Wiederanlauf bleiben geraetelokal.
     */
    if not public.workspace_user_can_intake(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_amend_draft_id := coalesce(nullif(trim(p_payload->>'draft_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_amend_draft_id is null then
      raise exception 'draft_id fehlt';
    end if;
    v_amend_draft_vorgang_id := nullif(trim(coalesce(p_payload->>'vorgang_id', '')), '');
    if v_amend_draft_vorgang_id is null or v_amend_draft_vorgang_id <> (p_payload->>'vorgang_id') then
      raise exception 'Nachtragsentwurf ungueltig: vorgang_id' using errcode = 'P0001';
    end if;

    v_amend_draft_payload := coalesce(p_payload->'payload', '{}'::jsonb);
    v_deleted := coalesce((p_payload->>'deleted')::boolean, false);

    if not v_deleted then
      if jsonb_typeof(v_amend_draft_payload) <> 'object' then
        raise exception 'Nachtragsentwurf ungueltig: payload' using errcode = 'P0001';
      end if;
      if v_amend_draft_payload->>'id' is distinct from v_amend_draft_id then
        raise exception 'Nachtragsentwurf ungueltig: id' using errcode = 'P0001';
      end if;
      if v_amend_draft_payload->>'vorgangId' is distinct from v_amend_draft_vorgang_id then
        raise exception 'Nachtragsentwurf ungueltig: vorgangId' using errcode = 'P0001';
      end if;
      if jsonb_typeof(v_amend_draft_payload->'title') is distinct from 'string' then
        raise exception 'Nachtragsentwurf ungueltig: Titel' using errcode = 'P0001';
      end if;
      if jsonb_typeof(v_amend_draft_payload->'positions') is distinct from 'array' then
        raise exception 'Nachtragsentwurf ungueltig: Positionen' using errcode = 'P0001';
      end if;
      if exists (
        select 1
        from jsonb_array_elements(v_amend_draft_payload->'positions') p
        where jsonb_typeof(p) <> 'object'
           or nullif(trim(coalesce(p->>'id', '')), '') is null
           or p ?| array['sourceAmendmentId', 'sourceAmendmentSequence', 'executedQuantity', 'plannedQuantity']
      ) then
        raise exception 'Nachtragsentwurf ungueltig: Positionen' using errcode = 'P0001';
      end if;
      /* Sequenz, Fingerprint und Bestaetigung entstehen erst bei der Bestaetigung; Intent und Wiederanlauf bleiben geraetelokal. */
      if v_amend_draft_payload ?| array['sequence', 'sequenceNo', 'expectedAmendmentSequence', 'clientAmendmentId',
                                        'contentFingerprint', 'fingerprint', 'rpcInput', 'intent', 'state',
                                        'confirmedAt', 'confirmedBy', 'sourceDraftId', 'localSourceDraftId'] then
        raise exception 'Nachtragsentwurf ungueltig: Bestaetigungsdaten' using errcode = 'P0001';
      end if;
      if v_amend_draft_payload ?| array['workspaceId', 'sync', 'conflict', 'status'] then
        raise exception 'Nachtragsentwurf ungueltig: lokale Felder' using errcode = 'P0001';
      end if;
      if length(v_amend_draft_payload::text) > 262144 then
        raise exception 'Nachtragsentwurf ungueltig: zu gross' using errcode = 'P0001';
      end if;
    end if;

    /*
     * Der Auftrag wird nur gelesen, nicht gesperrt: Die Bestaetigung sperrt
     * zuerst den Vorgang und danach diesen Entwurf. Hielte dieser Zweig den
     * Entwurf und wartete auf den Vorgang, entstuende eine Sperrkette. Die
     * Bestaetigung prueft den Auftrag ohnehin selbst unter Sperre.
     */
    select v.* into v_amend_draft_vorgang
    from public.workspace_vorgaenge v
    where v.workspace_id = p_workspace_id and v.vorgang_id = v_amend_draft_vorgang_id;

    select d.* into v_row_amend_draft
    from public.workspace_order_amendment_drafts d
    where d.workspace_id = p_workspace_id and d.client_draft_id = v_amend_draft_id
    for update;
    v_current_version := v_row_amend_draft.row_version;

    /* Ein Nachtragsentwurf wechselt nie seinen Auftrag. */
    if v_current_version is not null and v_row_amend_draft.vorgang_id is distinct from v_amend_draft_vorgang_id then
      raise exception 'Nachtragsentwurf ungueltig: Auftrag' using errcode = 'P0001';
    end if;

    /* 01G/01G2 -- wie beim Auftragsentwurf. */
    if v_current_version is not null and p_row_version <= 0 then
      if v_row_amend_draft.deleted and v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_amend_draft_id,
          'row_version', v_row_amend_draft.row_version,
          'payload', to_jsonb(v_row_amend_draft),
          'deleted', true,
          'replayed', true
        );
      end if;
      if v_row_amend_draft.status = 'active' and not v_row_amend_draft.deleted and not v_deleted
         and v_row_amend_draft.payload = v_amend_draft_payload then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_amend_draft_id,
          'row_version', v_row_amend_draft.row_version,
          'payload', to_jsonb(v_row_amend_draft),
          'deleted', false,
          'replayed', true
        );
      end if;
      raise exception 'Versionskonflikt order_amendment_draft:%', v_current_version using errcode = 'P0001';
    end if;

    /*
     * Ein Grabstein fuer einen Entwurf, den die Cloud nie gesehen hat, zu einem
     * Auftrag, den sie nicht kennt, ist gegenstandslos: Es gibt nichts
     * wiederzubeleben und nichts festzuhalten.
     */
    if v_current_version is null and v_deleted and v_amend_draft_vorgang.vorgang_id is null then
      return jsonb_build_object(
        'entity_type', p_entity_type,
        'entity_id', v_amend_draft_id,
        'row_version', 0,
        'payload', '{}'::jsonb,
        'deleted', true,
        'replayed', true
      );
    end if;

    /* Nur zu einem bestehenden, bestaetigten Auftrag -- wie im Produkt. */
    if not v_deleted then
      if v_amend_draft_vorgang.vorgang_id is null or v_amend_draft_vorgang.deleted then
        raise exception 'Nachtragsentwurf ungueltig: Auftrag fehlt' using errcode = 'P0001';
      end if;
      if jsonb_typeof(v_amend_draft_vorgang.payload->'contractConfirmation') is distinct from 'object' then
        raise exception 'Nachtragsentwurf ungueltig: Auftrag nicht bestaetigt' using errcode = 'P0001';
      end if;
    end if;

    if v_current_version is null then
      begin
        insert into public.workspace_order_amendment_drafts (
          workspace_id,
          client_draft_id,
          vorgang_id,
          status,
          payload,
          row_version,
          deleted,
          deleted_at,
          created_by,
          updated_by
        )
        values (
          p_workspace_id,
          v_amend_draft_id,
          v_amend_draft_vorgang_id,
          'active',
          case when v_deleted then '{}'::jsonb else v_amend_draft_payload end,
          1,
          v_deleted,
          case when v_deleted then now() else null end,
          auth.uid(),
          auth.uid()
        )
        returning to_jsonb(public.workspace_order_amendment_drafts.*) into v_result;
      exception
        when unique_violation then
          raise exception 'Versionskonflikt order_amendment_draft:0' using errcode = 'P0001';
      end;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt order_amendment_draft:%', v_current_version using errcode = 'P0001';
      end if;
      if v_row_amend_draft.deleted and v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_amend_draft_id,
          'row_version', v_row_amend_draft.row_version,
          'payload', to_jsonb(v_row_amend_draft),
          'deleted', true,
          'replayed', true
        );
      end if;
      /* Verworfen bleibt verworfen, bestaetigt bleibt bestaetigt -- auch mit passender Version. */
      if v_row_amend_draft.deleted or v_row_amend_draft.status <> 'active' then
        raise exception 'Versionskonflikt order_amendment_draft:%', v_current_version using errcode = 'P0001';
      end if;

      update public.workspace_order_amendment_drafts
      set
        payload = case when v_deleted then '{}'::jsonb else v_amend_draft_payload end,
        deleted = v_deleted,
        deleted_at = case when v_deleted then coalesce(deleted_at, now()) else null end,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id and client_draft_id = v_amend_draft_id
      returning to_jsonb(public.workspace_order_amendment_drafts.*) into v_result;
    end if;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_amend_draft_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result,
      'deleted', (v_result->>'deleted')::boolean
    );

  else
    raise exception 'Unbekannter Entity-Typ: %', p_entity_type;
  end if;
end;
$$;

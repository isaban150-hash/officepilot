-- EINRICHTUNG-01 / AP6 -- Firmenprofil, Vorlagen und Antwortadresse (Szenariopaket Fassung 2, Vertraege 1.19, 1.21, 1.22;
-- Migration 20261202120000_einrichtung01_ap6_profil_kommunikation.sql).
--
--   V-03.2   neue Vorlagenfelder im Server-Katalog mit introduced_in = 3; Schema 2 bewahrt sie
--   V-03.1   Fusszeile, Hinweis steuerfrei, Vorlagen: 2000 Codepunkte (Grenze-1, Grenze, Grenze+1)
--   E-02.1   Betreffe (Rechnung, Angebot, Brief): 255 Codepunkte, ohne Zeilenumbruch
--   E-04.1   Anzeigename: < @ Zeilenumbruch, 121 Codepunkte, E-Mail-Adresse -> display_name_invalid
--   V-01.2   Angebotsgueltigkeit 0, 366, "abc" abgewiesen; E-05 Sprache nur de, tr, bg
--   E18      Altbestand bleibt speicherbar: geprueft wird nur ein geaenderter Wert
--   E-03.1-E-03.13 (S-Anteil)  Antwortadresse: Ausgabe, Fristen, Bindung, Bestaetigung, Idempotenz, Versuchslimit,
--            Rueckfall auf die bestaetigte Anmelde-E-Mail des aktuellen Inhabers, fail-closed
--   Rechte   Dienstrolle-Funktionen ohne Client-Rechte; Statusabfrage nur angemeldet und nur Inhaber/Admin
--
-- Nur in einer Wegwerf-Kopie nach Anwendung der Migration ausfuehren (Werkzeug
-- pruefunterlagen/einrichtung-01/werkzeug/ap6/ap-sql-isoliert.mjs). Alles wird zurueckgerollt.
\set ON_ERROR_STOP on
\pset tuples_only on

begin;

create function pg_temp.als(p_user uuid) returns void language plpgsql as $p$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
end;
$p$;

create function pg_temp.zurueck() returns void language plpgsql as $p$
begin
  reset role;
  perform set_config('request.jwt.claims', '{}', true);
end;
$p$;

create function pg_temp.pruefe(p_ok boolean, p_label text) returns void language plpgsql as $p$
begin
  if not coalesce(p_ok, false) then
    raise exception 'FEHLER %', p_label;
  end if;
end;
$p$;

create function pg_temp.erwarte_abweisung(p_label text, p_sql text, p_text text) returns void language plpgsql as $p$
begin
  begin
    execute p_sql;
  exception when others then
    if position(p_text in sqlerrm) = 0 then
      raise exception '% -- falsche Abweisung: % (erwartet: %)', p_label, sqlerrm, p_text;
    end if;
    return;
  end;
  raise exception '% -- NICHT abgewiesen, erwartet: %', p_label, p_text;
end;
$p$;

/** Genau p_n Codepunkte aus ae, Euro und Bauarbeiter im Wechsel. */
create function pg_temp.text_n(p_n integer) returns text language sql immutable as $p$
  select coalesce(string_agg(case i % 3 when 0 then chr(228) when 1 then chr(8364) else chr(128119) end, '' order by i), '')
  from generate_series(0, p_n - 1) as i
$p$;

create function pg_temp.hash(p_token text) returns text language sql immutable as $p$
  select encode(extensions.digest(p_token, 'sha256'), 'hex')
$p$;

create function pg_temp.w1() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-0000000e6ca1'::uuid $p$;
create function pg_temp.w2() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-0000000e6ca2'::uuid $p$;
create function pg_temp.w3() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-0000000e6ca3'::uuid $p$;
create function pg_temp.o1() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-0000000e6c01'::uuid $p$;
create function pg_temp.a1() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-0000000e6c02'::uuid $p$;
create function pg_temp.m1() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-0000000e6c03'::uuid $p$;
create function pg_temp.o2() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-0000000e6c04'::uuid $p$;
create function pg_temp.o3() returns uuid language sql immutable as $p$ select '00000000-0000-0000-0000-0000000e6c05'::uuid $p$;

/** Profil von W1 direkt aendern (Trigger greifen fuer jede Rolle). */
create function pg_temp.setze(p_ws uuid, p_felder jsonb) returns void language sql as $p$
  update public.workspace_company_profiles set payload = payload || p_felder where workspace_id = p_ws;
$p$;

/** Als Nutzer ueber den Sync-Weg schreiben; eine Abweisung nimmt Rolle und Claims mit der Subtransaktion zurueck. */
create function pg_temp.sende(p_user uuid, p_ws uuid, p_payload jsonb, p_version bigint) returns jsonb language plpgsql as $p$
declare
  v jsonb;
begin
  perform pg_temp.als(p_user);
  v := public.upsert_workspace_sync_entity(p_ws, 'company_profile', p_payload, p_version);
  perform pg_temp.zurueck();
  return v;
end;
$p$;

create function pg_temp.status_als(p_user uuid, p_ws uuid) returns jsonb language plpgsql as $p$
declare
  v jsonb;
begin
  perform pg_temp.als(p_user);
  v := public.get_workspace_reply_to_status(p_ws);
  perform pg_temp.zurueck();
  return v;
end;
$p$;

create function pg_temp.einladung_als(p_user uuid, p_invitation uuid) returns jsonb language plpgsql as $p$
declare
  v jsonb;
begin
  perform pg_temp.als(p_user);
  v := public.resolve_workspace_reply_to_for_invitation(p_invitation);
  perform pg_temp.zurueck();
  return v;
end;
$p$;

/** Zustand der Antwortadresse eines Betriebs als Text (fuer Vergleiche). */
create function pg_temp.zustand(p_ws uuid) returns text language sql as $p$
  select coalesce(address, '-') || '|' || revision || '|' || coalesce(confirmed_address, '-') || '|' || coalesce(confirmed_revision::text, '-')
  from public.workspace_reply_to_state where workspace_id = p_ws
$p$;

-- Konten (synthetisch); O3 mit unbestaetigter Anmelde-E-Mail (E-03.11).
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
select v.id::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', v.email, 'x',
       case when v.bestaetigt then now() end, now(), now(), '{}', jsonb_build_object('firstName', v.vorname, 'lastName', 'AP6')
from (values
  ('00000000-0000-0000-0000-0000000e6c01', 'o1-ap6@example.invalid', 'Olga', true),
  ('00000000-0000-0000-0000-0000000e6c02', 'a1-ap6@example.invalid', 'Anton', true),
  ('00000000-0000-0000-0000-0000000e6c03', 'm1-ap6@example.invalid', 'Mira', true),
  ('00000000-0000-0000-0000-0000000e6c04', 'o2-ap6@example.invalid', 'Otto', true),
  ('00000000-0000-0000-0000-0000000e6c05', 'o3-ap6@example.invalid', 'Oda', false)
) as v(id, email, vorname, bestaetigt);
update public.profiles set status = 'approved', license_status = 'active', license_expires_at = null
where id in (pg_temp.o1(), pg_temp.a1(), pg_temp.m1(), pg_temp.o2(), pg_temp.o3());

insert into public.workspaces (id, name, owner_user_id) values
  (pg_temp.w1(), 'AP6 W1', pg_temp.o1()),
  (pg_temp.w2(), 'AP6 W2', pg_temp.o2()),
  (pg_temp.w3(), 'AP6 W3', pg_temp.o3());
insert into public.workspace_members (workspace_id, user_id, role, status) values
  (pg_temp.w1(), pg_temp.o1(), 'owner', 'active'),
  (pg_temp.w1(), pg_temp.a1(), 'admin', 'active'),
  (pg_temp.w1(), pg_temp.m1(), 'member', 'active'),
  (pg_temp.w2(), pg_temp.o2(), 'owner', 'active'),
  (pg_temp.w3(), pg_temp.o3(), 'owner', 'active');
insert into public.workspace_company_profiles (workspace_id, payload, row_version, updated_by) values
  (pg_temp.w1(), '{"companyName":"AP6 W1","street":"Musterweg 1","zip":"33602","city":"Bielefeld","email":"info@w1.example.invalid","taxNumber":"133/8150/8159","defaultPaymentDays":14}'::jsonb, 1, pg_temp.o1()),
  (pg_temp.w2(), '{"companyName":"AP6 W2","email":"info@w2.example.invalid"}'::jsonb, 1, pg_temp.o2()),
  (pg_temp.w3(), '{"companyName":"AP6 W3","replyToEmail":"antwort@w3.example.invalid"}'::jsonb, 1, pg_temp.o3());

/* ------------------------------------------------------------------ */
/* V-03.2 Katalog                                                      */
/* ------------------------------------------------------------------ */
do $t$
declare
  v_src text;
  v_feld text;
begin
  select pg_get_functiondef(p.oid) into v_src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'upsert_workspace_sync_entity';
  foreach v_feld in array array['offerValidityDays', 'offerIntroText', 'offerClosingText', 'orderIntroText',
                                 'orderClosingText', 'letterSalutation', 'letterClosing', 'communicationLanguage'] loop
    perform pg_temp.pruefe(position(format('(%L, 3)', v_feld) in v_src) > 0, format('V-03.2 Katalog %s mit introduced_in = 3', v_feld));
  end loop;
  raise notice 'OK  V-03.2 Katalog: 8 neue Felder mit introduced_in = 3';
end;
$t$;

do $t$
declare
  v_version bigint;
  v jsonb;
begin
  -- Schema-3-Patch setzt die neuen Felder.
  select row_version into v_version from public.workspace_company_profiles where workspace_id = pg_temp.w1();
  v := pg_temp.sende(pg_temp.o1(), pg_temp.w1(),
    jsonb_build_object('profile_schema_version', 3, 'payload', jsonb_build_object(
      'offerValidityDays', 14, 'offerIntroText', 'Gern bieten wir an:', 'offerClosingText', 'Wir freuen uns.',
      'orderIntroText', 'Danke fuer den Auftrag.', 'orderClosingText', 'Mit Gruss', 'letterSalutation', 'Guten Tag,',
      'letterClosing', 'Freundliche Gruesse', 'communicationLanguage', 'tr')), v_version);
  -- Ein Schreiber mit Schema 2 kennt die Felder nicht und sendet das ganze Profil ohne sie.
  select row_version into v_version from public.workspace_company_profiles where workspace_id = pg_temp.w1();
  v := pg_temp.sende(pg_temp.o1(), pg_temp.w1(),
    jsonb_build_object('profile_schema_version', 2, 'payload', jsonb_build_object(
      'companyName', 'AP6 W1', 'street', 'Musterweg 1', 'zip', '33602', 'city', 'Bielefeld', 'email', 'info@w1.example.invalid',
      'taxNumber', '133/8150/8159', 'defaultPaymentDays', 14, 'phone', '0521 1')), v_version);
  perform pg_temp.pruefe(
    (select payload->>'offerValidityDays' = '14' and payload->>'offerIntroText' = 'Gern bieten wir an:'
            and payload->>'letterClosing' = 'Freundliche Gruesse' and payload->>'communicationLanguage' = 'tr'
            and payload->>'phone' = '0521 1'
       from public.workspace_company_profiles where workspace_id = pg_temp.w1()),
    'V-03.2 Schema 2 bewahrt die neuen Felder');
  raise notice 'OK  V-03.2 Schema-2-Schreiber bewahrt offerValidityDays, Vorlagen und Sprache';
end;
$t$;

/* ------------------------------------------------------------------ */
/* V-03.1, E-02.1, E-04.1, V-01.2, E-05 Grenzen                        */
/* ------------------------------------------------------------------ */
do $t$
declare
  v_feld text;
begin
  foreach v_feld in array array['invoiceFooterNotes', 'taxFreeNotice', 'offerIntroText', 'offerClosingText',
                                 'orderIntroText', 'orderClosingText', 'letterSalutation', 'letterClosing'] loop
    perform pg_temp.setze(pg_temp.w1(), jsonb_build_object(v_feld, pg_temp.text_n(1999)));
    perform pg_temp.setze(pg_temp.w1(), jsonb_build_object(v_feld, pg_temp.text_n(2000)));
    perform pg_temp.erwarte_abweisung(format('V-03.1c %s', v_feld),
      format('select pg_temp.setze(pg_temp.w1(), jsonb_build_object(%L, pg_temp.text_n(2001)))', v_feld),
      format('Firmenprofil ungueltig: %s', v_feld));
    perform pg_temp.pruefe((select length(payload->>v_feld) = 2000 from public.workspace_company_profiles where workspace_id = pg_temp.w1()),
      format('V-03.1 %s bleibt bei 2000', v_feld));
  end loop;
  raise notice 'OK  V-03.1a-c Fusszeile, Hinweis steuerfrei und sechs Vorlagenfelder: 1999 und 2000 gespeichert, 2001 abgewiesen';
end;
$t$;

do $t$
declare
  v_version bigint;
  v_feld text;
begin
  -- E-02.1 ueber den Sync-Weg (Validator 1.10): 255 gespeichert, 256 und Zeilenumbruch abgewiesen.
  foreach v_feld in array array['defaultInvoiceEmailSubject', 'defaultOfferEmailSubject', 'defaultLetterEmailSubject'] loop
    select row_version into v_version from public.workspace_company_profiles where workspace_id = pg_temp.w1();
    perform pg_temp.sende(pg_temp.o1(), pg_temp.w1(),
      jsonb_build_object('profile_schema_version', 3, 'payload', jsonb_build_object(v_feld, pg_temp.text_n(255))), v_version);
    perform pg_temp.erwarte_abweisung(format('E-02.1c %s', v_feld), format(
      'select pg_temp.sende(%L::uuid, %L::uuid, jsonb_build_object(%L, 3, %L, jsonb_build_object(%L, pg_temp.text_n(256))), %s)',
      pg_temp.o1(), pg_temp.w1(), 'profile_schema_version', 'payload', v_feld, v_version + 1), 'Firmenprofil ungueltig');
    perform pg_temp.erwarte_abweisung(format('E-02.2 %s', v_feld), format(
      'select pg_temp.sende(%L::uuid, %L::uuid, jsonb_build_object(%L, 3, %L, jsonb_build_object(%L, %L || chr(10) || %L)), %s)',
      pg_temp.o1(), pg_temp.w1(), 'profile_schema_version', 'payload', v_feld, 'Zeile', 'Zwei', v_version + 1), 'Firmenprofil ungueltig');
    perform pg_temp.pruefe((select length(payload->>v_feld) = 255 from public.workspace_company_profiles where workspace_id = pg_temp.w1()), format('E-02.1 %s bleibt bei 255', v_feld));
  end loop;
  raise notice 'OK  E-02.1a-c/E-02.2 Betreffe Rechnung, Angebot, Brief: 255 gespeichert, 256 und Zeilenumbruch abgewiesen';
end;
$t$;

do $t$
declare
  v_wert text;
begin
  foreach v_wert in array array['Muster <b>', 'Muster @ Bau', 'info@muster.example.invalid', 'Muster "Bau"',
                                 'Zeile' || chr(10) || 'Zwei', 'Zeile' || chr(8232) || 'Zwei', pg_temp.text_n(121)] loop
    perform pg_temp.erwarte_abweisung(format('E-04.1 %s', left(v_wert, 20)),
      format('select pg_temp.setze(pg_temp.w1(), jsonb_build_object(%L, %L))', 'senderDisplayName', v_wert), 'display_name_invalid');
  end loop;
  perform pg_temp.setze(pg_temp.w1(), jsonb_build_object('senderDisplayName', pg_temp.text_n(120)));
  perform pg_temp.setze(pg_temp.w1(), jsonb_build_object('senderDisplayName', 'Muster Bau GmbH'));
  raise notice 'OK  E-04.1 Anzeigename: < @ " Zeilenumbruch, U+2028, 121 Codepunkte und E-Mail-Adresse abgewiesen; 120 gespeichert';
end;
$t$;

do $t$
declare
  v_wert jsonb;
begin
  foreach v_wert in array array['0'::jsonb, '366'::jsonb, '"abc"'::jsonb, '14.5'::jsonb, '-3'::jsonb, '"14"'::jsonb] loop
    perform pg_temp.erwarte_abweisung(format('V-01.2 %s', v_wert),
      format('select pg_temp.setze(pg_temp.w1(), jsonb_build_object(%L, %L::jsonb))', 'offerValidityDays', v_wert), 'offerValidityDays');
  end loop;
  perform pg_temp.setze(pg_temp.w1(), '{"offerValidityDays": 1}');
  perform pg_temp.setze(pg_temp.w1(), '{"offerValidityDays": 365}');
  foreach v_wert in array array['"fr"'::jsonb, '"DE"'::jsonb, '1'::jsonb] loop
    perform pg_temp.erwarte_abweisung(format('E-05 Sprache %s', v_wert),
      format('select pg_temp.setze(pg_temp.w1(), jsonb_build_object(%L, %L::jsonb))', 'communicationLanguage', v_wert), 'communicationLanguage');
  end loop;
  perform pg_temp.setze(pg_temp.w1(), '{"communicationLanguage": "bg"}');
  raise notice 'OK  V-01.2 Gueltigkeit 0, 366, "abc", 14.5, -3, "14" abgewiesen; 1 und 365 gespeichert; E-05 nur de, tr, bg';
end;
$t$;

do $t$
begin
  -- E18: ein aelterer, ungueltiger Wert (vor der Migration gespeichert) blockiert andere Aenderungen nicht.
  alter table public.workspace_company_profiles disable trigger einrichtung01_company_profile_changes_check;
  perform pg_temp.setze(pg_temp.w2(), jsonb_build_object('senderDisplayName', 'alt@bestand.example.invalid', 'invoiceFooterNotes', pg_temp.text_n(2500)));
  alter table public.workspace_company_profiles enable trigger einrichtung01_company_profile_changes_check;
  perform pg_temp.setze(pg_temp.w2(), '{"phone": "0521 2"}');
  perform pg_temp.pruefe((select payload->>'phone' = '0521 2' from public.workspace_company_profiles where workspace_id = pg_temp.w2()), 'E18 Altbestand speicherbar');
  perform pg_temp.erwarte_abweisung('E18 geaenderter Altwert wird geprueft',
    format('select pg_temp.setze(%L::uuid, jsonb_build_object(%L, %L))', pg_temp.w2(), 'senderDisplayName', 'neu@bestand.example.invalid'), 'display_name_invalid');
  raise notice 'OK  E18 nur geaenderte Werte werden geprueft: Altbestand bleibt speicherbar, eine Aenderung daran wird geprueft';
end;
$t$;

/* ------------------------------------------------------------------ */
/* E-03 Antwortadresse                                                 */
/* ------------------------------------------------------------------ */
do $t$
declare
  v jsonb;
begin
  -- Ohne eigene Antwortadresse: Rueckfall auf die bestaetigte Anmelde-E-Mail des Inhabers (E18).
  v := public.resolve_workspace_reply_to(pg_temp.w1());
  perform pg_temp.pruefe(v->>'email' = 'o1-ap6@example.invalid' and v->>'source' = 'owner_login', 'E18 ohne Antwortadresse: Inhaber-Anmeldung');
  -- E-03.1: neue Antwortadresse -> Zustand Revision 1, unbestaetigt; Versand weiter mit der Inhaber-Anmeldung.
  perform pg_temp.setze(pg_temp.w1(), '{"replyToEmail": " Antwort@W1.example.invalid "}');
  -- Der Zustand entsteht mit dem Profil (Revision 1, ohne Adresse); die neue Adresse ist Revision 2.
  perform pg_temp.pruefe(pg_temp.zustand(pg_temp.w1()) = 'antwort@w1.example.invalid|2|-|-', 'E-03.1 Zustand ' || coalesce(pg_temp.zustand(pg_temp.w1()), 'null'));
  v := public.resolve_workspace_reply_to(pg_temp.w1());
  perform pg_temp.pruefe(v->>'email' = 'o1-ap6@example.invalid' and v->>'source' = 'owner_login', 'E-03.1 unbestaetigt: Inhaber-Anmeldung');
  -- Firmen-E-Mail und Antwortadresse werden nie verwendet, solange nicht bestaetigt (E-03.9 S-Anteil).
  perform pg_temp.pruefe(v->>'email' not in ('info@w1.example.invalid', 'antwort@w1.example.invalid'), 'E-03.9 keine unbestaetigte Wunschadresse');
  raise notice 'OK  E-03.1/E18 neue Antwortadresse unbestaetigt (neue Revision); Versand nutzt die bestaetigte Anmelde-E-Mail des Inhabers';
end;
$t$;

do $t$
declare
  v jsonb;
begin
  v := public.reply_to_confirmation_issue(pg_temp.w1(), pg_temp.m1(), pg_temp.hash('t-m1-' || repeat('x', 40)), 'antwort@w1.example.invalid');
  perform pg_temp.pruefe(v->>'code' = 'forbidden', 'E-03 Mitglied darf keine Bestaetigung anfordern: ' || v::text);
  v := public.reply_to_confirmation_issue(pg_temp.w1(), pg_temp.o2(), pg_temp.hash('t-o2-' || repeat('x', 40)), 'antwort@w1.example.invalid');
  perform pg_temp.pruefe(v->>'code' = 'forbidden', 'E-03 fremder Inhaber darf nicht: ' || v::text);
  v := public.reply_to_confirmation_issue(pg_temp.w1(), pg_temp.o1(), pg_temp.hash('t-falsch-' || repeat('x', 40)), 'andere@w1.example.invalid');
  perform pg_temp.pruefe(v->>'code' = 'address_mismatch', 'E-03 nur die aktuelle Adresse: ' || v::text);
  v := public.reply_to_confirmation_issue(pg_temp.w1(), pg_temp.o1(), 'kein-hash', 'antwort@w1.example.invalid');
  perform pg_temp.pruefe(v->>'code' = 'invalid_request', 'E-03 Hash-Format: ' || v::text);
  v := public.reply_to_confirmation_issue(pg_temp.w2(), pg_temp.o2(), pg_temp.hash('t-w2-' || repeat('x', 40)), 'irgendwer@w2.example.invalid');
  perform pg_temp.pruefe(v->>'code' = 'reply_to_missing', 'E-03 ohne Antwortadresse: ' || v::text);
  perform pg_temp.pruefe((select count(*) = 0 from public.workspace_reply_to_tokens), 'E-03 Abweisungen erzeugen keine Bestaetigung');
  raise notice 'OK  E-03 Ausgabe nur fuer Inhaber/Admin des Betriebs, nur fuer die aktuelle Adresse, nur mit Hash';
end;
$t$;

create temp table merk (k text primary key, v text);

do $t$
declare
  v jsonb;
begin
  v := public.reply_to_confirmation_issue(pg_temp.w1(), pg_temp.o1(), pg_temp.hash('token-1-' || repeat('a', 35)), 'antwort@w1.example.invalid');
  perform pg_temp.pruefe(v->>'ok' = 'true' and v->>'address' = 'antwort@w1.example.invalid' and (v->>'revision')::int = 2, 'E-03 Ausgabe O1: ' || v::text);
  perform pg_temp.pruefe((select expires_at - created_at = interval '72 hours' and token_hash = pg_temp.hash('token-1-' || repeat('a', 35))
                            from public.workspace_reply_to_tokens), 'E-03 72 Stunden, nur Hash gespeichert');
  perform pg_temp.pruefe(not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'workspace_reply_to_tokens' and column_name ~ 'token' and column_name <> 'token_hash'),
    'E-03 keine Klartextspalte');
  -- E-03.4: vor Ablauf von 10 Minuten abgewiesen, mit fruehestem Zeitpunkt.
  v := public.reply_to_confirmation_issue(pg_temp.w1(), pg_temp.a1(), pg_temp.hash('token-x-' || repeat('a', 35)), 'antwort@w1.example.invalid');
  perform pg_temp.pruefe(v->>'code' = 'resend_too_early' and v ? 'retry_after', 'E-03.4 zu frueh: ' || v::text);
  perform public.reply_to_confirmation_mark_sent(pg_temp.hash('token-1-' || repeat('a', 35)), pg_temp.o1());
  perform pg_temp.pruefe((select count(*) = 1 and bool_and(details->>'address' = 'a***@w1.example.invalid')
                            from public.workspace_reply_to_events where workspace_id = pg_temp.w1() and action = 'reply_to_confirmation_sent'),
    'E-03 Pruefspur mit maskierter Adresse');
  raise notice 'OK  E-03.1/E-03.4 Bestaetigung 72 h, nur Hash; erneut senden vor 10 min abgewiesen; Pruefspur maskiert';
end;
$t$;

do $t$
declare
  v jsonb;
  i integer;
begin
  -- „erneut senden“ nach 10 Minuten (Admin): Token 2; Token 1 wird unwirksam (E-03.8).
  update public.workspace_reply_to_tokens set created_at = created_at - interval '11 minutes', expires_at = expires_at - interval '11 minutes';
  v := public.reply_to_confirmation_issue(pg_temp.w1(), pg_temp.a1(), pg_temp.hash('token-2-' || repeat('b', 35)), 'antwort@w1.example.invalid');
  perform pg_temp.pruefe(v->>'ok' = 'true', 'E-03.8 Token 2: ' || v::text);
  perform public.reply_to_confirmation_mark_sent(pg_temp.hash('token-2-' || repeat('b', 35)), pg_temp.a1());
  perform pg_temp.pruefe((select superseded_at is not null from public.workspace_reply_to_tokens where token_hash = pg_temp.hash('token-1-' || repeat('a', 35))), 'E-03.8 Token 1 unwirksam');
  v := public.reply_to_confirmation_confirm(pg_temp.hash('token-1-' || repeat('a', 35)), 'schluessel-1');
  perform pg_temp.pruefe(v = '{"ok": false, "code": "invalid"}'::jsonb, 'E-03.8 Token 1 abgewiesen: ' || v::text);
  -- Token 2 bestaetigt genau einmal; die Wiederholung ist idempotent.
  v := public.reply_to_confirmation_confirm(pg_temp.hash('token-2-' || repeat('b', 35)), 'schluessel-1');
  perform pg_temp.pruefe(v = '{"ok": true, "status": "confirmed", "address": "a***@w1.example.invalid"}'::jsonb, 'E-03.2 bestaetigt: ' || v::text);
  v := public.reply_to_confirmation_confirm(pg_temp.hash('token-2-' || repeat('b', 35)), 'schluessel-1');
  perform pg_temp.pruefe(v->>'status' = 'already_confirmed', 'E-03.8 idempotent: ' || v::text);
  perform pg_temp.pruefe((select count(*) = 1 from public.workspace_reply_to_events where workspace_id = pg_temp.w1() and action = 'reply_to_confirmed'), 'E-03.8 genau ein Pruefspur-Eintrag');
  perform pg_temp.pruefe(pg_temp.zustand(pg_temp.w1()) = 'antwort@w1.example.invalid|2|antwort@w1.example.invalid|2', 'E-03.2 Zustand ' || pg_temp.zustand(pg_temp.w1()));
  v := public.resolve_workspace_reply_to(pg_temp.w1());
  perform pg_temp.pruefe(v->>'email' = 'antwort@w1.example.invalid' and v->>'source' = 'confirmed_reply_to', 'E-03.2 Versand nutzt die bestaetigte Adresse');
  v := public.reply_to_confirmation_issue(pg_temp.w1(), pg_temp.o1(), pg_temp.hash('token-3-' || repeat('c', 35)), 'antwort@w1.example.invalid');
  perform pg_temp.pruefe(v->>'code' = 'already_confirmed', 'E-03 bereits bestaetigt: ' || v::text);
  raise notice 'OK  E-03.2/E-03.8 Token 1 nach erneutem Senden abgewiesen; Token 2 bestaetigt genau einmal (idempotent, ein Pruefspur-Eintrag); Versand nutzt die Adresse';
end;
$t$;

do $t$
declare
  v jsonb;
begin
  -- E-03.5/E-03.6: Adresse A offen, Aenderung auf B -> neue Revision, A wieder unbestaetigt; der Link fuer A greift nicht.
  update public.workspace_reply_to_tokens set created_at = created_at - interval '11 minutes', expires_at = expires_at - interval '11 minutes';
  perform pg_temp.setze(pg_temp.w1(), '{"replyToEmail": "a-neu@w1.example.invalid"}');
  v := public.reply_to_confirmation_issue(pg_temp.w1(), pg_temp.o1(), pg_temp.hash('token-a-' || repeat('d', 35)), 'a-neu@w1.example.invalid');
  perform pg_temp.pruefe(v->>'ok' = 'true' and (v->>'revision')::int = 3, 'E-03.5 Revision 3: ' || v::text);
  update public.workspace_reply_to_tokens set created_at = created_at - interval '11 minutes', expires_at = expires_at - interval '11 minutes';
  perform pg_temp.setze(pg_temp.w1(), '{"replyToEmail": "b-neu@w1.example.invalid"}');
  perform pg_temp.pruefe(pg_temp.zustand(pg_temp.w1()) = 'b-neu@w1.example.invalid|4|antwort@w1.example.invalid|2', 'E-03.6 Zustand ' || pg_temp.zustand(pg_temp.w1()));
  v := public.reply_to_confirmation_confirm(pg_temp.hash('token-a-' || repeat('d', 35)), 'schluessel-2');
  perform pg_temp.pruefe(v = '{"ok": false, "code": "invalid"}'::jsonb, 'E-03.6 veralteter Link: ' || v::text);
  v := public.resolve_workspace_reply_to(pg_temp.w1());
  perform pg_temp.pruefe(v->>'source' = 'owner_login' and v->>'email' = 'o1-ap6@example.invalid', 'E-03.6 weder A noch B bestaetigt: ' || v::text);
  v := public.reply_to_confirmation_issue(pg_temp.w1(), pg_temp.o1(), pg_temp.hash('token-b-' || repeat('e', 35)), 'b-neu@w1.example.invalid');
  perform pg_temp.pruefe(v->>'ok' = 'true' and (v->>'revision')::int = 4, 'E-03.6 eigene Bestaetigung fuer B: ' || v::text);
  raise notice 'OK  E-03.5/E-03.6 Aenderung macht unbestaetigt (neue Revision); veralteter Link fuer A abgewiesen; B erhaelt eine eigene Bestaetigung';
end;
$t$;

do $t$
declare
  v jsonb;
  v_w3 text := pg_temp.zustand(pg_temp.w3());
begin
  -- E-03.3: abgelaufen, unbekannt, falsche Form -> dieselbe Antwort.
  update public.workspace_reply_to_tokens set expires_at = now() - interval '1 minute', created_at = now() - interval '73 hours'
   where token_hash = pg_temp.hash('token-b-' || repeat('e', 35));
  foreach v in array array[
    public.reply_to_confirmation_confirm(pg_temp.hash('token-b-' || repeat('e', 35)), 'schluessel-3'),
    public.reply_to_confirmation_confirm(pg_temp.hash('nie-ausgegeben'), 'schluessel-3'),
    public.reply_to_confirmation_confirm('kein-hash', 'schluessel-3'),
    public.reply_to_confirmation_confirm(null, 'schluessel-3')
  ] loop
    perform pg_temp.pruefe(v = '{"ok": false, "code": "invalid"}'::jsonb, 'E-03.3 einheitliche Antwort: ' || v::text);
  end loop;
  -- E-03.7: ein Token bestaetigt hoechstens seinen eigenen Betrieb; W3 bleibt unberuehrt.
  perform pg_temp.pruefe(pg_temp.zustand(pg_temp.w3()) is not distinct from v_w3, 'E-03.7 fremder Betrieb unberuehrt');
  raise notice 'OK  E-03.3/E-03.7 abgelaufen, unbekannt, falsche Form: dieselbe Antwort; kein Einfluss auf andere Betriebe';
end;
$t$;

do $t$
declare
  v jsonb;
  i integer;
begin
  -- E-03.13: 20 Fehlversuche je Schluessel in 15 Minuten, danach „zu viele Versuche“ — auch fuer ein gueltiges Token.
  for i in 1..20 loop
    v := public.reply_to_confirmation_confirm(pg_temp.hash('raten-' || i), 'schluessel-raten');
  end loop;
  v := public.reply_to_confirmation_confirm(pg_temp.hash('raten-21'), 'schluessel-raten');
  perform pg_temp.pruefe(v->>'code' = 'rate_limited', 'E-03.13 Versuchslimit: ' || v::text);
  -- Ein anderer Schluessel ist nicht betroffen.
  v := public.reply_to_confirmation_confirm(pg_temp.hash('raten-21'), 'schluessel-anders');
  perform pg_temp.pruefe(v->>'code' = 'invalid', 'E-03.13 anderer Schluessel: ' || v::text);
  raise notice 'OK  E-03.13 Versuchslimit greift nach 20 Fehlversuchen je Schluessel; Antwort ohne Existenzangabe';
end;
$t$;

do $t$
declare
  v jsonb;
  i integer;
begin
  -- E-03.4: hoechstens 5 Ausgaben je Tag und Betrieb.
  delete from public.workspace_reply_to_tokens where workspace_id = pg_temp.w3();
  for i in 1..5 loop
    v := public.reply_to_confirmation_issue(pg_temp.w3(), pg_temp.o3(), pg_temp.hash('w3-' || i || '-' || repeat('f', 35)), 'antwort@w3.example.invalid');
    perform pg_temp.pruefe(v->>'ok' = 'true', format('E-03.4 Ausgabe %s: %s', i, v::text));
    update public.workspace_reply_to_tokens set created_at = created_at - interval '11 minutes', expires_at = expires_at - interval '11 minutes'
     where workspace_id = pg_temp.w3();
  end loop;
  v := public.reply_to_confirmation_issue(pg_temp.w3(), pg_temp.o3(), pg_temp.hash('w3-6-' || repeat('f', 35)), 'antwort@w3.example.invalid');
  perform pg_temp.pruefe(v->>'code' = 'resend_limit', 'E-03.4 sechste Ausgabe am Tag: ' || v::text);
  raise notice 'OK  E-03.4 die sechste Bestaetigung am Tag wird abgewiesen';
end;
$t$;

do $t$
declare
  v jsonb;
begin
  -- E-03.11: Inhaber-Anmeldung unbestaetigt und keine bestaetigte Antwortadresse -> fail-closed.
  v := public.resolve_workspace_reply_to(pg_temp.w3());
  perform pg_temp.pruefe(v = '{"ok": false, "code": "reply_to_unavailable"}'::jsonb, 'E-03.11 fail-closed: ' || v::text);
  -- E-03.10: Uebergabe an A1 -> die bestaetigte Anmelde-E-Mail des neuen Inhabers; ein offener E-Mail-Wechsel aendert nichts.
  update public.workspace_reply_to_state set confirmed_revision = null, confirmed_address = null where workspace_id = pg_temp.w1();
  update public.workspaces set owner_user_id = pg_temp.a1() where id = pg_temp.w1();
  v := public.resolve_workspace_reply_to(pg_temp.w1());
  perform pg_temp.pruefe(v->>'email' = 'a1-ap6@example.invalid' and v->>'source' = 'owner_login', 'E-03.10 neuer Inhaber: ' || v::text);
  update auth.users set email_change = 'a1-neu@example.invalid', email_change_sent_at = now() where id = pg_temp.a1();
  v := public.resolve_workspace_reply_to(pg_temp.w1());
  perform pg_temp.pruefe(v->>'email' = 'a1-ap6@example.invalid', 'E-03.10 offener Wechsel aendert nichts: ' || v::text);
  update auth.users set email = 'a1-neu@example.invalid', email_change = '', email_confirmed_at = now() where id = pg_temp.a1();
  v := public.resolve_workspace_reply_to(pg_temp.w1());
  perform pg_temp.pruefe(v->>'email' = 'a1-neu@example.invalid', 'E-03.10 abgeschlossener Wechsel: ' || v::text);
  update public.workspaces set owner_user_id = pg_temp.o1() where id = pg_temp.w1();
  raise notice 'OK  E-03.10/E-03.11 Rueckfall folgt dem aktuellen Inhaber und seinem abgeschlossenen E-Mail-Wechsel; ohne bestaetigte Adresse fail-closed';
end;
$t$;

/* ------------------------------------------------------------------ */
/* Statusabfrage, Einladungsweg und Rechte                              */
/* ------------------------------------------------------------------ */
do $t$
declare
  v jsonb;
begin
  v := pg_temp.status_als(pg_temp.o1(), pg_temp.w1());
  perform pg_temp.pruefe(v->>'address' = 'b-neu@w1.example.invalid' and v->>'confirmed' = 'false' and v->>'effective_source' = 'owner_login'
                         and v->>'effective_masked' = 'o***@example.invalid' and v->>'unavailable' = 'false', 'Status O1: ' || v::text);
  perform pg_temp.pruefe(position('o1-ap6@' in v::text) = 0, 'Status zeigt die Inhaber-Anmeldung nur maskiert');
  perform pg_temp.erwarte_abweisung('Status M1', format('select pg_temp.status_als(%L::uuid, %L::uuid)', pg_temp.m1(), pg_temp.w1()), 'workspace_forbidden_role');
  perform pg_temp.erwarte_abweisung('Status fremder Betrieb', format('select pg_temp.status_als(%L::uuid, %L::uuid)', pg_temp.o2(), pg_temp.w1()), 'workspace_forbidden_role');
  perform pg_temp.pruefe(current_user = 'postgres', 'Rolle nach Abweisung zurueck');
  raise notice 'OK  Status fuer Inhaber und Admins des Betriebs, Rueckfall nur maskiert; Mitglied und fremder Inhaber abgewiesen';
end;
$t$;

do $t$
declare
  v jsonb;
begin
  insert into public.workspace_invitations (id, workspace_id, email, role, token_hash, invited_by, expires_at)
  values ('00000000-0000-0000-0000-0000000e6e01', pg_temp.w1(), 'neu-ap6@example.invalid', 'member',
          extensions.digest('einladung-ap6-' || repeat('g', 30), 'sha256'), pg_temp.o1(), now() + interval '7 days');
  v := pg_temp.einladung_als(pg_temp.o1(), '00000000-0000-0000-0000-0000000e6e01');
  perform pg_temp.pruefe(v->>'source' = 'owner_login' and v->>'email' = 'o1-ap6@example.invalid', 'Einladung O1: ' || v::text);
  perform pg_temp.erwarte_abweisung('Einladung M1', format('select pg_temp.einladung_als(%L::uuid, %L::uuid)', pg_temp.m1(), '00000000-0000-0000-0000-0000000e6e01'), 'workspace_forbidden_role');
  perform pg_temp.erwarte_abweisung('Einladung fremder Inhaber', format('select pg_temp.einladung_als(%L::uuid, %L::uuid)', pg_temp.o2(), '00000000-0000-0000-0000-0000000e6e01'), 'workspace_not_member');
  raise notice 'OK  Einladungsweg: dieselbe Regel nur fuer Inhaber und Admins des Einladungsbetriebs';
end;
$t$;

do $t$
declare
  v_fn text;
  v_tab text;
begin
  foreach v_fn in array array['public.reply_to_confirmation_issue(uuid, uuid, text, text)', 'public.reply_to_confirmation_mark_sent(text, uuid)',
                               'public.reply_to_confirmation_withdraw(text)', 'public.reply_to_confirmation_confirm(text, text)',
                               'public.resolve_workspace_reply_to(uuid)'] loop
    perform pg_temp.pruefe(has_function_privilege('service_role', v_fn, 'execute'), v_fn || ' service_role');
    perform pg_temp.pruefe(not has_function_privilege('anon', v_fn, 'execute') and not has_function_privilege('authenticated', v_fn, 'execute'), v_fn || ' ohne Client-Rechte');
  end loop;
  foreach v_fn in array array['public.get_workspace_reply_to_status(uuid)', 'public.resolve_workspace_reply_to_for_invitation(uuid)'] loop
    perform pg_temp.pruefe(has_function_privilege('authenticated', v_fn, 'execute') and not has_function_privilege('anon', v_fn, 'execute'), v_fn || ' nur authenticated');
  end loop;
  foreach v_fn in array array['public.einrichtung01_resolve_reply_to(uuid)', 'public.einrichtung01_reply_to_state_lock(uuid)',
                               'public.einrichtung01_profile_reply_to(uuid)', 'public.einrichtung01_mask_email(text)'] loop
    perform pg_temp.pruefe(not has_function_privilege('anon', v_fn, 'execute') and not has_function_privilege('authenticated', v_fn, 'execute')
                           and not has_function_privilege('service_role', v_fn, 'execute'), v_fn || ' intern');
  end loop;
  foreach v_tab in array array['public.workspace_reply_to_state', 'public.workspace_reply_to_tokens', 'public.reply_to_confirm_attempts',
                                'public.workspace_reply_to_events'] loop
    perform pg_temp.pruefe(not has_table_privilege('anon', v_tab, 'select') and not has_table_privilege('authenticated', v_tab, 'select')
                           and not has_table_privilege('authenticated', v_tab, 'insert'), v_tab || ' ohne Client-Rechte');
    perform pg_temp.pruefe((select relrowsecurity from pg_class where oid = v_tab::regclass), v_tab || ' RLS');
  end loop;
  perform pg_temp.erwarte_abweisung('Pruefspur unveraenderlich', 'delete from public.workspace_reply_to_events', 'unveraenderlich');
  raise notice 'OK  Rechte: Dienstrolle-Funktionen ohne Client-Rechte, Status/Einladung nur authenticated, interne Helfer ohne Rechte, Tabellen ohne Client-Zugriff mit RLS, Pruefspur unveraenderlich';
end;
$t$;

rollback;

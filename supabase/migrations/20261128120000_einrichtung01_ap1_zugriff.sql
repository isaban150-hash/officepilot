-- EINRICHTUNG-01 / AP1 -- Kontozugriff auf dem Server (Katalog V3 vom 23.10.2026, Vertraege 1.1, 1.2, 1.3, 1.8, 1.9).
--
-- Eine Zugriffsregel je Zielbetrieb, bei jedem Aufruf aus dem aktuellen Datenbankstand:
--   Stufe 1  Identitaet: angemeldet, die Sitzung des Tokens besteht noch (session_id, Vertrag 1.8), Profil vorhanden
--   Stufe 2  Kontosperre (unveraendert, unabhaengig von Lizenz und Rolle)
--   Stufe 3  Freigabe: profiles.status = 'approved'
--   Stufe 4  aktive Mitgliedschaft genau im Zielbetrieb
--   Stufe 5  Rolle je Aktionsklasse (unveraendert in den bestehenden Wegen)
--   Stufe 6  Betriebslizenz = Lizenz des Inhabers laut workspaces.owner_user_id (E3); nicht wirksam -> Nur-Lesen (E5)
--
-- Umsetzung:
--   * Lesehelfer is_active_workspace_member / workspace_member_role (STABLE, RLS) pruefen zusaetzlich Sitzung und
--     Freigabe. can_write_workspace und workspace_user_can_intake folgen unveraendert; die Lizenz steht bewusst NICHT
--     darin, weil can_write_workspace in 18 Lese-Policies steckt und Nur-Lesen das Lesen erhalten muss.
--   * Schreibschutz: ein BEFORE-Trigger zz_einrichtung01_schreibschutz auf allen Betriebstabellen (ausser
--     workspace_members und den eigenen OAuth-Zwischenstaenden; workspaces nur UPDATE) ruft die volatile Pruefung
--     assert_workspace_write_access. Sie sperrt Mitgliedschafts- und Inhaberprofilzeile FOR SHARE (Vertrag 1.9) und
--     weist mit 42501 und strukturiertem Code ab (session_not_active, account_blocked, account_not_approved,
--     workspace_not_member, license_not_effective). Dienst- und Wartungswege ohne auth.uid() bleiben unberuehrt; sie
--     sind durch die Edge Functions (workspace_user_can_write mit Lizenz) bzw. den pausierten Planer gedeckt.
--     Kein Rumpf einer FINANZ-CORE-01A- oder DOKUMENTE-01-RPC wird dafuer geaendert.
--   * Finanzwaechter (E3a): dieselbe Reihenfolge und dieselben Fehlercodes; die Lizenzcodes beziehen sich jetzt auf die
--     Betriebslizenz. VOLATILE mit FOR SHARE auf Mitgliedschafts- und Inhaberprofilzeile.
--   * ensure_personal_workspace (Weg A, EIN-03): Sperre je Konto (pg_advisory_xact_lock), Freigabe Pflicht,
--     Neuanlage nur mit wirksamer eigener Lizenz (sonst Antwort reason = no_license, nichts angelegt).
--     Die Einladungsvorrangregel (invitation_pending) folgt mit den Einladungstabellen in AP4.
--   * Storage-Schreibhelfer, workspace_user_can_write (Edge Functions): zusaetzlich Freigabe und Betriebslizenz.
--   * Neu: get_workspace_access (Client: Rolle und Lizenzstand), workspace_user_access_denial (Edge Functions:
--     strukturierter Ablehnungsgrund, nur service_role).
--   * EIN-18: Spaltenrechte auf workspace_mailbox_connections ohne Cursor, Lease und Kontosubjekt.
--
-- Nur lokal. Nicht remote anwenden (Gesamtveroeffentlichung RELEASE-01).

/* ======================================================================== */
/* 1. Bausteine der Zugriffsregel                                           */
/* ======================================================================== */

/*
 * Stufe 1 (Vertrag 1.8) -- besteht die Sitzung des Tokens noch?
 *
 * Supabase-Zugriffstoken tragen session_id. Ist die Sitzung widerrufen (Abmelden auf allen Geraeten,
 * Passwortwechsel) oder zeitlich beendet (not_after), wird jeder DB-, RPC- und Storage-Zugriff sofort abgewiesen,
 * obwohl das Token bis exp technisch gueltig bleibt. Ohne Anmeldung entscheiden die anderen Stufen; ein Token ohne
 * session_id (interne Aufrufe, synthetische Testclaims) gilt hier als bestehend.
 *
 * Abgewiesen wird mit eigenem Code statt mit false: Eine beendete Sitzung ist ein Anmeldeproblem, keine fehlende
 * Mitgliedschaft. Der Client darf Auftraege deshalb nicht als endgueltig abgewiesen verbuchen, sondern verlangt
 * die Anmeldung (Vertrag 1.8, Zustand „bestaetigt nicht vorhanden“). Ein unlesbarer Claim gilt ebenso (fail-closed).
 */
create or replace function public.workspace_session_active()
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_claims jsonb;
  v_sid text;
begin
  if auth.uid() is null then
    return true;
  end if;
  begin
    v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  exception when others then
    v_claims := '{"session_id":"unlesbar"}'::jsonb;
  end;
  v_sid := v_claims->>'session_id';
  if v_sid is null then
    return true;
  end if;
  if v_sid ~ ('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}' || chr(36))
     and exists (
       select 1
       from auth.sessions s
       where s.id = v_sid::uuid
         and s.user_id = auth.uid()
         and (s.not_after is null or s.not_after > now())
     ) then
    return true;
  end if;
  raise exception 'session_not_active: Die Sitzung ist beendet' using errcode = '42501';
end;
$$;

revoke all on function public.workspace_session_active() from public, anon, authenticated, service_role;

/* Stufe 3 -- Profil vorhanden und freigegeben. Gesperrt, wartend und ohne Profil ergeben false. */
create or replace function public.workspace_account_approved(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select p.status = 'approved' from public.profiles p where p.id = p_user_id), false);
$$;

revoke all on function public.workspace_account_approved(uuid) from public, anon, authenticated, service_role;

/*
 * Stufe 6 -- Zustand der Betriebslizenz (Vertrag 1.1): die Lizenz des Inhabers laut workspaces.owner_user_id.
 *   effective  Profil vorhanden, approved, license_status active, Ablauf leer oder > now()
 *   expired    license_status expired oder Ablauf erreicht (Gleichheit mit now() gilt als abgelaufen)
 *   inactive   alles andere: nie erteilt, deaktiviert, Inhaberprofil fehlt, Inhaber gesperrt oder nicht
 *              freigegeben (E15), unbekannte Werte (fail-closed)
 * Die persoenliche Lizenz eines Admins oder Mitglieds spielt keine Rolle.
 */
create or replace function public.workspace_license_state(p_workspace_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select case
      when p.id is null then 'inactive'
      when p.status is distinct from 'approved' then 'inactive'
      when p.license_status = 'expired' or (p.license_expires_at is not null and p.license_expires_at <= now()) then 'expired'
      when p.license_status is distinct from 'active' then 'inactive'
      else 'effective'
    end
    from public.workspaces w
    left join public.profiles p on p.id = w.owner_user_id
    where w.id = p_workspace_id
  ), 'inactive');
$$;

revoke all on function public.workspace_license_state(uuid) from public, anon, authenticated, service_role;

create or replace function public.workspace_license_effective(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.workspace_license_state(p_workspace_id) = 'effective';
$$;

revoke all on function public.workspace_license_effective(uuid) from public, anon, authenticated, service_role;

/* ======================================================================== */
/* 2. Lesehelfer (STABLE, RLS): zusaetzlich Sitzung und Freigabe             */
/* ======================================================================== */

create or replace function public.is_active_workspace_member(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = p_workspace_id
      and wm.user_id = auth.uid()
      and wm.status = 'active'
  )
  and not public.workspace_account_blocked(auth.uid())
  -- EINRICHTUNG-01 (Stufen 1 und 3): Sitzung besteht, Konto freigegeben.
  and public.workspace_account_approved(auth.uid())
  and public.workspace_session_active();
$$;

create or replace function public.workspace_member_role(p_workspace_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select wm.role
  from public.workspace_members wm
  where wm.workspace_id = p_workspace_id
    and wm.user_id = auth.uid()
    and wm.status = 'active'
    and not public.workspace_account_blocked(auth.uid())
    -- EINRICHTUNG-01 (Stufen 1 und 3): Sitzung besteht, Konto freigegeben.
    and public.workspace_account_approved(auth.uid())
    and public.workspace_session_active()
  limit 1;
$$;

/* ======================================================================== */
/* 3. Schreibschutz (VOLATILE, Vertrag 1.9)                                 */
/* ======================================================================== */

/*
 * Die zentrale Pruefung fuer jeden schreibenden Zugriff einer angemeldeten Person auf Betriebsdaten.
 * Sperrt die eigene Mitgliedschaftszeile und die Profilzeile des Inhabers FOR SHARE: Eine Rechte-, Lizenz-,
 * Uebergabe- oder Teamaenderung (FOR UPDATE) wartet, bis dieser Schreibvorgang abgeschlossen ist; jeder spaeter
 * gepruefte Schreibvorgang sieht die Aenderung. Die Rolle (Stufe 5) prueft weiterhin der jeweilige Weg.
 *
 * Kein Mischzustand (Vertrag 1.9, N-Z4): Die Rollenpruefung des Weges liest ohne Sperre. Aendert eine gleichzeitige
 * Rechteaenderung die Mitgliedschaft, waehrend dieser Schreibvorgang auf die Sperre wartet, gilt die fruehere
 * Pruefung nicht mehr: abgewiesen mit 40001 (workspace_access_changed), ein neuer Versuch sieht die neue Rolle.
 * Fuer Tabellen, die nur Inhaber und Admins schreiben (p_requires_writer), gilt die Rolle zusaetzlich nach der Sperre.
 */
create or replace function public.assert_workspace_write_access(p_workspace_id uuid, p_requires_writer boolean default false)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_role_vorher text;
  v_owner uuid;
begin
  if v_user_id is null then
    raise exception 'Nicht angemeldet' using errcode = '42501';
  end if;
  if not public.workspace_session_active() then
    raise exception 'session_not_active: Die Sitzung ist beendet' using errcode = '42501';
  end if;
  if public.workspace_account_blocked(v_user_id) then
    raise exception 'account_blocked: Konto ist gesperrt' using errcode = '42501';
  end if;
  if not public.workspace_account_approved(v_user_id) then
    raise exception 'account_not_approved: Konto ist nicht freigegeben' using errcode = '42501';
  end if;

  -- Was die vorangehende Rollenpruefung des Weges gesehen hat: der festgeschriebene Stand ohne Sperre.
  select wm.role
  into v_role_vorher
  from public.workspace_members wm
  where wm.workspace_id = p_workspace_id
    and wm.user_id = v_user_id
    and wm.status = 'active';

  select wm.role
  into v_role
  from public.workspace_members wm
  where wm.workspace_id = p_workspace_id
    and wm.user_id = v_user_id
    and wm.status = 'active'
  for share;
  if v_role is null then
    raise exception 'workspace_not_member: Kein Zugriff auf Workspace' using errcode = '42501';
  end if;
  if v_role_vorher is distinct from v_role then
    raise exception 'workspace_access_changed: Die Rechte wurden gleichzeitig geaendert' using errcode = '40001';
  end if;
  if p_requires_writer and v_role not in ('owner', 'admin') then
    raise exception 'workspace_forbidden_role: Keine Schreibberechtigung' using errcode = '42501';
  end if;

  select w.owner_user_id into v_owner from public.workspaces w where w.id = p_workspace_id;
  perform 1 from public.profiles p where p.id = v_owner for share;

  -- Erst nach der Sperre gelesen: der zuletzt festgeschriebene Stand.
  if public.workspace_license_state(p_workspace_id) <> 'effective' then
    raise exception 'license_not_effective: Die Lizenz des Betriebs ist nicht wirksam' using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.assert_workspace_write_access(uuid, boolean) from public, anon, authenticated, service_role;

/*
 * Der Trigger ruft die Pruefung fuer jede Zeile, die ein Client schreibt: eine Sitzung in der Rolle authenticated
 * (PostgREST setzt sie per SET ROLE; innerhalb einer SECURITY-DEFINER-Funktion bleibt die Einstellung `role`
 * erhalten, nur current_user wechselt) mit angemeldetem Nutzer. Dienstrolle, Planer, Wartung und Migrationen bleiben
 * unberuehrt. Ein vertrauenswuerdiger Systemweg (AP4: Uebergabe, Plattform-Reparatur) setzt fuer genau seine
 * Transaktion officetakt.einrichtung_systemweg = pg_current_xact_id(); Clients koennen diese Einstellung nicht setzen.
 */
create or replace function public.einrichtung01_workspace_write_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_neu jsonb;
  v_alt jsonb;
  v_ws uuid;
  v_ws_alt uuid;
  -- Trigger-Argument 'writer': Tabellen, die ausschliesslich Inhaber und Admins schreiben.
  v_writer boolean := tg_nargs > 0 and tg_argv[0] = 'writer';
begin
  if auth.uid() is null or coalesce(current_setting('role', true), 'none') <> 'authenticated' then
    return coalesce(new, old);
  end if;
  if current_setting('officetakt.einrichtung_systemweg', true) = pg_current_xact_id()::text then
    return coalesce(new, old);
  end if;

  if tg_op <> 'DELETE' then v_neu := to_jsonb(new); end if;
  if tg_op <> 'INSERT' then v_alt := to_jsonb(old); end if;

  if tg_table_name = 'workspaces' then
    v_ws := nullif(coalesce(v_neu, v_alt)->>'id', '')::uuid;
    v_ws_alt := nullif(v_alt->>'id', '')::uuid;
  else
    v_ws := nullif(coalesce(v_neu, v_alt)->>'workspace_id', '')::uuid;
    v_ws_alt := nullif(v_alt->>'workspace_id', '')::uuid;
  end if;

  if v_ws is not null then
    perform public.assert_workspace_write_access(v_ws, v_writer);
  end if;
  if v_ws_alt is not null and v_ws_alt is distinct from v_ws then
    perform public.assert_workspace_write_access(v_ws_alt, v_writer);
  end if;
  return coalesce(new, old);
end;
$$;

revoke all on function public.einrichtung01_workspace_write_guard() from public, anon, authenticated, service_role;

-- Der Name beginnt mit zz_: BEFORE-Trigger laufen nach Namen; dieser kommt NACH den bestehenden Schutztriggern, damit
-- deren Fehlervertraege (u. a. die Finanzcodes der E-Rechnungs-Bindung, Vertrag 1.2) unveraendert Vorrang behalten.
create trigger zz_einrichtung01_schreibschutz before update on public.workspaces
  for each row execute function public.einrichtung01_workspace_write_guard('writer');
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.ai_usage_counters for each row execute function public.einrichtung01_workspace_write_guard();
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_accounting_assignments for each row execute function public.einrichtung01_workspace_write_guard();
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_accounting_period_closures for each row execute function public.einrichtung01_workspace_write_guard();
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_bank_accounts for each row execute function public.einrichtung01_workspace_write_guard();
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_bank_reconciliations for each row execute function public.einrichtung01_workspace_write_guard();
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_bank_transactions for each row execute function public.einrichtung01_workspace_write_guard();
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_business_letters for each row execute function public.einrichtung01_workspace_write_guard();
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_communication_events for each row execute function public.einrichtung01_workspace_write_guard();
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_company_profiles for each row execute function public.einrichtung01_workspace_write_guard('writer');
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_customers for each row execute function public.einrichtung01_workspace_write_guard('writer');
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_document_deliveries for each row execute function public.einrichtung01_workspace_write_guard('writer');
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_document_file_bindings for each row execute function public.einrichtung01_workspace_write_guard();
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_document_restorations for each row execute function public.einrichtung01_workspace_write_guard('writer');
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_document_work_results for each row execute function public.einrichtung01_workspace_write_guard();
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_documents for each row execute function public.einrichtung01_workspace_write_guard();
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_email_assignment_events for each row execute function public.einrichtung01_workspace_write_guard('writer');
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_email_message_attachments for each row execute function public.einrichtung01_workspace_write_guard('writer');
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_email_messages for each row execute function public.einrichtung01_workspace_write_guard('writer');
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_email_provider_events for each row execute function public.einrichtung01_workspace_write_guard();
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_employee_payments for each row execute function public.einrichtung01_workspace_write_guard();
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_employees for each row execute function public.einrichtung01_workspace_write_guard();
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_expense_payments for each row execute function public.einrichtung01_workspace_write_guard();
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_expenses for each row execute function public.einrichtung01_workspace_write_guard();
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_files for each row execute function public.einrichtung01_workspace_write_guard();
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_finance_changes for each row execute function public.einrichtung01_workspace_write_guard();
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_inbox_items for each row execute function public.einrichtung01_workspace_write_guard();
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_invoice_drafts for each row execute function public.einrichtung01_workspace_write_guard();
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_invoice_dunning_documentations for each row execute function public.einrichtung01_workspace_write_guard();
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_invoice_frist_klaerungen for each row execute function public.einrichtung01_workspace_write_guard();
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_invoice_number_formats for each row execute function public.einrichtung01_workspace_write_guard();
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_invoice_payments for each row execute function public.einrichtung01_workspace_write_guard();
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_invoice_sequences for each row execute function public.einrichtung01_workspace_write_guard();
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_invoices for each row execute function public.einrichtung01_workspace_write_guard();
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_knowledge_facts for each row execute function public.einrichtung01_workspace_write_guard();
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_mailbox_connections for each row execute function public.einrichtung01_workspace_write_guard('writer');
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_mailbox_import_failures for each row execute function public.einrichtung01_workspace_write_guard();
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_offer_sequences for each row execute function public.einrichtung01_workspace_write_guard('writer');
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_offers for each row execute function public.einrichtung01_workspace_write_guard();
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_order_amendment_drafts for each row execute function public.einrichtung01_workspace_write_guard();
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_order_amendments for each row execute function public.einrichtung01_workspace_write_guard('writer');
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_order_drafts for each row execute function public.einrichtung01_workspace_write_guard();
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_order_sequences for each row execute function public.einrichtung01_workspace_write_guard('writer');
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_paper_register_entries for each row execute function public.einrichtung01_workspace_write_guard();
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_paper_register_owner_changes for each row execute function public.einrichtung01_workspace_write_guard();
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_restricted_documents for each row execute function public.einrichtung01_workspace_write_guard();
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_settings for each row execute function public.einrichtung01_workspace_write_guard('writer');
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_setup for each row execute function public.einrichtung01_workspace_write_guard('writer');
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_tasks for each row execute function public.einrichtung01_workspace_write_guard();
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_vorgaenge for each row execute function public.einrichtung01_workspace_write_guard('writer');
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_vorgang_notes for each row execute function public.einrichtung01_workspace_write_guard();
create trigger zz_einrichtung01_schreibschutz before insert or update or delete on public.workspace_vorgang_sequences for each row execute function public.einrichtung01_workspace_write_guard('writer');

/* ======================================================================== */
/* 4. Finanzwaechter (E3a)                                                  */
/* ======================================================================== */

/*
 * Reihenfolge und Fehlercodes wie in 20261109120000: Sperre, Mitgliedschaft, Rolle, Freigabe der handelnden Person,
 * Lizenz. Neu: Die Lizenzcodes beziehen sich auf die Betriebslizenz (Inhaber), nicht auf die eigene Lizenz; die
 * Mitgliedschaft wird ohne die Freigabestufe der Lesehelfer gelesen, damit eine wartende Person weiter
 * finance_account_not_approved erhaelt. VOLATILE mit FOR SHARE (Vertrag 1.9). Eine beendete Sitzung gilt wie
 * keine Anmeldung.
 */
create or replace function public.assert_financial_action_allowed(p_workspace_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $function$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_status text;
  v_owner uuid;
  v_license_state text;
begin
  if v_user_id is null or not public.workspace_session_active() then
    raise exception 'Nicht angemeldet';
  end if;
  if p_workspace_id is null then
    raise exception 'workspace_id fehlt';
  end if;

  if public.workspace_account_blocked(v_user_id) then
    raise exception 'finance_account_blocked: Konto ist gesperrt'
      using errcode = 'P0001';
  end if;

  select wm.role
  into v_role
  from public.workspace_members wm
  where wm.workspace_id = p_workspace_id
    and wm.user_id = v_user_id
    and wm.status = 'active'
  for share;
  if v_role is null then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  if v_role not in ('owner', 'admin') then
    raise exception 'finance_forbidden_role: Finanzaktion erfordert Inhaber- oder Verwaltungsrecht'
      using errcode = 'P0001';
  end if;

  select p.status into v_status from public.profiles p where p.id = v_user_id;
  if v_status is null then
    raise exception 'finance_account_not_approved: Konto ist nicht freigegeben'
      using errcode = 'P0001';
  end if;
  if v_status = 'blocked' then
    raise exception 'finance_account_blocked: Konto ist gesperrt'
      using errcode = 'P0001';
  end if;
  if v_status <> 'approved' then
    raise exception 'finance_account_not_approved: Konto ist nicht freigegeben'
      using errcode = 'P0001';
  end if;

  -- E: Betriebslizenz (E3a). Die Inhaberzeile wird vor dem Lesen FOR SHARE gesperrt.
  select w.owner_user_id into v_owner from public.workspaces w where w.id = p_workspace_id;
  perform 1 from public.profiles p where p.id = v_owner for share;
  v_license_state := public.workspace_license_state(p_workspace_id);
  if v_license_state = 'expired' then
    raise exception 'finance_license_expired: Lizenz ist abgelaufen'
      using errcode = 'P0001';
  end if;
  if v_license_state <> 'effective' then
    raise exception 'finance_license_inactive: Keine aktive Lizenz'
      using errcode = 'P0001';
  end if;
end;
$function$;

/* ======================================================================== */
/* 5. Edge Functions und Storage                                            */
/* ======================================================================== */

-- Schreibrecht eines ausdruecklich genannten Nutzers (Edge Functions): zusaetzlich Freigabe und Betriebslizenz.
create or replace function public.workspace_user_can_write(p_workspace_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = p_workspace_id
      and wm.user_id = p_user_id
      and wm.status = 'active'
      and wm.role in ('owner', 'admin')
  )
  and not public.workspace_account_blocked(p_user_id)
  and public.workspace_account_approved(p_user_id)
  and public.workspace_license_effective(p_workspace_id);
$$;

/*
 * Der Ablehnungsgrund fuer eine Edge Function, in der Reihenfolge der Zugriffsregel; null = erlaubt.
 *   p_action 'write'  : owner oder admin (Versand, Postfach)
 *   p_action 'member' : jede aktive Rolle (KI)
 * Nur service_role; gibt nichts preis, was die Funktion nicht ohnehin pruefen muss.
 */
create or replace function public.workspace_user_access_denial(p_workspace_id uuid, p_user_id uuid, p_action text)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  if p_workspace_id is null or p_user_id is null or p_action not in ('write', 'member') then
    return 'invalid_request';
  end if;
  if public.workspace_account_blocked(p_user_id) then
    return 'account_blocked';
  end if;
  if not public.workspace_account_approved(p_user_id) then
    return 'account_not_approved';
  end if;
  select wm.role into v_role
  from public.workspace_members wm
  where wm.workspace_id = p_workspace_id and wm.user_id = p_user_id and wm.status = 'active'
  limit 1;
  if v_role is null then
    return 'not_member';
  end if;
  if p_action = 'write' and v_role not in ('owner', 'admin') then
    return 'forbidden_role';
  end if;
  if not public.workspace_license_effective(p_workspace_id) then
    return 'license_not_effective';
  end if;
  return null;
end;
$$;

revoke all on function public.workspace_user_access_denial(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.workspace_user_access_denial(uuid, uuid, text) to service_role;

-- Storage-Schreibhelfer (nur INSERT-Policies): zusaetzlich die Betriebslizenz. Lesen bleibt unveraendert.
create or replace function public.branding_asset_can_write(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    public.can_write_workspace(public.branding_asset_workspace_id(p_name))
      and public.workspace_license_effective(public.branding_asset_workspace_id(p_name)),
    false
  );
$$;

create or replace function public.document_delivery_attachment_can_write(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    public.can_write_workspace(public.document_delivery_attachment_workspace_id(p_name))
      and public.workspace_license_effective(public.document_delivery_attachment_workspace_id(p_name)),
    false
  );
$$;

create or replace function public.email_attachment_can_write(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    public.can_write_workspace(public.email_attachment_workspace_id(p_name))
      and public.workspace_license_effective(public.email_attachment_workspace_id(p_name)),
    false
  );
$$;

create or replace function public.workspace_file_object_can_write(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when length(p_name) = 101 and p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{64}'
      then public.workspace_user_can_intake(split_part(p_name, '/', 1)::uuid)
        and public.workspace_license_effective(split_part(p_name, '/', 1)::uuid)
    else false
  end;
$$;

/* ======================================================================== */
/* 6. Client: Rolle und Lizenzstand des aktiven Betriebs                    */
/* ======================================================================== */

/*
 * Was der Client fuer Schreibrecht und Nur-Lesen-Hinweis braucht: die eigene Rolle und der Zustand der
 * Betriebslizenz (effective, expired, inactive). Nur fuer aktive, freigegebene Mitglieder mit bestehender Sitzung.
 * Keine Inhaberdaten, kein Ablaufdatum.
 */
create or replace function public.get_workspace_access(p_workspace_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role text;
  v_state text;
begin
  if auth.uid() is null or not public.workspace_session_active() then
    raise exception 'Nicht angemeldet';
  end if;
  v_role := public.workspace_member_role(p_workspace_id);
  if v_role is null then
    raise exception 'Kein Zugriff auf Workspace';
  end if;
  v_state := public.workspace_license_state(p_workspace_id);
  return jsonb_build_object(
    'workspace_id', p_workspace_id,
    'role', v_role,
    'license_state', v_state,
    'license_effective', v_state = 'effective'
  );
end;
$$;

revoke all on function public.get_workspace_access(uuid) from public, anon, service_role;
grant execute on function public.get_workspace_access(uuid) to authenticated;

/* ======================================================================== */
/* 7. Betriebsanlage (Weg A, EIN-03)                                        */
/* ======================================================================== */

create or replace function public.ensure_personal_workspace(p_name text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_user_id uuid := auth.uid();
  v_workspace public.workspaces;
  v_member public.workspace_members;
  v_name text;
  v_status text;
  v_license text;
  v_expires timestamptz;
begin
  if v_user_id is null or not public.workspace_session_active() then
    raise exception 'Nicht angemeldet';
  end if;

  /*
   * EINRICHTUNG-01 (EIN-03, Z-09) -- Aufrufe desselben Kontos laufen nacheinander. Ein zweiter, gleichzeitiger
   * Aufruf wartet und findet danach den Betrieb des ersten; so entsteht nie ein zweiter eigener Betrieb.
   * Alle Pruefungen stehen nach der Sperre.
   */
  perform pg_advisory_xact_lock(hashtextextended('einrichtung01:ensure_personal_workspace:' || v_user_id::text, 0));

  -- KONTOSPERRE: Ein gesperrtes Konto erhaelt und erzeugt keine Betriebsbindung.
  if public.workspace_account_blocked(v_user_id) then
    raise exception 'account_blocked: Konto ist gesperrt' using errcode = '42501';
  end if;

  -- EINRICHTUNG-01 (Stufe 3, Z-01) -- nur ein freigegebenes Konto; ohne Profil gibt es keine Freigabe.
  select p.status, p.license_status, p.license_expires_at
  into v_status, v_license, v_expires
  from public.profiles p
  where p.id = v_user_id;
  if v_status is distinct from 'approved' then
    raise exception 'account_not_approved: Konto ist nicht freigegeben' using errcode = '42501';
  end if;

  select wm.*
  into v_member
  from public.workspace_members wm
  where wm.user_id = v_user_id
    and wm.status = 'active'
    and wm.role = 'owner'
  order by wm.created_at asc
  limit 1;

  if found then
    select * into v_workspace from public.workspaces w where w.id = v_member.workspace_id;
    return jsonb_build_object(
      'workspace', to_jsonb(v_workspace),
      'member', to_jsonb(v_member),
      'created', false
    );
  end if;

  -- FC01A (P2 T8-02): Ein Mitarbeiterkonto erreicht beim ersten Login den Betrieb seiner
  -- bestehenden aktiven Mitgliedschaft, mit genau dieser Rolle. Nichts wird angelegt oder
  -- veraendert; ein fremder Betrieb ist ausgeschlossen (nur eigene Mitgliedschaften).
  select wm.*
  into v_member
  from public.workspace_members wm
  join public.workspaces w on w.id = wm.workspace_id
  where wm.user_id = v_user_id
    and wm.status = 'active'
    and wm.role in ('admin', 'member')
  order by case when wm.role = 'admin' then 0 else 1 end,
           wm.created_at asc,
           wm.workspace_id asc
  limit 1;

  if found then
    select * into v_workspace from public.workspaces w where w.id = v_member.workspace_id;
    return jsonb_build_object(
      'workspace', to_jsonb(v_workspace),
      'member', to_jsonb(v_member),
      'created', false
    );
  end if;

  /*
   * EINRICHTUNG-01 (Weg A, Z-03.1) -- ein eigener Betrieb entsteht nur mit wirksamer eigener Lizenz (sie wird die
   * Betriebslizenz). Sonst wird nichts angelegt; die Antwort nennt den Grund, damit die Oberflaeche den naechsten
   * Schritt zeigen kann, statt eine Einrichtung anzubieten, deren Eingaben nicht gespeichert werden koennten.
   */
  if not (v_license = 'active' and (v_expires is null or v_expires > now())) then
    return jsonb_build_object('workspace', null, 'member', null, 'created', false, 'reason', 'no_license');
  end if;

  v_name := coalesce(nullif(trim(p_name), ''), 'Mein Workspace');

  insert into public.workspaces (name, owner_user_id)
  values (v_name, v_user_id)
  returning * into v_workspace;

  insert into public.workspace_members (workspace_id, user_id, role, status)
  values (v_workspace.id, v_user_id, 'owner', 'active')
  returning * into v_member;

  insert into public.workspace_settings (workspace_id, settings)
  values (v_workspace.id, '{}'::jsonb)
  on conflict (workspace_id) do nothing;

  return jsonb_build_object(
    'workspace', to_jsonb(v_workspace),
    'member', to_jsonb(v_member),
    'created', true
  );
end;
$function$;

revoke all on function public.ensure_personal_workspace(text) from public, anon, service_role;
grant execute on function public.ensure_personal_workspace(text) to authenticated;

-- Dieselben Stufen fuer die Betriebsbindung ohne Anlage.
create or replace function public.get_active_workspace()
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_user_id uuid := auth.uid();
  v_member public.workspace_members;
  v_workspace public.workspaces;
begin
  if v_user_id is null or not public.workspace_session_active() then
    raise exception 'Nicht angemeldet';
  end if;

  -- KONTOSPERRE: Ein gesperrtes Konto erhaelt und erzeugt keine Betriebsbindung.
  if public.workspace_account_blocked(v_user_id) then
    raise exception 'account_blocked: Konto ist gesperrt' using errcode = '42501';
  end if;
  if not public.workspace_account_approved(v_user_id) then
    raise exception 'account_not_approved: Konto ist nicht freigegeben' using errcode = '42501';
  end if;

  select wm.*
  into v_member
  from public.workspace_members wm
  where wm.user_id = v_user_id
    and wm.status = 'active'
  order by case when wm.role = 'owner' then 0 when wm.role = 'admin' then 1 else 2 end,
           wm.created_at asc
  limit 1;

  if not found then
    return null;
  end if;

  select * into v_workspace from public.workspaces w where w.id = v_member.workspace_id;

  return jsonb_build_object(
    'workspace', to_jsonb(v_workspace),
    'member', to_jsonb(v_member)
  );
end;
$function$;

/* ======================================================================== */
/* 8. EIN-18: Postfach-Interna nicht direkt lesbar                          */
/* ======================================================================== */

/*
 * Die Oberflaeche liest Postfachverbindungen nur ueber list_workspace_mailbox_connections. Direkt lesbar bleiben fuer
 * authenticated die unkritischen Spalten; Cursor, Lease und das Kontosubjekt des Anbieters nicht. Schreibrechte
 * hatte authenticated ohnehin nicht (keine Policy); sie werden auch auf Tabellenebene entzogen. anon erhaelt nichts.
 */
revoke all on public.workspace_mailbox_connections from anon, authenticated;
grant select (
  id, workspace_id, provider_type, mailbox_address, display_name, status, last_successful_sync_at, last_attempt_at,
  next_attempt_at, error_category, error_code, safe_error_message, created_by, created_at, updated_at, row_version,
  auth_mode, mailbox_source_kind, mailbox_source_name, import_from, account_verified_at, consecutive_failures
) on public.workspace_mailbox_connections to authenticated;

/* ======================================================================== */
/* 9. Automatischer Postfachabruf nur bei wirksamer Betriebslizenz          */
/* ======================================================================== */

/*
 * Der Planer (pg_cron, derzeit pausiert) ruft ueber die Edge Function mailbox-auto-sync ohne Nutzerkontext ab. Ein
 * Postfachabruf ist im Nur-Lesen-Betrieb nicht erlaubt (Vertrag 1.3); Betriebe ohne wirksame Betriebslizenz erscheinen
 * deshalb nicht mehr in der Kandidatenliste. Sonst unveraendert (Fassung 20261105120000).
 */
create or replace function public.list_workspace_mailbox_auto_sync_candidates(p_limit integer default 200)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
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
      and public.workspace_license_effective(c.workspace_id)
    order by coalesce(c.last_attempt_at, 'epoch'::timestamptz), c.id
    limit least(greatest(coalesce(p_limit, 200), 1), 1000)
  ) x;
$function$;

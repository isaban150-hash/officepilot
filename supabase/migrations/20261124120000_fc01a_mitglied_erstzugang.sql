-- FINANZ-CORE-01A — Nacharbeit WEISS-Recheck 21d, P2 (T8-02): Mitarbeiter-Erstzugang.
--
-- Befund (WEISS, reproduzierbar; Rollback-Nachweis t802-erstzugang): Ein Konto, das
-- ausschliesslich als admin oder member in einem bestehenden Betrieb aktiv ist, erhielt beim
-- ersten Login einen NEU angelegten eigenen Betrieb mit owner-Rolle statt des berechtigten
-- Betriebs. Der Client ruft ensure_personal_workspace nur bei der Erstbindung eines Geraets auf
-- (workspaceCloudBootstrapService); die Fassung aus 20261109120000_account_block_enforcement.sql
-- suchte dabei ausschliesslich eine owner-Mitgliedschaft. Einen anderen Weg in einen bestehenden
-- Betrieb hat das Produkt nicht.
--
-- Korrektur — nur diese Funktion; Signatur und Rueckgabeform unveraendert:
--   1. Anmeldung und Kontosperre unveraendert zuerst.
--   2. Aktive owner-Mitgliedschaft: unveraendert der aelteste eigene Betrieb.
--   3. NEU: sonst die aktive admin- oder member-Mitgliedschaft — admin vor member, die aelteste
--      zuerst (dieselbe Rangfolge wie get_active_workspace), bei Gleichstand nach Betriebskennung.
--      Es wird nichts angelegt, keine Rolle veraendert und der Betrieb nicht angefasst; p_name
--      bleibt unbeachtet. Rueckgabe: die tatsaechliche Mitgliedschaft, created = false.
--   4. Nur ohne jede aktive Mitgliedschaft entsteht wie bisher ein eigener Betrieb.
-- Eingeladene (invited) und entfernte (removed) Mitgliedschaften gewaehren keinen Zugang; sie
-- werden weder aktiviert noch wiederbelebt und verhindern das Anlegen nicht (wie bisher).
-- Mitgliedschaften entstehen nur ueber diese Funktion (eigener Betrieb) oder durch einen
-- Berechtigten: workspace_members hat fuer authenticated nur eine Lese-Policy.
--
-- Bewusst NICHT Teil dieser Migration (im Bericht genannt): Konten, die vor dieser Korrektur
-- bereits einen eigenen Betrieb erhalten haben (owner geht weiterhin vor), eine Betriebsauswahl
-- in der Oberflaeche, eine Einladungsannahme. 20261109120000 bleibt unveraendert.
--
-- Rechte: ausdruecklich wie in Produktion (Schemaabzug) — nur authenticated. CREATE OR REPLACE
-- behielte die bestehenden Rechte; lokal hatten zusaetzlich anon und service_role EXECUTE.
--
-- Lokal vorbereitet und getestet (supabase/tests/fc01a_mitglied_erstzugang.sql). NICHT remote.

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
begin
  if v_user_id is null then
    raise exception 'Nicht angemeldet';
  end if;

  -- KONTOSPERRE: Ein gesperrtes Konto erhaelt und erzeugt keine Betriebsbindung.
  if public.workspace_account_blocked(v_user_id) then
    raise exception 'account_blocked: Konto ist gesperrt' using errcode = '42501';
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

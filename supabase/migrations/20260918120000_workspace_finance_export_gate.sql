-- FINANZ-CORE-DURABILITY-01D — Steuerberater-Monatsmappe: serverseitige Freigabe.
--
-- Die Monatsmappe ist eine abgeleitete Darstellung der kanonischen Finanzdaten
-- (Rechnungen, Ausgaben, Zahlungen, Archivdateien). Sie erzeugt keine zweite
-- Wahrheit und keine eigene Tabelle. Was sie braucht, ist eine belastbare
-- Berechtigungsgrenze: Dieselbe Regel wie fuer Ausgaben (01C) — owner/admin.
--
-- Der Client ruft diese Funktion vor jedem Export auf. Ein Mitglied ohne
-- Finanzrecht erhaelt 'Kein Zugriff auf Workspace' — unabhaengig davon, was die
-- Oberflaeche anzeigt. Die Datenseite ist ohnehin gesichert: Ausgaben werden
-- Mitgliedern per RLS/RPC nie ausgeliefert.

create or replace function public.assert_workspace_finance_export(p_workspace_id uuid)
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
  return jsonb_build_object('allowed', true, 'checked_at', now());
end;
$$;

revoke all on function public.assert_workspace_finance_export(uuid) from public;
grant execute on function public.assert_workspace_finance_export(uuid) to authenticated;

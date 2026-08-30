-- BRANDING-01D -- Bruecke zwischen Storage-Policies und den Workspace-Helfern.
--
-- Befund aus dem ersten echten Upload:
--
--   permission denied for function can_write_workspace   (SQLSTATE 42501)
--
-- Ursache: 20250711140000_workspace_cloud_data.sql entzieht die drei
-- Membership-Helfer ausdruecklich der Allgemeinheit --
--
--   revoke all on function public.is_active_workspace_member(uuid) from public;
--   revoke all on function public.workspace_member_role(uuid)      from public;
--   revoke all on function public.can_write_workspace(uuid)        from public;
--
-- -- und erteilt ihnen bewusst **kein** `grant execute to authenticated`. Sie
-- sind ausschliesslich fuer den Aufruf aus den Security-Definer-RPCs gedacht,
-- die als Eigentuemer laufen.
--
-- Eine RLS-Policy auf storage.objects wird dagegen als **aufrufende** Rolle
-- ausgewertet. Sie kann die Helfer daher nicht direkt verwenden.
--
-- Der naheliegende Ausweg -- den drei Helfern EXECUTE fuer `authenticated` zu
-- erteilen -- wird hier ausdruecklich NICHT gegangen. Das waere eine globale
-- Rechteausweitung fuer eine lokale Anforderung: Jeder angemeldete Nutzer
-- koennte dann Mitgliedschaft und Rolle beliebiger Workspaces abfragen.
--
-- Stattdessen zwei minimale Security-Definer-Bruecken, die ausschliesslich
-- einen Storage-Objektnamen entgegennehmen und ausschliesslich `boolean`
-- zurueckgeben. Keine Rolle, keine Kennung, keine Geschaeftsdaten -- und keine
-- eigene Mitgliedschaftslogik: Die bleibt vollstaendig bei den vorhandenen
-- Funktionen, `auth.uid()` wirkt dort unveraendert.
--
-- Die bereits angewendete Migration 20250831120000 bleibt unberuehrt; der
-- sichere Pfad-Parser branding_asset_workspace_id(text) wird von dort
-- wiederverwendet. Keine zweite Regex, kein direkter text::uuid-Cast.

-- ---------------------------------------------------------------------------
-- Lesebruecke
-- ---------------------------------------------------------------------------

create or replace function public.branding_asset_can_read(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    public.is_active_workspace_member(public.branding_asset_workspace_id(p_name)),
    false
  );
$$;

-- ---------------------------------------------------------------------------
-- Schreibbruecke
-- ---------------------------------------------------------------------------
--
-- Lesen darf jedes aktive Mitglied, anlegen nur, wer auch sonst schreiben darf.
-- Eine Leserolle soll kein unloeschbares Objekt erzeugen koennen.

create or replace function public.branding_asset_can_write(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    public.can_write_workspace(public.branding_asset_workspace_id(p_name)),
    false
  );
$$;

-- Ungueltiger Pfad -> branding_asset_workspace_id liefert NULL -> die Helfer
-- liefern NULL oder false -> coalesce ergibt false. Keine Ausnahme, kein
-- Abbruch der Policy-Auswertung.

-- ---------------------------------------------------------------------------
-- Rechte
-- ---------------------------------------------------------------------------
--
-- Nur die beiden Bruecken werden freigegeben. Die drei zugrunde liegenden
-- Workspace-Helfer behalten ihren bisherigen Vertrag und bleiben fuer
-- `authenticated` und `anon` unaufrufbar.

revoke all on function public.branding_asset_can_read(text) from public;
revoke all on function public.branding_asset_can_write(text) from public;

grant execute on function public.branding_asset_can_read(text) to authenticated;
grant execute on function public.branding_asset_can_write(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------
--
-- Gleiche Regeln wie zuvor, nur ueber die Bruecken aufgerufen.
-- Weiterhin auf den eigenen Bucket beschraenkt, weiterhin ohne UPDATE und
-- ohne DELETE -- darauf beruht die Unveraenderlichkeit der Assets.

drop policy if exists branding_assets_select_member on storage.objects;
create policy branding_assets_select_member
on storage.objects for select to authenticated
using (
  bucket_id = 'branding-assets'
  and public.branding_asset_can_read(name)
);

drop policy if exists branding_assets_insert_writer on storage.objects;
create policy branding_assets_insert_writer
on storage.objects for insert to authenticated
with check (
  bucket_id = 'branding-assets'
  and public.branding_asset_can_write(name)
);

-- Bewusst weiterhin keine UPDATE-Policy: Assets sind unveraenderlich.
-- Bewusst weiterhin keine DELETE-Policy: ein ersetztes Logo bleibt erhalten,
-- damit historische Dokumente ihre Referenz nicht verlieren.

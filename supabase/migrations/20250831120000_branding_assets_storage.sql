-- BRANDING-01D -- privater Bucket fuer unveraenderliche Branding-Assets.
--
-- Ein Firmenlogo wird nie ueberschrieben. Ein neues Logo ist ein neues Objekt
-- unter einer neuen Kennung; das alte bleibt bestehen, damit ein bereits
-- finalisiertes Dokument seine Asset-Referenz behaelt und spaeter nicht
-- ploetzlich ein anderes Logo zeigt.
--
-- Erzwungen wird das serverseitig ueber die Menge der Policies:
--
--   SELECT  -- aktive Workspace-Mitglieder
--   INSERT  -- nur mit Schreibberechtigung
--   UPDATE  -- absichtlich NICHT vorhanden
--   DELETE  -- absichtlich NICHT vorhanden (V1)
--
-- Unter RLS ist verboten, was nicht ausdruecklich erlaubt ist. Ohne
-- UPDATE-Policy kann selbst ein versehentliches `upsert: true` im Client kein
-- vorhandenes Objekt ersetzen -- die Storage-Bibliothek benoetigt dafuer
-- ausdruecklich das UPDATE-Recht.
--
-- Objektpfad: <workspace_id>/<asset_id>
-- Keine Dateiendung, kein Dateiname des Nutzers, keine Geschaeftsdaten.
--
-- Alle Policies sind auf bucket_id = 'branding-assets' eingeschraenkt. Keine
-- pauschale Regel auf storage.objects, damit spaetere Buckets unberuehrt
-- bleiben.

-- ---------------------------------------------------------------------------
-- Pfad -> Workspace-UUID
-- ---------------------------------------------------------------------------
--
-- Der Helper existiert wegen einer konkreten Falle: `text::uuid` wirft in
-- PostgreSQL bei ungueltiger Eingabe eine Ausnahme, statt NULL zu liefern. Ein
-- Objektname mit beliebigem erstem Segment wuerde die Auswertung der Policy
-- also mit einem Fehler abbrechen lassen, statt den Zugriff schlicht zu
-- verweigern.
--
-- Der Helper prueft deshalb zuerst die vollstaendige Pfadform und castet erst
-- danach. Er trifft **keine** Sicherheitsentscheidung -- Mitgliedschaft und
-- Schreibrecht bleiben bei den vorhandenen Funktionen.
--
-- Akzeptiert wird ausschliesslich `<uuid>/<asset-id>`: genau zwei Segmente.
-- Weder `workspace/asset/mehr` noch `workspace/` noch `/asset`.
--
-- Kein SECURITY DEFINER: Die Funktion liest keine Tabelle und braucht keine
-- fremden Rechte.

create or replace function public.branding_asset_workspace_id(p_name text)
returns uuid
language sql
immutable
set search_path = public
as $$
  select case
    when p_name ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
     and p_name !~ '\.\.'
    then split_part(p_name, '/', 1)::uuid
    else null
  end;
$$;

grant execute on function public.branding_asset_workspace_id(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Bucket
-- ---------------------------------------------------------------------------
--
-- Privat: OfficePilot trennt Daten konsequent nach Workspace. Fuer Branding
-- soll diese Grenze nicht aufgeweicht werden, auch wenn ein Firmenlogo kein
-- Geheimnis ist. Abgerufen wird deshalb ueber authentifiziertes download(),
-- nicht ueber oeffentliche URLs -- was fuer spaetere PDFs ohnehin passt, weil
-- pdf-lib Bytes benoetigt und keine URL.
--
-- MIME-Liste und Groessengrenze wiederholen bewusst die Client-Regeln aus
-- BRANDING-01C: gestaffelte Absicherung, nicht Ersatz.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'branding-assets',
  'branding-assets',
  false,
  2097152,
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------

drop policy if exists branding_assets_select_member on storage.objects;
create policy branding_assets_select_member
on storage.objects for select to authenticated
using (
  bucket_id = 'branding-assets'
  and public.is_active_workspace_member(public.branding_asset_workspace_id(name))
);

-- Lesen darf jedes aktive Mitglied; erzeugen nur, wer auch sonst schreiben
-- darf. Jeder andere Schreibpfad des Projekts prueft can_write_workspace --
-- eine Leserolle soll kein unloeschbares Objekt anlegen koennen.
drop policy if exists branding_assets_insert_writer on storage.objects;
create policy branding_assets_insert_writer
on storage.objects for insert to authenticated
with check (
  bucket_id = 'branding-assets'
  and public.can_write_workspace(public.branding_asset_workspace_id(name))
);

-- Bewusst keine UPDATE-Policy: Assets sind unveraenderlich.
-- Bewusst keine DELETE-Policy: ein ersetztes Logo bleibt erhalten, damit
-- historische Dokumente ihre Referenz nicht verlieren.

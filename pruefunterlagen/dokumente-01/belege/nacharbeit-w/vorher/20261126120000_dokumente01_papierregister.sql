-- DOKUMENTE-01 / F9 — der Papierregister-Eintrag gehört seinem Dokument.
--
-- Befund (Mitgliedsgerät, „Keine Schreibberechtigung"):
--
--   Je Dokument gibt es genau einen Eintrag mit fester Kennung
--   (`paper-reg-<Dokument-ID>`). Sichtbarkeit und Schreibrecht eines Mitglieds
--   hängen aber am Anleger der Zeile (`created_by`), nicht am Dokument
--   (20261030120000, 20261104120000). Legt der Inhaber den Eintrag zum Dokument
--   eines Mitglieds zuerst an — er hakt es ab, bevor das Mitgliedsgerät seinen
--   Eintrag gesendet hat, oder sein Gerät lädt Altbestand hoch —, sieht das
--   Mitglied die Zeile nicht. Sein Gerät hält sie für fehlend, sendet seinen
--   Eintrag mit Version 0, und der Server weist ihn endgültig ab. Das Mitglied
--   sieht „nicht abgeheftet" und einen Sync-Fehler, für immer.
--
--   Der Kopfkommentar von 20261030120000 verspricht dagegen: „Rechte und
--   Sichtbarkeit folgen dem Dokument". `created_by` war dafür nur der
--   Stellvertreter — und versagt genau dann, wenn Eintrag und Dokument
--   verschiedene Anleger haben.
--
-- Lösung, ohne den Dispatcher oder den Abzug anzufassen:
--
--   1  Ein neuer Eintrag zu einem Archivdokument trägt als `created_by` den
--      Anleger dieses Dokuments; wer ihn geschrieben hat, steht wie bisher in
--      `updated_by`. Policy, Abzug und Schreibrecht (alle über `created_by`)
--      folgen damit dem Dokument: Das Mitglied sieht und ändert den Eintrag zu
--      seinem Dokument, auch wenn der Inhaber ihn angelegt hat. Ohne
--      Archivdokument in der Cloud bleibt es beim Schreibenden.
--   2  Altbestand: bestehende Einträge bekommen einmalig denselben Anleger.
--      Version und Inhalt bleiben, nur die Zuordnung wechselt.
--
-- Unverändert: Grabsteine setzen nur Inhaber und Admin; geschützte Belege
-- (Mitarbeiterzahlungen) sieht und schreibt kein Mitglied; ein Eintrag wechselt
-- nie sein Dokument.
--
-- Nur lokal vorbereitet. Die Anwendung auf die Cloud ist ein eigener,
-- ausdrücklich freizugebender Schritt.

/* ------------------------------------------------------------------------ */
/* 1 — neuer Eintrag: Anleger des Dokuments                                  */
/* ------------------------------------------------------------------------ */
create or replace function public.workspace_paper_register_entries_document_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_anleger uuid;
begin
  if new.client_document_id is null then
    return new;
  end if;
  select d.created_by into v_anleger
  from public.workspace_documents d
  where d.workspace_id = new.workspace_id
    and d.client_document_id = new.client_document_id
    and d.document_kind = 'archived_document';
  if v_anleger is not null then
    new.created_by := v_anleger;
  end if;
  return new;
end;
$$;

revoke all on function public.workspace_paper_register_entries_document_owner()
  from public, anon, authenticated, service_role;

drop trigger if exists workspace_paper_register_entries_document_owner on public.workspace_paper_register_entries;
create trigger workspace_paper_register_entries_document_owner
  before insert on public.workspace_paper_register_entries
  for each row execute function public.workspace_paper_register_entries_document_owner();

/* ------------------------------------------------------------------------ */
/* 2 — Altbestand                                                            */
/* ------------------------------------------------------------------------ */
create or replace function public.workspace_paper_register_entries_assign_document_owner()
returns integer
language sql
security definer
set search_path = public
as $$
  with umgestellt as (
    update public.workspace_paper_register_entries e
    set created_by = d.created_by
    from public.workspace_documents d
    where d.workspace_id = e.workspace_id
      and d.client_document_id = e.client_document_id
      and d.document_kind = 'archived_document'
      and d.created_by is not null
      and e.created_by is distinct from d.created_by
    returning 1
  )
  select count(*)::integer from umgestellt;
$$;

revoke all on function public.workspace_paper_register_entries_assign_document_owner()
  from public, anon, authenticated, service_role;

select public.workspace_paper_register_entries_assign_document_owner();

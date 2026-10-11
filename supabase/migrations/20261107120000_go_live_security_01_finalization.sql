-- GO-LIVE-SECURITY-01 / VOLLSTAENDIGE SICHERHEITSFINALISIERUNG — Altbestand
-- der E-Rechnungsbindungen, Nebenlaeufigkeit und Identitaet der Rechnungsbelege.
--
-- Baut auf 20261106120000_einvoice_binding_security_01.sql auf. Jene Datei
-- bleibt unveraendert; ihre Waechterfunktion fuer Bindungen wird hier durch
-- eine erweiterte Fassung ersetzt (create or replace), alle Regeln von dort
-- gelten unveraendert weiter. Rein additiv; keine angewendete Migration wird
-- angefasst.
--
-- Befunde (lokal nachgewiesen), hier geschlossen:
--
--   A  Altbestand. Vor 20261106120000 konnten Mitglieder E-Rechnungsbindungen
--      anlegen (lokal: Rechnung 2026-0005, XRechnung und ZUGFeRD eines
--      Mitglieds; dazu drei alte Testbindungen ohne Datei an einem
--      Archivdokument). Clients lieferten abgelegte Dateien als Original aus
--      und verwendeten sie wieder, ohne die Herkunft zu kennen.
--      Neu ist die Vertrauensmarke einvoice_untrusted_at / _reason. Diese
--      Migration setzt sie auf jeder E-Rechnungsbindung, die die heutigen
--      Regeln in Herkunft, Zuordnung oder Datei nicht erfuellt. Sonst wird
--      nichts geaendert und nichts geloescht: Datei, Beleg, Rechnung, Version
--      und Urheber bleiben, wie sie sind. Die Marke verschwindet nur, wenn
--      Inhaber oder Admin die Datei unter allen Pruefungen ersetzen; kein
--      Client kann sie setzen oder entfernen. Clients liefern eine markierte
--      Datei nur aus, wenn eine frische Erzeugung exakt dieselben Bytes ergibt.
--   B  Nebenlaeufigkeit. Der Bindungswaechter las Beleg und Datei ohne Sperre;
--      ein gleichzeitiges Aendern der Datei oder Loeschen des Belegs konnte
--      zwischen Pruefung und Abschluss fallen. Jetzt FOR SHARE auf beiden
--      Zeilen: Wer sie gleichzeitig aendert, wartet, und der Dateiwaechter
--      sieht danach die neue Bindung.
--   C  Identitaet der Rechnungsbelege. Ueber den Eingangsweg legte ein Mitglied
--      ein Archivdokument mit linked_invoice_id oder linkedInvoiceId in der
--      Nutzlast an. Der Client hielt es fuer den Beleg der Rechnung
--      (faelschen, verdraengen) und scheiterte danach an der eigenen Ablage
--      (blockieren). Die Kennung des Korrekturbelegs ist vorhersagbar
--      (corr-<Rechnung>): Ein vorab angelegtes Dokument liess jede spaetere
--      Stornierung mit "Dokumentkonflikt" scheitern; vorab angelegte Bindungen
--      haengten sich an den kuenftigen Korrekturbeleg.
--      Jetzt, auf jedem Schreibweg: Mitglieder schreiben weder Rechnungs- noch
--      Korrekturbelege, nichts unter corr- (Dokument oder Bindung) und kein
--      Archivdokument mit Rechnungsbezug (Spalte oder Nutzlast).
--
-- Fehlerbilder fuer die Clients: wie 20261106120000 ('Keine
-- Schreibberechtigung' 42501 endgueltig, 'einvoice_binding_pending' P0001
-- wiederholbar, 'einvoice_binding_invalid' 22023 endgueltig).
--
-- Was der Server auch danach NICHT durchsetzt: siehe 20261106120000 (Inhalt
-- und Speicher-Bytes, Ausgabe auf dem Geraet, Wartung ohne Nutzer, Rollen zum
-- Schreibzeitpunkt). Vorab angelegte Archivdokumente mit Rechnungsbezug oder
-- unter corr- aus der Zeit davor bleiben bestehen; die Pruefabfragen dazu
-- stehen in supabase/tests/go_live_security_01_finalization.sql.
--
-- Nur lokal vorbereitet. Die Anwendung auf die Cloud ist ein eigener,
-- ausdruecklich freizugebender Schritt.

/* ------------------------------------------------------------------------ */
/* A1 — Vertrauensmarke                                                      */
/* ------------------------------------------------------------------------ */
alter table public.workspace_document_file_bindings
  add column if not exists einvoice_untrusted_at timestamptz,
  add column if not exists einvoice_untrusted_reason text;

comment on column public.workspace_document_file_bindings.einvoice_untrusted_at is
  'GO-LIVE-SECURITY-01: gesetzt, wenn die E-Rechnungsbindung nicht nachweislich von Inhaber/Admin unter allen Pruefungen stammt. Nur der Server setzt und loescht sie.';
comment on column public.workspace_document_file_bindings.einvoice_untrusted_reason is
  'GO-LIVE-SECURITY-01: Grund der Vertrauensmarke (Pruefcode).';

/* ------------------------------------------------------------------------ */
/* A2/B/C — Bindungswaechter, erweiterte Fassung von 20261106120000          */
/* Neu gegenueber dort: Vertrauensmarke (Schutz, Loeschen nur bei neuer      */
/* Datei), corr- als Rechnungsbeleg, FOR SHARE auf Beleg und Datei.          */
/* ------------------------------------------------------------------------ */
create or replace function public.workspace_einvoice_binding_write_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_neu_erechnung boolean;
  v_alt_erechnung boolean := false;
  v_rechnungsbeleg boolean;
  v_dokument public.workspace_documents%rowtype;
  v_rechnung public.workspace_invoices%rowtype;
  v_datei public.workspace_files%rowtype;
  v_dateityp text;
begin
  -- Wartung ohne angemeldeten Nutzer (Migrationen, service_role, Verwaltung).
  if auth.uid() is null then
    return new;
  end if;

  -- FINALISIERUNG — die Vertrauensmarke setzt und loescht nur der Server:
  -- Neuanlage ohne Marke, Aenderung behaelt sie. Geloescht wird sie unten erst
  -- nach allen Pruefungen, und nur fuer eine neue Datei.
  if tg_op = 'INSERT' then
    new.einvoice_untrusted_at := null;
    new.einvoice_untrusted_reason := null;
  else
    new.einvoice_untrusted_at := old.einvoice_untrusted_at;
    new.einvoice_untrusted_reason := old.einvoice_untrusted_reason;
  end if;

  -- Fremdschluesselpflege (ON DELETE SET NULL auf created_by/updated_by)
  -- aendert keinen Inhalt und keine Version.
  if tg_op = 'UPDATE'
     and (to_jsonb(new) - 'created_by' - 'updated_by') = (to_jsonb(old) - 'created_by' - 'updated_by')
     and (new.created_by is null or new.created_by is not distinct from old.created_by)
     and (new.updated_by is null or new.updated_by is not distinct from old.updated_by) then
    return new;
  end if;

  -- E-Rechnung ist jede Bindung der Rolle structured und jede mit einer
  -- E-Rechnungs-Unterrolle, gleich in welcher Schreibweise.
  v_neu_erechnung := coalesce(lower(btrim(new.binding_kind)) = 'structured', false)
                  or coalesce(lower(btrim(new.part)) in ('xrechnung-cii', 'zugferd-en16931'), false);
  if tg_op = 'UPDATE' then
    v_alt_erechnung := coalesce(lower(btrim(old.binding_kind)) = 'structured', false)
                    or coalesce(lower(btrim(old.part)) in ('xrechnung-cii', 'zugferd-en16931'), false);
  end if;

  -- Rechnungsbeleg: Beleg einer festgeschriebenen Rechnung oder Korrekturbeleg.
  -- FINALISIERUNG — dazu jede Kennung unter corr-: Sie ist dem Korrekturbeleg
  -- der Stornierung vorbehalten, auch solange es ihn noch nicht gibt.
  v_rechnungsbeleg := new.client_document_id like 'corr-%' or exists (
    select 1 from public.workspace_documents d
    where d.workspace_id = new.workspace_id
      and d.client_document_id = new.client_document_id
      and d.document_kind in ('generated_invoice', 'generated_invoice_correction')
  );
  if tg_op = 'UPDATE' and not v_rechnungsbeleg then
    v_rechnungsbeleg := old.client_document_id like 'corr-%' or exists (
      select 1 from public.workspace_documents d
      where d.workspace_id = old.workspace_id
        and d.client_document_id = old.client_document_id
        and d.document_kind in ('generated_invoice', 'generated_invoice_correction')
    );
  end if;

  if not (v_neu_erechnung or v_alt_erechnung or v_rechnungsbeleg) then
    return new;
  end if;

  -- Rolle: nur Inhaber und Admin. Mitglieder legen nichts an, ersetzen nichts,
  -- beleben nichts wieder und aendern nichts, auch nicht Eigenes.
  if not public.can_write_workspace(new.workspace_id) then
    raise exception 'Keine Schreibberechtigung' using errcode = '42501';
  end if;

  -- Kein Umhaengen an einen anderen Beleg, kein Umetikettieren.
  if tg_op = 'UPDATE' and (
       new.workspace_id is distinct from old.workspace_id
       or new.client_document_id is distinct from old.client_document_id
       or new.binding_kind is distinct from old.binding_kind
       or new.part is distinct from old.part) then
    raise exception 'einvoice_binding_invalid: Schluessel einer Rechnungsbindung sind unveraenderlich'
      using errcode = '22023';
  end if;

  -- Inhaber/Admin an einem Rechnungsbeleg ohne E-Rechnungsbezug: wie bisher.
  if not (v_neu_erechnung or v_alt_erechnung) then
    return new;
  end if;

  -- Grabstein auf einer bestehenden Bindung: Aufraeumen ohne weitere
  -- Bedingung. Eine geloeschte Bindung liest kein Client.
  if tg_op = 'UPDATE' and new.deleted then
    return new;
  end if;

  -- Typangaben: E-Rechnungs-Unterrollen nur an structured; structured nur mit
  -- genau bekannter Unterrolle oder ohne (Altbindung aus 04D3).
  if new.binding_kind is distinct from 'structured' then
    raise exception 'einvoice_binding_invalid: E-Rechnungs-Unterrolle nur an der Rolle structured'
      using errcode = '22023';
  end if;
  if new.part is not null and new.part not in ('xrechnung-cii', 'zugferd-en16931') then
    raise exception 'einvoice_binding_invalid: unbekannte Unterrolle einer E-Rechnung'
      using errcode = '22023';
  end if;

  -- Neuanlage als Grabstein: Es entsteht nichts Lesbares.
  if new.deleted then
    return new;
  end if;

  -- Unveraenderte Wiederholung einer lebenden Bindung: kein neuer Inhalt.
  if tg_op = 'UPDATE' and not old.deleted
     and new.client_file_ref_id is not distinct from old.client_file_ref_id
     and new.provenance is not distinct from old.provenance then
    return new;
  end if;

  -- Ab hier: anlegen, wiederbeleben, Datei ersetzen oder Herkunft aendern.
  -- Gueltige Berechtigung wie beim Festschreiben: Rolle, Freigabe, Lizenz.
  perform public.assert_financial_action_allowed(new.workspace_id);

  -- FINALISIERUNG — FOR SHARE: Beleg und Datei koennen sich bis zum Abschluss
  -- dieser Schreibung nicht mehr aendern; wer es versucht, wartet.
  select * into v_dokument
  from public.workspace_documents d
  where d.workspace_id = new.workspace_id
    and d.client_document_id = new.client_document_id
  for share;
  if v_dokument.id is null then
    raise exception 'einvoice_binding_pending: Rechnungsbeleg liegt noch nicht in der Cloud';
  end if;
  if v_dokument.document_kind is distinct from 'generated_invoice' or v_dokument.linked_invoice_id is null then
    raise exception 'einvoice_binding_invalid: E-Rechnungen gehoeren nur an den Beleg einer Rechnung'
      using errcode = '22023';
  end if;
  if v_dokument.deleted or v_dokument.deleted_at is not null then
    raise exception 'einvoice_binding_invalid: Rechnungsbeleg ist geloescht'
      using errcode = '22023';
  end if;

  select * into v_rechnung
  from public.workspace_invoices i
  where i.workspace_id = new.workspace_id
    and i.client_invoice_id = v_dokument.linked_invoice_id;
  if v_rechnung.id is null or v_rechnung.invoice_status = 'entwurf' then
    raise exception 'einvoice_binding_pending: Rechnung ist in der Cloud nicht festgeschrieben';
  end if;
  -- Dieselbe Lesart wie get_workspace_invoice_service_period_confirmation:
  -- Nur eine echte Bestaetigung zaehlt. Die Bestaetigung ist monoton (es gibt
  -- keinen Weg zurueck), eine Sperre auf der Rechnung braucht es deshalb nicht.
  if v_rechnung.payload->>'servicePeriodConfirmed' is distinct from 'true' then
    raise exception 'einvoice_binding_pending: Leistungszeitraum ist in der Cloud nicht bestaetigt';
  end if;

  select * into v_datei
  from public.workspace_files f
  where f.workspace_id = new.workspace_id
    and f.client_file_ref_id = new.client_file_ref_id
  for share;
  if v_datei.id is null then
    raise exception 'einvoice_binding_pending: Datei liegt noch nicht in der Cloud';
  end if;
  if v_datei.deleted then
    raise exception 'einvoice_binding_invalid: Datei ist geloescht'
      using errcode = '22023';
  end if;
  v_dateityp := lower(btrim(split_part(coalesce(v_datei.mime_type, ''), ';', 1)));
  if (new.part = 'zugferd-en16931' and v_dateityp <> 'application/pdf')
     or (new.part is distinct from 'zugferd-en16931' and v_dateityp not in ('application/xml', 'text/xml')) then
    raise exception 'einvoice_binding_invalid: Dateityp passt nicht zur E-Rechnung'
      using errcode = '22023';
  end if;

  -- FINALISIERUNG — nur eine neue Datei, die alle Pruefungen bestanden hat,
  -- loescht die Marke. Wiederbeleben oder Herkunft aendern behalten sie: Sonst
  -- liesse sich eine fremde Altdatei durch Inhaber/Admin reinwaschen.
  if tg_op = 'INSERT' or new.client_file_ref_id is distinct from old.client_file_ref_id then
    new.einvoice_untrusted_at := null;
    new.einvoice_untrusted_reason := null;
  end if;

  return new;
end;
$$;

revoke all on function public.workspace_einvoice_binding_write_guard() from public, anon, authenticated, service_role;

/* ------------------------------------------------------------------------ */
/* C — Identitaet der Rechnungsbelege                                        */
/* ------------------------------------------------------------------------ */
create or replace function public.workspace_invoice_document_identity_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or public.can_write_workspace(new.workspace_id) then
    return new;
  end if;

  -- Fremdschluesselpflege (ON DELETE SET NULL auf created_by, updated_by,
  -- deleted_by) aendert keinen Inhalt.
  if tg_op = 'UPDATE'
     and (to_jsonb(new) - 'created_by' - 'updated_by' - 'deleted_by')
         = (to_jsonb(old) - 'created_by' - 'updated_by' - 'deleted_by')
     and (new.created_by is null or new.created_by is not distinct from old.created_by)
     and (new.updated_by is null or new.updated_by is not distinct from old.updated_by)
     and (new.deleted_by is null or new.deleted_by is not distinct from old.deleted_by) then
    return new;
  end if;

  -- Rechnungs- und Korrekturbelege schreiben nur Inhaber und Admin.
  if new.document_kind in ('generated_invoice', 'generated_invoice_correction')
     or (tg_op = 'UPDATE' and old.document_kind in ('generated_invoice', 'generated_invoice_correction')) then
    raise exception 'Keine Schreibberechtigung' using errcode = '42501';
  end if;

  -- corr-<Rechnung> ist dem Korrekturbeleg der Stornierung vorbehalten.
  if new.client_document_id like 'corr-%'
     or (tg_op = 'UPDATE' and old.client_document_id like 'corr-%') then
    raise exception 'Keine Schreibberechtigung' using errcode = '42501';
  end if;

  -- Ein Archivdokument eines Mitglieds gibt sich nicht als Beleg einer
  -- Rechnung aus: kein Rechnungsbezug, weder in der Spalte noch in der
  -- Nutzlast, aus der der Client ihn liest.
  if new.linked_invoice_id is not null
     or nullif(btrim(coalesce(new.payload->>'linkedInvoiceId', '')), '') is not null then
    raise exception 'Keine Schreibberechtigung' using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists workspace_documents_invoice_identity_guard on public.workspace_documents;
create trigger workspace_documents_invoice_identity_guard
  before insert or update on public.workspace_documents
  for each row execute function public.workspace_invoice_document_identity_guard();

revoke all on function public.workspace_invoice_document_identity_guard() from public, anon, authenticated, service_role;

/* ------------------------------------------------------------------------ */
/* A3 — Altbestand einstufen: nur die Marke, sonst nichts                    */
/* ------------------------------------------------------------------------ */
-- Die Einstufung ist eine eigene, nur lesende Funktion: Migration, SQL-Test und
-- Bestandspruefung verwenden dieselbe Regel. Ergebnis null = unauffaellig oder
-- keine E-Rechnungsbindung. Rollen sind die heutigen; der erste zutreffende
-- Grund zaehlt.
create or replace function public.workspace_einvoice_binding_trust_reason(b public.workspace_document_file_bindings)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when not (coalesce(lower(btrim(b.binding_kind)) = 'structured', false)
              or coalesce(lower(btrim(b.part)) in ('xrechnung-cii', 'zugferd-en16931'), false)) then null
    when b.binding_kind is distinct from 'structured' then 'unterrolle_an_falscher_rolle'
    when b.part is not null and b.part not in ('xrechnung-cii', 'zugferd-en16931') then 'unterrolle_unbekannt'
    when d.id is null or d.document_kind is distinct from 'generated_invoice' or d.linked_invoice_id is null
      then 'kein_rechnungsbeleg'
    when d.deleted or d.deleted_at is not null then 'rechnungsbeleg_geloescht'
    when i.id is null or i.invoice_status = 'entwurf' then 'rechnung_nicht_festgeschrieben'
    when f.id is null then 'datei_fehlt'
    when f.deleted then 'datei_geloescht'
    when (b.part = 'zugferd-en16931' and lower(btrim(split_part(coalesce(f.mime_type, ''), ';', 1))) <> 'application/pdf')
      or (b.part is distinct from 'zugferd-en16931'
          and lower(btrim(split_part(coalesce(f.mime_type, ''), ';', 1))) not in ('application/xml', 'text/xml'))
      then 'dateityp_passt_nicht'
    when not exists (select 1 from public.workspace_members m
                     where m.workspace_id = b.workspace_id and m.user_id = b.created_by
                       and m.status = 'active' and m.role in ('owner', 'admin'))
      or not exists (select 1 from public.workspace_members m
                     where m.workspace_id = b.workspace_id and m.user_id = b.updated_by
                       and m.status = 'active' and m.role in ('owner', 'admin'))
      then 'bindung_nicht_von_inhaber_oder_admin'
    when not exists (select 1 from public.workspace_members m
                     where m.workspace_id = b.workspace_id and m.user_id = f.created_by
                       and m.status = 'active' and m.role in ('owner', 'admin'))
      then 'datei_nicht_von_inhaber_oder_admin'
    else null
  end
  from (select 1) as eins
  left join public.workspace_documents d
    on d.workspace_id = b.workspace_id and d.client_document_id = b.client_document_id
  left join public.workspace_invoices i
    on i.workspace_id = b.workspace_id and i.client_invoice_id = d.linked_invoice_id
  left join public.workspace_files f
    on f.workspace_id = b.workspace_id and f.client_file_ref_id = b.client_file_ref_id;
$$;

revoke all on function public.workspace_einvoice_binding_trust_reason(public.workspace_document_file_bindings)
  from public, anon, authenticated, service_role;

-- Auch geloeschte Bindungen werden markiert: Ein spaeteres Wiederbeleben mit
-- derselben Datei behaelt die Marke. Version, Urheber, Datei und Beleg bleiben.
update public.workspace_document_file_bindings b
set einvoice_untrusted_at = now(),
    einvoice_untrusted_reason = e.grund
from (
  select x.id, public.workspace_einvoice_binding_trust_reason(x) as grund
  from public.workspace_document_file_bindings x
  where x.einvoice_untrusted_at is null
) e
where e.id = b.id
  and e.grund is not null;

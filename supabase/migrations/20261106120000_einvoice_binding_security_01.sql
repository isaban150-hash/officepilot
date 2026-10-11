-- GO-LIVE-SECURITY-01 / SERVER-SICHERHEIT E-RECHNUNGEN — Dateibindungen von
-- XRechnung und ZUGFeRD-Rechnung serverseitig absichern.
--
-- Befund (lokal nachgewiesen gegen den Stand nach 20261105120000):
--
--   Einziger Schreibweg fuer workspace_document_file_bindings ist
--   upsert_workspace_intake_entity (Zweig document_file_binding). Clients haben
--   an der Tabelle nur SELECT und keine Schreib-Policy; keine andere Funktion
--   schreibt Bindungen. Der Zweig prueft nur die Mitgliedschaft. Jedes aktive
--   Mitglied konnte deshalb
--     * die strukturierte E-Rechnungsbindung am Beleg einer Rechnung anlegen
--       (Rolle structured, Unterrolle xrechnung-cii oder zugferd-en16931 oder
--       ohne Unterrolle als Altbindung aus 04D3), solange es sie noch nicht gab,
--     * eigene Bindungen ersetzen (client_file_ref_id), in der Herkunft aendern
--       und eigene Grabsteine wiederbeleben (deleted = false),
--     * beliebige Rollen und Unterrollen an beliebige Belege haengen, auch an
--       den Beleg einer Rechnung, und eine Datei mit beliebiger Kennung und
--       beliebigem Typ dafuer hochladen. Beleg, Rechnung, Datei und Unterrolle
--       prueft der Zweig nicht.
--   Die Wiederverwendung abgelegter E-Rechnungen vertraut dieser Bindung (der
--   Hash belegt Unversehrtheit, nicht Herkunft): Ein manipulierter
--   Mitglieds-Client konnte die erste E-Rechnungsdatei einer Rechnung stellen.
--
-- Geschlossen durch zwei Waechter an den Tabellen. Sie erfassen jeden
-- Schreibweg -- den Eingangsweg, jede kuenftige Security-Definer-Funktion und
-- direkte Schreibversuche --, ohne die angewendete Funktion anzufassen:
--
--   1  workspace_document_file_bindings. Eine E-Rechnungsbindung (Rolle
--      structured oder eine E-Rechnungs-Unterrolle; Schreibweise normalisiert;
--      alter und neuer Stand) und jede Bindung am Beleg einer Rechnung oder
--      eines Korrekturbelegs schreiben nur Inhaber und Admin (42501).
--      Anlegen, Wiederbeleben, Datei ersetzen und Herkunft aendern einer
--      E-Rechnungsbindung verlangen zusaetzlich
--        * gueltige Berechtigung wie beim Festschreiben (Freigabe, Lizenz),
--        * den lebenden Beleg einer festgeschriebenen Rechnung dieses Betriebs
--          (document_kind generated_invoice -- den legt nur Inhaber/Admin an;
--          ein Archivdokument mit linked_invoice_id zaehlt nicht),
--        * den serverseitig bestaetigten Leistungszeitraum dieser Rechnung,
--        * eine lebende Datei dieses Betriebs, deren Typ zur Unterrolle passt.
--      Unterrollen nur genau xrechnung-cii, zugferd-en16931 oder keine (04D3),
--      nur an structured. Schluessel einer solchen Bindung sind unveraenderlich.
--      Grabsteine durch Inhaber/Admin bleiben ohne weitere Bedingung
--      (Aufraeumen), eine unveraenderte Wiederholung ebenso.
--   2  workspace_files. Eine Datei, auf die eine E-Rechnungsbindung oder eine
--      Bindung an einem Rechnungsbeleg zeigt (auch eine geloeschte), legen
--      Mitglieder weder an, noch aendern sie ihre Angaben.
--
-- Die Herkunft der gebundenen Datei bleibt bewusst offen: Der Client legt
-- Dateien ueber den Hash zusammen. Erzeugt der Inhaber dieselben Bytes, die
-- ein Mitglied schon hochgeladen hat, bindet er dessen Dateizeile -- mit
-- seinem eigenen Inhalt. Eine Pflicht "Datei vom Inhaber" braeche diesen
-- zulaessigen Weg.
--
-- Fehlerbilder fuer die Clients:
--   * 'Keine Schreibberechtigung' (42501): endgueltig, Rollenabweisung.
--   * 'einvoice_binding_pending: ...' (P0001): noch nicht moeglich und
--     wiederholbar. Beleg, Datei oder Bestaetigung des Leistungszeitraums sind
--     noch nicht in der Cloud (Offline-Reihenfolge); ein spaeterer Lauf gelingt.
--   * 'einvoice_binding_invalid: ...' (22023): unzulaessige Angaben, endgueltig.
--   * 'finance_...' (P0001): Konto nicht freigegeben oder Lizenz nicht aktiv.
--
-- Bewusste Grenzen:
--   * rein additiv: keine Aenderung an 20261105120000 oder an
--     upsert_workspace_intake_entity, keine neue Spalte, keine neue Policy,
--   * keine Datenmigration: vorhandene Bindungen und Dateien bleiben, wie sie
--     sind, auch solche, die Mitglieder vor dieser Migration angelegt haben,
--   * Wartung ohne angemeldeten Nutzer (Migration, service_role) bleibt frei.
--
-- Was der Server danach ausdruecklich NICHT durchsetzt:
--   * Altbestand: Bindungen von vor dieser Migration gelten weiter und werden
--     weiter ausgeliefert und wiederverwendet. Sichtung mit der Einstufung aus
--     supabase/tests/einvoice_binding_security_01.sql (Abschnitt D).
--   * Inhalt: ob XML oder PDF zur Rechnung passt und der Norm entspricht, und
--     ob die Bytes im Speicher zum Hash passen. Jedes Mitglied darf Objekte
--     unter <betrieb>/<hash> hochladen; Clients pruefen den Hash beim Laden.
--   * Ausgabe: Erzeugen, Herunterladen, Drucken und Versenden auf dem Geraet.
--     Der Server sieht nur die Ablage in der Cloud.
--   * Belegidentitaet: Ueber den Eingangsweg legen Mitglieder weiterhin
--     Archivdokumente mit linked_invoice_id an. Fuer E-Rechnungen zaehlen sie
--     hier nicht; ob der Client sie als Rechnungsbeleg nimmt, entscheidet er.
--   * Noch unbekannte Belege: Bindungen ohne E-Rechnungsbezug an Kennungen,
--     die es noch nicht gibt (etwa corr-<Rechnung>), legt ein Mitglied
--     weiterhin vorab an.
--   * Rollen gelten zum Schreibzeitpunkt; fruehere Schreibvorgaenge spaeter
--     herabgestufter Nutzer bleiben bestehen.
--
-- Nur lokal vorbereitet. Die Anwendung auf die Cloud ist ein eigener,
-- ausdruecklich freizugebender Schritt.

/* ------------------------------------------------------------------------ */
/* 1 — Bindungen                                                             */
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
  -- Beide entstehen nur ueber Wege fuer Inhaber/Admin; der Eingangsweg legt
  -- ausschliesslich archived_document an.
  v_rechnungsbeleg := exists (
    select 1 from public.workspace_documents d
    where d.workspace_id = new.workspace_id
      and d.client_document_id = new.client_document_id
      and d.document_kind in ('generated_invoice', 'generated_invoice_correction')
  );
  if tg_op = 'UPDATE' and not v_rechnungsbeleg then
    v_rechnungsbeleg := exists (
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

  select * into v_dokument
  from public.workspace_documents d
  where d.workspace_id = new.workspace_id
    and d.client_document_id = new.client_document_id;
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
  -- Nur eine echte Bestaetigung zaehlt.
  if v_rechnung.payload->>'servicePeriodConfirmed' is distinct from 'true' then
    raise exception 'einvoice_binding_pending: Leistungszeitraum ist in der Cloud nicht bestaetigt';
  end if;

  select * into v_datei
  from public.workspace_files f
  where f.workspace_id = new.workspace_id
    and f.client_file_ref_id = new.client_file_ref_id;
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

  return new;
end;
$$;

drop trigger if exists workspace_document_file_bindings_einvoice_write_guard on public.workspace_document_file_bindings;
create trigger workspace_document_file_bindings_einvoice_write_guard
  before insert or update on public.workspace_document_file_bindings
  for each row execute function public.workspace_einvoice_binding_write_guard();

/* ------------------------------------------------------------------------ */
/* 2 — Dateien hinter E-Rechnungs- und Rechnungsbeleg-Bindungen              */
/* ------------------------------------------------------------------------ */
create or replace function public.workspace_einvoice_file_write_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kennungen text[] := array[new.client_file_ref_id];
begin
  if auth.uid() is null or public.can_write_workspace(new.workspace_id) then
    return new;
  end if;

  -- Fremdschluesselpflege (ON DELETE SET NULL) aendert keinen Inhalt.
  if tg_op = 'UPDATE'
     and (to_jsonb(new) - 'created_by' - 'updated_by' - 'uploaded_by')
         = (to_jsonb(old) - 'created_by' - 'updated_by' - 'uploaded_by')
     and (new.created_by is null or new.created_by is not distinct from old.created_by)
     and (new.updated_by is null or new.updated_by is not distinct from old.updated_by)
     and (new.uploaded_by is null or new.uploaded_by is not distinct from old.uploaded_by) then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    v_kennungen := array_append(v_kennungen, old.client_file_ref_id);
  end if;

  -- Auch geloeschte Bindungen zaehlen: Ein Inhaber kann sie wiederbeleben, und
  -- dann darf die Datei dahinter nicht inzwischen von einem Mitglied stammen.
  if exists (
    select 1
    from public.workspace_document_file_bindings b
    left join public.workspace_documents d
      on d.workspace_id = b.workspace_id and d.client_document_id = b.client_document_id
    where b.workspace_id = new.workspace_id
      and b.client_file_ref_id = any (v_kennungen)
      and (coalesce(lower(btrim(b.binding_kind)) = 'structured', false)
           or coalesce(lower(btrim(b.part)) in ('xrechnung-cii', 'zugferd-en16931'), false)
           or coalesce(d.document_kind in ('generated_invoice', 'generated_invoice_correction'), false))
  ) then
    raise exception 'Keine Schreibberechtigung' using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists workspace_files_einvoice_write_guard on public.workspace_files;
create trigger workspace_files_einvoice_write_guard
  before insert or update on public.workspace_files
  for each row execute function public.workspace_einvoice_file_write_guard();

/* ------------------------------------------------------------------------ */
/* Rechte: reine Trigger-Funktionen, fuer niemanden direkt aufrufbar         */
/* ------------------------------------------------------------------------ */
revoke all on function public.workspace_einvoice_binding_write_guard() from public, anon, authenticated, service_role;
revoke all on function public.workspace_einvoice_file_write_guard() from public, anon, authenticated, service_role;

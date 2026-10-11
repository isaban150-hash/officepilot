-- GO-LIVE-SECURITY-01 / ABSCHLUSS — Abgrenzung der E-Rechnungsbindungen.
--
-- Baut auf 20261106120000_einvoice_binding_security_01.sql und
-- 20261107120000_go_live_security_01_finalization.sql auf. Beide Dateien
-- bleiben unveraendert; der Bindungswaechter und die Einstufung der
-- Vertrauensmarke werden hier durch genauere Fassungen ersetzt (create or
-- replace). Rein additiv; keine angewendete Migration wird angefasst.
--
-- Befund (lokal nachgewiesen), hier geschlossen:
--
--   E  Abgrenzung. 20261106120000 behandelte JEDE Bindung der Rolle
--      structured als E-Rechnung. Der Serververtrag INTAKE-CLOUD-SQL-01B
--      (tests/e2e/localdbIntakeCloudSql01b.spec.ts) sieht structured mit der
--      Herkunft extracted aber ausdruecklich fuer das aus einem EMPFANGENEN
--      Beleg extrahierte XML vor (etwa die XRechnung eines Lieferanten im
--      Archiv). Diese Bindung lehnte der Waechter fuer jede Rolle ab, weil der
--      Beleg kein Rechnungsbeleg ist, und die Einstufung markierte solche
--      Altbindungen als 'kein_rechnungsbeleg'.
--      Jetzt ist E-Rechnung genau:
--        - jede Bindung mit einer E-Rechnungs-Unterrolle (xrechnung-cii,
--          zugferd-en16931), gleich in welcher Schreibweise,
--        - jede Bindung der Rolle structured an einem Rechnungs- oder
--          Korrekturbeleg oder unter corr-, gleich welcher Herkunft,
--        - jede andere Bindung der Rolle structured, deren Herkunft nicht
--          extracted ist (eine selbst erzeugte strukturierte Fassung).
--      structured/extracted an einem gewoehnlichen Archivdokument ist damit
--      wieder ein normaler Eingangsweg mit den Regeln des Eingangs
--      (20260916120000, 20261105120000). Am Schutz der Rechnungsbelege
--      aendert sich nichts: Jede Bindung an einem Rechnungs- oder
--      Korrekturbeleg oder unter corr- schreiben weiterhin nur Inhaber und
--      Admin, und Clients werten E-Rechnungen ausschliesslich am erzeugten
--      Rechnungsbeleg aus.
--      Die Marke 'kein_rechnungsbeleg' wird nur dort entfernt, wo die Bindung
--      nach dieser Abgrenzung gar keine E-Rechnung ist. Jede andere Marke
--      bleibt unveraendert (kein Reinwaschen ueber spaetere Rollen).
--
--   R  Rechte und Stoerungen durch Mitarbeiter (Abschlusspruefung aller
--      Schreibwege auf Dokumente, Dateien, Bindungen, Speicher und Rechnungen):
--      R1 Mitglieder belebten Grabsteine von Inhaber/Admin wieder: Der
--         Eingangsweg uebernahm deleted=false fuer eigene Dateien, Bindungen,
--         Eingangseintraege und Arbeitsergebnisse, und die Datei war danach
--         wieder lesbar. Jetzt: Wiederbeleben nur Inhaber/Admin (Trigger).
--      R2 Mitglieder legten Bindungen an fremden Archivdokumenten an (etwa
--         eine eigene Vorschau an einem Dokument des Inhabers, das sie nicht
--         einmal lesen) und besetzten damit den Platz, an dem der Inhaber
--         spaeter scheiterte. Jetzt: Mitglieder binden nur an eigene oder noch
--         nicht vorhandene Dokumente (Trigger).
--      R3 corr-<Rechnung> war fuer Inhaber/Admin als Archivdokument frei; ein
--         solcher Platzhalter liess jede spaetere Stornierung mit
--         "Dokumentkonflikt" scheitern. Jetzt: Neue oder umgewidmete Dokumente
--         unter corr- sind fuer jeden angemeldeten Nutzer nur der Korrekturbeleg
--         (generated_invoice_correction). Bestehende Altplatzhalter bleiben
--         bereinigbar.
--      R4 Der Dateiwaechter uebersah Bindungen unter corr-, solange es den
--         Korrekturbeleg noch nicht gibt. Jetzt mitgezaehlt; ausserdem gilt
--         fuer ihn dieselbe Abgrenzung wie in E (die eigene Eingangs-XML eines
--         Mitglieds an structured/extracted bleibt aenderbar).
--      R5 Der Versandvermerk setzte auch eine intern stornierte Rechnung auf
--         versendet ("versendet und storniert" ohne Korrekturbeleg). Jetzt
--         abgewiesen (22023); Versandangaben einer bereits versendeten Rechnung
--         bleiben korrigierbar.
--      R6 Versandvermerk und Bestaetigung des Leistungszeitraums pruefen jetzt
--         wie das Festschreiben Freigabe, Sperre und Lizenz
--         (assert_financial_action_allowed), nach der Rollenpruefung.
--      R7 Wer den Hash einer eingeschraenkten Datei kannte (etwa eines
--         Mitarbeiterzahlungsbelegs), konnte als Mitglied eine eigene Dateizeile
--         mit diesem Hash anlegen und das Speicherobjekt lesen. Jetzt liest ein
--         Mitglied kein Objekt, zu dessen Pfad eine eingeschraenkte Datei gehoert.
--      R8 Mitglieder aenderten fremde Bankkonten und Umsaetze, die sie nicht
--         lesen duerfen, und erhielten die Zeile zurueck. Jetzt: Mitglieder
--         aendern nur selbst angelegte Bankzeilen (Trigger); Import und eigenes
--         Umbenennen bleiben.
--
-- Fehlerbilder fuer die Clients: wie 20261106120000; neue Rollenabweisungen
-- als 'Keine Schreibberechtigung' (42501), invoice_cancelled und
-- invoice_document_identity als 22023 (endgueltig).
--
-- Bewusst NICHT geaendert (siehe Abschlussbericht): Speicherpfade bleiben
-- inhaltsadressiert ohne Inhaltspruefung beim Hochladen (wer zuerst hochlaedt,
-- belegt den Pfad; Clients und Versanddienst pruefen den Hash beim Lesen, eine
-- Faelschung wird nie ausgeliefert); Versand, Belegarchiv sowie Loeschen und
-- Wiederherstellen von Dokumenten pruefen weiterhin nur die Rolle, nicht die
-- Lizenz; Mitglieder bearbeiten Notizen, Aufgaben und Entwuerfe anderer
-- Mitglieder wie bisher (kein Eigentumsmodell).
--
-- Nur lokal vorbereitet. Die Anwendung auf die Cloud ist ein eigener,
-- ausdruecklich freizugebender Schritt.

/* ------------------------------------------------------------------------ */
/* E1 — Bindungswaechter mit genauer Abgrenzung                              */
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
  v_alt_rechnungsbeleg boolean := false;
  v_dokument public.workspace_documents%rowtype;
  v_rechnung public.workspace_invoices%rowtype;
  v_datei public.workspace_files%rowtype;
  v_dateityp text;
begin
  -- Wartung ohne angemeldeten Nutzer (Migrationen, service_role, Verwaltung).
  if auth.uid() is null then
    return new;
  end if;

  -- Die Vertrauensmarke setzt und loescht nur der Server: Neuanlage ohne
  -- Marke, Aenderung behaelt sie. Geloescht wird sie unten erst nach allen
  -- Pruefungen, und nur fuer eine neue Datei.
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

  -- Rechnungsbeleg: Beleg einer festgeschriebenen Rechnung, Korrekturbeleg
  -- oder jede Kennung unter corr- (dem Korrekturbeleg der Stornierung
  -- vorbehalten, auch solange es ihn noch nicht gibt).
  v_rechnungsbeleg := new.client_document_id like 'corr-%' or exists (
    select 1 from public.workspace_documents d
    where d.workspace_id = new.workspace_id
      and d.client_document_id = new.client_document_id
      and d.document_kind in ('generated_invoice', 'generated_invoice_correction')
  );
  if tg_op = 'UPDATE' then
    v_alt_rechnungsbeleg := old.client_document_id like 'corr-%' or exists (
      select 1 from public.workspace_documents d
      where d.workspace_id = old.workspace_id
        and d.client_document_id = old.client_document_id
        and d.document_kind in ('generated_invoice', 'generated_invoice_correction')
    );
  end if;

  -- ABSCHLUSS E — E-Rechnung: E-Rechnungs-Unterrolle; structured an einem
  -- Rechnungsbeleg; jede andere structured-Bindung ausser dem aus einem
  -- empfangenen Beleg extrahierten XML (structured/extracted).
  v_neu_erechnung := coalesce(lower(btrim(new.part)) in ('xrechnung-cii', 'zugferd-en16931'), false)
                  or (coalesce(lower(btrim(new.binding_kind)) = 'structured', false)
                      and (v_rechnungsbeleg or new.provenance is distinct from 'extracted'));
  if tg_op = 'UPDATE' then
    v_alt_erechnung := coalesce(lower(btrim(old.part)) in ('xrechnung-cii', 'zugferd-en16931'), false)
                    or (coalesce(lower(btrim(old.binding_kind)) = 'structured', false)
                        and (v_alt_rechnungsbeleg or old.provenance is distinct from 'extracted'));
  end if;
  v_rechnungsbeleg := v_rechnungsbeleg or v_alt_rechnungsbeleg;

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

  -- FOR SHARE: Beleg und Datei koennen sich bis zum Abschluss dieser
  -- Schreibung nicht mehr aendern; wer es versucht, wartet.
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

  -- Nur eine neue Datei, die alle Pruefungen bestanden hat, loescht die
  -- Marke. Wiederbeleben oder Herkunft aendern behalten sie: Sonst liesse sich
  -- eine fremde Altdatei durch Inhaber/Admin reinwaschen.
  if tg_op = 'INSERT' or new.client_file_ref_id is distinct from old.client_file_ref_id then
    new.einvoice_untrusted_at := null;
    new.einvoice_untrusted_reason := null;
  end if;

  return new;
end;
$$;

comment on function public.workspace_einvoice_binding_write_guard() is
  'GO-LIVE-SECURITY-01 (20261106120000, 20261107120000, 20261108120000): E-Rechnungsbindungen (E-Rechnungs-Unterrolle; structured an einem Rechnungsbeleg oder unter corr-; structured mit Herkunft ausser extracted) und jede Bindung an Rechnungs-/Korrekturbelegen nur Inhaber/Admin; Anlage nur am lebenden Beleg einer festgeschriebenen Rechnung mit bestaetigtem Leistungszeitraum und lebender Datei passenden Typs; Vertrauensmarke nur durch den Server. structured/extracted an gewoehnlichen Archivdokumenten ist Eingangsweg.';

revoke all on function public.workspace_einvoice_binding_write_guard() from public, anon, authenticated, service_role;

/* ------------------------------------------------------------------------ */
/* E2 — Einstufung mit derselben Abgrenzung                                  */
/* ------------------------------------------------------------------------ */
create or replace function public.workspace_einvoice_binding_trust_reason(b public.workspace_document_file_bindings)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when not (coalesce(lower(btrim(b.part)) in ('xrechnung-cii', 'zugferd-en16931'), false)
              or (coalesce(lower(btrim(b.binding_kind)) = 'structured', false)
                  and (b.client_document_id like 'corr-%'
                       or coalesce(d.document_kind in ('generated_invoice', 'generated_invoice_correction'), false)
                       or b.provenance is distinct from 'extracted'))) then null
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

comment on function public.workspace_einvoice_binding_trust_reason(public.workspace_document_file_bindings) is
  'GO-LIVE-SECURITY-01 (20261107120000, 20261108120000): Grund, aus dem eine E-Rechnungsbindung den heutigen Regeln nicht genuegt (null = genuegt oder keine E-Rechnung). Abgrenzung wie workspace_einvoice_binding_write_guard.';

revoke all on function public.workspace_einvoice_binding_trust_reason(public.workspace_document_file_bindings)
  from public, anon, authenticated, service_role;

/* ------------------------------------------------------------------------ */
/* E3 — Fehlmarke an Eingangsbindungen zuruecknehmen                         */
/* ------------------------------------------------------------------------ */
-- Nur Bindungen, die nach E1/E2 gar keine E-Rechnung sind: structured mit der
-- Herkunft extracted, ohne E-Rechnungs-Unterrolle, an einem gewoehnlichen
-- Archivdokument und nicht unter corr-. Andere Marken bleiben unveraendert.
update public.workspace_document_file_bindings b
set einvoice_untrusted_at = null,
    einvoice_untrusted_reason = null
where b.einvoice_untrusted_at is not null
  and b.einvoice_untrusted_reason = 'kein_rechnungsbeleg'
  and public.workspace_einvoice_binding_trust_reason(b) is null
  and lower(btrim(b.binding_kind)) = 'structured'
  and b.provenance = 'extracted'
  and not coalesce(lower(btrim(b.part)) in ('xrechnung-cii', 'zugferd-en16931'), false)
  and b.client_document_id not like 'corr-%'
  and not exists (
    select 1 from public.workspace_documents d
    where d.workspace_id = b.workspace_id
      and d.client_document_id = b.client_document_id
      and d.document_kind in ('generated_invoice', 'generated_invoice_correction')
  );

/* ------------------------------------------------------------------------ */
/* R1 — Wiederbeleben von Grabsteinen nur durch Inhaber/Admin               */
/* ------------------------------------------------------------------------ */
create or replace function public.workspace_member_revive_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Wartung ohne angemeldeten Nutzer (Migrationen, service_role, Verwaltung).
  if auth.uid() is null then
    return new;
  end if;

  -- Einen Grabstein setzen nur Inhaber und Admin (Eingangsweg); also hebt ihn
  -- auch nur Inhaber oder Admin wieder auf. Ein Mitglied, das eine geloeschte
  -- eigene Zeile wieder lebendig schreibt, setzt sich ueber deren Entscheidung
  -- hinweg — und eine Datei waere danach wieder aus dem Speicher lesbar.
  if old.deleted and not coalesce(new.deleted, false)
     and not public.can_write_workspace(new.workspace_id) then
    raise exception 'Keine Schreibberechtigung' using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.workspace_member_revive_guard() is
  'GO-LIVE-SECURITY-01 (20261108120000) R1: Grabsteine auf Dateien, Bindungen, Eingangseintraegen und Arbeitsergebnissen hebt nur Inhaber/Admin auf (42501).';

revoke all on function public.workspace_member_revive_guard() from public, anon, authenticated, service_role;

drop trigger if exists workspace_files_member_revive_guard on public.workspace_files;
create trigger workspace_files_member_revive_guard
before update on public.workspace_files
for each row execute function public.workspace_member_revive_guard();

drop trigger if exists workspace_document_file_bindings_member_revive_guard on public.workspace_document_file_bindings;
create trigger workspace_document_file_bindings_member_revive_guard
before update on public.workspace_document_file_bindings
for each row execute function public.workspace_member_revive_guard();

drop trigger if exists workspace_inbox_items_member_revive_guard on public.workspace_inbox_items;
create trigger workspace_inbox_items_member_revive_guard
before update on public.workspace_inbox_items
for each row execute function public.workspace_member_revive_guard();

drop trigger if exists workspace_document_work_results_member_revive_guard on public.workspace_document_work_results;
create trigger workspace_document_work_results_member_revive_guard
before update on public.workspace_document_work_results
for each row execute function public.workspace_member_revive_guard();

/* ------------------------------------------------------------------------ */
/* R2 — Mitglieder binden nur an eigene oder noch unbekannte Dokumente       */
/* ------------------------------------------------------------------------ */
create or replace function public.workspace_binding_document_owner_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or public.can_write_workspace(new.workspace_id) then
    return new;
  end if;

  -- Fremdschluesselpflege (ON DELETE SET NULL auf created_by/updated_by)
  -- aendert keinen Inhalt.
  if tg_op = 'UPDATE'
     and (to_jsonb(new) - 'created_by' - 'updated_by') = (to_jsonb(old) - 'created_by' - 'updated_by')
     and (new.created_by is null or new.created_by is not distinct from old.created_by)
     and (new.updated_by is null or new.updated_by is not distinct from old.updated_by) then
    return new;
  end if;

  -- Ein Mitglied bindet Dateien nur an Dokumente, die es selbst angelegt hat.
  -- Ein Dokument, das es (noch) nicht gibt, ist frei: Der Eingangsweg darf die
  -- Bindung vor dem eigenen Dokument senden, und fremde Kennungen sind zufaellig.
  if exists (
    select 1
    from public.workspace_documents d
    where d.workspace_id = new.workspace_id
      and d.client_document_id = new.client_document_id
      and d.created_by is distinct from auth.uid()
  ) then
    raise exception 'Keine Schreibberechtigung' using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.workspace_binding_document_owner_guard() is
  'GO-LIVE-SECURITY-01 (20261108120000) R2: Mitglieder binden Dateien nur an eigene oder noch nicht vorhandene Dokumente (42501); Inhaber/Admin und Wartung unveraendert.';

revoke all on function public.workspace_binding_document_owner_guard() from public, anon, authenticated, service_role;

drop trigger if exists workspace_document_file_bindings_document_owner_guard on public.workspace_document_file_bindings;
create trigger workspace_document_file_bindings_document_owner_guard
before insert or update on public.workspace_document_file_bindings
for each row execute function public.workspace_binding_document_owner_guard();

/* ------------------------------------------------------------------------ */
/* R3 — corr- ist fuer jeden angemeldeten Nutzer nur der Korrekturbeleg      */
/* ------------------------------------------------------------------------ */
create or replace function public.workspace_invoice_document_identity_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
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

  if public.can_write_workspace(new.workspace_id) then
    -- ABSCHLUSS R3 — corr-<Rechnung> ist dem Korrekturbeleg der Stornierung
    -- vorbehalten, auch fuer Inhaber und Admin. Ein neues oder umgewidmetes
    -- Dokument dort ist nur der Korrekturbeleg selbst (cancel_workspace_invoice).
    -- Ein bestehender Altplatzhalter bleibt bearbeitbar, etwa zum Aufraeumen;
    -- er wird nur nicht neu geschaffen. (Mitglieder: unten, 42501.)
    if new.client_document_id like 'corr-%'
       and new.document_kind is distinct from 'generated_invoice_correction'
       and (tg_op = 'INSERT'
            or old.client_document_id not like 'corr-%'
            or old.document_kind is not distinct from 'generated_invoice_correction') then
      raise exception 'invoice_document_identity: Kennungen unter corr- sind dem Korrekturbeleg der Stornierung vorbehalten'
        using errcode = '22023';
    end if;
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

comment on function public.workspace_invoice_document_identity_guard() is
  'GO-LIVE-SECURITY-01 (20261107120000, 20261108120000): corr- nur als Korrekturbeleg (Inhaber/Admin 22023); Mitglieder schreiben keine Rechnungs-/Korrekturbelege, nichts unter corr- und kein Archivdokument mit Rechnungsbezug (42501).';

revoke all on function public.workspace_invoice_document_identity_guard() from public, anon, authenticated, service_role;

/* ------------------------------------------------------------------------ */
/* R4 — Dateiwaechter: dieselbe Abgrenzung wie E1, dazu corr-                */
/* ------------------------------------------------------------------------ */
CREATE OR REPLACE FUNCTION public.workspace_einvoice_file_write_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      -- ABSCHLUSS E/R4: dieselbe Abgrenzung wie der Bindungswaechter (E1) --
      -- E-Rechnungs-Unterrolle, Rechnungs- oder Korrekturbeleg, jede Kennung
      -- unter corr- (auch solange es den Korrekturbeleg noch nicht gibt) und
      -- structured ausser dem aus einem empfangenen Beleg extrahierten XML.
      and (coalesce(lower(btrim(b.part)) in ('xrechnung-cii', 'zugferd-en16931'), false)
           or coalesce(d.document_kind in ('generated_invoice', 'generated_invoice_correction'), false)
           or b.client_document_id like 'corr-%'
           or (coalesce(lower(btrim(b.binding_kind)) = 'structured', false)
               and b.provenance is distinct from 'extracted'))
  ) then
    raise exception 'Keine Schreibberechtigung' using errcode = '42501';
  end if;

  return new;
end;
$function$;

revoke all on function public.workspace_einvoice_file_write_guard() from public, anon, authenticated, service_role;

/* ------------------------------------------------------------------------ */
/* R5/R6 — Versandvermerk und Leistungszeitraum                              */
/* ------------------------------------------------------------------------ */
CREATE OR REPLACE FUNCTION public.update_workspace_invoice_sent(p_workspace_id uuid, p_client_invoice_id text, p_sent_at text, p_sent_via text, p_sent_note text DEFAULT NULL::text)
 RETURNS SETOF workspace_invoices
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_existing public.workspace_invoices;
  v_sent_at text;
  v_sent_via text;
  v_sent_note text;
  v_sent_source text;
  v_updated public.workspace_invoices;
begin
  if v_user_id is null then
    raise exception 'Nicht angemeldet';
  end if;

  if p_workspace_id is null then
    raise exception 'workspace_id fehlt';
  end if;

  if not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  /*
   * GO-LIVE-SECURITY-01 — Der Versandvermerk setzt eine festgeschriebene
   * Rechnung auf "versendet" und bewegt damit Fristen und Archivschutz. Das ist
   * Verwaltung wie Finalisieren (R1-SEC-01) und der Versand selbst
   * (send-document): Inhaber oder Admin, nicht jedes Mitglied.
   */
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Keine Schreibberechtigung' using errcode = '42501';
  end if;

  /*
   * GO-LIVE-SECURITY-01 / ABSCHLUSS R6 — gueltige Berechtigung wie beim
   * Festschreiben: freigegebenes, nicht gesperrtes Konto mit aktiver Lizenz.
   * Nach der Rollenpruefung, damit ein Mitglied weiterhin 42501 erhaelt.
   */
  perform public.assert_financial_action_allowed(p_workspace_id);

  if nullif(trim(coalesce(p_client_invoice_id, '')), '') is null then
    raise exception 'client_invoice_id fehlt';
  end if;

  v_sent_at := nullif(trim(coalesce(p_sent_at, '')), '');
  if v_sent_at is null then
    raise exception 'sent_at fehlt';
  end if;
  if v_sent_at !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'sent_at ungueltig';
  end if;
  begin
    perform v_sent_at::date;
  exception
    when others then
      raise exception 'sent_at ungueltig';
  end;

  v_sent_via := nullif(trim(coalesce(p_sent_via, '')), '');
  if v_sent_via is null or v_sent_via not in ('email', 'post', 'persoenlich', 'portal', 'sonstige') then
    raise exception 'sent_via ungueltig';
  end if;

  v_sent_note := nullif(trim(coalesce(p_sent_note, '')), '');

  select * into v_existing
  from public.workspace_invoices
  where workspace_id = p_workspace_id
    and client_invoice_id = trim(p_client_invoice_id)
  for update;

  if v_existing.id is null then
    raise exception 'Rechnung nicht gefunden';
  end if;

  if v_existing.invoice_status = 'entwurf' then
    raise exception 'Rechnung nicht finalisiert';
  end if;

  /*
   * GO-LIVE-SECURITY-01 / ABSCHLUSS R5 — eine stornierte Rechnung, die nicht
   * versendet war (interne Stornierung ohne Korrekturbeleg), wird nicht
   * nachtraeglich versendet. Sonst entstuende "versendet und storniert" ohne
   * Korrekturbeleg. Versandangaben einer bereits versendeten Rechnung bleiben
   * korrigierbar.
   */
  if v_existing.cancelled_at is not null and v_existing.invoice_status is distinct from 'versendet' then
    raise exception 'invoice_cancelled: Eine stornierte Rechnung wird nicht mehr als versendet vermerkt'
      using errcode = '22023';
  end if;

  -- Herkunft: bleibt officepilot, wenn ein OfficePilot-Versand die Wahrheit gesetzt hat.
  v_sent_source := coalesce(v_existing.sent_source, 'manual');

  /*
   * Monotonie unveraendert (04B1-Hardening): 'versendet' ist ein Endzustand,
   * Versandangaben duerfen korrigiert werden; RETURNING + Nachbedingungen wie
   * bisher. Neu ist ausschliesslich die Herkunft (sent_source / sentSource).
   */
  update public.workspace_invoices
  set
    invoice_status = 'versendet',
    sent_source = v_sent_source,
    payload = case
      when v_sent_note is null then
        (payload - 'sentNote')
          || jsonb_build_object('status', 'versendet', 'sentAt', v_sent_at, 'sentVia', v_sent_via, 'sentSource', v_sent_source)
      else
        payload
          || jsonb_build_object(
            'status', 'versendet',
            'sentAt', v_sent_at,
            'sentVia', v_sent_via,
            'sentNote', v_sent_note,
            'sentSource', v_sent_source
          )
    end,
    row_version = row_version + 1,
    updated_at = now(),
    updated_by = v_user_id
  where id = v_existing.id
  returning * into v_updated;

  if v_updated.id is null then
    raise exception 'Sent-Update nicht angewendet';
  end if;

  if v_updated.invoice_status is distinct from 'versendet' then
    raise exception 'Sent-Update Nachbedingung verletzt: invoice_status';
  end if;
  if v_updated.payload->>'status' is distinct from 'versendet' then
    raise exception 'Sent-Update Nachbedingung verletzt: payload.status';
  end if;
  if v_updated.payload->>'sentAt' is distinct from v_sent_at then
    raise exception 'Sent-Update Nachbedingung verletzt: payload.sentAt';
  end if;
  if v_updated.payload->>'sentVia' is distinct from v_sent_via then
    raise exception 'Sent-Update Nachbedingung verletzt: payload.sentVia';
  end if;
  if v_sent_note is null then
    if v_updated.payload ? 'sentNote' then
      raise exception 'Sent-Update Nachbedingung verletzt: sentNote vorhanden';
    end if;
  else
    if v_updated.payload->>'sentNote' is distinct from v_sent_note then
      raise exception 'Sent-Update Nachbedingung verletzt: payload.sentNote';
    end if;
  end if;

  return next v_updated;
end;
$function$;

CREATE OR REPLACE FUNCTION public.confirm_workspace_invoice_service_period(p_workspace_id uuid, p_client_invoice_id text)
 RETURNS SETOF workspace_invoices
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_existing public.workspace_invoices;
begin
  if v_user_id is null then
    raise exception 'Nicht angemeldet';
  end if;

  if p_workspace_id is null then
    raise exception 'workspace_id fehlt';
  end if;

  if not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  /*
   * GO-LIVE-SECURITY-01 — Die Bestaetigung des Leistungszeitraums ist eine
   * dauerhafte Aussage ueber eine festgeschriebene Rechnung und gibt deren
   * PDF-Weg frei. Inhaber oder Admin, wie das Finalisieren (R1-SEC-01).
   */
  if not public.can_write_workspace(p_workspace_id) then
    raise exception 'Keine Schreibberechtigung' using errcode = '42501';
  end if;

  /*
   * GO-LIVE-SECURITY-01 / ABSCHLUSS R6 — gueltige Berechtigung wie beim
   * Festschreiben. Die Bestaetigung ist Voraussetzung jeder Ausgabe und jeder
   * E-Rechnungsbindung (20261106120000); ein gesperrtes Konto oder eine
   * abgelaufene Lizenz gibt sie nicht mehr frei. Nach der Rollenpruefung, damit
   * ein Mitglied weiterhin 42501 erhaelt.
   */
  perform public.assert_financial_action_allowed(p_workspace_id);

  if nullif(trim(coalesce(p_client_invoice_id, '')), '') is null then
    raise exception 'client_invoice_id fehlt';
  end if;

  -- Identitaet ausschliesslich ueber workspace_id + client_invoice_id.
  -- Die Rechnungsnummer ist eine Anzeigegroesse und nie ein technischer Schluessel.
  select * into v_existing
  from public.workspace_invoices
  where workspace_id = p_workspace_id
    and client_invoice_id = trim(p_client_invoice_id)
  for update;

  if v_existing.id is null then
    raise exception 'Rechnung nicht gefunden';
  end if;

  -- Ein Entwurf ist noch keine finalisierte Rechnung.
  if v_existing.invoice_status = 'entwurf' then
    raise exception 'Rechnung nicht finalisiert';
  end if;

  /*
   * Idempotenz: Steht die Bestaetigung bereits, wird nichts geschrieben.
   * Anders als beim Sent-Update, das Korrekturen der Versandangaben zulaesst,
   * gibt es hier nichts zu korrigieren — `true` ist ein Endzustand. Ein
   * wiederholter Aufruf soll deshalb weder `row_version` noch `updated_at`
   * bewegen: Ein zweiter Klick ist kein Ereignis.
   */
  if v_existing.payload->>'servicePeriodConfirmed' = 'true' then
    return query
    select * from public.workspace_invoices where id = v_existing.id;
    return;
  end if;

  /*
   * Gezieltes Merge: Genau ein Schluessel kommt hinzu. Der uebrige Payload —
   * Positionen, Betraege, Nummer, Typ, Datum, Snapshots, Versand, Storno —
   * wird nicht entgegengenommen und kann deshalb nicht ueberschrieben werden.
   */
  update public.workspace_invoices
  set
    payload = payload || jsonb_build_object('servicePeriodConfirmed', true),
    row_version = row_version + 1,
    updated_at = now(),
    updated_by = v_user_id
  where id = v_existing.id;

  return query
  select * from public.workspace_invoices where id = v_existing.id;
end;
$function$;

/* ------------------------------------------------------------------------ */
/* R7 — kein Lesen eingeschraenkter Speicherobjekte ueber den Hash          */
/* ------------------------------------------------------------------------ */
create or replace function public.workspace_file_object_can_read(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.workspace_files f
    where f.storage_path = p_name
      and f.deleted = false
      and (
        public.can_write_workspace(f.workspace_id)
        or (
          public.workspace_user_can_intake(f.workspace_id)
          and f.created_by = auth.uid()
          and not public.workspace_file_is_restricted(f.workspace_id, f.client_file_ref_id)
          -- ABSCHLUSS R7: Der Pfad ist der Hash des Inhalts. Gehoert zu diesem
          -- Pfad irgendeine eingeschraenkte Datei (auch eine geloeschte), liest
          -- ein Mitglied das Objekt nicht — eine eigene Zeile mit demselben Hash
          -- ist kein Schluessel zu fremden Mitarbeiterbelegen.
          and not exists (
            select 1
            from public.workspace_files g
            where g.workspace_id = f.workspace_id
              and g.storage_path = p_name
              and public.workspace_file_is_restricted(g.workspace_id, g.client_file_ref_id)
          )
        )
      )
  );
$$;

comment on function public.workspace_file_object_can_read(text) is
  'Speicher-Lesepolicy workspace-files: Inhaber/Admin; Mitglied nur eigene, nicht eingeschraenkte Datei und nur, wenn zum Pfad keine eingeschraenkte Datei gehoert (GO-LIVE-SECURITY-01 20261108120000 R7).';

/* ------------------------------------------------------------------------ */
/* R8 — Mitglieder aendern nur selbst angelegte Bankzeilen                   */
/* ------------------------------------------------------------------------ */
create or replace function public.workspace_bank_member_own_row_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or public.can_write_workspace(new.workspace_id) then
    return new;
  end if;

  -- Fremdschluesselpflege (ON DELETE SET NULL auf created_by/updated_by)
  -- aendert keinen Inhalt.
  if (to_jsonb(new) - 'created_by' - 'updated_by') = (to_jsonb(old) - 'created_by' - 'updated_by')
     and (new.created_by is null or new.created_by is not distinct from old.created_by)
     and (new.updated_by is null or new.updated_by is not distinct from old.updated_by) then
    return new;
  end if;

  -- Bankzeilen liest nur Inhaber/Admin. Ein Mitglied liest Auszuege ein und
  -- benennt eigene Konten um; fremde Konten und Umsaetze aendert es nicht.
  if old.created_by is distinct from auth.uid() then
    raise exception 'Keine Schreibberechtigung' using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.workspace_bank_member_own_row_guard() is
  'GO-LIVE-SECURITY-01 (20261108120000) R8: Mitglieder aendern nur selbst angelegte Bankkonten und Umsaetze (42501); Anlegen/Import unveraendert.';

revoke all on function public.workspace_bank_member_own_row_guard() from public, anon, authenticated, service_role;

drop trigger if exists workspace_bank_accounts_member_own_row_guard on public.workspace_bank_accounts;
create trigger workspace_bank_accounts_member_own_row_guard
before update on public.workspace_bank_accounts
for each row execute function public.workspace_bank_member_own_row_guard();

drop trigger if exists workspace_bank_transactions_member_own_row_guard on public.workspace_bank_transactions;
create trigger workspace_bank_transactions_member_own_row_guard
before update on public.workspace_bank_transactions
for each row execute function public.workspace_bank_member_own_row_guard();

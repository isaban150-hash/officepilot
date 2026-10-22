-- DOKUMENTE-01 / D-017 — gesetzliche Aufbewahrung und Löschschutz.
--
-- Bisher kannte der Server keine Aufbewahrungsfrist: Inhaber und Admin konnten
-- jede Rechnung und jeden Beleg beerdigen, über beide Löschwege
-- (`tombstone_workspace_document` und `upsert_workspace_intake_entity`,
-- Zweig `archived_document`). Ab hier gilt:
--
--   1  `workspace_retention_year`      — Jahr eines Datums oder Zeitstempels, Berliner Zeit.
--   2  `workspace_retention_rule`      — die reine Regel. Dieselben Testvektoren
--                                         wie im Client (`documentRetentionVectors.ts`).
--   3  `workspace_document_retention`  — die Fakten aus dem Serverstand, dann die Regel.
--   4  Archivdokumente                  — während der Frist kein Grabstein und keine
--                                         Abschwächung der Einstufung, auf keinem Weg.
--   5  Original                        — Original-Bindung und Datei eines geschützten
--                                         Dokuments werden nicht beerdigt und nicht
--                                         umgehängt: Datei, Dokument, Betrieb, Art und
--                                         Teil der Bindung bleiben, ebenso Inhalt und
--                                         Ablageort der Datei (DOK01-W1). Eine identische
--                                         Wiederholung und Vorschau, Archiv-PDF und
--                                         E-Rechnungs-XML bleiben frei. Die
--                                         E-Rechnungsbindung (structured) bleibt beim
--                                         Aufräumen ohne Bedingung (20261106): Ihr XML
--                                         entsteht byte-gleich aus der festgeschriebenen
--                                         Rechnung neu, und keine Datei verlässt den Speicher.
--
-- Die Regel: Buchungsbelege und Rechnungen 8 Jahre (§ 147 Abs. 1 Nr. 4, Abs. 3 AO;
-- § 257 Abs. 1 Nr. 4, Abs. 4 HGB; § 14b Abs. 1 UStG — Fassung des Vierten
-- Bürokratieentlastungsgesetzes), Handels- und Geschäftsbriefe 6 Jahre
-- (§ 147 Abs. 1 Nr. 2 und 3 AO; § 257 Abs. 1 Nr. 2 und 3 HGB). Fristbeginn mit
-- Schluss des Kalenderjahres (§ 147 Abs. 4 AO, § 257 Abs. 5 HGB); als Jahr gilt
-- das späteste aus Dokumentdatum, Erfassung und Serveranlage. Alles andere ist
-- „Aufbewahrung prüfen": keine Frist, kein Serverschutz, im Client Löschen nur
-- nach ausdrücklicher Bestätigung. Nach dem rechnerischen Ende entfällt nur die
-- Sperre; die Ablaufhemmung (§ 147 Abs. 3 AO) prüft der Betrieb.
--
-- Abweisungen tragen „Keine Schreibberechtigung" und 42501: Jeder Client stuft
-- sie als endgültig ein, und die Wiederherstellung abgewiesener Archivlöschungen
-- (`planRoleDeniedArchiveRestore`) holt ein lokal schon gelöschtes Dokument samt
-- Bindungen und Datei aus der Cloud zurück. Der Marker „Aufbewahrung" nennt den
-- Grund.
--
-- Additiv: keine bestehende Funktion wird geändert. Alle neuen Funktionen sind
-- intern (kein EXECUTE für public, anon, authenticated, service_role).
--
-- Nur lokal vorbereitet. Die Anwendung auf die Cloud ist ein eigener,
-- ausdrücklich freizugebender Schritt.

/* ------------------------------------------------------------------------ */
/* 1 — Jahr eines Datums oder Zeitstempels                                   */
/* ------------------------------------------------------------------------ */
create or replace function public.workspace_retention_year(p_value text)
returns integer
language plpgsql
stable
set search_path = public
as $$
declare
  v_text text := btrim(coalesce(p_value, ''));
  v_year integer;
begin
  if v_text ~ '^\d{4}-\d{2}-\d{2}$' then
    -- Nur ein echter Kalendertag: 2026-02-30 wirft und zählt nicht.
    v_year := extract(year from v_text::date)::integer;
  elsif v_text ~ '^\d{4}-\d{2}-\d{2}[T ]' then
    -- Ohne Zonenangabe gilt UTC, wie im Client — nie die Zeitzone der Sitzung.
    if v_text !~* '(z|[+-]\d{2}(:?\d{2})?)$' then
      v_text := v_text || 'Z';
    end if;
    v_year := extract(year from (v_text::timestamptz at time zone 'Europe/Berlin'))::integer;
  else
    return null;
  end if;
  if v_year < 1900 or v_year > 2200 then
    return null;
  end if;
  return v_year;
exception when others then
  return null;
end;
$$;

revoke all on function public.workspace_retention_year(text) from public, anon, authenticated, service_role;

/* ------------------------------------------------------------------------ */
/* 2 — die reine Regel                                                       */
/* ------------------------------------------------------------------------ */
create or replace function public.workspace_retention_rule(
  p_rechnungsbeleg text,
  p_classified_kind text,
  p_category text,
  p_ausgabenbeleg boolean,
  p_zahlungsnachweis boolean,
  p_dates text[],
  p_fallback_year integer,
  p_heute date
)
returns table (klasse text, grund text, jahre integer, bezugsjahr integer, frist_ende date, frist_status text)
language plpgsql
stable
set search_path = public
as $$
declare
  v_rechnungsbeleg text := nullif(btrim(coalesce(p_rechnungsbeleg, '')), '');
  -- Gross-/Kleinschreibung und Leerzeichen ändern die Art nicht — im Zweifel greift die Frist.
  v_kind text := lower(btrim(coalesce(p_classified_kind, '')));
  v_category text := lower(btrim(coalesce(p_category, '')));
begin
  if coalesce(p_zahlungsnachweis, false) then
    klasse := 'buchungsbeleg'; grund := 'zahlungsnachweis';
  elsif coalesce(p_ausgabenbeleg, false) then
    klasse := 'buchungsbeleg'; grund := 'ausgabenbeleg';
  elsif v_rechnungsbeleg is not null then
    -- Erst die festgeschriebene Rechnung ist ausgestellt; ein Entwurf ist kein Beleg.
    if v_rechnungsbeleg = 'offen' then
      klasse := 'pruefen'; grund := 'rechnung_nicht_festgeschrieben';
    else
      klasse := 'buchungsbeleg'; grund := 'rechnungsbeleg';
    end if;
  elsif v_kind = any (array[
      'eingangsrechnung', 'rechnung', 'rechnungskorrektur', 'ausgangsrechnung', 'gutschrift',
      'quittung', 'kassenbeleg', 'ec_beleg', 'kreditkartenbeleg', 'kontoauszug',
      'reparaturrechnung', 'tankbeleg'])
    or v_category = 'ausgangsrechnung' then
    klasse := 'buchungsbeleg'; grund := 'belegart';
  elsif v_kind = any (array[
      'auftrag', 'auftragsbestaetigung', 'werkvertrag', 'subunternehmervertrag',
      'nachunternehmervertrag', 'nachtrag', 'mahnung', 'zahlungserinnerung']) then
    klasse := 'geschaeftsbrief'; grund := 'geschaeftsbrief';
  else
    klasse := 'pruefen'; grund := 'keine_feste_regel';
  end if;

  if klasse = 'pruefen' then
    jahre := null; bezugsjahr := null; frist_ende := null; frist_status := 'pruefen';
    return next;
    return;
  end if;

  jahre := case klasse when 'buchungsbeleg' then 8 else 6 end;
  select max(public.workspace_retention_year(d.wert)) into bezugsjahr
  from unnest(coalesce(p_dates, '{}'::text[])) as d(wert);
  -- Ohne lesbares Datum beginnt die Frist frühestens im angegebenen Jahr: lieber zu lang als zu kurz.
  bezugsjahr := coalesce(bezugsjahr, p_fallback_year, extract(year from p_heute)::integer);
  frist_ende := make_date(bezugsjahr + jahre, 12, 31);
  frist_status := case when p_heute <= frist_ende then 'laeuft' else 'abgelaufen' end;
  return next;
end;
$$;

revoke all on function public.workspace_retention_rule(text, text, text, boolean, boolean, text[], integer, date)
  from public, anon, authenticated, service_role;

/* ------------------------------------------------------------------------ */
/* 3 — Fakten aus dem Serverstand                                            */
/* ------------------------------------------------------------------------ */
create or replace function public.workspace_document_retention(p_document public.workspace_documents)
returns table (klasse text, grund text, jahre integer, bezugsjahr integer, frist_ende date, frist_status text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_ws uuid := p_document.workspace_id;
  v_id text := p_document.client_document_id;
  v_origin text := nullif(btrim(coalesce(p_document.payload->>'sourceInboxItemId', '')), '');
  v_heute date := (now() at time zone 'Europe/Berlin')::date;
  v_rechnungsbeleg text;
  v_ausgabenbeleg boolean;
  v_zahlungsnachweis boolean;
begin
  -- Nachweis einer Zahlung, auch storniert, und Quittung einer Mitarbeiterzahlung.
  v_zahlungsnachweis := exists (
      select 1 from public.workspace_expense_payments p
      where p.workspace_id = v_ws and p.proof_document_id = v_id
    ) or exists (
      select 1 from public.workspace_invoice_payments p
      where p.workspace_id = v_ws and p.proof_document_id = v_id
    ) or exists (
      select 1 from public.workspace_employee_payments p
      where p.workspace_id = v_ws and (p.proof_document_id = v_id or p.receipt_document_id = v_id)
    );

  -- Beleg einer Ausgabe: über die eigene Verknüpfung oder den gemeinsamen Eingang (wie `isExpenseReceipt`).
  v_ausgabenbeleg := exists (
    select 1 from public.workspace_expenses e
    where e.workspace_id = v_ws
      and not e.deleted
      and (e.archive_document_id = v_id or (v_origin is not null and e.linked_inbox_id = v_origin))
  );

  if p_document.document_kind = 'generated_invoice_correction' then
    v_rechnungsbeleg := 'korrektur';
  elsif p_document.document_kind = 'generated_invoice' then
    v_rechnungsbeleg := case when exists (
        select 1 from public.workspace_invoices wi
        where wi.workspace_id = v_ws
          and wi.client_invoice_id = p_document.linked_invoice_id
          and wi.invoice_status in ('vorbereitet', 'versendet')
      ) then 'festgeschrieben' else 'offen' end;
  end if;

  return query
  select r.klasse, r.grund, r.jahre, r.bezugsjahr, r.frist_ende, r.frist_status
  from public.workspace_retention_rule(
    v_rechnungsbeleg,
    p_document.payload->>'classifiedKind',
    p_document.payload->>'category',
    v_ausgabenbeleg,
    v_zahlungsnachweis,
    array[
      p_document.payload->>'documentDate',
      p_document.payload->>'issueDate',
      p_document.payload->>'uploadedAt',
      p_document.payload->>'createdAt',
      -- Die Serveranlage zählt mit: Eine veränderte Nutzlast verkürzt die Frist nicht.
      to_char(p_document.created_at at time zone 'Europe/Berlin', 'YYYY-MM-DD')
    ],
    extract(year from v_heute)::integer,
    v_heute
  ) as r;
end;
$$;

revoke all on function public.workspace_document_retention(public.workspace_documents)
  from public, anon, authenticated, service_role;

/* ------------------------------------------------------------------------ */
/* 4 — Archivdokumente: kein Grabstein, keine Abschwächung                   */
/* ------------------------------------------------------------------------ */
create or replace function public.workspace_documents_retention_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_alt record;
  v_neu record;
begin
  -- Ein schon gelöschtes Dokument hat nichts zu schützen; die Wiederherstellung bleibt frei.
  if coalesce(old.deleted, false) or old.deleted_at is not null then
    return new;
  end if;

  select * into v_alt from public.workspace_document_retention(old);
  if v_alt.frist_status is distinct from 'laeuft' then
    return new;
  end if;

  if coalesce(new.deleted, false) or new.deleted_at is not null then
    raise exception 'Keine Schreibberechtigung: Aufbewahrungsfrist laeuft bis % (%, % Jahre)',
      to_char(v_alt.frist_ende, 'DD.MM.YYYY'), v_alt.klasse, v_alt.jahre
      using errcode = '42501';
  end if;

  -- Während der Frist macht keine Änderung aus einem Beleg ein „prüfen" (FINANZ-CORE-01A STO-03).
  select * into v_neu from public.workspace_document_retention(new);
  if (case v_neu.klasse when 'buchungsbeleg' then 2 when 'geschaeftsbrief' then 1 else 0 end)
     < (case v_alt.klasse when 'buchungsbeleg' then 2 when 'geschaeftsbrief' then 1 else 0 end) then
    raise exception 'Keine Schreibberechtigung: Aufbewahrungspflichtige Einstufung (%, Frist bis %) kann nicht abgeschwaecht werden',
      v_alt.klasse, to_char(v_alt.frist_ende, 'DD.MM.YYYY')
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function public.workspace_documents_retention_guard() from public, anon, authenticated, service_role;

drop trigger if exists workspace_documents_retention_guard on public.workspace_documents;
create trigger workspace_documents_retention_guard
  before update on public.workspace_documents
  for each row execute function public.workspace_documents_retention_guard();

/* ------------------------------------------------------------------------ */
/* 5 — das Original eines geschützten Dokuments                              */
/* ------------------------------------------------------------------------ */
create or replace function public.workspace_document_file_bindings_retention_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_document public.workspace_documents;
  v_aufbewahrung record;
begin
  -- Nur das empfangene Original ist das Dokument selbst; Vorschau, Archiv-PDF und
  -- E-Rechnungs-XML entstehen daraus bzw. aus der festgeschriebenen Rechnung neu.
  -- Eine schon beerdigte Bindung hat nichts mehr zu schützen.
  if old.binding_kind <> 'original' or coalesce(old.deleted, false) then
    return new;
  end if;

  /*
   * DOK01-W1 — geschützt ist die Zuordnung, nicht nur das Löschflag. Sonst hängt
   * ein Schreiber das Original erst auf eine andere Datei um und beerdigt danach
   * die bisherige, die dann an keinem Original mehr hängt. Frei bleibt die
   * identische Wiederholung: dieselbe Datei an demselben Dokument im selben
   * Betrieb, gleiche Art, gleicher Teil, nicht beerdigt. Herkunft, Version und
   * Bearbeiter ändern die Zuordnung nicht.
   */
  if new.workspace_id = old.workspace_id
     and new.client_document_id = old.client_document_id
     and new.client_file_ref_id is not distinct from old.client_file_ref_id
     and new.binding_kind = old.binding_kind
     and coalesce(new.part, '') = coalesce(old.part, '')
     and not coalesce(new.deleted, false) then
    return new;
  end if;

  select * into v_document
  from public.workspace_documents d
  where d.workspace_id = old.workspace_id and d.client_document_id = old.client_document_id;
  if v_document.id is null or coalesce(v_document.deleted, false) or v_document.deleted_at is not null then
    return new;
  end if;

  select * into v_aufbewahrung from public.workspace_document_retention(v_document);
  if v_aufbewahrung.frist_status = 'laeuft' then
    raise exception 'Keine Schreibberechtigung: Original eines Dokuments mit Aufbewahrungsfrist bis %',
      to_char(v_aufbewahrung.frist_ende, 'DD.MM.YYYY')
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.workspace_document_file_bindings_retention_guard()
  from public, anon, authenticated, service_role;

drop trigger if exists workspace_document_file_bindings_retention_guard on public.workspace_document_file_bindings;
create trigger workspace_document_file_bindings_retention_guard
  before update on public.workspace_document_file_bindings
  for each row
  execute function public.workspace_document_file_bindings_retention_guard();

create or replace function public.workspace_files_retention_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_document public.workspace_documents;
  v_aufbewahrung record;
begin
  -- Eine schon beerdigte Datei hat nichts mehr zu schützen.
  if coalesce(old.deleted, false) then
    return new;
  end if;
  -- DOK01-W1 — frei sind Metadaten (Name, Typ, Herkunft); Grabstein, Inhalt und Ablageort nicht.
  if not coalesce(new.deleted, false)
     and new.workspace_id = old.workspace_id
     and new.client_file_ref_id = old.client_file_ref_id
     and new.content_sha256 is not distinct from old.content_sha256
     and new.storage_path is not distinct from old.storage_path then
    return new;
  end if;

  for v_document in
    select d.*
    from public.workspace_document_file_bindings b
    join public.workspace_documents d
      on d.workspace_id = b.workspace_id and d.client_document_id = b.client_document_id
    where b.workspace_id = old.workspace_id
      and b.client_file_ref_id = old.client_file_ref_id
      and b.binding_kind = 'original'
      and not b.deleted
      and not coalesce(d.deleted, false)
      and d.deleted_at is null
  loop
    select * into v_aufbewahrung from public.workspace_document_retention(v_document);
    if v_aufbewahrung.frist_status = 'laeuft' then
      raise exception 'Keine Schreibberechtigung: Datei eines Dokuments mit Aufbewahrungsfrist bis %',
        to_char(v_aufbewahrung.frist_ende, 'DD.MM.YYYY')
        using errcode = '42501';
    end if;
  end loop;
  return new;
end;
$$;

revoke all on function public.workspace_files_retention_guard() from public, anon, authenticated, service_role;

drop trigger if exists workspace_files_retention_guard on public.workspace_files;
create trigger workspace_files_retention_guard
  before update on public.workspace_files
  for each row
  execute function public.workspace_files_retention_guard();

-- OFFICEPILOT-GENERATED-INVOICE-DOCUMENT-CLOUD-05C1
--
-- Erzeugte Ausgangsrechnungs-Dokumente waren bisher rein lokal. Auf einer
-- frischen Origin kamen Rechnung, Versandstatus und Zahlungen zurueck — das
-- zugehoerige Archivdokument nicht. Die Suche fand nur das Rechnungsobjekt.
--
-- Bewusste Entwurfsentscheidungen dieser Migration:
--
--   * Eigene Tabelle statt Dokumente im Vorgang-Payload. Der Vorgang reist als
--     ein LWW-Gesamtobjekt; zwei Geraete, die verschiedene Dokumente anlegen,
--     wuerden sich gegenseitig ueberschreiben.
--
--   * Die Beziehung wird nur in EINE Richtung gefuehrt: ueber
--     `linked_invoice_id`. `archiveDocumentId` bleibt ein lokaler, abgeleiteter
--     Komfort-Verweis und wird ausdruecklich NICHT zur zweiten Cloud-Wahrheit.
--     Die bestehenden Payload-Ausschluesse in `workspace_invoices` bleiben
--     unveraendert.
--
--   * Nur Metadaten. Fuer ein selbst erzeugtes Dokument ist das ausreichend,
--     weil die Datei reproduzierbar aus der bereits cloud-durablen Rechnung
--     entsteht. Kein Blob, kein Storage, kein `file_ref_id`.
--
--   * Grabstein statt physischer Loeschung — nur so erfaehrt ein Geraet mit
--     alter Kopie ueberhaupt von der Loeschung.
--
--   * `workspace_invoices`, `workspace_invoice_payments` und alle bestehenden
--     RPCs bleiben unangetastet.

create table if not exists public.workspace_documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  client_document_id text not null,
  document_kind text not null,
  linked_invoice_id text null,
  linked_vorgang_id text null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  created_by uuid null references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid null references auth.users (id) on delete set null,
  row_version bigint not null default 1,
  deleted_at timestamptz null,
  deleted_by uuid null references auth.users (id) on delete set null,
  /*
   * 05C1 laesst produktiv nur `generated_invoice` zu. Die Spalte ist trotzdem
   * frei gehalten, damit spaetere Dokumentarten keine Tabellenmigration
   * brauchen — der Check wird dann erweitert, nicht ersetzt.
   */
  constraint workspace_documents_kind_check check (document_kind in ('generated_invoice')),
  /*
   * Ein erzeugtes Rechnungsdokument ohne Rechnung ergibt keinen Sinn. Die
   * Bedingung steht in der Datenbank, nicht nur im Client.
   */
  constraint workspace_documents_generated_invoice_link_check check (
    document_kind <> 'generated_invoice' or linked_invoice_id is not null
  ),
  constraint workspace_documents_client_id_unique unique (workspace_id, client_document_id)
);

/*
 * Die fachliche Eindeutigkeit — der eigentliche Kern dieser Migration.
 *
 * Zwei Geraete, die dieselbe Rechnung archivieren, erzeugen lokal zwei
 * verschiedene `doc-<uuid>`. Der technische Schluessel oben wuerde das nicht
 * bemerken; es entstuenden zwei Karten fuer dieselbe Ausgangsrechnung. Dieser
 * partielle Index laesst genau eine kanonische Zeile je Rechnung zu.
 *
 * 05C1C — Grabsteine sind ausdruecklich **nicht** ausgenommen.
 *
 * Zuerst stand hier `and deleted_at is null`. Das klang grosszuegig, war aber
 * ein Loch im Vertrag: Ein Grabstein haette den Schluessel freigegeben, und
 * der naechste Archivierungslauf haette mit einer neuen Kennung ein zweites,
 * aktives Dokument fuer dieselbe Rechnung angelegt. Genau das ist die
 * Wiederbelebung, die 05C1 ausschliesst — nur ueber Umwege.
 *
 * Ein Grabstein bleibt deshalb Besitzer seines Business Key. Ein echtes
 * Wiederherstellen waere ein eigener, ausdruecklicher Vertrag und gehoert
 * nicht hierher.
 */
create unique index if not exists workspace_documents_generated_invoice_unique
  on public.workspace_documents (workspace_id, linked_invoice_id)
  where document_kind = 'generated_invoice'
    and linked_invoice_id is not null;

create index if not exists workspace_documents_workspace_kind_idx
  on public.workspace_documents (workspace_id, document_kind);

create index if not exists workspace_documents_updated_idx
  on public.workspace_documents (workspace_id, updated_at desc);

drop trigger if exists workspace_documents_set_updated_at on public.workspace_documents;
create trigger workspace_documents_set_updated_at
before update on public.workspace_documents
for each row
execute function public.set_workspace_updated_at();

-- RLS: select fuer Mitglieder; Schreiben ausschliesslich ueber die RPCs unten.
alter table public.workspace_documents enable row level security;

drop policy if exists workspace_documents_select_member on public.workspace_documents;
create policy workspace_documents_select_member
on public.workspace_documents for select to authenticated
using (public.is_active_workspace_member(workspace_id));

/*
 * 05C1C — die Rechte werden ausdruecklich gesetzt, nicht von Supabase-
 * Standardwerten geerbt. `authenticated` bekommt erst alles entzogen und dann
 * genau ein Recht zurueck: lesen. Geschrieben wird ausschliesslich ueber die
 * `security definer`-RPCs weiter unten.
 */
revoke all on public.workspace_documents from public, anon;
revoke all on public.workspace_documents from authenticated;
grant select on public.workspace_documents to authenticated;

/* -------------------------------------------------------------------------- */
/* Upsert                                                                     */
/* -------------------------------------------------------------------------- */

create or replace function public.upsert_workspace_generated_invoice_document(
  p_workspace_id uuid,
  p_client_document_id text,
  p_linked_invoice_id text,
  p_linked_vorgang_id text,
  p_payload jsonb
)
returns setof public.workspace_documents
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_invoice public.workspace_invoices;
  v_existing public.workspace_documents;
  v_inserted public.workspace_documents;
  v_document_id text;
  v_invoice_id text;
  v_vorgang_id text;
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

  v_document_id := nullif(trim(coalesce(p_client_document_id, '')), '');
  if v_document_id is null then
    raise exception 'client_document_id fehlt';
  end if;

  v_invoice_id := nullif(trim(coalesce(p_linked_invoice_id, '')), '');
  if v_invoice_id is null then
    raise exception 'linked_invoice_id fehlt';
  end if;

  /*
   * 05C1C — der Vorgang ist fuer ein erzeugtes Rechnungsdokument zwingend.
   * Er still auf null laufen zu lassen, waere ein Dokument ohne Zuordnung.
   */
  v_vorgang_id := nullif(trim(coalesce(p_linked_vorgang_id, '')), '');
  if v_vorgang_id is null then
    raise exception 'linked_vorgang_id fehlt';
  end if;

  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'payload ungueltig';
  end if;

  /*
   * Der Serialisierungspunkt.
   *
   * Ein `select … for update` auf die Dokumentzeile koennte nichts sperren,
   * solange es sie nicht gibt — genau der Fehler, den 04B2B3 fuer Zahlungen
   * korrigiert hat. Hier existiert aber bereits eine stabile Zeile fuer
   * dieselbe fachliche Einheit: die Rechnung. Zwei Geraete, die dieselbe
   * Rechnung archivieren, laufen zwangslaeufig durch dieselbe Zeile und werden
   * dort hintereinander gereiht. Der zweite sieht dann garantiert das Dokument
   * des ersten.
   */
  select * into v_invoice
  from public.workspace_invoices
  where workspace_id = p_workspace_id
    and client_invoice_id = v_invoice_id
  for update;

  if v_invoice.id is null then
    raise exception 'Rechnung nicht gefunden';
  end if;
  if v_invoice.invoice_status = 'entwurf' then
    raise exception 'Rechnung nicht finalisiert';
  end if;

  /*
   * 05C1C — der Vorgang kommt aus der Rechnung, nicht vom Client.
   *
   * `workspace_invoices.vorgang_id` ist `not null` und traegt die Zuordnung
   * bereits. Ohne diese Pruefung koennte ein Client fuer eine Rechnung einen
   * beliebigen fremden Vorgang behaupten. Abgeglichen wird die Spalte, nicht
   * ein Titel oder ein anderes Merkmal.
   */
  if v_vorgang_id is distinct from v_invoice.vorgang_id then
    raise exception 'Dokumentkonflikt: Vorgang passt nicht zur Rechnung';
  end if;

  /*
   * 05C1C — Payload und Spalten duerfen nicht zwei verschiedene Identitaeten
   * behaupten. Das ist bewusst keine vollstaendige Fachlogik in SQL: Die
   * semantische Vergleichsprojektion bleibt im Client (05C1B). Hier geht es
   * nur um die innere Widerspruchsfreiheit **einer** Zeile.
   */
  if p_payload->>'linkedInvoiceId' is distinct from v_invoice_id
    or p_payload->'linkedVorgang'->>'vorgangId' is distinct from v_vorgang_id
  then
    raise exception 'Dokumentkonflikt: Payload widerspricht der Rechnungsidentitaet';
  end if;

  if p_payload->>'category' is distinct from 'ausgangsrechnung'
    or p_payload->>'classifiedKind' is distinct from 'ausgangsrechnung'
    or p_payload->>'archived' is distinct from 'true'
  then
    raise exception 'Dokumentkonflikt: Payload ist kein archiviertes Ausgangsrechnungs-Dokument';
  end if;

  /*
   * Fachliche Identitaet zuerst: Gibt es fuer diese Rechnung bereits ein
   * Dokument, ist das die kanonische Zeile — unabhaengig davon, welche lokale
   * Kennung das anfragende Geraet mitbringt.
   *
   * 05C1C — bewusst **ohne** `deleted_at is null`. Wuerde hier nur nach
   * aktiven Zeilen gesucht, saehe der RPC den Grabstein nicht und liefe in
   * einen Insert, den der Business-Key-Index hart abweist — mit einer
   * technischen Fehlermeldung statt einer verstaendlichen Aussage.
   */
  select * into v_existing
  from public.workspace_documents
  where workspace_id = p_workspace_id
    and document_kind = 'generated_invoice'
    and linked_invoice_id = v_invoice_id;

  if v_existing.id is not null then
    /*
     * Grabsteinvorrang — vor allem anderen. Ein geloeschtes Dokument wird
     * weder wiederbelebt noch als Erfolg zurueckgegeben, und der Business Key
     * bleibt bei ihm. Ein echtes Wiederherstellen waere ein eigener Vertrag.
     */
    if v_existing.deleted_at is not null then
      raise exception 'Dokumentkonflikt: dieses Dokument wurde geloescht';
    end if;

    /*
     * Kein zweites Dokument, aber auch keine stille Uebernahme. Verglichen wird
     * die fachliche Substanz, nicht die lokale Kennung: Zwei Geraete duerfen
     * verschiedene `doc-`IDs haben, aber nicht verschiedene Inhalte behaupten.
     */
    if v_existing.linked_vorgang_id is distinct from v_vorgang_id then
      raise exception 'Dokumentkonflikt: abweichender Vorgang fuer dieselbe Rechnung';
    end if;

    return next v_existing;
    return;
  end if;

  /*
   * 05C1C — die Kennungspruefung gilt **nur** hier, beim Anlegen der neuen
   * kanonischen Zeile.
   *
   * Beim Replay eines zweiten Geraets traegt die kanonische Zeile die Kennung
   * des ersten; dort waere dieselbe Pruefung schlicht falsch und wuerde den
   * zulaessigen Zwei-Geraete-Fall unmoeglich machen. Deshalb steht sie hinter
   * der Rueckgabe der bestehenden Zeile.
   */
  if p_payload ? 'id' and p_payload->>'id' is distinct from v_document_id then
    raise exception 'Dokumentkonflikt: Payload-ID passt nicht zur Dokumentkennung';
  end if;

  insert into public.workspace_documents (
    workspace_id, client_document_id, document_kind,
    linked_invoice_id, linked_vorgang_id, payload, created_by, updated_by
  )
  values (
    p_workspace_id, v_document_id, 'generated_invoice',
    v_invoice_id, v_vorgang_id, p_payload, v_user_id, v_user_id
  )
  on conflict (workspace_id, client_document_id) do nothing
  returning * into v_inserted;

  if v_inserted.id is null then
    /*
     * Dieselbe lokale Kennung existiert bereits — und zwar fuer eine **andere**
     * Rechnung, denn jede Zeile zu dieser Rechnung haette die fachliche Suche
     * oben gefunden, Grabsteine eingeschlossen. Eine Kennung darf nicht zwei
     * Rechnungen bezeichnen.
     */
    raise exception 'Dokumentkonflikt: diese Kennung gehoert zu einer anderen Rechnung';
  end if;

  -- Nachbedingung: Die zurueckgegebene Zeile bildet den Request vollstaendig ab.
  if v_inserted.workspace_id is distinct from p_workspace_id
    or v_inserted.client_document_id is distinct from v_document_id
    or v_inserted.document_kind is distinct from 'generated_invoice'
    or v_inserted.linked_invoice_id is distinct from v_invoice_id
    or v_inserted.linked_vorgang_id is distinct from v_vorgang_id
    or v_inserted.payload is distinct from p_payload
    or v_inserted.deleted_at is not null
  then
    raise exception 'Dokument Nachbedingung verletzt';
  end if;

  return next v_inserted;
end;
$$;

/* -------------------------------------------------------------------------- */
/* Tombstone                                                                  */
/* -------------------------------------------------------------------------- */

create or replace function public.tombstone_workspace_document(
  p_workspace_id uuid,
  p_client_document_id text
)
returns setof public.workspace_documents
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_existing public.workspace_documents;
  v_updated public.workspace_documents;
  v_document_id text;
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

  v_document_id := nullif(trim(coalesce(p_client_document_id, '')), '');
  if v_document_id is null then
    raise exception 'client_document_id fehlt';
  end if;

  select * into v_existing
  from public.workspace_documents
  where workspace_id = p_workspace_id
    and client_document_id = v_document_id
  for update;

  if v_existing.id is null then
    raise exception 'Dokument nicht gefunden';
  end if;

  -- Idempotent: ein bereits geloeschtes Dokument bleibt, wie es ist.
  if v_existing.deleted_at is not null then
    return next v_existing;
    return;
  end if;

  update public.workspace_documents
  set deleted_at = now(),
      deleted_by = v_user_id,
      row_version = row_version + 1,
      updated_at = now(),
      updated_by = v_user_id
  where id = v_existing.id
  returning * into v_updated;

  if v_updated.id is null or v_updated.deleted_at is null then
    raise exception 'Loeschung nicht angewendet';
  end if;

  return next v_updated;
end;
$$;

/* -------------------------------------------------------------------------- */
/* Pull                                                                       */
/* -------------------------------------------------------------------------- */

create or replace function public.pull_workspace_documents(
  p_workspace_id uuid,
  p_since timestamptz default null
)
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
  if not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  /*
   * Grabsteine werden ausdruecklich mitgeliefert. Wuerde der Pull sie
   * verschweigen, behielte ein Geraet mit alter lokaler Kopie das Dokument fuer
   * gueltig und wuerde es beim Zusammenfuehren wiederbeleben.
   */
  return coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', d.id,
          'workspace_id', d.workspace_id,
          'client_document_id', d.client_document_id,
          'document_kind', d.document_kind,
          'linked_invoice_id', d.linked_invoice_id,
          'linked_vorgang_id', d.linked_vorgang_id,
          'payload', d.payload,
          'created_at', d.created_at,
          'updated_at', d.updated_at,
          'row_version', d.row_version,
          'deleted_at', d.deleted_at
        )
        order by d.created_at asc
      )
      from public.workspace_documents d
      where d.workspace_id = p_workspace_id
        and d.document_kind = 'generated_invoice'
        and (p_since is null or d.updated_at > p_since)
    ),
    '[]'::jsonb
  );
end;
$$;

-- 05C1C: `public` schliesst `anon` nicht zwingend ein — beide ausdruecklich nennen.
revoke all on function public.upsert_workspace_generated_invoice_document(uuid, text, text, text, jsonb) from public, anon;
revoke all on function public.tombstone_workspace_document(uuid, text) from public, anon;
revoke all on function public.pull_workspace_documents(uuid, timestamptz) from public, anon;

grant execute on function public.upsert_workspace_generated_invoice_document(uuid, text, text, text, jsonb) to authenticated;
grant execute on function public.tombstone_workspace_document(uuid, text) to authenticated;
grant execute on function public.pull_workspace_documents(uuid, timestamptz) to authenticated;

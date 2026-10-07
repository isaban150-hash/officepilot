/*
 * CLOUD-SYNC S3 -- bestaetigtes Wissen wird Workspace-Wahrheit.
 *
 * WAS EIN WISSENSEINTRAG IST
 *
 * Ein vom Nutzer auf der Wissen-Seite festgehaltener und damit bestaetigter
 * Satz zum Betrieb, zu einem Kunden, Auftrag oder Ansprechpartner -- etwa eine
 * Kommunikationsvorliebe oder eine Materialpraeferenz. Er wird angelegt,
 * geaendert, aktiviert/deaktiviert und geloescht. Gelesen wird er vom
 * Kommunikationskontext (KI-Entwuerfe) und vom Brain-Snapshot.
 *
 * Bisher lag er ausschliesslich im lokalen Zustand des Geraets
 * (`knowledgeFacts`): Ein zweites Geraet kannte das Wissen nicht, und die
 * KI-Kontexte dort liefen ohne es.
 *
 * ZEILENFORM UND VERSIONSVERTRAG
 *
 * Wie bei Vorgangsnotizen und Papierablage: `client_fact_id`, `payload` mit
 * dem fachlichen Eintrag, `row_version`, `deleted`, `deleted_at`,
 * `created_by`, `updated_by`. Scope, Kategorie und Aktiv-Kennzeichen stehen
 * zusaetzlich als lesbare Spalten; die Wahrheit ist der Payload.
 * Versionsvertrag wortgleich zu den Notizen (01G, 01G2,
 * CREATE-RETRY-CONFLICT-02). Ein geloeschter Eintrag wird nicht wiederbelebt.
 *
 * SICHTBARKEIT UND RECHTE
 *
 * Wissen ist frei eingegebenes Betriebswissen zu Objekten, die jedes aktive
 * Mitglied sieht (Firma, Kunden, Auftraege), und speist denselben
 * Kommunikationskontext wie die Vorgangsnotizen. Fuer Notizen gilt seit
 * 20260923120000: Lesen und Schreiben jedes aktive Mitglied. Dieselbe Regel
 * gilt hier -- die Cloud bildet ab, was lokal fuer jeden Nutzer galt, und
 * oeffnet keine Datenart, die bisher enger war.
 *
 * Die beiden Funktionen werden aus ihrer geltenden Fassung (20261031120000)
 * uebernommen und ausschliesslich um den neuen Zweig bzw. Schluessel
 * ergaenzt.
 */

/* -------------------------------------------------------------------------- */
/* 1. Tabelle                                                                  */
/* -------------------------------------------------------------------------- */

create table if not exists public.workspace_knowledge_facts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  client_fact_id text not null,
  /* Lesbare Ordnung; die Wahrheit steht im Payload. */
  scope text null,
  scope_id text null,
  category text null,
  active boolean not null default true,
  payload jsonb not null default '{}'::jsonb,
  row_version bigint not null default 1,
  deleted boolean not null default false,
  deleted_at timestamptz null,
  created_by uuid null references auth.users (id) on delete set null,
  updated_by uuid null references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_knowledge_facts_client_id_unique
    unique (workspace_id, client_fact_id)
);

-- Bestehende Trigger-Funktion aus 20250711140000 -- unveraendert wiederverwendet.
drop trigger if exists workspace_knowledge_facts_set_updated_at on public.workspace_knowledge_facts;
create trigger workspace_knowledge_facts_set_updated_at
before update on public.workspace_knowledge_facts
for each row execute function public.set_workspace_updated_at();

alter table public.workspace_knowledge_facts enable row level security;

/* SELECT: jedes aktive Mitglied -- wie bei den Vorgangsnotizen. */
drop policy if exists workspace_knowledge_facts_select_member on public.workspace_knowledge_facts;
create policy workspace_knowledge_facts_select_member
on public.workspace_knowledge_facts for select to authenticated
using (public.is_active_workspace_member(workspace_id));

-- Schreiben ausschliesslich ueber die Security-Definer-RPC.
revoke all on public.workspace_knowledge_facts from public, anon;
revoke all on public.workspace_knowledge_facts from authenticated;
grant select on public.workspace_knowledge_facts to authenticated;

/* -------------------------------------------------------------------------- */
/* 2. Push: der bestehende Dispatcher, ergaenzt um einen Zweig                 */
/* -------------------------------------------------------------------------- */

/*
 * Woertlich die geltende Fassung aus 20261031120000 -- alle fuenfzehn
 * bisherigen Zweige unveraendert, dazu knowledge_fact.
 */
create or replace function public.upsert_workspace_sync_entity(
  p_workspace_id uuid,
  p_entity_type text,
  p_payload jsonb,
  p_row_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_version bigint;
  v_result jsonb;
  v_vorgang_id text;
  v_customer_id text;
  -- BRIEFE-01B: nur fuer den business_letter-Zweig.
  v_letter_id text;
  v_letter_customer_id text;
  v_letter_vorgang_id text;
  v_letter_status text;
  v_letter_payload jsonb;
  v_row_letter public.workspace_business_letters;
  -- ANGEBOT->AUFTRAG-02B: nur fuer den vorgang-Zweig.
  v_incoming_vorgang jsonb;
  v_key text;
  v_offer_result_vid text;
  -- EINGANG-01C-2: nur fuer den vorgang-Zweig.
  v_request_vorgang_number boolean;
  v_vorgang_number text;
  -- ANGEBOT-01B: nur fuer den offer-Zweig.
  v_offer_id text;
  v_offer_customer_id text;
  v_offer_status text;
  v_offer_payload jsonb;
  v_row_offer public.workspace_offers;
  v_offer_archive text;
  -- CLOUD-DURABILITY-01B: nur fuer den vorgang_note-Zweig.
  v_note_id text;
  v_note_vorgang_id text;
  v_note_payload jsonb;
  -- CLOUD-DURABILITY-01C: nur fuer den task-Zweig.
  v_task_id text;
  v_task_payload jsonb;
  v_task_status text;
  v_task_dedupe text;
  v_task_auto boolean;
  v_canonical public.workspace_tasks;
  -- SYNC-DURABILITY-HARDENING-01G: der gespeicherte Stand fuer den Version-0-Vertrag.
  v_row_vorgang public.workspace_vorgaenge;
  v_row_customer public.workspace_customers;
  v_row_note public.workspace_vorgang_notes;
  v_row_task public.workspace_tasks;
  v_incoming jsonb;
  -- CLOUD-DURABILITY-01D: nur fuer den dunning_documentation-Zweig.
  v_dun_id text;
  v_dun_invoice_id text;
  v_dun_vorgang_id text;
  v_dun_kind text;
  v_dun_documented_at date;
  v_dun_delivery text;
  v_dun_payload jsonb;
  v_dun_existing public.workspace_invoice_dunning_documentations;
  v_deleted boolean;
  -- BRANDING-01E-0 / FIRMENPROFIL-01B: nur fuer den company_profile-Zweig.
  v_existing_profile jsonb;
  v_incoming_profile jsonb;
  v_incoming_schema integer;
  v_field record;
  /* BANKABGLEICH-V1 BLOCK 2B: nur fuer die beiden Bank-Zweige. */
  v_bank_account_id text;
  v_bank_account_payload jsonb;
  v_bank_transaction_id text;
  v_bank_transaction_payload jsonb;
  v_row_bank_account public.workspace_bank_accounts;
  v_row_bank_transaction public.workspace_bank_transactions;
  /* CLOUD-SYNC S1: nur fuer den paper_register_entry-Zweig. */
  v_paper_entry_id text;
  v_paper_document_id text;
  v_paper_payload jsonb;
  v_row_paper public.workspace_paper_register_entries;
  /* CLOUD-SYNC S2: nur fuer den communication_event-Zweig. */
  v_comm_event_id text;
  v_comm_payload jsonb;
  v_comm_context jsonb;
  v_comm_context_type text;
  v_comm_event_type text;
  v_comm_event_at timestamptz;
  v_row_comm public.workspace_communication_events;
  /* CLOUD-SYNC S3: nur fuer den knowledge_fact-Zweig. */
  v_fact_id text;
  v_fact_payload jsonb;
  v_fact_scope text;
  v_row_fact public.workspace_knowledge_facts;
begin
  /*
   * SYNC-DURABILITY-HARDENING-01G4 -- kein dritter Zustand.
   *
   * Alle folgenden Zweige vergleichen `p_row_version`. Waere der Wert `NULL`,
   * ergaebe jeder dieser Vergleiche `NULL` und damit nicht wahr -- die Zeile
   * wuerde ungeprueft ueberschrieben. Eine fehlende Angabe ist keine bestaetigte
   * Serverversion, also gilt sie hier als unbestaetigt.
   */
  p_row_version := coalesce(p_row_version, 0);

  if auth.uid() is null then
    raise exception 'Nicht angemeldet';
  end if;

  if not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  if p_entity_type = 'vorgang' then
    if not public.can_write_workspace(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_vorgang_id := coalesce(nullif(trim(p_payload->>'vorgang_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_vorgang_id is null then
      raise exception 'vorgang_id fehlt';
    end if;

    v_deleted := coalesce((p_payload->>'deleted')::boolean, false);
    -- EINGANG-01C-2: der Nummernwunsch zaehlt nur als ausdrueckliches JSON-true auf Push-Ebene.
    v_request_vorgang_number := coalesce(
      jsonb_typeof(p_payload->'request_vorgang_number') = 'boolean'
        and (p_payload->>'request_vorgang_number')::boolean,
      false
    );

    select v.* into v_row_vorgang
    from public.workspace_vorgaenge v
    where v.workspace_id = p_workspace_id and v.vorgang_id = v_vorgang_id
    for update;
    v_current_version := v_row_vorgang.row_version;

    /*
     * SYNC-DURABILITY-HARDENING-01G — Version 0 bei vorhandener Zeile.
     *
     * `p_row_version = 0` heisst ausschliesslich: Dieser Client hat **keine**
     * bestaetigte Serverversion. Bisher umging dieser Wert die Versionspruefung
     * vollstaendig und durfte deshalb eine neuere Fassung oder einen Grabstein
     * ueberschreiben. Zulaessig ist er jetzt nur noch in zwei Faellen: Es gibt
     * keine Zeile (CREATE), oder der Inhalt ist identisch — dann ist es die
     * Wiederholung eines Schreibvorgangs, dessen Bestaetigung verloren ging, und
     * die Zeile wird unveraendert zurueckgegeben.
     */
    if v_current_version is not null and p_row_version <= 0 then
      v_incoming := coalesce(p_payload->'payload', p_payload, '{}'::jsonb);
      -- 01G2 -- beide Seiten wollen dasselbe: geloescht.
      if v_row_vorgang.deleted and v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_vorgang_id,
          'row_version', v_row_vorgang.row_version,
          'payload', to_jsonb(v_row_vorgang),
          'deleted', true,
          'replayed', true
        );
      end if;
      if v_row_vorgang.deleted and not v_deleted then
        raise exception 'Versionskonflikt vorgang:%', v_current_version using errcode = 'P0001';
      end if;
      /*
       * EINGANG-01C-2 -- die Vorgangsnummer schreibt der Server selbst in den
       * Payload. Ein sonst identischer Replay ohne sie ist dieselbe Absicht;
       * eine abweichende mitgesendete Nummer ist dagegen kein Replay.
       */
      if (v_row_vorgang.payload - 'vorgangNumber') = (v_incoming - 'vorgangNumber' - 'request_vorgang_number')
         and (not (v_incoming ? 'vorgangNumber') or v_incoming->>'vorgangNumber' is not distinct from v_row_vorgang.vorgang_number)
         and v_row_vorgang.deleted = v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_vorgang_id,
          'row_version', v_row_vorgang.row_version,
          'payload', to_jsonb(v_row_vorgang),
          'deleted', v_row_vorgang.deleted,
          'replayed', true
        );
      end if;
      raise exception 'Versionskonflikt vorgang:%', v_current_version using errcode = 'P0001';
    end if;

    if v_current_version is null then
      -- ANGEBOT->AUFTRAG-02B: Auftragsherkunft und -nummer vergibt nur accept_workspace_offer.
      v_incoming_vorgang := coalesce(p_payload->'payload', p_payload, '{}'::jsonb);
      if (not v_deleted) and (v_incoming_vorgang ? 'sourceOfferId' or v_incoming_vorgang ? 'orderNumber') then
        raise exception 'Auftragsnummer und Herkunft nur ueber accept_workspace_offer oder create_workspace_order' using errcode = 'P0001';
      end if;

      -- EINGANG-01C-2: Eine Vorgangsnummer vergibt ausschliesslich der Server.
      if v_incoming_vorgang ? 'vorgangNumber' then
        raise exception 'Vorgangsnummer vergibt ausschliesslich der Server' using errcode = 'P0001';
      end if;
      v_incoming_vorgang := v_incoming_vorgang - 'request_vorgang_number';
      /*
       * Nur auf ausdruecklichen Wunsch und nie fuer einen Grabstein. Ein
       * Erst-Upload ohne Wunsch -- Altbestand, Provisioning -- bleibt ohne
       * Nummer: kein Backfill. Vergabe und Einfuegen teilen die Transaktion;
       * scheitert das Einfuegen, rollt auch der Zaehler zurueck.
       */
      v_vorgang_number := null;
      if v_request_vorgang_number and not v_deleted then
        v_vorgang_number := public.allocate_workspace_vorgang_number(p_workspace_id);
        v_incoming_vorgang := v_incoming_vorgang || jsonb_build_object('vorgangNumber', v_vorgang_number);
      end if;

      insert into public.workspace_vorgaenge (
        workspace_id,
        vorgang_id,
        payload,
        row_version,
        deleted,
        deleted_at,
        updated_by,
        vorgang_number
      )
      values (
        p_workspace_id,
        v_vorgang_id,
        v_incoming_vorgang,
        1,
        v_deleted,
        case when v_deleted then now() else null end,
        auth.uid(),
        v_vorgang_number
      )
      returning to_jsonb(public.workspace_vorgaenge.*) into v_result;
    else
      -- CREATE-RETRY-CONFLICT-02: `0` ist jetzt die Erwartung "Zeile fehlt".
      if p_row_version <> v_current_version then
        raise exception 'Versionskonflikt vorgang:%', v_current_version using errcode = 'P0001';
      end if;

      /*
       * ANGEBOT->AUFTRAG-02B / AUFTRAG-02C -- Serverwahrheit fuer Auftraege.
       *
       * Ohne Auftragsnummer: Der Payload darf weder Herkunft noch Nummer
       * tragen (die setzen nur accept_workspace_offer und
       * create_workspace_order). Mit Auftragsnummer -- aus Angebot oder
       * manuell -- gilt fuer beide dasselbe Regelwerk: Die
       * kaufmaennischen Snapshot-Felder sind write-once, und Herkunft, Nummer,
       * Datum werden aus den Spalten bzw. dem gespeicherten Payload erzwungen --
       * ein abweichender Client-Wert erreicht die Zeile nie.
       */
      v_incoming_vorgang := coalesce(p_payload->'payload', p_payload, v_row_vorgang.payload);
      if not v_deleted then
        -- AUFTRAG-02C: Die Frage ist "bestaetigter eigener Auftrag?", nicht "aus Angebot?".
        if v_row_vorgang.order_number is null then
          if v_incoming_vorgang ? 'sourceOfferId' or v_incoming_vorgang ? 'orderNumber' then
            raise exception 'Auftragsnummer und Herkunft nur ueber accept_workspace_offer oder create_workspace_order' using errcode = 'P0001';
          end if;
        else
          foreach v_key in array array['contractConfirmation', 'taxStatus', 'paymentTermsText', 'introText', 'closingText', 'contractTotals', 'customerId', 'customerBilling'] loop
            if v_row_vorgang.payload ? v_key and (v_row_vorgang.payload -> v_key) is distinct from (v_incoming_vorgang -> v_key) then
              raise exception 'Auftrag: % ist festgeschrieben', v_key using errcode = 'P0001';
            end if;
          end loop;
          -- Operativer Plan: nur Hauptsnapshot + bestaetigte Nachtraege (executedQuantity bleibt frei).
          perform public.assert_workspace_order_positions_frozen(
            p_workspace_id, v_vorgang_id, v_row_vorgang.payload->'contractConfirmation', v_incoming_vorgang->'orderPositions');
          if (v_incoming_vorgang ? 'sourceOfferId' and v_incoming_vorgang->>'sourceOfferId' is distinct from v_row_vorgang.source_offer_id)
             or (v_incoming_vorgang ? 'orderNumber' and v_incoming_vorgang->>'orderNumber' is distinct from v_row_vorgang.order_number) then
            raise exception 'Auftragsherkunft und Auftragsnummer koennen nicht geaendert werden' using errcode = 'P0001';
          end if;
          v_incoming_vorgang := v_incoming_vorgang || jsonb_strip_nulls(jsonb_build_object(
            'sourceOfferId', v_row_vorgang.source_offer_id,
            'orderNumber', v_row_vorgang.order_number,
            'sourceOfferNumber', v_row_vorgang.payload->'sourceOfferNumber',
            'orderDate', v_row_vorgang.payload->'orderDate'
          ));
        end if;

        /*
         * EINGANG-01C-2 -- unabhaengig vom Auftrag: Die Spalte ist die Wahrheit,
         * der Payload ihr Abbild. Ohne Nummer darf der Client keine setzen; mit
         * Nummer darf er sie weder aendern noch entfernen -- ein alter Stand
         * ohne Feld bekommt sie zurueckgeschrieben.
         */
        v_incoming_vorgang := v_incoming_vorgang - 'request_vorgang_number';
        if v_row_vorgang.vorgang_number is null then
          if v_incoming_vorgang ? 'vorgangNumber' then
            raise exception 'Vorgangsnummer vergibt ausschliesslich der Server' using errcode = 'P0001';
          end if;
        else
          if v_incoming_vorgang ? 'vorgangNumber'
             and v_incoming_vorgang->>'vorgangNumber' is distinct from v_row_vorgang.vorgang_number then
            raise exception 'Vorgangsnummer kann nicht geaendert werden' using errcode = 'P0001';
          end if;
          v_incoming_vorgang := v_incoming_vorgang || jsonb_build_object('vorgangNumber', v_row_vorgang.vorgang_number);
        end if;
      end if;

      update public.workspace_vorgaenge
      set
        payload = case when v_deleted then payload else v_incoming_vorgang end,
        deleted = v_deleted,
        deleted_at = case when v_deleted then coalesce(deleted_at, now()) else null end,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id and vorgang_id = v_vorgang_id
      returning to_jsonb(public.workspace_vorgaenge.*) into v_result;
    end if;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_vorgang_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result,
      'deleted', (v_result->>'deleted')::boolean
    );

  elsif p_entity_type = 'customer' then
    /*
     * PRODUCT-FOUNDATION-03A-S1 -- strukturgleich zum Vorgangs-Zweig.
     *
     * Der Server prueft Berechtigung und Sync-Struktur, NICHT die
     * Customer-Fachlogik. Eigenfirmen-Guard, Namensvergleich und
     * Dublettenerkennung bleiben ausschliesslich im Client: der Guard braucht
     * das lokale Firmenprofil, das serverseitig gar nicht auswertbar ist.
     *
     * `deleted`/`deleted_at` werden bereits nach dem Vorgangs-Protokoll
     * behandelt, obwohl es noch keine Loeschfunktion gibt. Kein Client erzeugt
     * in diesem Stand `deleted = true`; die Semantik steht aber bereit, ohne
     * dass spaeter eine zweite Migration dieselbe RPC erneut anfassen muss.
     */
    if not public.can_write_workspace(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_customer_id := coalesce(nullif(trim(p_payload->>'customer_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_customer_id is null then
      raise exception 'customer_id fehlt';
    end if;

    v_deleted := coalesce((p_payload->>'deleted')::boolean, false);

    select c.* into v_row_customer
    from public.workspace_customers c
    where c.workspace_id = p_workspace_id and c.customer_id = v_customer_id
    for update;
    v_current_version := v_row_customer.row_version;

    -- 01G — siehe Vorgangs-Zweig: Version 0 ueberschreibt keine vorhandene Zeile.
    if v_current_version is not null and p_row_version <= 0 then
      v_incoming := coalesce(p_payload->'payload', p_payload, '{}'::jsonb);
      -- 01G2 -- beide Seiten wollen dasselbe: geloescht.
      if v_row_customer.deleted and v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_customer_id,
          'row_version', v_row_customer.row_version,
          'payload', to_jsonb(v_row_customer),
          'deleted', true,
          'replayed', true
        );
      end if;
      if v_row_customer.deleted and not v_deleted then
        raise exception 'Versionskonflikt customer:%', v_current_version using errcode = 'P0001';
      end if;
      if v_row_customer.payload = v_incoming and v_row_customer.deleted = v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_customer_id,
          'row_version', v_row_customer.row_version,
          'payload', to_jsonb(v_row_customer),
          'deleted', v_row_customer.deleted,
          'replayed', true
        );
      end if;
      raise exception 'Versionskonflikt customer:%', v_current_version using errcode = 'P0001';
    end if;

    if v_current_version is null then
      insert into public.workspace_customers (
        workspace_id,
        customer_id,
        payload,
        row_version,
        deleted,
        deleted_at,
        updated_by
      )
      values (
        p_workspace_id,
        v_customer_id,
        coalesce(p_payload->'payload', p_payload, '{}'::jsonb),
        1,
        v_deleted,
        case when v_deleted then now() else null end,
        auth.uid()
      )
      returning to_jsonb(public.workspace_customers.*) into v_result;
    else
      -- CREATE-RETRY-CONFLICT-02: `0` ist jetzt die Erwartung "Zeile fehlt".
      if p_row_version <> v_current_version then
        raise exception 'Versionskonflikt customer:%', v_current_version using errcode = 'P0001';
      end if;

      update public.workspace_customers
      set
        payload = case when v_deleted then payload else coalesce(p_payload->'payload', p_payload, payload) end,
        deleted = v_deleted,
        deleted_at = case when v_deleted then coalesce(deleted_at, now()) else null end,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id and customer_id = v_customer_id
      returning to_jsonb(public.workspace_customers.*) into v_result;
    end if;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_customer_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result,
      'deleted', (v_result->>'deleted')::boolean
    );

  elsif p_entity_type = 'business_letter' then
    /*
     * BRIEFE-01B — ausgehendes Geschaeftsschreiben.
     *
     * Schreibrecht wie bei Notizen und Aufgaben: Ein Brief ist normale
     * Bueroarbeit, keine Eigentuemerhandlung. Der Versionsvertrag ist
     * unveraendert der aus 01G -- einschliesslich der Regel, dass eine
     * unbestaetigte Version (<= 0) nur anlegen oder eine inhaltsgleiche
     * Wiederholung sein darf.
     */
    if not public.workspace_user_can_intake(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_letter_id := coalesce(nullif(trim(p_payload->>'letter_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_letter_id is null then
      raise exception 'letter_id fehlt';
    end if;

    v_letter_payload := coalesce(p_payload->'payload', '{}'::jsonb);
    v_letter_customer_id := nullif(trim(coalesce(p_payload->>'customer_id', v_letter_payload->>'customerId')), '');
    v_letter_vorgang_id := nullif(trim(coalesce(p_payload->>'vorgang_id', v_letter_payload->>'vorgangId')), '');
    v_letter_status := coalesce(nullif(trim(p_payload->>'status'), ''), nullif(trim(v_letter_payload->>'status'), ''), 'draft');
    v_deleted := coalesce((p_payload->>'deleted')::boolean, false);

    if v_letter_status not in ('draft', 'finalized') then
      raise exception 'Brief ungueltig: status' using errcode = 'P0001';
    end if;

    if not v_deleted then
      if jsonb_typeof(v_letter_payload->'subject') <> 'string' or length(trim(v_letter_payload->>'subject')) = 0 then
        raise exception 'Brief ungueltig: subject' using errcode = 'P0001';
      end if;
      if length(v_letter_payload->>'subject') > 300 then
        raise exception 'Brief ungueltig: subject zu lang' using errcode = 'P0001';
      end if;
      if jsonb_typeof(v_letter_payload->'body') <> 'string' or length(trim(v_letter_payload->>'body')) = 0 then
        raise exception 'Brief ungueltig: body' using errcode = 'P0001';
      end if;
      if length(v_letter_payload->>'body') > 50000 then
        raise exception 'Brief ungueltig: body zu lang' using errcode = 'P0001';
      end if;
    end if;

    select l.* into v_row_letter
    from public.workspace_business_letters l
    where l.workspace_id = p_workspace_id and l.client_letter_id = v_letter_id
    for update;
    v_current_version := v_row_letter.row_version;

    /*
     * SYNC-DURABILITY-HARDENING-01G — unbestaetigte Version bei vorhandener
     * Zeile. Wortgleich zu den uebrigen Zweigen: Anlegen ist erlaubt, eine
     * inhaltsgleiche Wiederholung wird unveraendert zurueckgegeben, alles
     * andere ist ein Konflikt.
     */
    if v_current_version is not null and p_row_version <= 0 then
      v_incoming := coalesce(p_payload->'payload', p_payload, '{}'::jsonb);

      if v_deleted and v_row_letter.deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_letter_id,
          'row_version', v_row_letter.row_version,
          'payload', v_row_letter.payload,
          'deleted', v_row_letter.deleted,
          'replayed', true
        );
      end if;

      if (not v_deleted) and (not v_row_letter.deleted) and v_row_letter.payload = v_incoming then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_letter_id,
          'row_version', v_row_letter.row_version,
          'payload', v_row_letter.payload,
          'deleted', v_row_letter.deleted,
          'replayed', true
        );
      end if;

      raise exception 'Versionskonflikt business_letter:%', v_current_version using errcode = 'P0001';
    end if;

    if v_current_version is null then
      insert into public.workspace_business_letters (
        workspace_id,
        client_letter_id,
        client_customer_id,
        client_vorgang_id,
        status,
        payload,
        row_version,
        deleted,
        deleted_at,
        created_by,
        updated_by
      )
      values (
        p_workspace_id,
        v_letter_id,
        v_letter_customer_id,
        v_letter_vorgang_id,
        v_letter_status,
        case when v_deleted then '{}'::jsonb else v_letter_payload end,
        1,
        v_deleted,
        case when v_deleted then now() else null end,
        auth.uid(),
        auth.uid()
      )
      returning to_jsonb(public.workspace_business_letters.*) into v_result;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt business_letter:%', v_current_version using errcode = 'P0001';
      end if;

      /*
       * BRIEFE-01B -- ein fertiggestellter Brief ist ein Beleg.
       *
       * Die Unveraenderlichkeit darf nicht am Client haengen: Wer den Aufruf
       * nachbaut, koennte sonst Betreff, Text, Datum, Empfaenger oder den
       * eingefrorenen Absender-Schnappschuss nachtraeglich umschreiben -- und
       * das Dokument hiesse morgen etwas anderes als das, was der Empfaenger
       * bekommen hat. Deshalb steht der Guard hier, nicht nur im Fachdienst.
       *
       * Erlaubt bleiben ausdruecklich:
       *   * der Uebergang draft -> finalized (die Zeile ist dann noch draft),
       *   * die wortgleiche Wiederholung eines Schreibvorgangs, dessen
       *     Bestaetigung verloren ging -- sie aendert nichts,
       *   * der Grabstein: Loeschen ist kein Umschreiben, und der Loeschweg
       *     muss dem uebrigen Sync-Vertrag folgen.
       *
       * `documentId` bleibt vom Vergleich ausgenommen: Es benennt die spaeter
       * erzeugte Archivdatei, gehoert aber nicht zum fachlichen Inhalt des
       * Schreibens.
       */
      if v_row_letter.status = 'finalized' and not v_row_letter.deleted and not v_deleted then
        if v_letter_status <> 'finalized' then
          raise exception 'Brief ist fertiggestellt und kann nicht zurueckgesetzt werden'
            using errcode = 'P0001';
        end if;
        if (v_row_letter.payload - 'documentId') is distinct from (v_letter_payload - 'documentId') then
          raise exception 'Brief ist fertiggestellt und kann nicht mehr geaendert werden'
            using errcode = 'P0001';
        end if;
      end if;

      /*
       * Grabstein: Der Fachinhalt bleibt stehen, ebenso die Bezuege zu Kunde
       * und Auftrag -- sie sind die Ordnung, ueber die ein zweites Geraet den
       * Grabstein zuordnet.
       */
      update public.workspace_business_letters
      set
        payload = case when v_deleted then payload else coalesce(v_letter_payload, payload) end,
        client_customer_id = coalesce(v_letter_customer_id, client_customer_id),
        client_vorgang_id = coalesce(v_letter_vorgang_id, client_vorgang_id),
        status = case when v_deleted then status else v_letter_status end,
        deleted = v_deleted,
        deleted_at = case when v_deleted then coalesce(deleted_at, now()) else null end,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id and client_letter_id = v_letter_id
      returning to_jsonb(public.workspace_business_letters.*) into v_result;
    end if;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_letter_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result->'payload',
      'deleted', (v_result->>'deleted')::boolean
    );

  elsif p_entity_type = 'offer' then
    /*
     * ANGEBOT-01B -- eigenes Angebot.
     *
     * Schreibrecht wie bei Briefen: normale Bueroarbeit, `workspace_user_can_intake`.
     * Versionsvertrag unveraendert aus 01G. Zusaetzlich:
     *   * Die Freigabe (Entwurf -> Nummer) laeuft NICHT hier, sondern nur ueber
     *     `finalize_workspace_offer`. Ein Client, der einen Entwurf mit einem
     *     anderen Status oder einer Nummer schreibt, wird abgewiesen.
     *   * Ein freigegebenes Angebot ist ein Beleg: Der eingefrorene Inhalt darf
     *     sich nicht aendern. Erlaubt sind nur die Zustandsfelder (status,
     *     sentAt, decidedAt, archiveDocumentId, resultingVorgangId, updatedAt)
     *     -- und nur entlang der erlaubten Uebergaenge.
     */
    if not public.workspace_user_can_intake(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_offer_id := coalesce(nullif(trim(p_payload->>'offer_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_offer_id is null then
      raise exception 'offer_id fehlt';
    end if;

    v_offer_payload := coalesce(p_payload->'payload', '{}'::jsonb);
    v_offer_customer_id := nullif(trim(coalesce(p_payload->>'customer_id', v_offer_payload->>'customerId')), '');
    v_offer_status := coalesce(nullif(trim(p_payload->>'status'), ''), nullif(trim(v_offer_payload->>'status'), ''), 'entwurf');
    v_deleted := coalesce((p_payload->>'deleted')::boolean, false);

    if v_offer_status not in ('entwurf', 'freigegeben', 'versendet', 'angenommen', 'abgelehnt', 'storniert', 'ersetzt') then
      raise exception 'Angebot ungueltig: status' using errcode = 'P0001';
    end if;

    select o.* into v_row_offer
    from public.workspace_offers o
    where o.workspace_id = p_workspace_id and o.client_offer_id = v_offer_id
    for update;
    v_current_version := v_row_offer.row_version;

    if v_current_version is not null and p_row_version <= 0 then
      v_incoming := coalesce(p_payload->'payload', p_payload, '{}'::jsonb);

      if v_deleted and v_row_offer.deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_offer_id,
          'row_version', v_row_offer.row_version,
          'payload', v_row_offer.payload,
          'deleted', v_row_offer.deleted,
          'replayed', true
        );
      end if;

      if (not v_deleted) and (not v_row_offer.deleted) and v_row_offer.payload = v_incoming then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_offer_id,
          'row_version', v_row_offer.row_version,
          'payload', v_row_offer.payload,
          'deleted', v_row_offer.deleted,
          'replayed', true
        );
      end if;

      raise exception 'Versionskonflikt offer:%', v_current_version using errcode = 'P0001';
    end if;

    if v_current_version is null then
      -- Neu anlegen darf nur ein Entwurf ohne Nummer: Nummern vergibt die Freigabe.
      if (not v_deleted) and (v_offer_status <> 'entwurf' or v_offer_payload ? 'offerNumber') then
        raise exception 'Freigabe nur ueber finalize_workspace_offer' using errcode = 'P0001';
      end if;

      insert into public.workspace_offers (
        workspace_id,
        client_offer_id,
        client_customer_id,
        status,
        payload,
        row_version,
        deleted,
        deleted_at,
        created_by,
        updated_by
      )
      values (
        p_workspace_id,
        v_offer_id,
        v_offer_customer_id,
        case when v_deleted then 'entwurf' else v_offer_status end,
        case when v_deleted then '{}'::jsonb else v_offer_payload end,
        1,
        v_deleted,
        case when v_deleted then now() else null end,
        auth.uid(),
        auth.uid()
      )
      returning to_jsonb(public.workspace_offers.*) into v_result;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt offer:%', v_current_version using errcode = 'P0001';
      end if;

      if (not v_deleted) and (not v_row_offer.deleted) then
        if v_row_offer.status = 'entwurf' then
          -- Ein Entwurf bleibt Entwurf: Freigabe und Nummer nur ueber die RPC.
          if v_offer_status <> 'entwurf' or v_offer_payload ? 'offerNumber' then
            raise exception 'Freigabe nur ueber finalize_workspace_offer' using errcode = 'P0001';
          end if;
        else
          -- Beleg: nur Zustandsfelder duerfen sich aendern, und nur vorwaerts.
          if (v_row_offer.payload - 'status' - 'sentAt' - 'decidedAt' - 'archiveDocumentId' - 'resultingVorgangId' - 'updatedAt')
             is distinct from
             (v_offer_payload - 'status' - 'sentAt' - 'decidedAt' - 'archiveDocumentId' - 'resultingVorgangId' - 'updatedAt') then
            raise exception 'Angebot ist freigegeben und kann nicht mehr geaendert werden' using errcode = 'P0001';
          end if;
          if v_offer_status <> v_row_offer.status then
            -- ANGEBOT->AUFTRAG-02B: Annahme nur atomar mit dem Auftrag.
            if v_offer_status = 'angenommen' then
              raise exception 'Annahme nur ueber accept_workspace_offer' using errcode = 'P0001';
            end if;
            if not (
              (v_row_offer.status = 'freigegeben' and v_offer_status in ('versendet', 'abgelehnt', 'storniert', 'ersetzt'))
              or (v_row_offer.status = 'versendet' and v_offer_status in ('abgelehnt', 'storniert', 'ersetzt'))
            ) then
              raise exception 'Statuswechsel % -> % ist nicht erlaubt', v_row_offer.status, v_offer_status using errcode = 'P0001';
            end if;
          end if;
          -- ANGEBOT->AUFTRAG-02B: resultingVorgangId ist Serverwahrheit (write-once, nur ueber die RPC).
          v_offer_result_vid := nullif(trim(coalesce(v_offer_payload->>'resultingVorgangId', '')), '');
          if v_offer_result_vid is distinct from nullif(trim(coalesce(v_row_offer.payload->>'resultingVorgangId', '')), '') then
            raise exception 'Auftragsbezug eines Angebots nur ueber accept_workspace_offer' using errcode = 'P0001';
          end if;
          -- Die Serverwahrheit ueber Nummer und Fingerabdruck bleibt, was sie ist.
          v_offer_payload := v_offer_payload || jsonb_build_object(
            'offerNumber', v_row_offer.offer_number,
            'offerSequenceNumber', v_row_offer.offer_sequence_number,
            'contentFingerprint', v_row_offer.content_fingerprint
          );
        end if;
      end if;

      /*
       * ANGEBOT-01B (Pre-Acceptance) -- Archiv-Invariante, serverseitig.
       * Die Ablage ist write-once und darf nur auf ein Dokument desselben
       * Workspaces zeigen, das als eigenes Angebot (classifiedKind = angebot)
       * genau dieses Angebot referenziert (linkedOfferId). Ein Entwurf hat
       * keine Ablage; ein Fremddokument oder das Dokument eines anderen
       * Angebots wird abgewiesen.
       */
      if not v_deleted then
        v_offer_archive := nullif(trim(coalesce(v_offer_payload->>'archiveDocumentId', '')), '');
        if v_offer_archive is distinct from nullif(trim(coalesce(v_row_offer.payload->>'archiveDocumentId', '')), '') then
          if v_row_offer.status = 'entwurf' then
            raise exception 'Ein Entwurf hat keine Archivablage' using errcode = 'P0001';
          end if;
          if nullif(trim(coalesce(v_row_offer.payload->>'archiveDocumentId', '')), '') is not null then
            raise exception 'Archivdokument eines Angebots kann nicht gewechselt werden' using errcode = 'P0001';
          end if;
          if v_offer_archive is not null and not exists (
            select 1 from public.workspace_documents d
            where d.workspace_id = p_workspace_id
              and d.client_document_id = v_offer_archive
              and d.deleted = false
              and d.payload->>'classifiedKind' = 'angebot'
              and d.payload->>'linkedOfferId' = v_offer_id
          ) then
            raise exception 'Archivdokument gehoert nicht zu diesem Angebot' using errcode = 'P0001';
          end if;
          if v_offer_archive is not null and exists (
            select 1 from public.workspace_offers o2
            where o2.workspace_id = p_workspace_id
              and o2.client_offer_id <> v_offer_id
              and o2.payload->>'archiveDocumentId' = v_offer_archive
          ) then
            raise exception 'Archivdokument ist bereits einem anderen Angebot zugeordnet' using errcode = 'P0001';
          end if;
        end if;
      end if;

      -- Loeschen: nur Entwuerfe. Ein Beleg wird storniert, nicht entfernt.
      if v_deleted and v_row_offer.status <> 'entwurf' then
        raise exception 'Ein freigegebenes Angebot kann nicht geloescht werden' using errcode = 'P0001';
      end if;

      update public.workspace_offers
      set
        payload = case when v_deleted then payload else coalesce(v_offer_payload, payload) end,
        client_customer_id = coalesce(v_offer_customer_id, client_customer_id),
        status = case when v_deleted then status else v_offer_status end,
        deleted = v_deleted,
        deleted_at = case when v_deleted then coalesce(deleted_at, now()) else null end,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id and client_offer_id = v_offer_id
      returning to_jsonb(public.workspace_offers.*) into v_result;
    end if;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_offer_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result->'payload',
      'deleted', (v_result->>'deleted')::boolean
    );

  elsif p_entity_type = 'vorgang_note' then
    /*
     * CLOUD-DURABILITY-CORE-01B -- Vorgangsnotizen.
     *
     * Berechtigung bewusst NICHT `can_write_workspace` (Inhaber/Admin):
     * Die Notiz entsteht heute in `VorgangDetailPage` ueber `addVorgangNote`
     * ohne jede Rollenpruefung -- jedes aktive Mitglied darf sie lokal
     * schreiben. `can_write_workspace` wuerde genau diese Mitglieder beim
     * ersten Push aussperren und ihre Notizen dauerhaft in der Outbox
     * haengen lassen. Verwendet wird deshalb die vorhandene Funktion
     * `workspace_user_can_intake` -- dieselbe Berechtigung, die schon fuer
     * Eingang und Dokumente den Satz "aktives Mitglied" ausdrueckt.
     *
     * SELECT: jedes aktive Mitglied (`is_active_workspace_member`, Policy
     * unten) -- lokal sieht jedes Mitglied alle Notizen eines Vorgangs, die
     * Cloud darf daran nichts verengen.
     * INSERT/UPDATE/TOMBSTONE: jedes aktive Mitglied
     * (`workspace_user_can_intake`), ausschliesslich ueber diese
     * Security-Definer-RPC.
     *
     * Serverseitig wird nur die Sync-Struktur geprueft, keine Fachlogik:
     * Notiz-ID, Vorgangsbezug und ein Textkoerper in vertretbarer Laenge.
     */
    if not public.workspace_user_can_intake(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_note_id := coalesce(nullif(trim(p_payload->>'note_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_note_id is null then
      raise exception 'note_id fehlt';
    end if;

    v_note_payload := coalesce(p_payload->'payload', '{}'::jsonb);
    v_note_vorgang_id := coalesce(
      nullif(trim(p_payload->>'vorgang_id'), ''),
      nullif(trim(v_note_payload->>'vorgangId'), '')
    );
    v_deleted := coalesce((p_payload->>'deleted')::boolean, false);

    -- Guard: der Vorgangsbezug ist die Ordnung dieser Tabelle und darf nur am
    -- Grabstein fehlen -- dort wird kein Fachinhalt mitgeschickt.
    if v_note_vorgang_id is null and not v_deleted then
      raise exception 'vorgang_id fehlt';
    end if;

    if not v_deleted then
      if jsonb_typeof(v_note_payload->'body') <> 'string' or length(trim(v_note_payload->>'body')) = 0 then
        raise exception 'Notiz ungueltig: body' using errcode = 'P0001';
      end if;
      if length(v_note_payload->>'body') > 20000 then
        raise exception 'Notiz ungueltig: body zu lang' using errcode = 'P0001';
      end if;
    end if;

    select n.* into v_row_note
    from public.workspace_vorgang_notes n
    where n.workspace_id = p_workspace_id and n.client_note_id = v_note_id
    for update;
    v_current_version := v_row_note.row_version;

    /*
     * 01G — Version 0 gegen eine vorhandene Notiz.
     *
     * Der Grabsteinfall ist hier der wichtigste: Eine geloeschte Notiz durfte
     * bisher von einem unbestaetigten Schreibvorgang wiederbelebt werden. Jetzt
     * gilt auch fuer sie: identischer Inhalt = Wiederholung, alles andere =
     * Konflikt.
     */
    if v_current_version is not null and p_row_version <= 0 then
      if v_row_note.deleted and not v_deleted then
        raise exception 'Versionskonflikt vorgang_note:%', v_current_version using errcode = 'P0001';
      end if;
      /*
       * 01G2 -- derselbe Loeschvorgang, im Produkt beobachtet.
       *
       * Wird eine nie bestaetigte Notiz geloescht und geht die Antwort
       * verloren, schickt der Wiederanlauf den **vollen** Fachinhalt mit
       * `deleted = true`; die Serverzeile traegt aber `payload = {}`, weil ein
       * Grabstein beim Einfuegen keinen Inhalt speichert. Ein reiner
       * Inhaltsvergleich hielt das faelschlich fuer einen Konflikt -- der
       * Sendeauftrag blieb dauerhaft blockiert (im Browser reproduziert).
       *
       * Beide Seiten wollen dasselbe: geloescht. Das ist ein sicherer Replay.
       */
      if v_row_note.deleted and v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_note_id,
          'row_version', v_row_note.row_version,
          'payload', to_jsonb(v_row_note),
          'deleted', true,
          'replayed', true
        );
      end if;
      if v_row_note.payload = v_note_payload and v_row_note.deleted = v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_note_id,
          'row_version', v_row_note.row_version,
          'payload', to_jsonb(v_row_note),
          'deleted', v_row_note.deleted,
          'replayed', true
        );
      end if;
      raise exception 'Versionskonflikt vorgang_note:%', v_current_version using errcode = 'P0001';
    end if;

    if v_current_version is null then
      insert into public.workspace_vorgang_notes (
        workspace_id,
        client_note_id,
        client_vorgang_id,
        payload,
        row_version,
        deleted,
        deleted_at,
        created_by,
        updated_by
      )
      values (
        p_workspace_id,
        v_note_id,
        v_note_vorgang_id,
        case when v_deleted then '{}'::jsonb else v_note_payload end,
        1,
        v_deleted,
        case when v_deleted then now() else null end,
        auth.uid(),
        auth.uid()
      )
      returning to_jsonb(public.workspace_vorgang_notes.*) into v_result;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt vorgang_note:%', v_current_version using errcode = 'P0001';
      end if;

      /*
       * Grabstein: der Fachinhalt bleibt unveraendert stehen (wie im
       * Vorgangs-Zweig), der Vorgangsbezug ebenso -- er ist die einzige
       * Ordnung, ueber die ein zweites Geraet den Grabstein zuordnet.
       */
      update public.workspace_vorgang_notes
      set
        payload = case when v_deleted then payload else coalesce(v_note_payload, payload) end,
        client_vorgang_id = coalesce(v_note_vorgang_id, client_vorgang_id),
        deleted = v_deleted,
        deleted_at = case when v_deleted then coalesce(deleted_at, now()) else null end,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id and client_note_id = v_note_id
      returning to_jsonb(public.workspace_vorgang_notes.*) into v_result;
    end if;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_note_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result,
      'deleted', (v_result->>'deleted')::boolean
    );

  elsif p_entity_type = 'task' then
    /*
     * CLOUD-DURABILITY-CORE-01C -- Aufgaben.
     *
     * Berechtigung wie bei den Vorgangsnotizen und aus demselben Grund:
     * Aufgaben entstehen heute ohne jede Rollenpruefung -- die Engine legt sie
     * beim blossen Oeffnen der Aufgabenseite an, und jedes aktive Mitglied darf
     * sie erledigen. `can_write_workspace` (Inhaber/Admin) wuerde genau diese
     * Mitglieder aussperren und ihre Aufgaben dauerhaft in der Outbox halten.
     *
     * SELECT: jedes aktive Mitglied (Policy unten).
     * CREATE/UPDATE/Statuswechsel/TOMBSTONE: jedes aktive Mitglied
     * (`workspace_user_can_intake`), ausschliesslich ueber diese RPC.
     */
    if not public.workspace_user_can_intake(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_task_id := coalesce(nullif(trim(p_payload->>'task_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_task_id is null then
      raise exception 'task_id fehlt';
    end if;

    v_task_payload := coalesce(p_payload->'payload', '{}'::jsonb);
    v_deleted := coalesce((p_payload->>'deleted')::boolean, false);
    v_task_status := coalesce(nullif(trim(p_payload->>'status'), ''), nullif(trim(v_task_payload->>'status'), ''), 'open');
    v_task_dedupe := coalesce(p_payload->>'dedupe_key', '');
    v_task_auto := coalesce((p_payload->>'auto_created')::boolean, false);

    -- Guards: nur Sync-Struktur, keine Fachlogik.
    if v_task_status not in ('open', 'in_progress', 'done', 'archived') then
      raise exception 'Aufgabe ungueltig: status' using errcode = 'P0001';
    end if;
    if not v_deleted then
      if jsonb_typeof(v_task_payload->'title') <> 'string' or length(trim(v_task_payload->>'title')) = 0 then
        raise exception 'Aufgabe ungueltig: title' using errcode = 'P0001';
      end if;
      if length(v_task_payload->>'title') > 500 then
        raise exception 'Aufgabe ungueltig: title zu lang' using errcode = 'P0001';
      end if;
    end if;

    /*
     * Idempotenz fuer konkurrierende automatische Aufgaben.
     *
     * Zwei Geraete, die offline dieselbe automatische Aufgabe erzeugen, senden
     * zwei verschiedene `client_task_id` mit demselben `dedupe_key`. Der zweite
     * Push darf weder eine zweite Zeile anlegen noch an der Eindeutigkeit
     * sterben: Er ist fachlich ein Replay. Der Server gibt dann die bereits
     * vorhandene kanonische Zeile zurueck und markiert die Antwort mit
     * `deduped`; der Client uebernimmt sie und verwirft seine eigene Kennung.
     *
     * Die Pruefung gilt fuer jeden Write, der in einer aktiven automatischen
     * Aufgabe endet -- auch fuer ein Wiederoeffnen, das sonst am Index
     * scheitern wuerde. Manuelle Aufgaben (`auto_created = false`) und Aufgaben
     * ohne Dedupe-Identitaet (leerer Schluessel) sind ausgenommen.
     */
    if v_task_auto and v_task_dedupe <> '' and not v_deleted and v_task_status in ('open', 'in_progress') then
      select t.* into v_canonical
      from public.workspace_tasks t
      where t.workspace_id = p_workspace_id
        and t.dedupe_key = v_task_dedupe
        and t.auto_created
        and not t.deleted
        and t.status in ('open', 'in_progress')
        and t.client_task_id <> v_task_id
      order by t.created_at, t.client_task_id
      limit 1
      for update;

      if found then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_canonical.client_task_id,
          'requested_entity_id', v_task_id,
          'row_version', v_canonical.row_version,
          'payload', to_jsonb(v_canonical),
          'deleted', false,
          -- Zusatzfeld, rueckwaertskompatibel: aeltere Clients lesen es nicht.
          'deduped', true
        );
      end if;
    end if;

    select t.* into v_row_task
    from public.workspace_tasks t
    where t.workspace_id = p_workspace_id and t.client_task_id = v_task_id
    for update;
    v_current_version := v_row_task.row_version;

    /*
     * 01G — Version 0 gegen eine vorhandene Aufgabe. Der Dedupe-Zweig oben ist
     * davon unberuehrt: Er beantwortet den fachlichen Wiederholungsfall zweier
     * Geraete und kommt vor dieser Pruefung.
     */
    if v_current_version is not null and p_row_version <= 0 then
      if v_row_task.deleted and not v_deleted then
        raise exception 'Versionskonflikt task:%', v_current_version using errcode = 'P0001';
      end if;
      -- 01G2 -- derselbe Loeschvorgang, siehe Notiz-Zweig.
      if v_row_task.deleted and v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_task_id,
          'row_version', v_row_task.row_version,
          'payload', to_jsonb(v_row_task),
          'deleted', true,
          'replayed', true
        );
      end if;
      if v_row_task.payload = v_task_payload
         and v_row_task.deleted = v_deleted
         and v_row_task.status = v_task_status then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_task_id,
          'row_version', v_row_task.row_version,
          'payload', to_jsonb(v_row_task),
          'deleted', v_row_task.deleted,
          'replayed', true
        );
      end if;
      raise exception 'Versionskonflikt task:%', v_current_version using errcode = 'P0001';
    end if;

    if v_current_version is null then
      insert into public.workspace_tasks (
        workspace_id,
        client_task_id,
        status,
        dedupe_key,
        auto_created,
        payload,
        row_version,
        deleted,
        deleted_at,
        created_by,
        updated_by
      )
      values (
        p_workspace_id,
        v_task_id,
        v_task_status,
        v_task_dedupe,
        v_task_auto,
        case when v_deleted then '{}'::jsonb else v_task_payload end,
        1,
        v_deleted,
        case when v_deleted then now() else null end,
        auth.uid(),
        auth.uid()
      )
      returning to_jsonb(public.workspace_tasks.*) into v_result;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt task:%', v_current_version using errcode = 'P0001';
      end if;

      update public.workspace_tasks
      set
        payload = case when v_deleted then payload else coalesce(v_task_payload, payload) end,
        status = v_task_status,
        dedupe_key = v_task_dedupe,
        auto_created = v_task_auto,
        deleted = v_deleted,
        deleted_at = case when v_deleted then coalesce(deleted_at, now()) else null end,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id and client_task_id = v_task_id
      returning to_jsonb(public.workspace_tasks.*) into v_result;
    end if;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_task_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result,
      'deleted', (v_result->>'deleted')::boolean
    );

  elsif p_entity_type = 'dunning_documentation' then
    /*
     * CLOUD-DURABILITY-CORE-01D -- Nachweis einer uebergebenen
     * Zahlungserinnerung oder Mahnung.
     *
     * Berechtigung wie bei Notizen und Aufgaben und aus demselben Grund: Das
     * Produkt kennt fuer das Dokumentieren keinerlei Rollenpruefung -- weder in
     * `DunningDocumentationPanel` noch in `dunningDocumentationService`. Jedes
     * aktive Mitglied darf es heute, und `can_write_workspace` (Inhaber/Admin)
     * wuerde genau diese Mitglieder beim ersten Push aussperren.
     *
     * SELECT: jedes aktive Mitglied (Policy unten).
     * CREATE und Wiederholung: jedes aktive Mitglied
     * (`workspace_user_can_intake`), ausschliesslich ueber diese RPC.
     *
     * **Append-only.** Es gibt kein Bearbeiten und kein Loeschen; entsprechend
     * kennt dieser Zweig keinen Update-Pfad und die Tabelle keine
     * Grabsteinspalten. Ein erneuter Push derselben Kennung ist ein Replay und
     * gibt die vorhandene Zeile unveraendert zurueck -- der Nachweis bleibt
     * genau so stehen, wie er festgehalten wurde.
     */
    if not public.workspace_user_can_intake(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_dun_id := coalesce(nullif(trim(p_payload->>'documentation_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_dun_id is null then
      raise exception 'documentation_id fehlt';
    end if;

    v_dun_payload := coalesce(p_payload->'payload', '{}'::jsonb);
    v_dun_invoice_id := coalesce(nullif(trim(p_payload->>'invoice_id'), ''), nullif(trim(v_dun_payload->>'invoiceId'), ''));
    v_dun_vorgang_id := nullif(trim(coalesce(p_payload->>'vorgang_id', v_dun_payload->>'vorgangId', '')), '');
    v_dun_kind := coalesce(nullif(trim(p_payload->>'kind'), ''), nullif(trim(v_dun_payload->>'kind'), ''));
    v_dun_delivery := coalesce(nullif(trim(p_payload->>'delivery_method'), ''), nullif(trim(v_dun_payload->>'deliveryMethod'), ''));

    -- Guards: nur Sync-Struktur und die Identitaetsfelder, keine Fachlogik.
    if v_dun_invoice_id is null then
      raise exception 'invoice_id fehlt';
    end if;
    if v_dun_kind is null or v_dun_kind not in ('payment_reminder', 'dunning_notice') then
      raise exception 'Mahnnachweis ungueltig: kind' using errcode = 'P0001';
    end if;
    if v_dun_delivery is null then
      raise exception 'Mahnnachweis ungueltig: delivery_method' using errcode = 'P0001';
    end if;
    begin
      v_dun_documented_at := (coalesce(nullif(trim(p_payload->>'documented_at'), ''), v_dun_payload->>'documentedAt'))::date;
    exception when others then
      raise exception 'Mahnnachweis ungueltig: documented_at' using errcode = 'P0001';
    end;
    if v_dun_documented_at is null then
      raise exception 'Mahnnachweis ungueltig: documented_at' using errcode = 'P0001';
    end if;

    /*
     * Wiederholung derselben Kennung: unveraendert zurueckgeben.
     *
     * Ein Nachweis wird nicht fortgeschrieben. Ein zweiter Push entsteht durch
     * einen wiederholten Sendeversuch oder einen Backfill, nicht durch eine
     * Aenderung -- und darf den festgehaltenen Inhalt niemals ueberschreiben.
     */
    select d.* into v_dun_existing
    from public.workspace_invoice_dunning_documentations d
    where d.workspace_id = p_workspace_id and d.client_documentation_id = v_dun_id
    for update;

    if found then
      return jsonb_build_object(
        'entity_type', p_entity_type,
        'entity_id', v_dun_existing.client_documentation_id,
        'row_version', v_dun_existing.row_version,
        'payload', to_jsonb(v_dun_existing),
        'deleted', false
      );
    end if;

    /*
     * Fachliche Identitaet aus dem Produkt: `documentDunningDelivery` weist
     * eine zweite Bestaetigung derselben Uebergabe ab -- gleiche Rechnung,
     * gleicher Auftragsbezug, gleiche Art, gleiches Datum, gleicher Weg -- und
     * meldet `alreadyDocumented`. Zwei Geraete, die offline dasselbe
     * festhalten, senden zwei Kennungen fuer denselben Vorgang; der zweite
     * Push ist deshalb ein fachliches Replay und bekommt die vorhandene Zeile
     * zurueck. Die Notiz gehoert bewusst nicht zur Identitaet -- lokal war sie
     * es nie.
     */
    select d.* into v_dun_existing
    from public.workspace_invoice_dunning_documentations d
    where d.workspace_id = p_workspace_id
      and d.client_invoice_id = v_dun_invoice_id
      and coalesce(d.client_vorgang_id, '') = coalesce(v_dun_vorgang_id, '')
      and d.kind = v_dun_kind
      and d.documented_at = v_dun_documented_at
      and d.delivery_method = v_dun_delivery
    order by d.created_at, d.client_documentation_id
    limit 1
    for update;

    if found then
      return jsonb_build_object(
        'entity_type', p_entity_type,
        'entity_id', v_dun_existing.client_documentation_id,
        'requested_entity_id', v_dun_id,
        'row_version', v_dun_existing.row_version,
        'payload', to_jsonb(v_dun_existing),
        'deleted', false,
        'deduped', true
      );
    end if;

    insert into public.workspace_invoice_dunning_documentations (
      workspace_id,
      client_documentation_id,
      client_invoice_id,
      client_vorgang_id,
      kind,
      documented_at,
      delivery_method,
      payload,
      row_version,
      created_by,
      updated_by
    )
    values (
      p_workspace_id,
      v_dun_id,
      v_dun_invoice_id,
      v_dun_vorgang_id,
      v_dun_kind,
      v_dun_documented_at,
      v_dun_delivery,
      v_dun_payload,
      1,
      auth.uid(),
      auth.uid()
    )
    returning to_jsonb(public.workspace_invoice_dunning_documentations.*) into v_result;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_dun_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result,
      'deleted', false
    );

  elsif p_entity_type = 'workspace' then
    if not public.can_write_workspace(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    select w.version into v_current_version from public.workspaces w where w.id = p_workspace_id for update;
    if v_current_version is null then
      raise exception 'Workspace nicht gefunden';
    end if;
    if p_row_version > 0 and p_row_version <> v_current_version then
      raise exception 'Versionskonflikt workspace:%', v_current_version using errcode = 'P0001';
    end if;

    update public.workspaces
    set
      name = coalesce(nullif(trim(p_payload->>'name'), ''), name),
      version = version + 1
    where id = p_workspace_id
    returning to_jsonb(public.workspaces.*) into v_result;

    return jsonb_build_object('entity_type', p_entity_type, 'row_version', (v_result->>'version')::bigint, 'payload', v_result);

  elsif p_entity_type = 'workspace_settings' then
    if not public.can_write_workspace(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    select ws.version into v_current_version from public.workspace_settings ws where ws.workspace_id = p_workspace_id for update;
    if v_current_version is null then
      insert into public.workspace_settings (workspace_id, settings, version, updated_by)
      values (p_workspace_id, coalesce(p_payload->'settings', '{}'::jsonb), 1, auth.uid())
      returning to_jsonb(public.workspace_settings.*) into v_result;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt workspace_settings:%', v_current_version using errcode = 'P0001';
      end if;
      update public.workspace_settings
      set
        settings = coalesce(p_payload->'settings', settings),
        version = version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id
      returning to_jsonb(public.workspace_settings.*) into v_result;
    end if;

    return jsonb_build_object('entity_type', p_entity_type, 'row_version', (v_result->>'version')::bigint, 'payload', v_result);

  elsif p_entity_type = 'company_setup' then
    if not public.can_write_workspace(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    select s.row_version into v_current_version from public.workspace_setup s where s.workspace_id = p_workspace_id for update;
    if v_current_version is null then
      insert into public.workspace_setup (workspace_id, payload, setup_version, row_version, updated_by)
      values (
        p_workspace_id,
        coalesce(p_payload->'payload', p_payload, '{}'::jsonb),
        coalesce((p_payload->>'setup_version')::integer, 1),
        1,
        auth.uid()
      )
      returning to_jsonb(public.workspace_setup.*) into v_result;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt company_setup:%', v_current_version using errcode = 'P0001';
      end if;
      update public.workspace_setup
      set
        payload = coalesce(p_payload->'payload', p_payload, payload),
        setup_version = coalesce((p_payload->>'setup_version')::integer, setup_version),
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id
      returning to_jsonb(public.workspace_setup.*) into v_result;
    end if;

    return jsonb_build_object('entity_type', p_entity_type, 'row_version', (v_result->>'row_version')::bigint, 'payload', v_result);

  elsif p_entity_type = 'company_profile' then
    if not public.can_write_workspace(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    select cp.row_version, cp.payload into v_current_version, v_existing_profile
    from public.workspace_company_profiles cp
    where cp.workspace_id = p_workspace_id
    for update;

    /*
     * 01B3 -- profile_schema_version: fehlend = 0 (Altclient); sonst nur
     * plausible, bekannte Werte 0..2. Ein hoeherer oder negativer Wert koennte
     * die Preserve-/Loeschsemantik aushebeln und wird abgewiesen.
     */
    if p_payload ? 'profile_schema_version'
       and (jsonb_typeof(p_payload->'profile_schema_version') <> 'number'
            or (p_payload->>'profile_schema_version') !~ ('^[0-9]{1,3}' || chr(36))
            or (p_payload->>'profile_schema_version')::integer > 2) then
      raise exception 'Firmenprofil ungueltig: profile_schema_version' using errcode = 'P0001';
    end if;
    v_incoming_schema := coalesce(nullif(p_payload->>'profile_schema_version', '')::integer, 0);

    if v_current_version is null then
      v_incoming_profile := coalesce(p_payload->'payload', p_payload, '{}'::jsonb);
      if jsonb_typeof(v_incoming_profile) = 'object' and v_incoming_schema >= 2 then
        -- explizites null eines wissenden Clients = nicht gesetzt
        for v_field in select * from (values ('defaultTaxStatus'), ('currency'), ('replyToEmail'), ('senderDisplayName')) as catalog(key) loop
          if jsonb_typeof(v_incoming_profile -> v_field.key) = 'null' then
            v_incoming_profile := v_incoming_profile - v_field.key;
          end if;
        end loop;
      end if;
      perform public.validate_workspace_company_profile_payload(v_incoming_profile);
      insert into public.workspace_company_profiles (workspace_id, payload, row_version, updated_by)
      values (p_workspace_id, v_incoming_profile, 1, auth.uid())
      returning to_jsonb(public.workspace_company_profiles.*) into v_result;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt company_profile:%', v_current_version using errcode = 'P0001';
      end if;

      v_incoming_profile := coalesce(p_payload->'payload', p_payload, v_existing_profile);

      if jsonb_typeof(v_incoming_profile) = 'object' then
        /*
         * PRODUCT-BASIS-FIRMENPROFIL-01B -- schema-versionierter Altclient-Schutz.
         *
         * Der Katalog nennt jedes Profilfeld, das nach der ersten Ganzdokument-
         * Fassung eingefuehrt wurde, mit der Schema-Version seiner Einfuehrung.
         * Ein Client sendet seine Schema-Version mit (fehlend = 0, alle Clients
         * vor 01B). Regel je Feld:
         *
         *   Client-Version <  Einfuehrungsversion und Feld fehlt im Payload
         *     -> der Client kennt das Feld nachweislich nicht: bestehenden Wert bewahren
         *   Client-Version >= Einfuehrungsversion
         *     -> der Client kennt das Feld: fehlend oder null = bewusstes Loeschen
         *
         * Kein Deep-Merge, kein pauschales Konservieren: Alles, was nicht im
         * Katalog steht, wird weiterhin vollstaendig ersetzt. Ein neues Feld
         * braucht genau einen Eintrag hier und eine erhoehte Version im Client.
         */
        for v_field in
          select * from (values
            ('defaultTaxStatus', 2),
            ('currency', 2),
            ('replyToEmail', 2),
            ('senderDisplayName', 2)
          ) as catalog(key, introduced_in)
        loop
          if v_incoming_schema < v_field.introduced_in
             and not (v_incoming_profile ? v_field.key)
             and (v_existing_profile ? v_field.key) then
            v_incoming_profile := jsonb_set(
              v_incoming_profile,
              array[v_field.key],
              v_existing_profile -> v_field.key,
              true
            );
          elsif v_incoming_schema >= v_field.introduced_in
             and jsonb_typeof(v_incoming_profile -> v_field.key) = 'null' then
            -- explizites null eines wissenden Clients = Loeschen: Schluessel entfernen
            v_incoming_profile := v_incoming_profile - v_field.key;
          end if;
        end loop;

        /*
         * BRANDING-01E-0 -- Altclient-Schutz fuer `branding` bleibt unveraendert
         * (Asset-Referenz ist unveraenderlich; null ist kein Loeschsignal):
         * uebernommen wird nur ein echtes JSON-Objekt, sonst wird ein
         * vorhandenes Branding bewahrt. Kein Deep-Merge.
         */
        if jsonb_typeof(v_incoming_profile->'branding') is distinct from 'object'
           and jsonb_typeof(v_existing_profile->'branding') = 'object' then
          v_incoming_profile := jsonb_set(
            v_incoming_profile,
            '{branding}',
            v_existing_profile->'branding',
            true
          );
        end if;
      end if;

      /*
       * 01B3 -- Validierung des **endgueltigen** Dokuments (nach Preserve und
       * Loeschsemantik): Ein ungueltiger Wert bricht den Write atomar ab, der
       * bestehende Stand bleibt unveraendert (kein Teilupdate).
       */
      perform public.validate_workspace_company_profile_payload(v_incoming_profile);

      update public.workspace_company_profiles
      set
        payload = v_incoming_profile,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id
      returning to_jsonb(public.workspace_company_profiles.*) into v_result;
    end if;

    return jsonb_build_object('entity_type', p_entity_type, 'row_version', (v_result->>'row_version')::bigint, 'payload', v_result);

  elsif p_entity_type = 'bank_account' then
    /*
     * BANKABGLEICH-V1 BLOCK 2B -- das Konto, unter dem Kontoauszuege liegen.
     *
     * Berechtigung wie bei Vorgangsnotizen und Aufgaben und aus demselben
     * Grund: Ein Konto entsteht heute beilaeufig beim ersten Import, ohne
     * jede Rollenpruefung. `can_write_workspace` (Inhaber/Admin) wuerde
     * genau die Mitglieder aussperren, die den Auszug einlesen, und ihre
     * Konten dauerhaft in der Outbox halten.
     *
     * Kein Banking: kein Zugang, kein Saldo, kein Anbieter. Nur die stabile
     * Identitaet, unter der Bewegungen aufbewahrt werden.
     */
    if not public.workspace_user_can_intake(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_bank_account_id := coalesce(nullif(trim(p_payload->>'account_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_bank_account_id is null then
      raise exception 'account_id fehlt';
    end if;

    v_bank_account_payload := coalesce(p_payload->'payload', '{}'::jsonb);
    v_deleted := coalesce((p_payload->>'deleted')::boolean, false);

    /*
     * Loeschen ist in Block 2B fachlich nicht vorgesehen -- weder die
     * Oberflaeche noch der Store bieten es an. Ein Grabstein kann hier also
     * nur aus einem Fehler stammen, und ein Konto mit Bewegungen darf wegen
     * `on delete restrict` ohnehin nicht verschwinden. Lieber laut ablehnen
     * als still eine Loeschsemantik erfinden, die niemand entworfen hat.
     */
    if v_deleted then
      raise exception 'Bankkonten koennen nicht geloescht werden' using errcode = 'P0001';
    end if;

    /* Der Anzeigename ist Pflicht, die Kontokennung ausdruecklich nicht. */
    if jsonb_typeof(v_bank_account_payload->'displayName') <> 'string'
      or length(trim(v_bank_account_payload->>'displayName')) = 0 then
      raise exception 'Bankkonto ungueltig: displayName' using errcode = 'P0001';
    end if;
    if length(v_bank_account_payload->>'displayName') > 200 then
      raise exception 'Bankkonto ungueltig: displayName zu lang' using errcode = 'P0001';
    end if;

    select a.* into v_row_bank_account
    from public.workspace_bank_accounts a
    where a.workspace_id = p_workspace_id and a.client_account_id = v_bank_account_id
    for update;
    v_current_version := v_row_bank_account.row_version;

    /* CREATE-RETRY-CONFLICT-02: `0` heisst "diese Zeile darf noch nicht existieren". */
    if v_current_version is not null and p_row_version <= 0 then
      if v_row_bank_account.payload = v_bank_account_payload then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_bank_account_id,
          'row_version', v_row_bank_account.row_version,
          'payload', to_jsonb(v_row_bank_account),
          'deleted', false,
          'replayed', true
        );
      end if;
      raise exception 'Versionskonflikt bank_account:%', v_current_version using errcode = 'P0001';
    end if;

    if v_current_version is null then
      insert into public.workspace_bank_accounts (
        workspace_id,
        client_account_id,
        display_name,
        identifier,
        payload,
        row_version,
        created_by,
        updated_by
      )
      values (
        p_workspace_id,
        v_bank_account_id,
        trim(v_bank_account_payload->>'displayName'),
        coalesce(nullif(trim(v_bank_account_payload->>'identifier'), ''), ''),
        v_bank_account_payload,
        1,
        auth.uid(),
        auth.uid()
      )
      returning to_jsonb(public.workspace_bank_accounts.*) into v_result;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt bank_account:%', v_current_version using errcode = 'P0001';
      end if;

      /*
       * Umbenennen ist ein Update derselben Zeile, keine neue.
       * `client_account_id` bleibt unberuehrt -- sie ist die Identitaet, an
       * der die Entdopplung der Bewegungen haengt.
       */
      update public.workspace_bank_accounts
      set
        display_name = trim(v_bank_account_payload->>'displayName'),
        identifier = coalesce(nullif(trim(v_bank_account_payload->>'identifier'), ''), identifier),
        payload = v_bank_account_payload,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id and client_account_id = v_bank_account_id
      returning to_jsonb(public.workspace_bank_accounts.*) into v_result;
    end if;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_bank_account_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result,
      'deleted', false
    );

  elsif p_entity_type = 'bank_transaction' then
    /*
     * BANKABGLEICH-V1 BLOCK 2B -- eine importierte Bankbewegung.
     *
     * Sie ist ein **Nachweis**, keine Zahlung: kein invoice_id, kein
     * expense_id, kein payment_id, kein Abgleichstatus. Dieser Zweig ruft
     * keine Zahlungsfunktion auf und beruehrt keinen Zahlungsstatus.
     */
    if not public.workspace_user_can_intake(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_bank_transaction_id := coalesce(nullif(trim(p_payload->>'transaction_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_bank_transaction_id is null then
      raise exception 'transaction_id fehlt';
    end if;

    v_bank_transaction_payload := coalesce(p_payload->'payload', '{}'::jsonb);
    v_deleted := coalesce((p_payload->>'deleted')::boolean, false);

    /* Wie beim Konto: Block 2B kennt kein Loeschen von Bankbewegungen. */
    if v_deleted then
      raise exception 'Bankbewegungen koennen nicht geloescht werden' using errcode = 'P0001';
    end if;

    /* Die Felder, an denen die Entdopplung haengt, muessen dastehen. */
    if coalesce(nullif(trim(v_bank_transaction_payload->>'accountKey'), ''), '') = '' then
      raise exception 'Bankbewegung ungueltig: accountKey' using errcode = 'P0001';
    end if;
    if coalesce(nullif(trim(v_bank_transaction_payload->>'fingerprint'), ''), '') = '' then
      raise exception 'Bankbewegung ungueltig: fingerprint' using errcode = 'P0001';
    end if;
    if jsonb_typeof(v_bank_transaction_payload->'amountCents') <> 'number'
      or (v_bank_transaction_payload->>'amountCents')::bigint = 0 then
      raise exception 'Bankbewegung ungueltig: amountCents' using errcode = 'P0001';
    end if;
    if coalesce((v_bank_transaction_payload->>'occurrence')::integer, 0) < 1 then
      raise exception 'Bankbewegung ungueltig: occurrence' using errcode = 'P0001';
    end if;

    /*
     * Das Konto muss serverseitig existieren, **bevor** seine Bewegung
     * geschrieben wird. Bewusst eine eigene, sprechende Pruefung statt der
     * rohen Fremdschluesselmeldung: Der Client soll erkennen koennen, dass
     * nur die Reihenfolge stimmen muss -- und es wird hier ausdruecklich
     * **kein** Konto angelegt. Das Konto ist eine eigene Entitaet mit
     * eigenem Push.
     */
    if not exists (
      select 1 from public.workspace_bank_accounts a
      where a.workspace_id = p_workspace_id
        and a.client_account_id = trim(v_bank_transaction_payload->>'accountKey')
    ) then
      raise exception 'Bankkonto fehlt: %', trim(v_bank_transaction_payload->>'accountKey') using errcode = 'P0001';
    end if;

    select t.* into v_row_bank_transaction
    from public.workspace_bank_transactions t
    where t.workspace_id = p_workspace_id and t.client_transaction_id = v_bank_transaction_id
    for update;
    v_current_version := v_row_bank_transaction.row_version;

    if v_current_version is not null and p_row_version <= 0 then
      if v_row_bank_transaction.payload = v_bank_transaction_payload then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_bank_transaction_id,
          'row_version', v_row_bank_transaction.row_version,
          'payload', to_jsonb(v_row_bank_transaction),
          'deleted', false,
          'replayed', true
        );
      end if;
      raise exception 'Versionskonflikt bank_transaction:%', v_current_version using errcode = 'P0001';
    end if;

    if v_current_version is null then
      insert into public.workspace_bank_transactions (
        workspace_id,
        client_transaction_id,
        account_key,
        import_id,
        file_name,
        imported_at,
        booking_date,
        value_date,
        amount_cents,
        currency,
        counterparty,
        counterparty_iban,
        purpose,
        bank_reference,
        fingerprint,
        occurrence,
        payload,
        row_version,
        created_by,
        updated_by
      )
      values (
        p_workspace_id,
        v_bank_transaction_id,
        trim(v_bank_transaction_payload->>'accountKey'),
        coalesce(nullif(trim(v_bank_transaction_payload->>'importId'), ''), ''),
        coalesce(nullif(trim(v_bank_transaction_payload->>'fileName'), ''), ''),
        coalesce((v_bank_transaction_payload->>'importedAt')::timestamptz, now()),
        (v_bank_transaction_payload->>'bookingDate')::date,
        nullif(trim(coalesce(v_bank_transaction_payload->>'valueDate', '')), '')::date,
        (v_bank_transaction_payload->>'amountCents')::bigint,
        nullif(trim(coalesce(v_bank_transaction_payload->>'currency', '')), ''),
        nullif(trim(coalesce(v_bank_transaction_payload->>'counterparty', '')), ''),
        nullif(trim(coalesce(v_bank_transaction_payload->>'counterpartyIban', '')), ''),
        nullif(trim(coalesce(v_bank_transaction_payload->>'purpose', '')), ''),
        nullif(trim(coalesce(v_bank_transaction_payload->>'bankReference', '')), ''),
        trim(v_bank_transaction_payload->>'fingerprint'),
        (v_bank_transaction_payload->>'occurrence')::integer,
        v_bank_transaction_payload,
        1,
        auth.uid(),
        auth.uid()
      )
      returning to_jsonb(public.workspace_bank_transactions.*) into v_result;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt bank_transaction:%', v_current_version using errcode = 'P0001';
      end if;

      /*
       * Eine Bankbewegung ist ein Nachweis und aendert sich fachlich nicht.
       * Der Update-Pfad existiert fuer den Wiederanlauf eines nicht
       * bestaetigten Pushes -- nicht, um einen Kontoauszug umzuschreiben.
       * Kontoschluessel, Fingerabdruck und laufende Nummer bleiben deshalb
       * bewusst stehen: Sie sind die Identitaet, an der die Entdopplung
       * haengt.
       */
      update public.workspace_bank_transactions
      set
        payload = v_bank_transaction_payload,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id and client_transaction_id = v_bank_transaction_id
      returning to_jsonb(public.workspace_bank_transactions.*) into v_result;
    end if;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_bank_transaction_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result,
      'deleted', false
    );

  elsif p_entity_type = 'paper_register_entry' then
    /*
     * CLOUD-SYNC S1 -- der Papierablage-Haken eines Dokuments.
     *
     * Rechte wie beim Dokument, zu dem der Eintrag gehoert (Kopfkommentar
     * der Migration): anlegen jedes aktive Mitglied, aendern nur
     * Inhaber/Admin oder wer die Zeile angelegt hat, Grabstein nur
     * Inhaber/Admin.
     *
     * Serverseitig wird nur die Sync-Struktur geprueft, keine Fachlogik:
     * Eintrag-ID, Dokumentbezug, Ordnerangaben, der Haken als Wahrheitswert
     * und eine vertretbare Groesse.
     */
    if not public.workspace_user_can_intake(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_paper_entry_id := coalesce(nullif(trim(p_payload->>'entry_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_paper_entry_id is null then
      raise exception 'entry_id fehlt';
    end if;

    v_paper_payload := coalesce(p_payload->'payload', '{}'::jsonb);
    v_paper_document_id := coalesce(
      nullif(trim(p_payload->>'document_id'), ''),
      nullif(trim(v_paper_payload->>'documentId'), '')
    );
    v_deleted := coalesce((p_payload->>'deleted')::boolean, false);

    -- Wie beim Dokument selbst: Grabsteine setzen nur Inhaber und Admin.
    if v_deleted and not public.can_write_workspace(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    -- Der Dokumentbezug darf nur am Grabstein fehlen.
    if v_paper_document_id is null and not v_deleted then
      raise exception 'document_id fehlt';
    end if;

    /*
     * coalesce um jsonb_typeof: Fehlt ein Feld, liefert jsonb_typeof NULL,
     * und ein Vergleich mit NULL waere nie wahr -- die Pruefung liefe ins
     * Leere.
     */
    if not v_deleted then
      if coalesce(jsonb_typeof(v_paper_payload->'physicalFiled'), '') <> 'boolean' then
        raise exception 'Papierablage ungueltig: physicalFiled' using errcode = 'P0001';
      end if;
      if coalesce(jsonb_typeof(v_paper_payload->'folderId'), '') <> 'string'
        or coalesce(jsonb_typeof(v_paper_payload->'register'), '') <> 'string' then
        raise exception 'Papierablage ungueltig: Ordner' using errcode = 'P0001';
      end if;
      if length(v_paper_payload::text) > 20000 then
        raise exception 'Papierablage ungueltig: zu gross' using errcode = 'P0001';
      end if;
    end if;

    select e.* into v_row_paper
    from public.workspace_paper_register_entries e
    where e.workspace_id = p_workspace_id and e.client_entry_id = v_paper_entry_id
    for update;
    v_current_version := v_row_paper.row_version;

    if v_current_version is not null then
      /*
       * Eine fremde Zeile aendern nur Inhaber und Admin -- dieselbe Regel wie
       * am Dokument. Sie steht vor dem Replay, damit auch eine Wiederholung
       * keine Zeile zurueckgibt, die der Aufrufer nicht lesen darf.
       */
      if not public.can_write_workspace(p_workspace_id)
        and v_row_paper.created_by is distinct from auth.uid() then
        raise exception 'Keine Schreibberechtigung';
      end if;
      -- Ein Eintrag wechselt nie sein Dokument.
      if v_paper_document_id is not null
        and v_row_paper.client_document_id is not null
        and v_row_paper.client_document_id <> v_paper_document_id then
        raise exception 'Papierablage ungueltig: document_id' using errcode = 'P0001';
      end if;
    end if;

    /*
     * 01G/01G2 -- unbestaetigte Version bei vorhandener Zeile, wortgleich zu
     * den Vorgangsnotizen: identischer Inhalt ist eine Wiederholung, beide
     * Seiten geloescht ebenfalls, alles andere ist ein Konflikt.
     */
    if v_current_version is not null and p_row_version <= 0 then
      if v_row_paper.deleted and not v_deleted then
        raise exception 'Versionskonflikt paper_register_entry:%', v_current_version using errcode = 'P0001';
      end if;
      if v_row_paper.deleted and v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_paper_entry_id,
          'row_version', v_row_paper.row_version,
          'payload', to_jsonb(v_row_paper),
          'deleted', true,
          'replayed', true
        );
      end if;
      if v_row_paper.payload = v_paper_payload and v_row_paper.deleted = v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_paper_entry_id,
          'row_version', v_row_paper.row_version,
          'payload', to_jsonb(v_row_paper),
          'deleted', v_row_paper.deleted,
          'replayed', true
        );
      end if;
      raise exception 'Versionskonflikt paper_register_entry:%', v_current_version using errcode = 'P0001';
    end if;

    if v_current_version is null then
      insert into public.workspace_paper_register_entries (
        workspace_id,
        client_entry_id,
        client_document_id,
        payload,
        row_version,
        deleted,
        deleted_at,
        created_by,
        updated_by
      )
      values (
        p_workspace_id,
        v_paper_entry_id,
        v_paper_document_id,
        case when v_deleted then '{}'::jsonb else v_paper_payload end,
        1,
        v_deleted,
        case when v_deleted then now() else null end,
        auth.uid(),
        auth.uid()
      )
      returning to_jsonb(public.workspace_paper_register_entries.*) into v_result;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt paper_register_entry:%', v_current_version using errcode = 'P0001';
      end if;

      /*
       * Kein Wiederbeleben: Der Grabstein gehoert zu einem geloeschten
       * Dokument. Auch mit passender Version wird er nicht wieder aktiv.
       */
      if v_row_paper.deleted and not v_deleted then
        raise exception 'Versionskonflikt paper_register_entry:%', v_current_version using errcode = 'P0001';
      end if;

      /*
       * Grabstein: Der Fachinhalt bleibt stehen, ebenso der Dokumentbezug --
       * er ist die Ordnung, ueber die ein zweites Geraet den Grabstein
       * zuordnet.
       */
      update public.workspace_paper_register_entries
      set
        payload = case when v_deleted then payload else coalesce(v_paper_payload, payload) end,
        client_document_id = coalesce(client_document_id, v_paper_document_id),
        deleted = v_deleted,
        deleted_at = case when v_deleted then coalesce(deleted_at, now()) else null end,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id and client_entry_id = v_paper_entry_id
      returning to_jsonb(public.workspace_paper_register_entries.*) into v_result;
    end if;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_paper_entry_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result,
      'deleted', (v_result->>'deleted')::boolean
    );

  elsif p_entity_type = 'communication_event' then
    /*
     * CLOUD-SYNC S2 -- ein Ereignis im Kommunikationsverlauf.
     *
     * Append-only wie der Mahnnachweis: Es gibt keinen Update-Pfad und kein
     * Loeschen. Eine vorhandene Kennung wird unveraendert zurueckgegeben --
     * das Ereignis bleibt genau so stehen, wie es festgehalten wurde.
     * `p_row_version` spielt hier deshalb keine Rolle.
     *
     * Serverseitig wird nur die Sync-Struktur geprueft, keine Fachlogik:
     * Kennung, Kontextart, Ereignisart, Ereigniszeit und eine vertretbare
     * Groesse. Art und Kontext werden als Form geprueft, nicht gegen eine
     * feste Liste -- sie tragen keine Serverlogik.
     */
    if not public.workspace_user_can_intake(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_comm_event_id := coalesce(nullif(trim(p_payload->>'event_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_comm_event_id is null then
      raise exception 'event_id fehlt';
    end if;

    -- Loeschen gibt es fuer Kommunikationsereignisse nicht. Laut statt erfunden.
    if coalesce((p_payload->>'deleted')::boolean, false) then
      raise exception 'Kommunikationsereignisse koennen nicht geloescht werden' using errcode = 'P0001';
    end if;

    v_comm_payload := coalesce(p_payload->'payload', '{}'::jsonb);
    v_comm_context := coalesce(v_comm_payload->'contextRef', '{}'::jsonb);
    v_comm_context_type := coalesce(nullif(trim(p_payload->>'context_type'), ''), nullif(trim(v_comm_context->>'type'), ''));
    v_comm_event_type := coalesce(nullif(trim(p_payload->>'event_type'), ''), nullif(trim(v_comm_payload->>'type'), ''));

    if v_comm_context_type is null or v_comm_context_type !~ '^[a-z_]{1,40}$' then
      raise exception 'Kommunikationsereignis ungueltig: contextRef' using errcode = 'P0001';
    end if;
    if v_comm_event_type is null or v_comm_event_type !~ '^[a-z_]{1,60}$' then
      raise exception 'Kommunikationsereignis ungueltig: type' using errcode = 'P0001';
    end if;
    begin
      v_comm_event_at := coalesce(nullif(trim(p_payload->>'event_at'), ''), v_comm_payload->>'timestamp')::timestamptz;
    exception when others then
      raise exception 'Kommunikationsereignis ungueltig: timestamp' using errcode = 'P0001';
    end;
    if v_comm_event_at is null then
      raise exception 'Kommunikationsereignis ungueltig: timestamp' using errcode = 'P0001';
    end if;
    if length(v_comm_payload::text) > 20000 then
      raise exception 'Kommunikationsereignis ungueltig: zu gross' using errcode = 'P0001';
    end if;

    select e.* into v_row_comm
    from public.workspace_communication_events e
    where e.workspace_id = p_workspace_id and e.client_event_id = v_comm_event_id
    for update;

    if found then
      /*
       * Wiederholung derselben Kennung. Eine fremde Zeile bekommen nur Inhaber
       * und Admin zurueck -- sonst laese ein Mitglied ueber ein Replay, was es
       * im Abzug nicht sehen darf.
       */
      if not public.can_write_workspace(p_workspace_id)
        and v_row_comm.created_by is distinct from auth.uid() then
        raise exception 'Keine Schreibberechtigung';
      end if;
      return jsonb_build_object(
        'entity_type', p_entity_type,
        'entity_id', v_row_comm.client_event_id,
        'row_version', v_row_comm.row_version,
        'payload', to_jsonb(v_row_comm),
        'deleted', false,
        'replayed', true
      );
    end if;

    insert into public.workspace_communication_events (
      workspace_id,
      client_event_id,
      context_type,
      context_id,
      context_vorgang_id,
      event_type,
      event_at,
      payload,
      row_version,
      created_by,
      updated_by
    )
    values (
      p_workspace_id,
      v_comm_event_id,
      v_comm_context_type,
      coalesce(nullif(trim(p_payload->>'context_id'), ''), nullif(trim(v_comm_context->>'id'), '')),
      coalesce(nullif(trim(p_payload->>'context_vorgang_id'), ''), nullif(trim(v_comm_context->>'vorgangId'), '')),
      v_comm_event_type,
      v_comm_event_at,
      v_comm_payload,
      1,
      auth.uid(),
      auth.uid()
    )
    returning to_jsonb(public.workspace_communication_events.*) into v_result;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_comm_event_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result,
      'deleted', false
    );

  elsif p_entity_type = 'knowledge_fact' then
    /*
     * CLOUD-SYNC S3 -- ein bestaetigter Wissenseintrag.
     *
     * Rechte wie bei den Vorgangsnotizen: Das Produkt kennt fuer das Anlegen,
     * Aendern und Loeschen von Wissen keine Rollenpruefung; jedes aktive
     * Mitglied darf es (`workspace_user_can_intake`), ausschliesslich ueber
     * diese RPC.
     *
     * Serverseitig wird nur die Sync-Struktur geprueft, keine Fachlogik:
     * Kennung, Scope als Form, Schluessel, Wert, Anzeigetext, das
     * Aktiv-Kennzeichen als Wahrheitswert und eine vertretbare Groesse.
     */
    if not public.workspace_user_can_intake(p_workspace_id) then
      raise exception 'Keine Schreibberechtigung';
    end if;

    v_fact_id := coalesce(nullif(trim(p_payload->>'fact_id'), ''), nullif(trim(p_payload->>'id'), ''));
    if v_fact_id is null then
      raise exception 'fact_id fehlt';
    end if;

    v_fact_payload := coalesce(p_payload->'payload', '{}'::jsonb);
    v_fact_scope := coalesce(nullif(trim(p_payload->>'scope'), ''), nullif(trim(v_fact_payload->>'scope'), ''));
    v_deleted := coalesce((p_payload->>'deleted')::boolean, false);

    if not v_deleted then
      if v_fact_scope is null or v_fact_scope !~ '^[a-z_]{1,40}$' then
        raise exception 'Wissen ungueltig: scope' using errcode = 'P0001';
      end if;
      if coalesce(jsonb_typeof(v_fact_payload->'key'), '') <> 'string' or length(trim(v_fact_payload->>'key')) = 0 then
        raise exception 'Wissen ungueltig: key' using errcode = 'P0001';
      end if;
      if coalesce(jsonb_typeof(v_fact_payload->'value'), '') <> 'string' or length(trim(v_fact_payload->>'value')) = 0 then
        raise exception 'Wissen ungueltig: value' using errcode = 'P0001';
      end if;
      if coalesce(jsonb_typeof(v_fact_payload->'displayText'), '') <> 'string'
        or length(trim(v_fact_payload->>'displayText')) = 0 then
        raise exception 'Wissen ungueltig: displayText' using errcode = 'P0001';
      end if;
      if coalesce(jsonb_typeof(v_fact_payload->'active'), '') <> 'boolean' then
        raise exception 'Wissen ungueltig: active' using errcode = 'P0001';
      end if;
      if length(v_fact_payload::text) > 20000 then
        raise exception 'Wissen ungueltig: zu gross' using errcode = 'P0001';
      end if;
    end if;

    select f.* into v_row_fact
    from public.workspace_knowledge_facts f
    where f.workspace_id = p_workspace_id and f.client_fact_id = v_fact_id
    for update;
    v_current_version := v_row_fact.row_version;

    /*
     * 01G/01G2 -- unbestaetigte Version bei vorhandener Zeile, wortgleich zu
     * den Vorgangsnotizen: identischer Inhalt ist eine Wiederholung, beide
     * Seiten geloescht ebenfalls, alles andere ist ein Konflikt.
     */
    if v_current_version is not null and p_row_version <= 0 then
      if v_row_fact.deleted and not v_deleted then
        raise exception 'Versionskonflikt knowledge_fact:%', v_current_version using errcode = 'P0001';
      end if;
      if v_row_fact.deleted and v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_fact_id,
          'row_version', v_row_fact.row_version,
          'payload', to_jsonb(v_row_fact),
          'deleted', true,
          'replayed', true
        );
      end if;
      if v_row_fact.payload = v_fact_payload and v_row_fact.deleted = v_deleted then
        return jsonb_build_object(
          'entity_type', p_entity_type,
          'entity_id', v_fact_id,
          'row_version', v_row_fact.row_version,
          'payload', to_jsonb(v_row_fact),
          'deleted', v_row_fact.deleted,
          'replayed', true
        );
      end if;
      raise exception 'Versionskonflikt knowledge_fact:%', v_current_version using errcode = 'P0001';
    end if;

    if v_current_version is null then
      insert into public.workspace_knowledge_facts (
        workspace_id,
        client_fact_id,
        scope,
        scope_id,
        category,
        active,
        payload,
        row_version,
        deleted,
        deleted_at,
        created_by,
        updated_by
      )
      values (
        p_workspace_id,
        v_fact_id,
        v_fact_scope,
        nullif(trim(v_fact_payload->>'scopeId'), ''),
        nullif(trim(v_fact_payload->>'category'), ''),
        case when v_deleted then false else coalesce((v_fact_payload->>'active')::boolean, true) end,
        case when v_deleted then '{}'::jsonb else v_fact_payload end,
        1,
        v_deleted,
        case when v_deleted then now() else null end,
        auth.uid(),
        auth.uid()
      )
      returning to_jsonb(public.workspace_knowledge_facts.*) into v_result;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt knowledge_fact:%', v_current_version using errcode = 'P0001';
      end if;

      /*
       * Kein Wiederbeleben: Das Produkt kennt kein Wiederherstellen eines
       * geloeschten Eintrags -- ein neuer Eintrag bekommt eine neue Kennung.
       */
      if v_row_fact.deleted and not v_deleted then
        raise exception 'Versionskonflikt knowledge_fact:%', v_current_version using errcode = 'P0001';
      end if;

      /* Grabstein: der Fachinhalt bleibt als Nachweis stehen. */
      update public.workspace_knowledge_facts
      set
        payload = case when v_deleted then payload else coalesce(v_fact_payload, payload) end,
        scope = case when v_deleted then scope else coalesce(v_fact_scope, scope) end,
        scope_id = case when v_deleted then scope_id else nullif(trim(v_fact_payload->>'scopeId'), '') end,
        category = case when v_deleted then category else coalesce(nullif(trim(v_fact_payload->>'category'), ''), category) end,
        active = case when v_deleted then false else coalesce((v_fact_payload->>'active')::boolean, active) end,
        deleted = v_deleted,
        deleted_at = case when v_deleted then coalesce(deleted_at, now()) else null end,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id and client_fact_id = v_fact_id
      returning to_jsonb(public.workspace_knowledge_facts.*) into v_result;
    end if;

    return jsonb_build_object(
      'entity_type', p_entity_type,
      'entity_id', v_fact_id,
      'row_version', (v_result->>'row_version')::bigint,
      'payload', v_result,
      'deleted', (v_result->>'deleted')::boolean
    );

  else
    raise exception 'Unbekannter Entity-Typ: %', p_entity_type;
  end if;
end;
$$;

/* -------------------------------------------------------------------------- */
/* 3. Pull: dieselbe Sammelfunktion, ein Schluessel mehr                       */
/* -------------------------------------------------------------------------- */

/*
 * Woertlich die geltende Fassung aus 20261031120000, dazu `knowledge_facts`.
 */
create or replace function public.pull_workspace_sync_state(p_workspace_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settings public.workspace_settings;
  v_setup public.workspace_setup;
  v_profile public.workspace_company_profiles;
  v_workspace public.workspaces;
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet';
  end if;

  if not public.is_active_workspace_member(p_workspace_id) then
    raise exception 'Kein Zugriff auf Workspace';
  end if;

  select * into v_workspace from public.workspaces w where w.id = p_workspace_id;
  select * into v_settings from public.workspace_settings ws where ws.workspace_id = p_workspace_id;
  select * into v_setup from public.workspace_setup s where s.workspace_id = p_workspace_id;
  select * into v_profile from public.workspace_company_profiles cp where cp.workspace_id = p_workspace_id;

  return jsonb_build_object(
    'workspace', to_jsonb(v_workspace),
    'members', coalesce(
      (select jsonb_agg(to_jsonb(wm)) from public.workspace_members wm where wm.workspace_id = p_workspace_id and wm.status = 'active'),
      '[]'::jsonb
    ),
    'settings', to_jsonb(v_settings),
    'setup', to_jsonb(v_setup),
    'company_profile', to_jsonb(v_profile),
    'vorgaenge', coalesce(
      (select jsonb_agg(to_jsonb(v)) from public.workspace_vorgaenge v where v.workspace_id = p_workspace_id),
      '[]'::jsonb
    ),
    /*
     * Ausdruecklich OHNE `deleted = false`. Der spaetere Backfill vergleicht
     * lokale Kunden-IDs gegen alle remote bekannten IDs; eine geloeschte ID
     * muss dabei als vorhanden gelten, sonst laedt ein zweites Geraet den
     * geloeschten Kunden wieder hoch. Der Vorgangs-Pull filtert aus demselben
     * Grund nicht.
     */
    'customers', coalesce(
      (select jsonb_agg(to_jsonb(c)) from public.workspace_customers c where c.workspace_id = p_workspace_id),
      '[]'::jsonb
    ),
    /*
     * Ebenfalls ausdruecklich OHNE `deleted = false`: Grabsteine muessen das
     * zweite Geraet erreichen, sonst taucht eine dort geloeschte Notiz wieder
     * auf, und der Backfill wuerde sie erneut hochladen.
     */
    'vorgang_notes', coalesce(
      (select jsonb_agg(to_jsonb(n)) from public.workspace_vorgang_notes n where n.workspace_id = p_workspace_id),
      '[]'::jsonb
    ),
    /*
     * CLOUD-DURABILITY-CORE-01C -- ebenfalls ohne `deleted = false`.
     * Ein Grabstein entsteht hier auch durch die Dedupe-Aufloesung; er muss
     * das zweite Geraet erreichen, sonst bliebe die unterlegene Aufgabe dort
     * sichtbar und der Backfill luede sie erneut hoch.
     */
    'tasks', coalesce(
      (select jsonb_agg(to_jsonb(t)) from public.workspace_tasks t where t.workspace_id = p_workspace_id),
      '[]'::jsonb
    ),
    /*
     * CLOUD-DURABILITY-CORE-01D -- Mahnnachweise. Kein Grabsteinfilter noetig:
     * Die Entitaet ist append-only, es gibt weder Loeschen noch Bearbeiten.
     */
    'dunning_documentations', coalesce(
      (select jsonb_agg(to_jsonb(d)) from public.workspace_invoice_dunning_documentations d
        where d.workspace_id = p_workspace_id),
      '[]'::jsonb
    ),
    /*
     * BRIEFE-01B -- Geschaeftsschreiben. Ebenfalls ohne `deleted = false`:
     * Grabsteine muessen das zweite Geraet erreichen, sonst taucht ein dort
     * geloeschter Brief wieder auf und der Altbestand luede ihn erneut hoch.
     */
    'business_letters', coalesce(
      (select jsonb_agg(to_jsonb(bl)) from public.workspace_business_letters bl
        where bl.workspace_id = p_workspace_id),
      '[]'::jsonb
    ),
    /*
     * ANGEBOT-01B -- eigene Angebote, ebenfalls inklusive Grabsteine.
     */
    'offers', coalesce(
      (select jsonb_agg(to_jsonb(o)) from public.workspace_offers o
        where o.workspace_id = p_workspace_id),
      '[]'::jsonb
    ),
    /*
     * BANKABGLEICH-V1 BLOCK 2B -- Importkonten und Bankbewegungen.
     *
     * Beide reisen im selben Abzug mit wie jede andere Workspace-Entitaet.
     * Kein zweiter Pull-Pfad, keine Bank-Sonderfunktion.
     *
     * Grabsteine gibt es fuer Bankdaten nicht -- Block 2B bietet kein
     * Loeschen an, und beide Push-Zweige weisen es ausdruecklich ab. Die
     * Zeilen kommen deshalb vollstaendig und ohne Filter.
     */
    'bank_accounts', coalesce(
      (select jsonb_agg(to_jsonb(ba)) from public.workspace_bank_accounts ba
        where ba.workspace_id = p_workspace_id),
      '[]'::jsonb
    ),
    'bank_transactions', coalesce(
      (select jsonb_agg(to_jsonb(bt)) from public.workspace_bank_transactions bt
        where bt.workspace_id = p_workspace_id),
      '[]'::jsonb
    ),
    /*
     * BANKABGLEICH-V1 BLOCK 4 — bestaetigte Zuordnungen.
     *
     * Nur Pull: Eine Zuordnung entsteht ausschliesslich in
     * `confirm_workspace_bank_reconciliation` und niemals durch einen
     * Client-Push. Deshalb gibt es fuer sie bewusst **keinen** Zweig im
     * Upsert-Dispatcher — ein Geraet soll eine Geldwirkung nicht
     * hochladen koennen, sondern nur erfahren.
     */
    'bank_reconciliations', coalesce(
      (select jsonb_agg(to_jsonb(br)) from public.workspace_bank_reconciliations br
        where br.workspace_id = p_workspace_id and br.deleted = false),
      '[]'::jsonb
    ),
    /*
     * CLOUD-SYNC S1 -- Papierablage-Haken.
     *
     * Ausdruecklich OHNE `deleted = false`: Grabsteine muessen das zweite
     * Geraet erreichen, sonst bliebe dort der Haken eines geloeschten
     * Dokuments stehen, und der Altbestand luede ihn erneut hoch.
     *
     * Sichtbarkeit wie beim Dokument (siehe Kopfkommentar): Inhaber/Admin
     * alles, Mitglieder die selbst angelegten Zeilen.
     */
    'paper_register_entries', coalesce(
      (select jsonb_agg(to_jsonb(pr)) from public.workspace_paper_register_entries pr
        where pr.workspace_id = p_workspace_id
          and (public.can_write_workspace(p_workspace_id) or pr.created_by = auth.uid())),
      '[]'::jsonb
    ),
    /*
     * CLOUD-SYNC S2 -- Kommunikationsverlauf, nach Ereigniszeit geordnet.
     *
     * Sichtbarkeit wie bei Dokumenten und Eingang (siehe Kopfkommentar):
     * Inhaber/Admin alles, Mitglieder die selbst angelegten Ereignisse.
     */
    'communication_events', coalesce(
      (select jsonb_agg(to_jsonb(ce) order by ce.event_at, ce.client_event_id)
         from public.workspace_communication_events ce
        where ce.workspace_id = p_workspace_id
          and (public.can_write_workspace(p_workspace_id) or ce.created_by = auth.uid())),
      '[]'::jsonb
    ),
    /*
     * CLOUD-SYNC S3 -- bestaetigtes Wissen.
     *
     * Ausdruecklich OHNE `deleted = false`: Grabsteine muessen das zweite
     * Geraet erreichen, sonst bliebe dort ein geloeschter Eintrag stehen, und
     * der Altbestand luede ihn erneut hoch. Sichtbar fuer jedes aktive
     * Mitglied -- wie die Vorgangsnotizen (siehe Kopfkommentar).
     */
    'knowledge_facts', coalesce(
      (select jsonb_agg(to_jsonb(kf)) from public.workspace_knowledge_facts kf
        where kf.workspace_id = p_workspace_id),
      '[]'::jsonb
    )
  );
end;
$$;

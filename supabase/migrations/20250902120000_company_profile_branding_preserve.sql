-- BRANDING-01E-0 -- Altclient-Schutz fuer das Feld `branding` im company_profile.
--
-- Ausgangslage: Der company_profile-Zweig ersetzt den Payload vollstaendig
-- (`payload = coalesce(p_payload->'payload', p_payload, payload)`), und der
-- Client sendet stets sein gesamtes Profil. Sobald ein neuer Client ein Feld
-- `branding` speichert, wuerde der naechste Schreibvorgang eines Clients, der
-- dieses Feld nicht kennt, es stillschweigend loeschen.
--
-- Der row_version-Guard hilft dagegen nicht: Der alte Client schreibt mit
-- gueltiger aktueller Version, sein Vorgang ist regulaer. Es entstuende kein
-- Konflikt und keine Meldung -- der Verlust waere unsichtbar. Betroffen sind
-- nicht nur alte Bundles, sondern auch ein noch geoeffneter Tab, der die Seite
-- vor dem Deployment geladen hat.
--
-- Diese Migration fuegt deshalb genau eine Regel hinzu, ausschliesslich fuer
-- den Schluessel `branding`:
--
--   fehlt                       -> bestehendes branding bewahren
--   "branding": {}              -> uebernehmen (bewusst geleert)
--   "branding": { ... }         -> uebernehmen
--   "branding": null            -> bewahren (kein Loeschsignal)
--   falscher Typ (Text, Zahl,
--   Array, Boolean)             -> bewahren (fail safe)
--   serverseitig kein branding  -> nichts erfinden
--
-- Uebernommen wird also nur, was ein JSON-Objekt ist. Die Regel ist bewusst
-- asymmetrisch zugunsten der Bewahrung: Ein faelschlich bewahrtes Branding
-- kann der Nutzer korrigieren, ein faelschlich geloeschtes ist verloren.
--
-- AUSDRUECKLICH NICHT eingefuehrt wird ein allgemeines Deep-Merge oder eine
-- Regel "unbekannte Felder immer bewahren". Alle uebrigen Felder des
-- CompanyProfile behalten ihre vollstaendige Replace-Semantik. Deshalb ist es
-- wichtig, dass `branding` ein abgegrenzter Unterblock bleibt und nicht als
-- flache Einzelfelder umgesetzt wird.
--
-- Unveraendert bleiben: Signatur, row_version-Guard, row_version-Inkrement,
-- updated_by, Rueckgabevertrag, INSERT-Zweig (dort gibt es nichts zu bewahren)
-- und alle uebrigen sechs Entity-Zweige. Sie werden hier nur mitgefuehrt, weil
-- `create or replace` die gesamte Funktion ersetzt.
--
-- Keine neue Tabelle, keine Spalte, keine Datenmigration, keine Grants, keine
-- RLS-Aenderung, keine zusaetzliche Clientberechtigung, kein zweiter RPC.
--
-- Die Preserve-Pruefung arbeitet auf dem **inneren** Profil-Payload, also auf
-- `p_payload->'payload'` beziehungsweise dem Fallback `p_payload` -- nicht auf
-- dem aeusseren Umschlag, den der Client sendet.

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
  v_deleted boolean;
  -- BRANDING-01E-0: nur fuer den company_profile-Zweig.
  v_existing_profile jsonb;
  v_incoming_profile jsonb;
begin
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

    select v.row_version into v_current_version
    from public.workspace_vorgaenge v
    where v.workspace_id = p_workspace_id and v.vorgang_id = v_vorgang_id
    for update;

    if v_current_version is null then
      insert into public.workspace_vorgaenge (
        workspace_id,
        vorgang_id,
        payload,
        row_version,
        deleted,
        deleted_at,
        updated_by
      )
      values (
        p_workspace_id,
        v_vorgang_id,
        coalesce(p_payload->'payload', p_payload, '{}'::jsonb),
        1,
        v_deleted,
        case when v_deleted then now() else null end,
        auth.uid()
      )
      returning to_jsonb(public.workspace_vorgaenge.*) into v_result;
    else
      -- CREATE-RETRY-CONFLICT-02: `0` ist jetzt die Erwartung "Zeile fehlt".
      if p_row_version <> v_current_version then
        raise exception 'Versionskonflikt vorgang:%', v_current_version using errcode = 'P0001';
      end if;

      update public.workspace_vorgaenge
      set
        payload = case when v_deleted then payload else coalesce(p_payload->'payload', p_payload, payload) end,
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

    select c.row_version into v_current_version
    from public.workspace_customers c
    where c.workspace_id = p_workspace_id and c.customer_id = v_customer_id
    for update;

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

    if v_current_version is null then
      insert into public.workspace_company_profiles (workspace_id, payload, row_version, updated_by)
      values (p_workspace_id, coalesce(p_payload->'payload', p_payload, '{}'::jsonb), 1, auth.uid())
      returning to_jsonb(public.workspace_company_profiles.*) into v_result;
    else
      if p_row_version > 0 and p_row_version <> v_current_version then
        raise exception 'Versionskonflikt company_profile:%', v_current_version using errcode = 'P0001';
      end if;

      v_incoming_profile := coalesce(p_payload->'payload', p_payload, v_existing_profile);

      /*
       * BRANDING-01E-0 -- Altclient-Schutz, ausschliesslich fuer `branding`.
       *
       * Uebernommen wird nur ein echtes JSON-Objekt. `jsonb_typeof` liefert
       * fuer einen fehlenden Schluessel NULL, fuer `"branding": null` den Wert
       * 'null' -- beides ist damit von `{}` unterscheidbar, das als 'object'
       * gilt und regulaer uebernommen wird.
       *
       * Bewahrt wird nur, wenn serverseitig tatsaechlich ein Branding-Objekt
       * vorliegt. Sonst entsteht kein kuenstliches Feld.
       *
       * Kein Deep-Merge: Alle uebrigen Felder werden weiterhin vollstaendig
       * ersetzt.
       */
      if jsonb_typeof(v_incoming_profile) = 'object'
         and jsonb_typeof(v_incoming_profile->'branding') is distinct from 'object'
         and jsonb_typeof(v_existing_profile->'branding') = 'object' then
        v_incoming_profile := jsonb_set(
          v_incoming_profile,
          '{branding}',
          v_existing_profile->'branding',
          true
        );
      end if;

      update public.workspace_company_profiles
      set
        payload = v_incoming_profile,
        row_version = row_version + 1,
        updated_by = auth.uid()
      where workspace_id = p_workspace_id
      returning to_jsonb(public.workspace_company_profiles.*) into v_result;
    end if;

    return jsonb_build_object('entity_type', p_entity_type, 'row_version', (v_result->>'row_version')::bigint, 'payload', v_result);

  else
    raise exception 'Unbekannter Entity-Typ: %', p_entity_type;
  end if;
end;
$$;

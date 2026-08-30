-- SECURITY-GEMINI-KEY-01B -- Nutzungszaehlung fuer den KI-Endpunkt.
--
-- Zweck ist ausschliesslich Missbrauchsschutz: Ein uebernommenes Konto, eine
-- Endlosschleife oder ein Bedienfehler sollen keine tausend Gemini-Aufrufe
-- ausloesen koennen. Kein Billing, kein Kosten-Metering -- das kommt spaeter
-- und braucht dann eigene Felder.
--
-- Gespeichert werden ausschliesslich technische Zaehldaten:
--   wer (user_id), wo (workspace_id), was fuer eine Operation, welches
--   Zeitfenster, wie oft.
--
-- Ausdruecklich NICHT gespeichert: Prompts, Antworten, Dokumenttexte, Namen,
-- Adressen, Betraege, Schluessel. Die Tabelle enthaelt keine Geschaeftsdaten.
--
-- Edge Functions sind zustandslos und skalieren; ein Zaehler im Speicher der
-- Instanz waere wirkungslos. Deshalb hier persistent -- und deshalb atomar:
-- Ein "erst lesen, dann schreiben" liesse zwei gleichzeitige Anfragen dasselbe
-- Limit passieren.

create table if not exists public.ai_usage_counters (
  user_id uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  operation text not null,
  -- Beginn des Zeitfensters; 'short' rollt in Sekunden, 'day' pro Kalendertag.
  window_kind text not null,
  window_start timestamptz not null,
  request_count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, workspace_id, operation, window_kind, window_start),
  constraint ai_usage_counters_window_kind_check check (window_kind in ('short', 'day')),
  constraint ai_usage_counters_count_check check (request_count >= 0)
);

-- Fuer das Aufraeumen alter Fenster und fuer Auswertungen nach Zeitraum.
create index if not exists ai_usage_counters_window_start_idx
  on public.ai_usage_counters (window_start);

-- ---------------------------------------------------------------------------
-- Rechte
-- ---------------------------------------------------------------------------
--
-- Kein angemeldeter Client darf diese Tabelle lesen, schreiben oder gar seinen
-- eigenen Zaehler zuruecksetzen. Zugriff hat ausschliesslich die Edge Function
-- ueber den Service-Role-Schluessel, und zwar nur ueber die Funktion unten.
--
-- RLS ist aktiviert und es gibt bewusst KEINE Policy: Unter RLS ist damit fuer
-- authenticated und anon alles verboten. Der Service-Role-Zugriff umgeht RLS
-- ohnehin.

alter table public.ai_usage_counters enable row level security;

revoke all on public.ai_usage_counters from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Atomare Pruefung und Zaehlung
-- ---------------------------------------------------------------------------
--
-- Liefert true, wenn die Anfrage erlaubt ist -- und hat dann bereits gezaehlt.
-- Liefert false, wenn eines der beiden Fenster erschoepft ist; dann wird nicht
-- gezaehlt, damit ein abgewiesener Versuch das Fenster nicht weiter belastet.
--
-- Die Atomizitaet entsteht durch `insert ... on conflict do update ... returning`:
-- Postgres serialisiert konkurrierende Upserts auf denselben Primaerschluessel,
-- der zurueckgegebene Zaehlerstand ist also eindeutig. Erst danach wird gegen
-- das Limit geprueft, und bei Ueberschreitung wird die Erhoehung wieder
-- zurueckgenommen.
--
-- SECURITY DEFINER ist hier nicht noetig: Aufgerufen wird ausschliesslich mit
-- dem Service-Role-Schluessel, der ohnehin volle Rechte hat. Kein GRANT an
-- authenticated -- ein Client soll diese Funktion nicht aufrufen koennen.

create or replace function public.ai_usage_check_and_count(
  p_user_id uuid,
  p_workspace_id uuid,
  p_operation text,
  p_short_window_seconds integer,
  p_short_limit integer,
  p_daily_limit integer
)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_short_start timestamptz;
  v_day_start timestamptz;
  v_short_count integer;
  v_day_count integer;
begin
  if p_short_window_seconds <= 0 or p_short_limit <= 0 or p_daily_limit <= 0 then
    raise exception 'ai_usage: ungueltige Limitkonfiguration';
  end if;

  -- Rollendes Kurzfenster, auf volle Fensterlaengen gerastert.
  v_short_start := to_timestamp(
    floor(extract(epoch from v_now) / p_short_window_seconds) * p_short_window_seconds
  );
  v_day_start := date_trunc('day', v_now);

  insert into public.ai_usage_counters (
    user_id, workspace_id, operation, window_kind, window_start, request_count, updated_at
  )
  values (p_user_id, p_workspace_id, p_operation, 'short', v_short_start, 1, v_now)
  on conflict (user_id, workspace_id, operation, window_kind, window_start)
  do update set request_count = public.ai_usage_counters.request_count + 1, updated_at = v_now
  returning request_count into v_short_count;

  insert into public.ai_usage_counters (
    user_id, workspace_id, operation, window_kind, window_start, request_count, updated_at
  )
  values (p_user_id, p_workspace_id, p_operation, 'day', v_day_start, 1, v_now)
  on conflict (user_id, workspace_id, operation, window_kind, window_start)
  do update set request_count = public.ai_usage_counters.request_count + 1, updated_at = v_now
  returning request_count into v_day_count;

  if v_short_count > p_short_limit or v_day_count > p_daily_limit then
    -- Abgewiesene Versuche zaehlen nicht mit, sonst verlaengerte ein
    -- wiederholender Client seine eigene Sperre unbegrenzt.
    update public.ai_usage_counters
    set request_count = greatest(0, request_count - 1)
    where user_id = p_user_id
      and workspace_id = p_workspace_id
      and operation = p_operation
      and ((window_kind = 'short' and window_start = v_short_start)
        or (window_kind = 'day' and window_start = v_day_start));
    return false;
  end if;

  return true;
end;
$$;

revoke all on function public.ai_usage_check_and_count(uuid, uuid, text, integer, integer, integer)
  from public, anon, authenticated;

-- Ausdrueckliche Freigabe fuer die Edge Function.
--
-- PostgreSQL erteilt neuen Funktionen EXECUTE an PUBLIC; der Widerruf oben
-- nimmt das zurueck. Ob service_role das Recht danach ueber Rollenattribute
-- behaelt, steht in keiner Migration dieses Projekts -- ohne diesen GRANT
-- waere der Aufruf aus der Function moeglicherweise nicht ausfuehrbar. Die
-- Funktion faengt das zwar fail closed ab (server_misconfigured), waere dann
-- aber vollstaendig unbenutzbar.
--
-- Der GRANT ist auch dann harmlos, wenn die Rolle das Recht ohnehin haette.
grant execute on function public.ai_usage_check_and_count(uuid, uuid, text, integer, integer, integer)
  to service_role;

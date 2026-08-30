-- SECURITY-GEMINI-KEY-01B -- Rate-Limit-Funktion als SECURITY DEFINER.
--
-- Remote bestaetigter Befund:
--
--   service_role EXECUTE ai_usage_check_and_count = true
--   service_role SELECT/INSERT/UPDATE/DELETE ai_usage_counters = false
--   ai_usage_check_and_count SECURITY DEFINER = false
--
-- Die Edge Function darf die Funktion also aufrufen, aber die Funktion lief
-- als SECURITY INVOKER -- also mit den Rechten von service_role, und die hat
-- auf die Zaehltabelle keine. Im Log erschien `rate_check_failed`, die
-- Function antwortete fail closed mit `server_misconfigured`.
--
-- Zwei Wege waeren moeglich gewesen:
--
--   a) service_role direkte SELECT/INSERT/UPDATE-Rechte auf die Tabelle geben
--   b) die Funktion als SECURITY DEFINER ausfuehren
--
-- Gewaehlt ist (b). Bei (a) haette der Zaehler von aussen direkt manipulierbar
-- werden koennen, sobald irgendwo sonst mit dem Service-Role-Schluessel
-- gearbeitet wird. Bei (b) bleibt die Tabelle vollstaendig geschlossen und
-- ausschliesslich ueber diese eine, eng begrenzte Funktion erreichbar.
--
-- Eignungspruefung der bestehenden Funktion vor dieser Aenderung:
--   * kein dynamisches SQL (kein EXECUTE, kein format(), keine Konkatenation)
--   * Zugriff ausschliesslich auf public.ai_usage_counters
--   * alle Parameter werden gebunden, nie als SQL-Text zusammengesetzt
--   * search_path bereits explizit auf public gesetzt
--   * ruft nur eingebaute Funktionen (now, to_timestamp, date_trunc, greatest)
--   * EXECUTE ist PUBLIC, anon und authenticated bereits entzogen
--
-- Geaendert wird ausschliesslich das Sicherheitsattribut -- per ALTER, damit
-- der Funktionsrumpf nicht dupliziert wird und Logik, Parameter, Rueckgabe und
-- Grenzwerte nachweislich unveraendert bleiben.
--
-- Die bereits angewendeten Migrationen 20250901120000 und 20250901123000
-- bleiben unberuehrt. Keine neuen Tabellenrechte, keine Policy.

alter function public.ai_usage_check_and_count(
  uuid, uuid, text, integer, integer, integer
) security definer;

-- Ausdruecklich erneut gesetzt: Bei SECURITY DEFINER ist ein fester
-- search_path Pflicht, damit die Funktion nicht ueber einen manipulierten
-- Suchpfad auf fremde Objekte gelenkt werden kann.
alter function public.ai_usage_check_and_count(
  uuid, uuid, text, integer, integer, integer
) set search_path = public;

-- Der Rechtevertrag bleibt, wie er ist -- hier nur zur Sicherheit erneut
-- festgeschrieben, weil eine SECURITY-DEFINER-Funktion mit EXECUTE an PUBLIC
-- gefaehrlich waere.
revoke all on function public.ai_usage_check_and_count(uuid, uuid, text, integer, integer, integer)
  from public, anon, authenticated;

grant execute on function public.ai_usage_check_and_count(uuid, uuid, text, integer, integer, integer)
  to service_role;

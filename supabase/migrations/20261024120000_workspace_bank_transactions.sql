/*
 * BANKABGLEICH-V1 BLOCK 2 — importierte Bankbewegungen als Nachweis.
 *
 * NOCH NICHT REMOTE AUSGEROLLT. Diese Datei beschreibt das Schema zur
 * Freigabe; der Client speichert Bankbewegungen in Block 2 zunaechst
 * ausschliesslich im workspace-bezogenen lokalen Zustand (`PersistedState`,
 * `storageScopeService`). Die Cloud-Anbindung folgt erst, wenn diese
 * Migration freigegeben und ausgefuehrt ist — vorher waere ein Push gegen
 * eine nicht existierende Tabelle ein stiller Dauerfehler.
 *
 * WAS HIER BEWUSST FEHLT
 *
 * Es gibt keine `invoice_id`, keine `expense_id`, keine `payment_id`, keinen
 * Abgleichstatus und keine Konfidenz. Eine Bankbewegung ist ein **Nachweis**
 * dessen, was auf dem Konto geschah — nicht die Zahlung selbst, nicht der
 * Zahlungsstatus und keine Buchung im steuerlichen Sinn. Die Verbindung zu
 * Rechnungen und Ausgaben entsteht in einem spaeteren Block in einer eigenen
 * Tabelle. Eine heute leere Spalte wuerde dagegen behaupten, hier werde
 * bereits abgeglichen.
 *
 * Es gibt ebenso **keine Zahlungs-RPC** und keine Aenderung an einer
 * bestehenden. Ein Kontoauszugimport darf keinen Zahlungsstatus beruehren.
 *
 * DIE EINDEUTIGKEIT
 *
 * `unique (workspace_id, account_key, fingerprint, occurrence)`.
 *
 * Der Fingerabdruck fasst den normalisierten Fachinhalt zusammen: Konto,
 * Buchungstag, Betrag in Cent, Gegenpartei, Verwendungszweck und — als
 * zusaetzliches Unterscheidungsmerkmal, nicht als alleiniger Schluessel — die
 * Bankreferenz. Eine Referenzspalte allein waere gefaehrlich: Manche Banken
 * schreiben dort eine Mandatsreferenz, die sich bei jeder Lastschrift
 * desselben Vertrags wiederholt; als alleiniger Schluessel wuerde sie
 * verschiedene Bewegungen verschmelzen und echtes Geld verschlucken.
 *
 * `occurrence` ist der Grund, warum zwei **echte** gleiche Abbuchungen am
 * selben Tag beide erhalten bleiben: Die erste ist 1, die zweite ist 2. Beim
 * erneuten Import derselben Datei sind beide bereits belegt, und es entsteht
 * keine dritte.
 *
 * `account_key` steht im Schluessel, damit dieselbe Bewegung auf einem
 * **zweiten** Bankkonto nicht faelschlich als dieselbe gilt.
 *
 * BLOCK 2B hat die offene Frage aus Block 2 geschlossen: Der Schluessel ist
 * nie leer und ist die **stabile Kontokennung** aus `workspace_bank_accounts`
 * — nicht der Anzeigename und nicht die IBAN aus der Datei. Nennt die Datei
 * ein Konto (Spalte „Auftragskonto"), wird es automatisch zugeordnet; nennt
 * sie keines, waehlt der Nutzer vor der Uebernahme eines. Der Fremdschluessel
 * erzwingt das auch serverseitig, und ein Umbenennen des Kontos laesst die
 * Entdopplung unberuehrt.
 */

/* -------------------------------------------------------------------------- */
/* Die Konten, unter denen Auszuege aufbewahrt werden                          */
/* -------------------------------------------------------------------------- */

/*
 * BLOCK 2B — kein Bankkonto im Banking-Sinn: kein Zugang, kein Saldo, kein
 * Anbieter. Nur die stabile Identitaet, unter der Auszuege liegen.
 *
 * `client_account_id` ist die Kennung aus dem Client und zugleich das, was
 * in jeder Bankbewegung steht. `display_name` ist frei aenderbar und geht
 * **nicht** in eine Eindeutigkeit ein — sonst erzeugte ein Umbenennen beim
 * naechsten Import lauter Dubletten.
 *
 * `identifier` ist die normalisierte Kontokennung aus der Datei
 * (Spalte „Auftragskonto“) oder leer. Eindeutig ist sie nur, **wenn** sie
 * gesetzt ist: Mehrere Konten ohne Kennung muessen nebeneinander bestehen
 * duerfen, weil der Nutzer sie von Hand unterscheidet.
 */
create table if not exists public.workspace_bank_accounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  client_account_id text not null,
  display_name text not null,
  identifier text not null default '',
  created_at timestamptz not null default now(),
  created_by uuid null references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  row_version bigint not null default 1,
  deleted_at timestamptz null,
  constraint workspace_bank_accounts_name_check check (length(btrim(display_name)) > 0),
  constraint workspace_bank_accounts_client_id_unique
    unique (workspace_id, client_account_id)
);

/* Nur eine gesetzte Kennung ist eindeutig — leere Kennungen koexistieren. */
create unique index if not exists workspace_bank_accounts_identifier_unique
  on public.workspace_bank_accounts (workspace_id, identifier)
  where identifier <> '';

drop trigger if exists workspace_bank_accounts_set_updated_at on public.workspace_bank_accounts;
create trigger workspace_bank_accounts_set_updated_at
before update on public.workspace_bank_accounts
for each row execute function public.set_workspace_updated_at();

alter table public.workspace_bank_accounts enable row level security;

drop policy if exists workspace_bank_accounts_select_writer on public.workspace_bank_accounts;
create policy workspace_bank_accounts_select_writer
on public.workspace_bank_accounts for select to authenticated
using (public.can_write_workspace(workspace_id));

revoke all on public.workspace_bank_accounts from public, anon;
grant select on public.workspace_bank_accounts to authenticated;

/* -------------------------------------------------------------------------- */
/* Die Bewegungen                                                              */
/* -------------------------------------------------------------------------- */

create table if not exists public.workspace_bank_transactions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  /* Die Kennung aus dem Client; sie traegt die Idempotenz eines Retries. */
  client_transaction_id text not null,

  /* Herkunft. */
  /*
   * Die stabile Kontokennung aus workspace_bank_accounts. Kein Default:
   * Eine Bewegung ohne Konto darf es nicht geben.
   */
  account_key text not null,
  import_id text not null,
  file_name text not null,
  imported_at timestamptz not null,

  /* Fachinhalt. */
  booking_date date not null,
  value_date date null,
  amount_cents bigint not null,
  currency text null,
  counterparty text null,
  counterparty_iban text null,
  purpose text null,
  bank_reference text null,

  /* Eindeutigkeit. */
  fingerprint text not null,
  occurrence integer not null,

  created_at timestamptz not null default now(),
  created_by uuid null references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  row_version bigint not null default 1,

  /*
   * Ein Betrag von genau 0 ist keine Bewegung. Negativ ist Abgang, positiv
   * ist Eingang — die Richtung steckt im Vorzeichen und wird bewusst nicht
   * zusaetzlich gespeichert, damit sie dem Betrag nicht widersprechen kann.
   */
  constraint workspace_bank_transactions_amount_check check (amount_cents <> 0),
  constraint workspace_bank_transactions_occurrence_check check (occurrence >= 1),
  constraint workspace_bank_transactions_account_check check (length(account_key) > 0),
  /* Serverseitig erzwungen: das Konto muss im selben Betrieb existieren. */
  constraint workspace_bank_transactions_account_fk
    foreign key (workspace_id, account_key)
    references public.workspace_bank_accounts (workspace_id, client_account_id)
    on delete restrict,
  constraint workspace_bank_transactions_client_id_unique
    unique (workspace_id, client_transaction_id),
  constraint workspace_bank_transactions_dedupe_unique
    unique (workspace_id, account_key, fingerprint, occurrence)
);

/* Die Liste wird fast immer nach Konto und Buchungstag gelesen. */
create index if not exists workspace_bank_transactions_booking_idx
  on public.workspace_bank_transactions (workspace_id, account_key, booking_date desc);

/* Der Dublettenabgleich eines Imports schlaegt ueber den Fingerabdruck nach. */
create index if not exists workspace_bank_transactions_fingerprint_idx
  on public.workspace_bank_transactions (workspace_id, account_key, fingerprint);

drop trigger if exists workspace_bank_transactions_set_updated_at on public.workspace_bank_transactions;
create trigger workspace_bank_transactions_set_updated_at
before update on public.workspace_bank_transactions
for each row execute function public.set_workspace_updated_at();

/*
 * RLS wie bei den Ausgaben: Lesen nur, wer im Betrieb schreiben darf.
 * Bankbewegungen nennen Gegenparteien und Betraege des Betriebs; sie sind
 * nicht weniger vertraulich als eine Eingangsrechnung.
 */
alter table public.workspace_bank_transactions enable row level security;

drop policy if exists workspace_bank_transactions_select_writer on public.workspace_bank_transactions;
create policy workspace_bank_transactions_select_writer
on public.workspace_bank_transactions for select to authenticated
using (public.can_write_workspace(workspace_id));

revoke all on public.workspace_bank_transactions from public, anon;
grant select on public.workspace_bank_transactions to authenticated;

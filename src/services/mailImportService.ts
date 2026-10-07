/**
 * CLOUD-SYNC S7 — Altbestand des früheren manuellen Mailimports (MAIL-01).
 *
 * Der manuelle Sonderweg „E-Mails importieren" ist aus dem Produkt genommen.
 * Mails kommen über das verbundene Postfach (kanonische Mailentität
 * `workspace_email_messages`), Dateien und Mail-Anhänge über den normalen
 * Eingangs-Upload. Neue MailImport-Datensätze entstehen nicht mehr.
 *
 * Geblieben ist nur das Laden, Halten und Speichern eines vorhandenen lokalen
 * Altbestands: Alte Persistenzstände und Backups werden unverändert geladen und
 * wieder geschrieben. Der Bestand ist keine eigene Geschäftswahrheit mehr — kein
 * aktiver Produktcode liest ihn (Suche, Kommunikation, Lebenszyklus), und er
 * reist nie in die Cloud (`mail_import` bleibt nur-lokal und wird nicht mehr
 * verfolgt). Ein Aufräumen alter lokaler Volltexte ist eine eigene
 * Datenschutzentscheidung.
 */
import type { MailImport } from '../types/mailImport';
import { getAllMailImportsFromStore, resetMailImportStore, upsertMailImportInStore } from './mailImportStore';

export function resetMailImports(): void {
  resetMailImportStore();
}

export function getMailImportSnapshot(): MailImport[] {
  return getAllMailImportsFromStore();
}

export function hydrateMailImports(items: MailImport[]): void {
  resetMailImportStore();
  items.forEach((item) => upsertMailImportInStore(item));
}

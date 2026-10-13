/**
 * FINANZ-CORE-01A (ANG-08) — der Versandstatus eines Angebots folgt seiner Versandhistorie.
 *
 * Bisher setzte nur das Angebotsdetail „versendet", und zwar nur, wenn der Versand dort
 * im selben Augenblick angenommen wurde. Derselbe Versand aus dem Dokumentdetail und ein
 * zunächst unklarer, später vom Provider bestätigter Versand liessen das Angebot auf
 * „Freigegeben" stehen — Nachverfolgung und Ablauf stimmten nicht.
 *
 * Jetzt gilt: Liegt für das Archivdokument eines eigenen Angebots ein angenommener
 * Versand vor, ist das Angebot versendet. Nur der Schritt „freigegeben → versendet" wird
 * gegangen; ein angenommenes, abgelehntes oder storniertes Angebot bleibt, wie es ist.
 *
 * Ein automatischer Schreiber ohne eigene Nutzeraktion: Er läuft im gesperrten
 * Schreibbereich (KONTOSPERRE), damit eine endgültige Abweisung des Angebots nicht
 * still abgelöst wird. Den Status setzen nur Inhaber und Admin — der Aufrufer prüft die
 * Rolle, wie bei der Ablage.
 */
import type { DocumentDelivery } from '../../types/documentDelivery';
import type { CompanyDocument } from '../../types/models';
import { findAcceptedDelivery } from '../delivery/documentDeliveryDefaults';
import { isOwnOfferDocument } from './offerArchiveService';
import { getOfferById, markOfferSent } from './offerService';
import { runAutomaticSyncWrite } from '../sync/syncOutboxService';

export function syncOfferSentFromDeliveries(
  document: Pick<CompanyDocument, 'classifiedKind' | 'linkedOfferId'>,
  deliveries: readonly DocumentDelivery[],
): boolean {
  if (!isOwnOfferDocument(document)) return false;
  if (!findAcceptedDelivery([...deliveries])) return false;
  const offerId = document.linkedOfferId!.trim();
  const offer = getOfferById(offerId);
  if (!offer || offer.status !== 'freigegeben') return false;
  return runAutomaticSyncWrite(() => markOfferSent(offerId)).success;
}

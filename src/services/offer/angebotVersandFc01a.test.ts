/**
 * FINANZ-CORE-01A (ANG-09) — versendet wird nur ein offenes Angebot.
 *
 *  V1  freigegeben und versendet (Zweitversand) ja; Entwurf, abgelehnt, storniert, ersetzt, angenommen nein
 */
import { describe, expect, it } from 'vitest';
import { OFFER_STATUSES, type OfferStatus } from '../../types/offer';
import { canSendOffer } from './offerService';

describe('ANG-09 — Versand nur für offene Angebote', () => {
  it('V1: nur freigegeben und versendet', () => {
    const erlaubt = OFFER_STATUSES.filter((status: OfferStatus) => canSendOffer({ status }));
    expect(erlaubt).toEqual(['freigegeben', 'versendet']);
  });
});

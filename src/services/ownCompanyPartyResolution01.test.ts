/**
 * OFFICEPILOT-DIRECT-CONFIRMATION-OWN-COMPANY-RESOLUTION-01E
 *
 * Der Direct-Confirmation-Pfad hing an `isOwnCompanyName`, einem exakten
 * Namensvergleich — schon eine abweichende Rechtsform ließ die eigene Partei
 * unauffindbar werden und den Pfad auf `unclear` fallen.
 *
 * Die Reihenfolge ist jetzt umgekehrt und ausdrücklich: **Identität zuerst,
 * Rolle danach als Richtungsprüfung**. Eine reine Rollenregel wäre unsicher,
 * weil der Nutzer bei einem Subunternehmervertrag auch selbst Auftraggeber sein
 * kann — dann stünde die fremde Firma in der Auftragnehmerrolle.
 *
 * Diese Tests rufen bewusst den **echten Adapter**, nicht die reine
 * Entscheidungstabelle mit handgebauten Signalen. Genau diese Mittelstrecke
 * fehlte den bisherigen Tests.
 *
 * Neutrale Beispieldaten, kein Netzwerk.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createAuftragInboxItem, createOrderPosition, createTestVorgang } from '../test/fixtures';
import { resetTestStores } from '../test/resetStores';
import { hydrateCompanyProfileStore } from './companyProfileService';
import { hydrateInboxStore } from './inboxService';
import { hydrateVorgangStore } from './vorgangService';
import { resolveOrderConfirmationPathForVorgang } from './orderConfirmationPathService';
import type { InboxItem, Vorgang } from '../types/models';

const OWN_PROFILE = {
  companyName: 'Cirmak Haustechnik GmbH',
  street: 'Bahnhofstraße 15',
  zip: '32105',
  city: 'Bad Salzuflen',
  contactPerson: 'Saban Irmak',
};

/** Realer Aufbau: Gegenpartei zuerst, eigene Firma als Auftragnehmer. */
function contractText(ownCompanyLabel = 'Cirmak Haustechnik GmbH'): string {
  return [
    'WERKVERTRAG / BAU-SUBUNTERNEHMERVERTRAG',
    'Auftraggeber Westfalen Projektbau GmbH',
    'Industriestraße 27',
    '33689 Bielefeld',
    'Ansprechpartner: Daniel Krüger',
    `Auftragnehmer ${ownCompanyLabel}`,
    'Bahnhofstraße 15',
    '32105 Bad Salzuflen',
    'Geschäftsführer: Saban Irmak',
    'Vertragsdatum 09.08.2026',
  ].join('\n');
}

/** Gegenfall: die eigene Firma beauftragt selbst. */
function reversedContractText(): string {
  return [
    'WERKVERTRAG / BAU-SUBUNTERNEHMERVERTRAG',
    'Auftraggeber Cirmak Haustechnik GmbH',
    'Bahnhofstraße 15',
    '32105 Bad Salzuflen',
    'Geschäftsführer: Saban Irmak',
    'Auftragnehmer Fremd Dach GmbH',
    'Fremdweg 9',
    '44444 Fremdstadt',
    'Geschäftsführer: Frank Fremd',
    'Vertragsdatum 09.08.2026',
  ].join('\n');
}

function seedInbox(text: string, id = 'inbox-own-1'): InboxItem {
  const item: InboxItem = {
    ...createAuftragInboxItem(),
    id,
    classifiedKind: 'subunternehmervertrag',
    sender: 'Westfalen Projektbau GmbH',
    recognizedData: { _vertragstext: text },
  };
  hydrateInboxStore([item]);
  return item;
}

function seedVorgang(inboxId: string, customer: string, id = 'v-own-1'): Vorgang {
  const vorgang = createTestVorgang({
    id,
    status: 'eingegangen',
    customer,
    baustelle: 'Logistikzentrum',
    title: 'Dachsanierung',
    createdFromInboxId: inboxId,
    orderPositions: [
      createOrderPosition({
        id: 'op-1',
        description: 'Abdichtung herstellen',
        unit: 'm²',
        plannedQuantity: 950,
        unitPrice: 3.8,
      }),
    ],
  });
  hydrateVorgangStore([vorgang]);
  return vorgang;
}

describe('OFFICEPILOT-OWN-COMPANY-PARTY-RESOLUTION-01E', () => {
  beforeEach(() => {
    resetTestStores();
    hydrateCompanyProfileStore(OWN_PROFILE);
  });

  it('A: der echte Adapter erkennt den Westfalen-Kontrollfall', () => {
    const item = seedInbox(contractText());
    const vorgang = seedVorgang(item.id, 'Westfalen Projektbau GmbH');

    const resolved = resolveOrderConfirmationPathForVorgang(vorgang);

    expect(resolved.signals.ownCompanyRole).toBe('auftragnehmer');
    expect(resolved.signals.counterpartyName).toBe('Westfalen Projektbau GmbH');
    expect(resolved.path).toBe('direct_confirmation_review');
  });

  it('B: abweichende Rechtsform wird durch die Adresse bestätigt', () => {
    // Im Dokument ohne Rechtsform, im Profil mit — Adresse identisch.
    const item = seedInbox(contractText('Cirmak Haustechnik'));
    const vorgang = seedVorgang(item.id, 'Westfalen Projektbau GmbH');

    const resolved = resolveOrderConfirmationPathForVorgang(vorgang);

    expect(resolved.signals.ownCompanyRole).toBe('auftragnehmer');
    expect(resolved.path).toBe('direct_confirmation_review');
  });

  it('C: ist die eigene Firma Auftraggeber, gibt es keinen Shortcut', () => {
    const item = seedInbox(reversedContractText(), 'inbox-own-rev');
    const vorgang = seedVorgang(item.id, 'Fremd Dach GmbH', 'v-own-rev');

    const resolved = resolveOrderConfirmationPathForVorgang(vorgang);

    // Die eigene Firma wird erkannt — aber auf der beauftragenden Seite.
    expect(resolved.signals.ownCompanyRole).toBe('auftraggeber');
    expect(resolved.path).not.toBe('direct_confirmation_review');
    expect(resolved.path).toBe('unclear');
  });

  it('C2: die fremde Firma wird nie allein wegen ihrer Rolle zur eigenen', () => {
    const item = seedInbox(reversedContractText(), 'inbox-own-rev2');
    const vorgang = seedVorgang(item.id, 'Fremd Dach GmbH', 'v-own-rev2');

    expect(resolveOrderConfirmationPathForVorgang(vorgang).signals.ownCompanyRole).not.toBe(
      'auftragnehmer',
    );
  });

  it('D: ohne sichere Identität bleibt es unclear', () => {
    hydrateCompanyProfileStore({
      companyName: 'Ganz Andere Firma GmbH',
      street: 'Anderweg 1',
      zip: '99999',
      city: 'Anderstadt',
      contactPerson: 'Anna Anders',
    });
    const item = seedInbox(contractText(), 'inbox-own-none');
    const vorgang = seedVorgang(item.id, 'Westfalen Projektbau GmbH', 'v-own-none');

    const resolved = resolveOrderConfirmationPathForVorgang(vorgang);

    expect(resolved.signals.ownCompanyRole).toBeUndefined();
    expect(resolved.path).toBe('unclear');
  });

  it('E: erfüllen zwei Parteien die Kriterien, wird keine gewählt', () => {
    // Beide Parteien tragen dieselbe Anschrift wie das Firmenprofil.
    const ambiguous = [
      'WERKVERTRAG / BAU-SUBUNTERNEHMERVERTRAG',
      'Auftraggeber Cirmak Haustechnik GmbH',
      'Bahnhofstraße 15',
      '32105 Bad Salzuflen',
      'Auftragnehmer Cirmak Haustechnik GmbH',
      'Bahnhofstraße 15',
      '32105 Bad Salzuflen',
    ].join('\n');
    const item = seedInbox(ambiguous, 'inbox-own-amb');
    const vorgang = seedVorgang(item.id, 'Cirmak Haustechnik GmbH', 'v-own-amb');

    const resolved = resolveOrderConfirmationPathForVorgang(vorgang);

    expect(resolved.signals.ownCompanyRole).toBeUndefined();
    expect(resolved.path).toBe('unclear');
  });

  it('F: ein Ansprechpartner allein beweist keine Firmenidentität', () => {
    hydrateCompanyProfileStore({
      companyName: 'Weit Entfernt GmbH',
      street: 'Weitweg 5',
      zip: '55555',
      city: 'Weitstadt',
      // Nur der Ansprechpartner stimmt mit einer Partei überein.
      contactPerson: 'Saban Irmak',
    });
    const item = seedInbox(contractText(), 'inbox-own-weak');
    const vorgang = seedVorgang(item.id, 'Westfalen Projektbau GmbH', 'v-own-weak');

    expect(resolveOrderConfirmationPathForVorgang(vorgang).signals.ownCompanyRole).toBeUndefined();
  });

  it('G: ein Angebot bleibt unabhängig von der Identität im Verhandlungsweg', () => {
    const item: InboxItem = {
      ...createAuftragInboxItem(),
      id: 'inbox-own-angebot',
      classifiedKind: 'angebot',
      recognizedData: { _vertragstext: contractText() },
    };
    hydrateInboxStore([item]);
    const vorgang = seedVorgang(item.id, 'Westfalen Projektbau GmbH', 'v-own-angebot');

    expect(resolveOrderConfirmationPathForVorgang(vorgang).path).toBe('negotiation');
  });

  it('H: ohne Bezug zum Ursprungsdokument bleibt es unclear', () => {
    const vorgang = createTestVorgang({
      id: 'v-own-noinbox',
      status: 'eingegangen',
      customer: 'Westfalen Projektbau GmbH',
      orderPositions: [
        createOrderPosition({ id: 'op-1', unit: 'm²', plannedQuantity: 1, unitPrice: 1 }),
      ],
    });
    hydrateVorgangStore([vorgang]);

    expect(resolveOrderConfirmationPathForVorgang(vorgang).path).toBe('unclear');
  });
});

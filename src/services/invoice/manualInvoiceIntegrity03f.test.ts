/**
 * MANUELLE-RECHNUNG-03F — die Clientseite der Serverintegritaet.
 *
 * Der eigentliche Beweis liegt in `supabase/tests/manual_invoice_integrity_03f.sql`:
 * Nur eine echte Datenbank kann zeigen, dass ein manipulierter Betrag keine
 * Rechnungsnummer verbraucht. Hier steht, was Vitest tatsaechlich beweisen
 * kann und was sonst still auseinanderlaufen wuerde:
 *
 *   - die Einheitenliste, die es jetzt zweimal gibt (Client und SQL),
 *   - die Zusage, dass der Server ueberhaupt alles bekommt, was er nachrechnen
 *     soll,
 *   - die Abbildung der neuen Serverfehler auf eine verstaendliche Meldung,
 *   - und dass die freie Rechnung dabei bleibt, was sie ist.
 *
 * Bewusst **nicht** wiederholt: der Entwurfsaufbau, die Positionsvalidierung
 * und der Freigabefluss. Die sind durch `manualInvoiceDraft01`,
 * `manualInvoicePage01b1b` und `manualInvoiceFinalize01` bereits bewiesen.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ORDER_UNITS } from '../orderUnits';
import { validateManualPosition, hasCompleteManualPositions } from './manualInvoiceFlow';
import { classifyInvoiceCloudErrorForTests } from './workspaceInvoiceCloudService';
import { mapFinalizationFailureToUx } from './invoiceApprovalUx';
import type { InvoiceDraftPosition } from '../../types/models';

const REPO = path.resolve(__dirname, '../../..');

/**
 * Der freie Zweig im Funktionsrumpf. Die Kopfzeile der Migration nennt dieselbe
 * Marke, deshalb das letzte Vorkommen — und als Ende der Beginn des
 * Auftragszweigs, der den Vorgang laedt.
 */
function freierZweig(sql: string): string {
  const von = sql.lastIndexOf('TEIL 2a');
  const bis = sql.indexOf('select * into v_vorgang');
  return sql.slice(von, bis);
}
const MIGRATION = readFileSync(
  path.join(REPO, 'supabase/migrations/20261006120000_workspace_manual_invoice_integrity.sql'),
  'utf8',
);
const VALIDATION_SERVICE = readFileSync(
  path.join(REPO, 'src/services/invoiceValidationService.ts'),
  'utf8',
);
const MIGRATION_03B = readFileSync(
  path.join(REPO, 'supabase/migrations/20261001120000_workspace_invoice_integrity.sql'),
  'utf8',
);

function pos(overrides: Partial<InvoiceDraftPosition> = {}): InvoiceDraftPosition {
  return {
    id: 'p1',
    description: 'Wartung',
    quantity: 2,
    unit: 'Stunden',
    unitPrice: 80,
    billable: true,
    ...overrides,
  } as unknown as InvoiceDraftPosition;
}

describe('A — die Einheitenliste gibt es jetzt zweimal', () => {
  /*
   * Der Server kann `ORDER_UNITS` nicht importieren. Laeuft eine der beiden
   * Listen weg, wuerde die App eine Einheit anbieten, die die Freigabe
   * abweist — oder der Server liesse eine durch, die es nicht gibt.
   */
  it('SQL und Client kennen exakt dieselben Einheiten', () => {
    const block = MIGRATION.match(/select p_unit in \(([^)]*)\)/);
    expect(block, 'Einheitenfunktion in der Migration gefunden').not.toBeNull();
    const ausSql = [...block![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
    expect([...ausSql].sort()).toEqual([...ORDER_UNITS].sort());
  });
});

describe('B — der Server bekommt alles, was er nachrechnen soll', () => {
  it('die Migration prüft Zwischensumme, Steuer und Gesamtbetrag für jede Rechnung', () => {
    // Der frühe Ausstieg ist weg — das war die eigentliche Lücke.
    expect(MIGRATION_03B).toMatch(/if p_vorgang_id is null then\s*\n\s*return;/);
    expect(MIGRATION).not.toMatch(/if p_vorgang_id is null then\s*\n\s*return;/);
    // Der Summenblock steht hinter beiden Zweigen, nicht in einem davon.
    const frei = MIGRATION.indexOf('TEIL 2a');
    const summen = MIGRATION.indexOf('invoice_totals_mismatch: netto');
    expect(frei).toBeGreaterThan(0);
    expect(summen).toBeGreaterThan(frei);
  });

  it('der 03B-Auftragszweig steht unverändert darin', () => {
    for (const regel of [
      'invoice_quantity_exceeds_available',
      'invoice_position_not_billable',
      'invoice_position_not_found',
      'invoice_deductions_mismatch',
      'invoice_tax_status_mismatch',
      'invoice_fixed_amount_with_positions',
    ]) {
      expect(MIGRATION, regel).toContain(regel);
    }
  });

  it('kein Schemawechsel und keine neue Signatur', () => {
    expect(MIGRATION).not.toMatch(/create table|alter table|add column|drop function/i);
    expect(MIGRATION).toContain('p_overbilling_acknowledged boolean\n)');
  });
});

describe('C — die neuen Serverbefunde werden verständlich', () => {
  const faelle = [
    ['invoice_positions_missing', 'position_mismatch'],
    ['invoice_position_description_missing', 'position_mismatch'],
    ['invoice_position_unit_invalid', 'position_mismatch'],
    ['invoice_totals_mismatch: netto 10000 / 20000', 'totals_mismatch'],
    ['invoice_customer_mismatch', 'customer_mismatch'],
    ['invoice_customer_address_incomplete', 'customer_mismatch'],
    ['invoice_tax_status_invalid', 'tax_status_mismatch'],
    ['invoice_quantity_invalid', 'totals_mismatch'],
  ] as const;

  it.each(faelle)('%s wird als %s klassifiziert', (message, erwartet) => {
    expect(classifyInvoiceCloudErrorForTests({ message }).code).toBe(erwartet);
  });

  it('der Entwurf bleibt nach einer Ablehnung bedienbar', () => {
    /*
     * Alle Integritätsbefunde laufen vor dem Insert; der Server hat nichts
     * geschrieben und keine Nummer verbraucht. Der Nutzer muss korrigieren
     * und erneut freigeben können — kein gesperrter Entwurf, kein Neuladen.
     */
    const ux = mapFinalizationFailureToUx({
      reason: 'server_integrity_rejected',
      cloudState: 'not_committed',
    } as never);
    expect(ux.messageKey).toBe('invoice.approve.serverRejected');
    expect(ux.unlock).toBe(true);
    expect(ux.reloadRequired).toBe(false);
  });
});

describe('D — Client und Server weisen dasselbe zurück', () => {
  it('die Clientregel blockiert, was der Server ablehnt', () => {
    expect(validateManualPosition(pos({ description: '   ' }))).toContain('description');
    expect(validateManualPosition(pos({ quantity: 0 }))).toContain('quantity');
    expect(validateManualPosition(pos({ quantity: -2 }))).toContain('quantity');
    expect(validateManualPosition(pos({ unitPrice: -1 }))).toContain('unitPrice');
    expect(validateManualPosition(pos({ unit: 'Fuhre' as never }))).toContain('unit');
    // Preis 0 bleibt erlaubt — kostenlose Zeile, auf beiden Seiten.
    expect(validateManualPosition(pos({ unitPrice: 0 }))).toEqual([]);
    expect(hasCompleteManualPositions({ positions: [] })).toBe(false);
  });

  it('die Migration weist dieselben Fälle ab', () => {
    const frei = freierZweig(MIGRATION);
    expect(frei).toContain('invoice_position_description_missing');
    expect(frei).toContain('v_quantity <= 0');
    expect(frei).toContain('v_unit_price < 0');
    expect(frei).toContain('workspace_invoice_unit_is_known');
    expect(frei).toContain('invoice_positions_missing');
  });
});

describe('D2 (03F2) — der Server ist nicht laxer als die Oberfläche', () => {
  /*
   * Beides sind Zustände, die die App gar nicht erst freigeben lässt. Bis 03F2
   * kam ein direkter RPC-Aufruf daran vorbei und bekam eine reguläre
   * Rechnungsnummer. Läuft eine der beiden Seiten weg, fällt es hier auf.
   */
  it('eine unklare Steuerentscheidung wird auch serverseitig abgewiesen', () => {
    const frei = freierZweig(MIGRATION);
    expect(frei).toContain("if v_tax_status = 'unclear' then");
    expect(frei).toContain('invoice_tax_status_invalid');
    // Nur ohne Auftrag — die Auftragsrechnung erbt ihren Status und bleibt unberührt.
    const auftrag = MIGRATION.slice(MIGRATION.indexOf('select * into v_vorgang'));
    expect(auftrag).not.toContain("if v_tax_status = 'unclear' then");
  });

  it('die Rechnungsanschrift braucht dieselben Mindestfelder wie im Client', () => {
    const frei = freierZweig(MIGRATION);
    for (const feld of ['street', 'zip', 'city']) {
      expect(frei, feld).toContain("customerSnapshot'->>'" + feld + "'");
    }
    expect(frei).toContain('invoice_customer_address_incomplete');
    // Kein Land — die Clientregel `hasUsableAddress` verlangt es auch nicht.
    expect(frei).not.toContain("customerSnapshot'->>'country'");
    expect(VALIDATION_SERVICE).toContain(
      'return Boolean(parts.street?.trim() && parts.zip?.trim() && parts.city?.trim());',
    );
  });
});

describe('E — die freie Rechnung bleibt, was sie ist', () => {
  it('ohne Auftrag ist nur die normale Rechnung erlaubt', () => {
    const frei = freierZweig(MIGRATION);
    expect(frei).toContain("if v_type <> 'rechnung' then");
    expect(frei).toContain('invoice_requires_vorgang_for_type');
  });

  it('der eingefrorene Kundensnapshot wird nicht gegen den Stammsatz erzwungen', () => {
    const frei = freierZweig(MIGRATION);
    // Gebunden wird die Kennung, nicht der Name auf dem Papier.
    expect(frei).toContain("p_invoice->>'customerId'");
    expect(frei).toContain('workspace_customers');
    expect(frei).not.toContain('v_master_customer');
  });

  it('Nummernkreis, Idempotenz und Storno bleiben unberührt', () => {
    // Erwaehnen darf die Migration sie — neu definieren nicht.
    expect(MIGRATION).not.toMatch(/create or replace function public\.finalize_workspace_invoice/);
    expect(MIGRATION).not.toMatch(/create or replace function public\.cancel_workspace_invoice/);
    expect(MIGRATION).not.toMatch(/insert into public\.workspace_invoice_sequences/);
  });
});

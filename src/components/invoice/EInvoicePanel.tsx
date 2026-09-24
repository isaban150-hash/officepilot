/**
 * E-RECHNUNG-04E3 — der gemeinsame Bereich für beide E-Rechnungsformate.
 *
 * XRechnung und ZUGFeRD sind **ein** Thema, nicht zwei. Wer eine Rechnung
 * elektronisch abgeben muss, sucht nicht nach „XRechnung", sondern nach der
 * Stelle, an der die elektronische Rechnung entsteht — welches Format der
 * Empfänger verlangt, erfährt er von diesem, nicht von uns. Zwei getrennte
 * Karten auf der Seite hätten zwei getrennte Funktionen behauptet und den
 * Nutzer vor eine Einordnung gestellt, die er nicht treffen kann.
 *
 * Deshalb ein Bereich, zwei klar getrennte Aktionen darin — und ein
 * Hilfetext, der in einem Satz je Format sagt, was herauskommt. Bewusst keine
 * Normenwand: `EN16931`, `CII`, `PDF/A-3U` und der Prüfwert stehen dort, wo sie
 * gebraucht werden, nämlich **nach** dem Erzeugen am fertigen Artefakt.
 *
 * Das gewöhnliche Rechnungs-PDF bleibt davon unberührt. Es hat seinen eigenen
 * Knopf und wird von hier weder ersetzt noch verändert.
 */
import { XRechnungPanel } from './XRechnungPanel';
import { ZugferdPanel } from './ZugferdPanel';
import { Card } from '../ui/Card';
import type { VorgangInvoice } from '../../types/models';

interface Props {
  invoice: VorgangInvoice;
}

export function EInvoicePanel({ invoice }: Props) {
  return (
    <Card className="invoice-einvoice" data-testid="invoice-einvoice-panel">
      <h3 className="ui-section-header__title">E-Rechnung</h3>
      <p className="hint-text" data-testid="invoice-einvoice-hint">
        Zwei Formate derselben Rechnung. Welches Sie brauchen, gibt der Empfänger vor. Beide
        entstehen erst, wenn Sie es anfordern — es wird nichts automatisch erzeugt und nichts
        automatisch versendet.
      </p>

      <div className="invoice-einvoice__formats">
        <XRechnungPanel invoice={invoice} />
        <ZugferdPanel invoice={invoice} />
      </div>
    </Card>
  );
}

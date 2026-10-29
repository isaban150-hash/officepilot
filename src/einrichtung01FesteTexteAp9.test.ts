/**
 * EINRICHTUNG-01 (AP9; Vertrag 1.31, Q-02.3) — kein fester deutscher Text in B2-Komponenten.
 *
 * Der Test liest die Quelltexte der B2-Flächen über den TypeScript-Parser und meldet
 *   - JSX-Textknoten mit Buchstaben,
 *   - Textattribute (`label`, `placeholder`, `title`, `aria-label`, `alt`, …) und gleichnamige Objekteigenschaften mit
 *     festem Text,
 *   - sonstige Zeichenketten, die nach deutschem Text aussehen (Umlaute, ß, typische Wörter, einzelnes großes Wort).
 * Übersetzungsschlüssel, Testkennungen, Klassen, Pfade, Konsolen- und Ausnahmemeldungen zählen nicht. Was bleiben darf,
 * steht mit Grund in der Ausnahmeliste (Eigennamen). Eine Positivkontrolle belegt, dass der Scanner feste Texte findet.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** B2-Flächen: Anmeldung, Einrichtung, Team, Plattform, Einstellungen, Sicherung, Export, Löschung, Gerät, Rahmen. */
const ORDNER = [
  'src/pages/settings',
  'src/components/settings',
  'src/components/auth',
  'src/components/team',
  'src/components/setup',
  'src/components/forms',
];
const EINZELN = [
  'src/pages/AccessBlockedPage.tsx',
  'src/pages/AdminUsersPage.tsx',
  'src/pages/EinstellungenPage.tsx',
  'src/pages/ForgotPasswordPage.tsx',
  'src/pages/InvitationPage.tsx',
  'src/pages/LegalConsentPage.tsx',
  'src/pages/LicenseExpiredPage.tsx',
  'src/pages/LoginPage.tsx',
  'src/pages/MehrPage.tsx',
  'src/pages/ProfileUnavailablePage.tsx',
  'src/pages/RegisterPage.tsx',
  'src/pages/ReplyToConfirmPage.tsx',
  // Nacharbeit AP5–AP10: die 404-Seite ist nach 1.14 B2 (vorher fest deutsch, nicht erfasst).
  'src/pages/system/NotFoundPage.tsx',
  // ebenso die Fehlergrenze (1.14 „Fehler“).
  'src/pages/system/ServerErrorPage.tsx',
  'src/pages/ResetPasswordPage.tsx',
  'src/pages/SetupPage.tsx',
  'src/pages/WaitingApprovalPage.tsx',
  'src/components/layout/UserMenu.tsx',
  'src/components/layout/AppShell.tsx',
  'src/components/layout/navConfig.ts',
  'src/components/system/WorkspaceReadOnlyBanner.tsx',
  'src/components/system/LeaveGuardHost.tsx',
  'src/components/system/AccountSessionLockHost.tsx',
  'src/components/system/BusinessStateGate.tsx',
  'src/components/system/WorkspaceRestoreFailure.tsx',
  'src/components/system/CloudBackupPendingBanner.tsx',
  'src/components/system/DocumentLanguage.tsx',
  'src/components/system/SkipLink.tsx',
  'src/components/system/RouteFocus.tsx',
  'src/components/legal/LegalPageLayout.tsx',
  'src/components/legal/LegalFooterLinks.tsx',
  'src/components/ui/ReadOnlyNotice.tsx',
  'src/components/ui/SimpleConfirmDialog.tsx',
  'src/components/communication/MailboxSettingsSection.tsx',
  'src/components/accounting/ChartOfAccountsSetting.tsx',
  'src/hooks/useAuthPageText.ts',
  // App-Eigenprüfung (E-9): die Notfallseiten sind nach 1.14 B2 und jetzt vollständig übersetzt.
  'src/pages/LocalRecoveryPage.tsx',
  'src/pages/LocalRecoveryImportPage.tsx',
  'src/components/system/RecoveryIdentityPanel.tsx',
];

/** Eigennamen, die in jeder Sprache gleich bleiben. */
const AUSNAHMEN: Record<string, string> = {
  OfficeTakt: 'Produktname',
  '← OfficeTakt': 'Produktname mit Pfeil (Zurück zur Anmeldung)',
  OP: 'Bildmarke im Kopf des Einrichtungsassistenten (aria-hidden)',
};

const TEXT_ATTR = new Set([
  'label', 'placeholder', 'title', 'aria-label', 'alt', 'subtitle', 'message', 'confirmLabel', 'cancelLabel', 'ariaLabel',
  'description', 'hint', 'emptyText', 'failureMessage', 'confirmPhraseLabel', 'heading', 'text', 'buttonLabel',
  'actionLabel', 'tooltip', 'aria-description', 'aria-valuetext', 'note', 'lead', 'caption', 'summary', 'legend',
]);
const TECH_ATTR =
  /^(data-|className$|key$|to$|href$|id$|name$|type$|role$|autoComplete$|inputMode$|htmlFor$|testId$|testIdPrefix$|variant$|size$|align$|tone$|target$|rel$|accept$|pattern$|method$|lang$|dir$|form$|mode$|state$|kind$|namespace$|workspaceType$|dialogTestId$|confirmTestId$|cancelTestId$|confirmVariant$|confirmPhraseTestId$)/;
const DEUTSCH =
  /[äöüÄÖÜß]|(^|\s)(Bitte|bitte|Sie|nicht|und|oder|der|die|das|den|dem|ein|eine|einen|ist|sind|wird|werden|wurde|kann|können|konnte|mit|für|auf|zum|zur|bei|noch|kein|keine|Ihr|Ihre|Ihren|jetzt|alle|bereits|Fehler)(?=\s|$|[.,:;!?])/;
const WORT = /\p{L}{2,}/u;
const EINZELWORT = /^[A-ZÄÖÜ][a-zäöüß]{3,}$/;
/** Übersetzungsschlüssel (`bereich.teil.name`) sind kein Text. */
const SCHLUESSEL = /^[a-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;

function b2Dateien(): string[] {
  const dateien = [...EINZELN];
  for (const ordner of ORDNER) {
    for (const datei of fs.readdirSync(path.join(REPO, ordner))) {
      if (/\.tsx?$/.test(datei) && !/\.test\./.test(datei)) dateien.push(`${ordner}/${datei}`);
    }
  }
  return dateien;
}

function textAttrName(name: string): boolean {
  return TEXT_ATTR.has(name.replace(/['"]/g, ''));
}

/** Meldet feste Texte in einem Quelltext; `datei` dient nur der Ortsangabe. */
function festeTexte(datei: string, quelle: string): string[] {
  const sf = ts.createSourceFile(
    datei,
    quelle,
    ts.ScriptTarget.Latest,
    true,
    datei.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const funde: string[] = [];
  const melde = (knoten: ts.Node, art: string, text: string) => {
    if (AUSNAHMEN[text] || SCHLUESSEL.test(text)) return;
    const zeile = sf.getLineAndCharacterOfPosition(knoten.getStart(sf)).line + 1;
    funde.push(`${datei}:${zeile} [${art}] ${JSON.stringify(text.slice(0, 110))}`);
  };
  const imTechKontext = (knoten: ts.Node): boolean => {
    for (let p: ts.Node | undefined = knoten.parent; p; p = p.parent) {
      if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) return true;
      if (ts.isCallExpression(p)) {
        const ausdruck = p.expression.getText(sf);
        if (/^console\./.test(ausdruck) || ausdruck === 'require' || p.expression.kind === ts.SyntaxKind.ImportKeyword) return true;
        if (/^(translate|t|text|tr|translateIn|formatMessage|interpolateParams)$/.test(ausdruck)) return true;
      }
      if (ts.isNewExpression(p) && /Error$/.test(p.expression.getText(sf))) return true;
      if (ts.isJsxAttribute(p)) return TECH_ATTR.test(p.name.getText(sf));
      if (ts.isLiteralTypeNode(p) || ts.isTypeReferenceNode(p) || ts.isUnionTypeNode(p)) return true;
      if (ts.isElementAccessExpression(p) && knoten.pos >= p.argumentExpression.pos && knoten.end <= p.argumentExpression.end) return true;
      if (ts.isPropertyAssignment(p) && knoten.pos >= p.name.pos && knoten.end <= p.name.end) return true;
      if (ts.isCaseClause(p)) return true;
      if (ts.isBinaryExpression(p) && /^(===|!==|==|!=)$/.test(p.operatorToken.getText(sf))) return true;
      if (ts.isBlock(p) || ts.isSourceFile(p)) return false;
    }
    return false;
  };
  const besuche = (knoten: ts.Node) => {
    if (ts.isJsxText(knoten)) {
      const text = knoten.getText(sf).trim();
      if (text && WORT.test(text)) melde(knoten, 'jsx-text', text);
    } else if (ts.isJsxAttribute(knoten) && knoten.initializer) {
      const init = knoten.initializer;
      const literal = ts.isStringLiteral(init)
        ? init
        : ts.isJsxExpression(init) &&
            init.expression &&
            (ts.isStringLiteral(init.expression) || ts.isNoSubstitutionTemplateLiteral(init.expression))
          ? init.expression
          : null;
      if (literal && textAttrName(knoten.name.getText(sf)) && WORT.test(literal.text)) {
        melde(knoten, `attr ${knoten.name.getText(sf)}`, literal.text);
      }
    } else if (
      ts.isPropertyAssignment(knoten) &&
      (ts.isStringLiteral(knoten.initializer) || ts.isNoSubstitutionTemplateLiteral(knoten.initializer)) &&
      textAttrName(knoten.name.getText(sf)) &&
      WORT.test(knoten.initializer.text)
    ) {
      melde(knoten, `prop ${knoten.name.getText(sf)}`, knoten.initializer.text);
    }
    if (
      (ts.isStringLiteral(knoten) || ts.isNoSubstitutionTemplateLiteral(knoten)) &&
      !ts.isJsxAttribute(knoten.parent) &&
      !(ts.isPropertyAssignment(knoten.parent) && textAttrName(knoten.parent.name.getText(sf)))
    ) {
      const text = knoten.text;
      if (!imTechKontext(knoten) && (DEUTSCH.test(text) || EINZELWORT.test(text))) melde(knoten, 'string', text);
    }
    if (ts.isTemplateExpression(knoten) && !imTechKontext(knoten)) {
      const teile = [knoten.head.text, ...knoten.templateSpans.map((span) => span.literal.text)].join(' ');
      if (DEUTSCH.test(teile)) melde(knoten, 'template', teile);
    }
    ts.forEachChild(knoten, besuche);
  };
  besuche(sf);
  return funde;
}

describe('EINRICHTUNG-01 AP9 — kein fester deutscher Text in B2-Komponenten (1.31)', () => {
  it('Positivkontrolle: der Scanner findet Textknoten, Textattribute, Texteigenschaften und lose Zeichenketten', () => {
    const probe = [
      "const LINKS = [{ to: '/agb', label: 'Allgemeine Bedingungen' }];",
      "const name = user ? user.name : 'Benutzer';",
      'export function Probe() {',
      '  return (',
      '    <div title="Hinweis zur Probe">',
      '      <p>Bitte warten</p>',
      "      <p>{translate('auth.login.submit')}</p>",
      '      <span data-testid="probe-hinweis" className="probe probe--klein">{`Sie haben ${3} Tage`}</span>',
      '    </div>',
      '  );',
      '}',
    ].join('\n');
    const funde = festeTexte('probe.tsx', probe);
    expect(funde.map((fund) => fund.replace(/^probe\.tsx:\d+ /, ''))).toEqual([
      '[prop label] "Allgemeine Bedingungen"',
      '[string] "Benutzer"',
      '[attr title] "Hinweis zur Probe"',
      '[jsx-text] "Bitte warten"',
      '[template] "Sie haben   Tage"',
    ]);
  });

  it('alle B2-Dateien existieren und enthalten keinen festen Text außer den Eigennamen der Ausnahmeliste', () => {
    const dateien = b2Dateien();
    expect(dateien.length).toBeGreaterThan(60);
    const funde: string[] = [];
    for (const datei of dateien) {
      const voll = path.join(REPO, datei);
      expect(fs.existsSync(voll), datei).toBe(true);
      funde.push(...festeTexte(datei, fs.readFileSync(voll, 'utf8')));
    }
    expect(funde).toEqual([]);
  });
});

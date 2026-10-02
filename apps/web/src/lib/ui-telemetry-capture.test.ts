/**
 * Parcours UI « tout enregistrer » (02/10) : ce qui part au panel pour un clic et pour un champ.
 * Les deux gardes qui comptent : un clic dans le vide est rapporté comme tel, et un champ secret ne
 * livre jamais sa valeur.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { clickData, inputData, isSecretField, targetLabel } from './ui-telemetry.js';

function html(markup: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = markup;
  document.body.append(root);
  return root;
}
const q = <T extends Element>(root: HTMLElement, selector: string): T => {
  const node = root.querySelector<T>(selector);
  if (node === null) throw new Error(selector);
  return node;
};

describe('parcours UI — ce qui est enregistré', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('clic sur un bouton : sa cible et ses coordonnées, sans marque « vide »', () => {
    const root = html('<button data-testid="action-start"><span id="in">Démarrer</span></button>');
    const inner = q(root, '#in');
    expect(targetLabel(inner)).toBe('action-start');
    expect(clickData(inner, 12.4, 80.6)).toMatchObject({ x: 12, y: 81, tag: 'span' });
    expect(clickData(inner, 0, 0)).not.toHaveProperty('void');
  });

  it('clic dans le vide : marqué `void`, situé par le repère le plus proche', () => {
    const root = html('<section data-testid="server-card"><p id="txt">du texte</p></section>');
    // Un repère `data-testid` n'est pas « dans le vide » ; un paragraphe hors repère l'est.
    const outside = html('<div><p id="bare">ailleurs</p></div>');
    expect(clickData(q(root, '#txt'), 1, 1)).not.toHaveProperty('void');
    expect(targetLabel(q(outside, '#bare'))).toBeUndefined();
    expect(clickData(q(outside, '#bare'), 300, 200)).toMatchObject({
      void: true,
      tag: 'p',
      x: 300,
      y: 200,
    });
  });

  it('champ ordinaire : sa valeur ; case à cocher : son état', () => {
    const root = html(
      '<input data-testid="prop-query.port" value="25570"><input type="checkbox" id="c" checked>',
    );
    expect(inputData(q<HTMLInputElement>(root, '[data-testid="prop-query.port"]'))).toEqual({
      value: '25570',
    });
    expect(inputData(q<HTMLInputElement>(root, '#c'))).toEqual({ checked: true });
  });

  it('champ secret : jamais la valeur, seulement sa longueur', () => {
    const root = html(
      [
        '<input type="password" id="a" value="hunter2">',
        '<input type="text" name="rcon.password" id="b" value="hunter2">',
        '<input type="text" data-testid="api-token" id="c" value="hunter2">',
        '<input type="text" aria-label="Code d\'appairage" data-testid="pair-code" id="d" value="hunter2">',
      ].join(''),
    );
    for (const id of ['a', 'b', 'c', 'd']) {
      const field = q<HTMLInputElement>(root, `#${id}`);
      expect(isSecretField(field)).toBe(true);
      expect(inputData(field)).toEqual({ secret: true, length: 7 });
      expect(JSON.stringify(inputData(field))).not.toContain('hunter2');
    }
  });

  it('une valeur longue est coupée', () => {
    const root = html('<textarea id="t"></textarea>');
    const field = q<HTMLTextAreaElement>(root, '#t');
    field.value = 'x'.repeat(400);
    expect(String(inputData(field).value)).toHaveLength(201);
  });
});

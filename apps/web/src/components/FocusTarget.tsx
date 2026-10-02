/**
 * « Clique sur l'élément, on t'amène au bon endroit et on te le montre » (demande de Yassin, 02/10).
 *
 * Un lien de l'aperçu porte `?tab=…&focus=<nom>` ; l'écran d'arrivée entoure la cible d'un
 * `FocusTarget` du même nom. À l'arrivée, la cible défile au centre de l'écran et reste encadrée
 * (classe `mmo-focus`, avec une pulsation au départ) tant qu'on ne quitte pas la page.
 */
import { useEffect, useRef, type ReactNode } from 'react';

export function FocusTarget({
  name,
  focus,
  children,
}: {
  name: string;
  /** Le `focus` de l'URL ; la cible ne réagit que si c'est son nom. */
  focus: string | undefined;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const active = focus === name;
  useEffect(() => {
    // jsdom n'a pas scrollIntoView : la mise en avant ne doit pas en dépendre.
    if (active && typeof ref.current?.scrollIntoView === 'function') {
      ref.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [active]);
  return (
    <div
      ref={ref}
      className={active ? 'mmo-focus' : undefined}
      data-focus-target={name}
      data-focused={active ? 'true' : undefined}
    >
      {children}
    </div>
  );
}

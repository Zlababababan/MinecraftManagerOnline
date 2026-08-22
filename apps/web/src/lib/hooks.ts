/** Hooks utilitaires. */
import { useEffect, useState } from 'react';

/** Horloge locale rafraîchie périodiquement (affichages « il y a … »). */
export function useNow(intervalMs = 10_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return () => {
      clearInterval(timer);
    };
  }, [intervalMs]);
  return now;
}

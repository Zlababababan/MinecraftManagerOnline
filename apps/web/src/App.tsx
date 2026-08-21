import { PROJECT_NAME } from '@mmo/shared';

import { pageTitle } from './title.js';

/** Squelette — la phase 5 apportera Mantine, le routeur, l'i18n et la PWA. */
export function App() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem' }}>
      <h1>{pageTitle(PROJECT_NAME)}</h1>
      <p>Phase 1 — fondations du monorepo.</p>
    </main>
  );
}

import '@mantine/core/styles.layer.css';
import '@mantine/notifications/styles.layer.css';
import 'mantine-datatable/styles.layer.css';
import './styles.css';
import './i18n/index.js';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app.js';
import { installUiTelemetry } from './lib/ui-telemetry.js';

installUiTelemetry();

const root = document.getElementById('root');
if (root === null) {
  throw new Error('Élément #root introuvable');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

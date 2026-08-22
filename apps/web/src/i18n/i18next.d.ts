import 'i18next';

import type { Resources } from '@mmo/shared';

import type { webEn } from './locales/en.js';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'web';
    returnNull: false;
    resources: {
      web: typeof webEn;
      common: Resources['common'];
      errors: Resources['errors'];
      detection: Resources['detection'];
    };
  }
}

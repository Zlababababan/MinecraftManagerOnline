// drizzle-kit : migrations de `metrics.db` (doc 04 §7), fichier séparé de `mmo.db`.
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema-metrics.ts',
  out: './drizzle/metrics',
});

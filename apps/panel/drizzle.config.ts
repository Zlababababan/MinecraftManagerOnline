// drizzle-kit : `pnpm db:generate` produit les migrations SQL commitées de `mmo.db` (doc 04).
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle/mmo',
});

import { buildApp } from './app.js';

const app = buildApp({ logger: true });
const port = Number(process.env.MMO_PORT ?? 3000);
const host = process.env.MMO_HOST ?? '127.0.0.1';

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

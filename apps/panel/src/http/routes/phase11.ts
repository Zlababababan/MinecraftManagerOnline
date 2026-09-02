/**
 * Phase 11 — distribution (doc 03 §3) : scripts d'installation et archives servis publiquement
 * (`/install.ps1`, `/install.sh`, `/dist/<fichier>`, `/api/dist`, `/api/dist/:platform`), dépôt
 * admin (`PUT /api/admin/dist/files/:file`, `PUT /api/admin/dist/manifest`, `DELETE /api/admin/dist`).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { z } from 'zod';

import type { AppContext } from '../../context.js';
import { normalizeOrigin } from '../../util/origin.js';
import { AppError } from '../../errors.js';
import { auditMeta } from './setup-auth.js';

const fileParams = z.object({ file: z.string().min(1).max(128) });

/**
 * Origine vue par la requête : `request.protocol` / `request.host` honorent `x-forwarded-*`
 * uniquement depuis un proxy de confiance (`trustProxy: 'loopback'` — `tailscale serve`), et la
 * valeur est validée comme origine stricte avant d'être injectée dans un script (phase 12).
 */
export function requestOrigin(request: FastifyRequest): string | undefined {
  const host = request.host;
  if (host === '') return undefined;
  return normalizeOrigin(`${request.protocol}://${host}`);
}

export function registerPhase11Routes(app: FastifyInstance, ctx: AppContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // Lot 9 : la distribution est publique par nature (installeurs, agents qui se mettent à jour),
  // donc limitée par adresse — une boucle de téléchargement ne doit pas saturer le disque du panel.
  const limited = ctx.rateLimits.hook('distribution');

  for (const name of ['install.ps1', 'install.sh'] as const) {
    r.get(`/${name}`, { config: { public: true }, preValidation: limited }, (request, reply) => {
      const script = ctx.distribution.installScript(name, requestOrigin(request));
      return reply
        .header('content-type', script.type)
        .header('cache-control', 'no-cache')
        .send(script.body);
    });
  }

  r.get(
    '/dist/:file',
    { config: { public: true }, schema: { params: fileParams }, preValidation: limited },
    (request, reply) => {
      const f = ctx.distribution.filePath(request.params.file);
      return reply
        .header('content-type', 'application/octet-stream')
        .header('content-length', String(f.size))
        .header('content-disposition', `attachment; filename="${request.params.file}"`)
        .header('x-sha256', f.sha256)
        .header('cache-control', 'public, max-age=3600')
        .send(createReadStream(f.path));
    },
  );

  r.get('/api/dist', { config: { public: true }, preValidation: limited }, () =>
    ctx.distribution.status(),
  );

  r.get(
    '/api/dist/:platform',
    {
      config: { public: true },
      schema: { params: z.object({ platform: z.string().max(32) }) },
      preValidation: limited,
    },
    (request) => ctx.distribution.platform(request.params.platform),
  );

  r.put(
    '/api/admin/dist/files/:file',
    { config: { role: 'admin' }, schema: { params: fileParams }, bodyLimit: 512 * 1024 * 1024 },
    async (request, reply) => {
      const body = request.body as Readable | undefined;
      if (body === undefined || typeof (body as { pipe?: unknown }).pipe !== 'function') {
        throw new AppError('E_VALIDATION', 'binary body expected (application/octet-stream)');
      }
      const result = await ctx.distribution.putFile(request.params.file, body);
      return reply.code(201).send(result);
    },
  );

  r.put(
    '/api/admin/dist/manifest',
    { config: { role: 'admin' }, schema: { body: z.unknown() } },
    async (request) => {
      const status = await ctx.distribution.putManifest(request.body);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'distribution.published',
        targetType: 'release',
        targetId: status.version ?? undefined,
        details: {
          platforms: Object.keys(status.platforms),
          runtimeVersion: status.runtimeVersion,
        },
      });
      return status;
    },
  );

  r.delete('/api/admin/dist', { config: { role: 'admin' } }, async (request) => {
    const before = ctx.distribution.status();
    await ctx.distribution.clear();
    ctx.audit.record({
      ...auditMeta(request),
      action: 'distribution.cleared',
      targetType: 'release',
      targetId: before.version ?? undefined,
    });
    return { ok: true };
  });
}

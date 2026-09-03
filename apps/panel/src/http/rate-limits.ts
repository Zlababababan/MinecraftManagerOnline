/**
 * Limiteurs des surfaces **publiques** (lot 9). Jusqu'ici seuls le login, le wizard et l'appairage
 * étaient limités ; le relais (`/api/relay/:token`), la distribution (`/dist/*`, `install.sh|ps1`,
 * `/api/dist*`) et la poignée de main `/ws/agent` répondaient sans limite à n'importe quelle
 * adresse — un scan de jetons de relais ou une boucle de téléchargement ne coûtaient rien.
 *
 * Une fenêtre glissante par adresse (`clientKey` : IPv4 telle quelle, IPv6 ramenée à son /64,
 * doc 03 §6), un compteur par surface, refus `429 E_RATE_LIMITED` (retryable). Les bornes sont
 * larges : un agent qui reprend un bundle par tranches `Range` fait quelques dizaines de requêtes
 * par minute, jamais des centaines.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError } from '../errors.js';
import { RateLimiter, clientKey } from '../util/rate-limit.js';

export interface PublicRateLimitOptions {
  /** Requêtes par adresse et par fenêtre (défaut 120). */
  max?: number;
  /** Fenêtre glissante (défaut 60 s). */
  windowMs?: number;
  now?: () => number;
}

export const PUBLIC_RATE_LIMIT = { max: 120, windowMs: 60_000 } as const;

export type PublicSurface = 'relay' | 'distribution' | 'ws-agent' | 'status';

export class PublicRateLimits {
  private readonly limiters = new Map<PublicSurface, RateLimiter>();
  private readonly options: Required<Omit<PublicRateLimitOptions, 'now'>> &
    Pick<PublicRateLimitOptions, 'now'>;

  constructor(options: PublicRateLimitOptions = {}) {
    this.options = {
      max: options.max ?? PUBLIC_RATE_LIMIT.max,
      windowMs: options.windowMs ?? PUBLIC_RATE_LIMIT.windowMs,
      ...(options.now === undefined ? {} : { now: options.now }),
    };
  }

  /** `true` si l'adresse peut encore solliciter cette surface (et la comptabilise). */
  allow(surface: PublicSurface, ip: string | undefined): boolean {
    let limiter = this.limiters.get(surface);
    if (limiter === undefined) {
      limiter = new RateLimiter({
        max: this.options.max,
        windowMs: this.options.windowMs,
        ...(this.options.now === undefined ? {} : { now: this.options.now }),
      });
      this.limiters.set(surface, limiter);
    }
    return limiter.hit(clientKey(ip));
  }

  /**
   * Hook Fastify à poser en `preValidation` : refuse en 429 avant tout travail — validation
   * comprise, sinon un scan de jetons mal formés (400) ne compterait jamais (même règle que
   * `/api/setup`, doc 03 §6).
   */
  hook(surface: PublicSurface) {
    return (request: FastifyRequest, _reply: FastifyReply, done: (error?: Error) => void): void => {
      if (!this.allow(surface, request.ip)) {
        done(
          new AppError('E_RATE_LIMITED', `too many requests on ${surface}`, { retryable: true }),
        );
        return;
      }
      done();
    };
  }
}

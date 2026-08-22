/** Mapping MC→Java côté panel : manifest Mojang (caché 6 h) → table statique (doc 03 §4). */
import type { Loader } from '@mmo/protocol';
import {
  createMojangJavaSource,
  resolveJavaRequirement,
  type JavaRequirement,
  type JavaVersionSource,
} from '@mmo/shared';

export class JavaResolver {
  private readonly source: JavaVersionSource | undefined;

  constructor(options: { manifest: boolean; fetch?: typeof fetch; now?: () => number }) {
    this.source = options.manifest
      ? createMojangJavaSource({
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          ...(options.now === undefined ? {} : { now: options.now }),
        })
      : undefined;
  }

  resolve(input: {
    mcVersion: string | undefined;
    loader: Loader | undefined;
    override: number | undefined;
  }): Promise<JavaRequirement | undefined> {
    if (input.override !== undefined) {
      return Promise.resolve({ majorVersion: input.override, strict: false, source: 'override' });
    }
    if (input.mcVersion === undefined) return Promise.resolve(undefined);
    return resolveJavaRequirement(
      {
        mcVersion: input.mcVersion,
        ...(input.loader === undefined ? {} : { loader: input.loader }),
      },
      this.source,
    );
  }
}

/**
 * Abstraction du système de fichiers pour la détection : le cœur reste pur (testable en mémoire,
 * utilisable côté panel) ; l'agent fournit l'implémentation Node (`@mmo/shared/node`).
 * Tous les chemins sont joints avec `/` par le cœur ; l'adaptateur normalise pour l'OS.
 */

export interface DirEntry {
  name: string;
  kind: 'file' | 'dir' | 'other';
  size?: number;
}

/** Accès en lecture seule à quelques entrées d'un jar (zip). */
export interface JarHandle {
  has(name: string): boolean;
  /** Contenu texte (UTF-8) d'une entrée, tronqué à `maxBytes` ; `undefined` si absente. */
  readText(name: string, maxBytes?: number): Promise<string | undefined>;
  close(): Promise<void>;
}

export interface DetectFs {
  /** Entrées d'un dossier ; `[]` s'il n'existe pas ou n'est pas lisible. */
  readdir(path: string): Promise<DirEntry[]>;
  /** Texte d'un fichier (UTF-8, tronqué à `maxBytes`) ; `undefined` s'il est absent ou illisible. */
  readText(path: string, maxBytes?: number): Promise<string | undefined>;
  /** Ouvre un jar ; `undefined` si absent ou pas un zip valide. */
  openJar(path: string): Promise<JarHandle | undefined>;
}

export function joinPath(...parts: string[]): string {
  return parts
    .filter((p) => p !== '')
    .join('/')
    .replace(/\/{2,}/g, '/');
}

export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return i === -1 ? trimmed : trimmed.slice(i + 1);
}

// --- Implémentation mémoire (tests, fixtures synthétiques) ------------------------------------------

export interface MemoryTree {
  [name: string]: string | Uint8Array | MemoryJar | MemoryTree;
}
export class MemoryJar {
  constructor(readonly entries: Record<string, string>) {}
}

/** FS en mémoire : `{ 'server.properties': 'server-port=25565', mods: { 'a.jar': new MemoryJar({...}) } }`. */
export class MemoryDetectFs implements DetectFs {
  constructor(private readonly roots: Record<string, MemoryTree>) {}

  private resolve(path: string): string | Uint8Array | MemoryJar | MemoryTree | undefined {
    const norm = path.replace(/\\/g, '/').replace(/\/+$/, '');
    for (const [root, tree] of Object.entries(this.roots)) {
      const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
      if (norm === r) return tree;
      if (!norm.startsWith(`${r}/`)) continue;
      let node: string | Uint8Array | MemoryJar | MemoryTree | undefined = tree;
      for (const part of norm.slice(r.length + 1).split('/')) {
        if (
          node === undefined ||
          typeof node === 'string' ||
          node instanceof Uint8Array ||
          node instanceof MemoryJar
        ) {
          return undefined;
        }
        node = node[part];
      }
      return node;
    }
    return undefined;
  }

  async readdir(path: string): Promise<DirEntry[]> {
    const node = this.resolve(path);
    if (
      node === undefined ||
      typeof node === 'string' ||
      node instanceof Uint8Array ||
      node instanceof MemoryJar
    ) {
      return [];
    }
    return Promise.resolve(
      Object.entries(node).map(([name, v]) =>
        typeof v === 'string' || v instanceof Uint8Array || v instanceof MemoryJar
          ? {
              name,
              kind: 'file',
              size: typeof v === 'string' ? v.length : v instanceof Uint8Array ? v.length : 1,
            }
          : { name, kind: 'dir' },
      ),
    );
  }

  async readText(path: string, maxBytes?: number): Promise<string | undefined> {
    const node = this.resolve(path);
    if (typeof node === 'string')
      return Promise.resolve(maxBytes === undefined ? node : node.slice(0, maxBytes));
    if (node instanceof Uint8Array)
      return Promise.resolve(new TextDecoder().decode(node).slice(0, maxBytes));
    return Promise.resolve(undefined);
  }

  async openJar(path: string): Promise<JarHandle | undefined> {
    const node = this.resolve(path);
    if (!(node instanceof MemoryJar)) return Promise.resolve(undefined);
    return Promise.resolve({
      has: (name) => Object.hasOwn(node.entries, name),
      readText: (name, maxBytes) => Promise.resolve(node.entries[name]?.slice(0, maxBytes)),
      close: () => Promise.resolve(),
    });
  }
}

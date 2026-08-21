/**
 * `server.properties` (doc 06 §7) : lecture tolérante, écriture « sûre universelle » (ASCII +
 * échappements `\uXXXX`, `\\`, `\:`, `\=`), mise à jour **en place** (ordre, commentaires et clés
 * inconnues conservés ; clés absentes ajoutées en fin de fichier).
 */

export type Properties = Map<string, string>;

function unescapeValue(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i] ?? '';
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = raw[++i];
    switch (n) {
      case 'u': {
        const hex = raw.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else out += 'u';
        break;
      }
      case 'n':
        out += '\n';
        break;
      case 't':
        out += '\t';
        break;
      case 'r':
        out += '\r';
        break;
      case 'f':
        out += '\f';
        break;
      case undefined:
        break;
      default:
        out += n;
    }
  }
  return out;
}

/** Sépare une ligne `clé=valeur` / `clé:valeur` / `clé valeur` (échappements respectés). */
function splitLine(line: string): { key: string; value: string } | undefined {
  const trimmed = line.replace(/^\s+/, '');
  if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('!')) return undefined;
  let i = 0;
  let key = '';
  for (; i < trimmed.length; i++) {
    const c = trimmed[i] ?? '';
    if (c === '\\') {
      key += c + (trimmed[i + 1] ?? '');
      i++;
      continue;
    }
    if (c === '=' || c === ':' || c === ' ' || c === '\t') break;
    key += c;
  }
  let rest = trimmed.slice(i).replace(/^[ \t]*/, '');
  if (rest.startsWith('=') || rest.startsWith(':')) rest = rest.slice(1).replace(/^[ \t]*/, '');
  return { key: unescapeValue(key), value: unescapeValue(rest) };
}

export function parseProperties(text: string): Properties {
  const map: Properties = new Map();
  for (const line of text.split(/\r?\n/)) {
    const kv = splitLine(line);
    if (kv) map.set(kv.key, kv.value);
  }
  return map;
}

export function escapeKey(key: string): string {
  return escapeCommon(key).replace(/ /g, '\\ ');
}

export function escapeValue(value: string): string {
  const common = escapeCommon(value);
  return common.startsWith(' ') ? `\\${common}` : common;
}

function escapeCommon(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    switch (ch) {
      case '\\':
        out += '\\\\';
        break;
      case '=':
        out += '\\=';
        break;
      case ':':
        out += '\\:';
        break;
      case '#':
        out += '\\#';
        break;
      case '!':
        out += '\\!';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\r':
        out += '\\r';
        break;
      case '\t':
        out += '\\t';
        break;
      case '\f':
        out += '\\f';
        break;
      default:
        if (code < 0x20 || code > 0x7e) {
          // Hors BMP : paire de surrogates (Java lit les deux \uXXXX)
          for (const unit of ch.split('').map((u) => u.charCodeAt(0))) {
            out += `\\u${unit.toString(16).padStart(4, '0')}`;
          }
        } else out += ch;
    }
  }
  return out;
}

/**
 * Applique `updates` au texte existant : les lignes des clés présentes sont réécrites en place,
 * les nouvelles clés sont ajoutées en fin. `null` supprime la clé.
 */
export function updateProperties(text: string, updates: Record<string, string | null>): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.split(/\r?\n/);
  const remaining = new Map(Object.entries(updates));
  const out: string[] = [];
  for (const line of lines) {
    const kv = splitLine(line);
    if (kv && remaining.has(kv.key)) {
      const value = remaining.get(kv.key);
      remaining.delete(kv.key);
      if (value === null || value === undefined) continue;
      out.push(`${escapeKey(kv.key)}=${escapeValue(value)}`);
    } else out.push(line);
  }
  while (out.length > 0 && out.at(-1) === '') out.pop();
  for (const [key, value] of remaining) {
    if (value === null) continue;
    out.push(`${escapeKey(key)}=${escapeValue(value)}`);
  }
  return out.length === 0 ? '' : out.join(eol) + eol;
}

export function parseBooleanProperty(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

export function parseIntProperty(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value.trim());
  return Number.isInteger(n) ? n : undefined;
}

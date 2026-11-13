// The key browser's namespace tree: keys split on a separator (":" by
// default, as `user:42:profile`), each prefix a folder with the number of
// keys under it. Binary keys split on their shown text (`\xff`), so they
// still land somewhere; the key itself stays as the server sent it.

import { binId, binText, type Bin } from "./bin";

export interface ScanKey {
  key: Bin;
  type: string;
}

export interface KeyFolder {
  // The folder's own segment ("42"), and the prefix it stands for with the
  // separator after it ("user:42:").
  name: string;
  prefix: string;
  folders: KeyFolder[];
  keys: ScanKey[];
  // Every key under it, however deep.
  count: number;
}

interface Building {
  name: string;
  prefix: string;
  folders: Map<string, Building>;
  keys: ScanKey[];
  count: number;
}

function finish(node: Building): KeyFolder {
  const folders = [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name)).map(finish);
  const keys = node.keys.slice().sort((a, b) => binText(a.key).localeCompare(binText(b.key)));
  return { name: node.name, prefix: node.prefix, folders, keys, count: node.count };
}

// `separator` "" lists every key flat.
export function buildKeyTree(keys: readonly ScanKey[], separator: string): KeyFolder {
  const root: Building = { name: "", prefix: "", folders: new Map(), keys: [], count: 0 };
  for (const entry of keys) {
    const text = binText(entry.key);
    const parts = separator === "" ? [text] : text.split(separator);
    let node = root;
    node.count += 1;
    let prefix = "";
    for (let i = 0; i < parts.length - 1; i++) {
      prefix += parts[i] + separator;
      let child = node.folders.get(parts[i]);
      if (child === undefined) {
        child = { name: parts[i], prefix, folders: new Map(), keys: [], count: 0 };
        node.folders.set(parts[i], child);
      }
      child.count += 1;
      node = child;
    }
    node.keys.push(entry);
  }
  return finish(root);
}

// Keys from successive SCAN pages, each once: SCAN may return a key again.
export class KeySet {
  private readonly seen = new Map<string, ScanKey>();

  add(keys: readonly ScanKey[]): number {
    let added = 0;
    for (const entry of keys) {
      const id = binId(entry.key);
      if (!this.seen.has(id)) {
        added += 1;
      }
      this.seen.set(id, entry);
    }
    return added;
  }

  delete(key: Bin): void {
    this.seen.delete(binId(key));
  }

  get size(): number {
    return this.seen.size;
  }

  list(): ScanKey[] {
    return [...this.seen.values()];
  }
}

// A glob for SCAN MATCH from what the user typed: their own glob as is,
// plain text as "contains" (`*text*`).
export function matchPattern(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "") {
    return null;
  }
  return /[*?[\]]/.test(trimmed) ? trimmed : `*${trimmed.replace(/\\/g, "\\\\")}*`;
}

// Saving edits from every view (cards, JSON blocks, table cells, the detail
// panel) with Elasticsearch's optimistic concurrency: the write carries the
// `_seq_no`/`_primary_term` the document was read with; when it changed
// elsewhere since, the document is read again and the user picks between the
// current value and their change (the same dialog as MongoDB's).

import { useCallback, useRef, useState } from "react";
import { t } from "../../../i18n";
import { deepEqual, type BsonDocument, type BsonValue } from "../../mongodb/bson";
import { applyEdits, type DocEdit } from "../../mongodb/guard";
import type { SaveEdits } from "../../mongodb/ui/types";
import type { DocConflict } from "../../mongodb/ui/useDocEdits";
import { asError } from "../../mongodb/ui/writeErrors";
import { getDoc, guardOf, hitOf, indexDoc, isVersionConflict, type Hit } from "../api";
import { toJson } from "../json";

export interface SearchEdits {
  save: SaveEdits;
  // The JSON editor's whole-document save, guarded the same way.
  replace(original: BsonDocument, replacement: BsonDocument): Promise<Error | null>;
  conflict: DocConflict | null;
}

// The view document (`_id` first) with its source fields only.
function sourceOf(doc: BsonDocument): BsonDocument {
  return new Map([...doc].filter(([key]) => key !== "_id"));
}

// `projected`: the page was read with a `_source` filter, so a view document
// holds only some fields; saving then starts from the stored document.
export function useSearchEdits(conn: string, projected: boolean, onSaved: () => void, notify: (message: string) => void): SearchEdits {
  const [conflict, setConflict] = useState<DocConflict | null>(null);
  const latest = useRef({ conn, projected, onSaved, notify });
  latest.current = { conn, projected, onSaved, notify };

  // Writes `next` (the whole new view document) guarded by the hit's
  // sequence numbers; on a conflict asks the user.
  const write = useCallback(async (original: BsonDocument, next: (stored: BsonDocument) => BsonDocument): Promise<Error | null> => {
    const hit = hitOf(original);
    if (hit === undefined) {
      return new Error(t("이 문서는 검색 결과에서 온 것이 아니라 저장할 수 없습니다"));
    }
    const { conn: c } = latest.current;
    let base = original;
    if (latest.current.projected) {
      try {
        const stored = await getDoc(c, hit.index, hit.id, hit.routing);
        if (!stored.found) {
          return new Error(t("다른 곳에서 삭제되었습니다"));
        }
        base = new Map<string, BsonValue>([["_id", hit.id], ...sourceOf(stored.source)]);
      } catch (error) {
        return asError(error);
      }
    }
    let mine: BsonDocument;
    try {
      mine = next(base);
    } catch (error) {
      return asError(error);
    }
    if (mine.get("_id") !== hit.id) {
      return new Error(t("_id는 바꿀 수 없습니다"));
    }
    if (deepEqual(mine, base)) {
      return null;
    }
    const send = (guard: boolean) => indexDoc(latest.current.conn, { index: hit.index, id: hit.id, doc: toJson(sourceOf(mine)), routing: hit.routing, ...(guard ? guardOf(hit) : {}) });
    try {
      await send(true);
      latest.current.onSaved();
      return null;
    } catch (error) {
      if (!isVersionConflict(error)) {
        return asError(error);
      }
    }
    return askAboutConflict(hit, original, mine, send);
  }, []);

  const askAboutConflict = (hit: Hit, original: BsonDocument, mine: BsonDocument, send: (guard: boolean) => Promise<unknown>): Promise<Error | null> =>
    getDoc(latest.current.conn, hit.index, hit.id, hit.routing).then(
      (stored) =>
        new Promise<Error | null>((resolve) => {
          const settle = (result: Error | null) => {
            setConflict(null);
            resolve(result);
          };
          setConflict({
            original,
            current: stored.found ? new Map<string, BsonValue>([["_id", hit.id], ...sourceOf(stored.source)]) : null,
            mine,
            busy: false,
            error: null,
            reload: () => {
              settle(null);
              latest.current.onSaved();
            },
            overwrite: () => {
              setConflict((c) => (c === null ? c : { ...c, busy: true, error: null }));
              send(false).then(
                () => {
                  settle(null);
                  latest.current.notify(t("내 변경으로 덮어썼습니다"));
                  latest.current.onSaved();
                },
                (error: unknown) => setConflict((c) => (c === null ? c : { ...c, busy: false, error: asError(error) })),
              );
            },
            dismiss: () => settle(new Error(t("다른 곳에서 바뀌어 저장하지 않았습니다"))),
          });
        }),
      (error: unknown) => asError(error),
    );

  const save = useCallback<SaveEdits>(
    (original, edits: DocEdit[]) => {
      if (edits.some((edit) => edit.path === "_id" || edit.path.startsWith("_id."))) {
        return Promise.resolve(new Error(t("_id는 바꿀 수 없습니다")));
      }
      return write(original, (base) => applyEdits(base, edits));
    },
    [write],
  );

  const replace = useCallback(
    (original: BsonDocument, replacement: BsonDocument) => {
      const id = replacement.get("_id");
      if (id !== undefined && id !== hitOf(original)?.id) {
        return Promise.resolve(new Error(t("_id는 바꿀 수 없습니다")));
      }
      return write(original, (base) => new Map<string, BsonValue>([["_id", base.get("_id") ?? null], ...sourceOf(replacement)]));
    },
    [write],
  );

  return { save, replace, conflict };
}

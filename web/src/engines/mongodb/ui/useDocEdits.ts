// Saving edits from every view (cards, JSON blocks, table cells, the detail
// panel) with the conflict guard of MONGODB.md §4: the filter carries the
// original value of each changed path; when it matches nothing the document
// is read again by `_id` and the user picks between the current value and
// their change.

import { useCallback, useRef, useState } from "react";
import { t } from "../../../i18n";
import { find, replace as replaceDoc, update, type Namespace } from "../api";
import type { BsonDocument } from "../bson";
import { applyEdits, guardReplace, guardUpdate, idFilter, type DocEdit } from "../guard";
import type { SaveEdits } from "./types";
import { asError } from "./writeErrors";

// A save that matched nothing, waiting for the user's choice.
export interface DocConflict {
  // The document as the page loaded it, as it is now (null: deleted
  // elsewhere), and as the user's change would leave it.
  original: BsonDocument;
  current: BsonDocument | null;
  mine: BsonDocument;
  busy: boolean;
  error: Error | null;
  // Drop the change and show the current value.
  reload(): void;
  // Send the change with only `_id` in the filter.
  overwrite(): void;
  // Close without deciding; the edit stays in its view.
  dismiss(): void;
}

export interface DocEdits {
  save: SaveEdits;
  // The JSON editor's replaceOne, guarded the same way.
  replace(original: BsonDocument, replacement: BsonDocument): Promise<Error | null>;
  conflict: DocConflict | null;
}

// `onSaved` reloads the page after a write (and after "다시 불러오기").
export function useDocEdits(ns: Namespace, onSaved: () => void, notify: (message: string) => void): DocEdits {
  const [conflict, setConflict] = useState<DocConflict | null>(null);
  const latest = useRef({ ns, onSaved, notify });
  latest.current = { ns, onSaved, notify };

  // Writes with the guard, and on matched 0 asks the user. `send(force)`
  // sends the guarded write, or with force the `_id`-only one.
  const guarded = useCallback(
    async (original: BsonDocument, mine: BsonDocument, send: (force: boolean) => Promise<{ matched: number }>): Promise<Error | null> => {
      let matched: number;
      try {
        matched = (await send(false)).matched;
      } catch (error) {
        return asError(error);
      }
      if (matched > 0) {
        latest.current.onSaved();
        return null;
      }
      let current: BsonDocument | null;
      try {
        current = (await find(latest.current.ns, { filter: idFilter(original), limit: 1 })).docs[0] ?? null;
      } catch (error) {
        return asError(error);
      }
      return new Promise<Error | null>((resolve) => {
        const settle = (result: Error | null) => {
          setConflict(null);
          resolve(result);
        };
        const base: DocConflict = {
          original,
          current,
          mine,
          busy: false,
          error: null,
          reload: () => {
            settle(null);
            latest.current.onSaved();
          },
          overwrite: () => {
            setConflict((c) => (c === null ? c : { ...c, busy: true, error: null }));
            send(true).then(
              (r) => {
                if (r.matched === 0) {
                  setConflict((c) => (c === null ? c : { ...c, busy: false, error: new Error(t("다른 곳에서 삭제되었습니다")) }));
                  return;
                }
                settle(null);
                latest.current.notify(t("내 변경으로 덮어썼습니다"));
                latest.current.onSaved();
              },
              (error: unknown) => setConflict((c) => (c === null ? c : { ...c, busy: false, error: asError(error) })),
            );
          },
          dismiss: () => settle(new Error(t("다른 곳에서 바뀌어 저장하지 않았습니다"))),
        };
        setConflict(base);
      });
    },
    [],
  );

  const save = useCallback<SaveEdits>(
    async (original, edits: DocEdit[]) => {
      let guard;
      try {
        guard = guardUpdate(original, edits);
      } catch (error) {
        return asError(error);
      }
      if (guard === null) {
        return null;
      }
      const { filter, update: change } = guard;
      return guarded(original, applyEdits(original, edits), (force) =>
        update(latest.current.ns, { filter: force ? idFilter(original) : filter, update: change, many: false }),
      );
    },
    [guarded],
  );

  const replace = useCallback(
    async (original: BsonDocument, replacement: BsonDocument) => {
      let guard;
      try {
        guard = guardReplace(original, replacement);
      } catch (error) {
        return asError(error);
      }
      return guarded(original, replacement, (force) => replaceDoc(latest.current.ns, force ? idFilter(original) : guard.filter, guard.replacement));
    },
    [guarded],
  );

  return { save, replace, conflict };
}

import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import { createPortal, flushSync } from "react-dom";
import { writeClipboard } from "../clipboard";
import { formatBytes } from "../format";
import { t } from "../i18n";
import {
  buildIndex,
  childIds,
  containerSize,
  inkOf,
  inlineText,
  isContainer,
  kindAt,
  lineage,
  openTo,
  openToDepth,
  pathOf,
  positionOf,
  lineSpans,
  prettyLines,
  primitiveText,
  searchIndex,
  setSubtree,
  visibleIds,
  type JsonIndex,
  type LineSpans,
} from "../jsonIndex";
import { IS_MAC, formatBinding, matchesBinding, withHint } from "../shortcuts";
import { useRowMotion } from "./Collapse";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { FieldBox } from "./FieldBox";
import { ChevronDownIcon, ChevronIcon, CloseIcon, CopyIcon, SearchIcon, ShrinkIcon, UpDownIcon } from "./icons";

// Quick Look's large view of a JSON value: a windowed tree that stays fast at
// hundreds of thousands of nodes, search over keys and values, the picked
// node's members as field boxes (as the popover shows them), and the whole
// document as indented text.

interface JsonExplorerProps {
  doc: object;
  // The cell as stored, when it is text: the raw view indents it as is, so
  // numbers past 2^53 and escapes read as stored.
  stored: string | null;
  // Where the value comes from (table, column, row).
  title: ReactNode;
  label: string;
  dialogRef?: Ref<HTMLDivElement>;
  onDialogKeyDown?(event: KeyboardEvent<HTMLDivElement>): void;
  // Absent: no shrink or close button (the view embedded in a pane).
  onCollapse?(): void;
  onClose?(): void;
  // Laid out in its container instead of over the window, as a region.
  // Its own bars go: the mode, search and expand controls are drawn into
  // `controlsTarget` (the host's toolbar), the picked node's path heads the
  // value pane, and the node count goes to `onStats`.
  embedded?: boolean;
  controlsTarget?: HTMLElement | null;
  onStats?(nodes: number): void;
}

// What the view keeps per document while Quick Look shows it, so going back
// to the popover and out again finds the tree as it was left.
interface ExplorerState {
  index: JsonIndex;
  open: Uint8Array;
  selected: number;
  lines: string[] | null;
  lowerLines: string[] | null;
  // Null until a container is picked; false when the lines don't follow the
  // parsed nodes (a stored object with a repeated key).
  spans: LineSpans | false | null;
}

// A container's own lines, cut from the document's lines: rows [from, from +
// count) with `indent` leading spaces dropped, the first row being `head`
// (no key) and the last `tail` (no comma after it).
interface LineSlice {
  lines: string[];
  from: number;
  count: number;
  indent: number;
  head: string;
  tail: string;
}

const ROW_HEIGHT = 26;
const LINE_HEIGHT = 20;
// Engines stop laying out tall boxes at about 2^25 px; past this height a
// scrolled pixel moves more than one pixel of rows.
const MAX_SCROLL_HEIGHT = 8_000_000;
const OVERSCAN = 8;
const SEARCH_DELAY_MS = 150;
// Characters of a text line drawn; the full value is in the tree.
const LINE_CAP = 4000;
// A field box's height (with the gap below it) until one of its kind is
// measured: a primitive's one line of value, an object's or array's few.
const FIELD_ESTIMATES = [60, 140];
const FIELD_OVERSCAN = 4;
const DEPTHS = [1, 2, 3, 4, 5];
const EMPTY = new Int32Array(0);

const states = new WeakMap<object, ExplorerState>();

function stateOf(doc: object): ExplorerState {
  let state = states.get(doc);
  if (state === undefined) {
    const index = buildIndex(doc);
    const open = new Uint8Array(index.count);
    open[0] = 1;
    state = { index, open, selected: 0, lines: null, lowerLines: null, spans: null };
    states.set(doc, state);
  }
  return state;
}

function linesOf(state: ExplorerState, doc: object, stored: string | null): string[] {
  if (state.lines === null) {
    state.lines = stored !== null ? prettyLines(stored) : JSON.stringify(doc, null, 2).split("\n");
  }
  return state.lines;
}

// Past a node's object key on its first line: `"key": {` reads `{`.
function afterKey(line: string, at: number): number {
  let end = at + 1;
  for (;;) {
    end = line.indexOf('"', end);
    if (end < 0) {
      return at;
    }
    let slashes = 0;
    while (line.charCodeAt(end - 1 - slashes) === 92) {
      slashes += 1;
    }
    if (slashes % 2 === 0) {
      return end + 3;
    }
    end += 1;
  }
}

// A container's lines as its field box and copy give them. They come from
// the document's cached lines, so showing a node costs no re-indenting and
// keeps numbers exactly as stored.
function sliceOf(state: ExplorerState, doc: object, stored: string | null, id: number): LineSlice | null {
  const lines = linesOf(state, doc, stored);
  if (state.spans === null) {
    const spans = lineSpans(state.index);
    state.spans = spans.total === lines.length ? spans : false;
  }
  if (state.spans === false) {
    let own: string[];
    try {
      own = JSON.stringify(state.index.values[id], null, 2).split("\n");
    } catch {
      return null;
    }
    return { lines: own, from: 0, count: own.length, indent: 0, head: own[0], tail: own[own.length - 1] };
  }
  const from = state.spans.starts[id];
  const close = state.spans.closes[id];
  const indent = state.index.depths[id] * 2;
  const parent = state.index.parents[id];
  const first = lines[from];
  let head = first.slice(parent >= 0 && state.index.kinds[parent] === 0 ? afterKey(first, indent) : indent);
  let tail = lines[close].slice(indent);
  if (tail.endsWith(",")) {
    tail = tail.slice(0, -1);
  }
  if (close === from) {
    head = tail = head.endsWith(",") ? head.slice(0, -1) : head;
  }
  return { lines, from, count: close - from + 1, indent, head, tail };
}

function sliceText(slice: LineSlice): string {
  const out = [slice.head];
  for (let at = 1; at < slice.count - 1; at += 1) {
    out.push(slice.lines[slice.from + at].slice(slice.indent));
  }
  if (slice.count > 1) {
    out.push(slice.tail);
  }
  return out.join("\n");
}

function searchLines(state: ExplorerState, lines: string[], needle: string): Int32Array {
  if (state.lowerLines === null) {
    state.lowerLines = lines.map((line) => line.toLowerCase());
  }
  const found = new Int32Array(lines.length);
  let count = 0;
  state.lowerLines.forEach((line, at) => {
    if (line.includes(needle)) {
      found[count] = at;
      count += 1;
    }
  });
  return found.subarray(0, count);
}

function utf8Length(text: string): number {
  let bytes = 0;
  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code < 0xdc00) {
      // A surrogate pair is one four-byte character.
      bytes += 4;
      at += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

// The text with each case-insensitive occurrence of the (lower-cased) needle marked.
function marked(text: string, needle: string): ReactNode {
  if (needle === "") {
    return text;
  }
  let lower = text.toLowerCase();
  // Lower-casing can change the length ("İ" becomes two characters); then
  // each lower-cased position maps back to the character it came from.
  let origin: number[] | null = null;
  if (lower.length !== text.length) {
    const pieces: string[] = [];
    origin = [];
    for (let at = 0; at < text.length; ) {
      const width = text.codePointAt(at)! > 0xffff ? 2 : 1;
      const piece = text.slice(at, at + width).toLowerCase();
      pieces.push(piece);
      for (let k = 0; k < piece.length; k += 1) {
        origin.push(at);
      }
      at += width;
    }
    origin.push(text.length);
    lower = pieces.join("");
  }
  const parts: ReactNode[] = [];
  let from = 0;
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + needle.length)) {
    let start = at;
    let end = at + needle.length;
    if (origin !== null) {
      start = origin[at];
      // A match ending inside a character's lower-case form covers that character.
      let next = end;
      while (next < lower.length && origin[next] === origin[end - 1]) {
        next += 1;
      }
      end = origin[next];
    }
    start = Math.max(from, start);
    parts.push(text.slice(from, start), <mark key={at}>{text.slice(start, end)}</mark>);
    from = end;
  }
  if (parts.length === 0) {
    return text;
  }
  parts.push(text.slice(from));
  return parts;
}

interface ScrollRequest {
  position: number;
  align: "nearest" | "center";
}

interface VirtualListProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  count: number;
  rowHeight: number;
  // A row's element, placed with the given style (its key is the caller's).
  renderRow(position: number, style: CSSProperties): ReactNode;
  // Scrolls a row into view; each new request object scrolls once.
  request: ScrollRequest | null;
  listRef?: Ref<HTMLDivElement>;
  contentWidth?: string;
}

// A scroller that draws only the rows in view, so its cost does not grow with
// the row count.
function VirtualList({
  count,
  rowHeight,
  renderRow,
  request,
  listRef,
  contentWidth,
  className,
  ...rest
}: VirtualListProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);
  const full = count * rowHeight;
  const height = Math.min(full, MAX_SCROLL_HEIGHT);
  const ratio = full > height && height > viewport ? (full - viewport) / (height - viewport) : 1;
  const offset = scrollTop * ratio;
  const first = Math.max(0, Math.floor(offset / rowHeight) - OVERSCAN);
  const last = Math.min(count, Math.ceil((offset + viewport) / rowHeight) + OVERSCAN);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null) {
      return;
    }
    setViewport(host.clientHeight);
    const observer = new ResizeObserver(() => setViewport(host.clientHeight));
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null || request === null || request.position < 0) {
      return;
    }
    const view = host.clientHeight;
    const top = request.position * rowHeight;
    const current = host.scrollTop * ratio;
    let target: number;
    if (request.align === "center") {
      target = top - (view - rowHeight) / 2;
    } else if (top < current) {
      target = top;
    } else if (top + rowHeight > current + view) {
      target = top + rowHeight - view;
    } else {
      return;
    }
    host.scrollTop = Math.max(0, target / ratio);
    setScrollTop(host.scrollTop);
    // Only a new request scrolls; the rows changing under it does not.
  }, [request]);

  const rows: ReactNode[] = [];
  for (let position = first; position < last; position += 1) {
    rows.push(renderRow(position, { top: scrollTop + position * rowHeight - offset, height: rowHeight }));
  }
  return (
    <div
      {...rest}
      className={`json-view-list${className ? ` ${className}` : ""}`}
      ref={(node) => {
        hostRef.current = node;
        if (typeof listRef === "function") {
          listRef(node);
        } else if (listRef) {
          listRef.current = node;
        }
      }}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div className="json-view-list-inner" style={{ height, width: contentWidth }}>
        {rows}
      </div>
    </div>
  );
}

interface LinesViewProps {
  lines: string[];
  needle: string;
  // The line the search is on, drawn as current.
  current: number;
  request: ScrollRequest | null;
  label: string;
  listRef?: Ref<HTMLDivElement>;
}

// Indented JSON as numbered lines, windowed like the tree.
function LinesView({ lines, needle, current, request, label, listRef }: LinesViewProps) {
  const digits = String(lines.length).length;
  const longest = useMemo(() => lines.reduce((most, line) => Math.max(most, line.length), 0), [lines]);
  return (
    <VirtualList
      className="json-view-lines"
      listRef={listRef}
      tabIndex={0}
      aria-label={label}
      count={lines.length}
      rowHeight={LINE_HEIGHT}
      request={request}
      contentWidth={`calc(${Math.min(longest, LINE_CAP + 12) + digits + 2}ch + 32px)`}
      renderRow={(position, style) => {
        const line = lines[position];
        const clipped = line.length > LINE_CAP;
        return (
          <div key={position} className={`json-view-line${position === current ? " current" : ""}`} style={style}>
            <span className="json-view-line-no" style={{ width: `${digits}ch` }}>
              {position + 1}
            </span>
            <span className="json-view-line-text">{marked(clipped ? line.slice(0, LINE_CAP) : line, needle)}</span>
            {clipped ? (
              <span className="json-view-line-more">
                {t("… {count}자 더", { count: (line.length - LINE_CAP).toLocaleString() })}
              </span>
            ) : null}
          </div>
        );
      }}
    />
  );
}

interface ExplorerFieldProps {
  state: ExplorerState;
  doc: object;
  stored: string | null;
  id: number;
}

// One node as a field box: its key, its type, and its value, an object or
// array indented as stored.
const ExplorerField = memo(function ExplorerField({ state, doc, stored, id }: ExplorerFieldProps) {
  const { index } = state;
  const text = useMemo(() => {
    if (!isContainer(index, id)) {
      return undefined;
    }
    const slice = sliceOf(state, doc, stored, id);
    return slice === null ? undefined : sliceText(slice);
  }, [state, doc, stored, id]);
  const kind = kindAt(index, id);
  return <FieldBox name={index.keys[id]} type={kind} value={index.values[id]} text={text} showAll json={kind} />;
});

interface FieldListProps {
  state: ExplorerState;
  doc: object;
  stored: string | null;
  ids: Int32Array;
  label: string;
}

// A container's members as field boxes, drawing only those in view. Boxes
// differ in height: each is measured once drawn, the rest are taken at the
// average of those measured, and the box at the view's top stays put while
// the guesses firm up.
function FieldList({ state, doc, stored, ids, label }: FieldListProps) {
  const { index } = state;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);
  // Heights by box, and their sums and counts by kind (0 a primitive or an
  // empty container, 1 a container with members).
  const [sizes] = useState(() => ({
    heights: new Float64Array(ids.length),
    known: new Uint8Array(ids.length),
    kinds: Uint8Array.from(ids, (id) => (isContainer(index, id) && index.sizes[id] > 0 ? 1 : 0)),
    sum: [0, 0],
    count: [0, 0],
  }));
  // Counts measurements that changed a height.
  const [measured, setMeasured] = useState(0);
  const tops = useMemo(() => {
    const { heights, known, kinds, sum, count } = sizes;
    const guess = [0, 1].map((kind) => (count[kind] > 0 ? sum[kind] / count[kind] : FIELD_ESTIMATES[kind]));
    const out = new Float64Array(ids.length + 1);
    for (let at = 0; at < ids.length; at += 1) {
      out[at + 1] = out[at] + (known[at] === 1 ? heights[at] : guess[kinds[at]]);
    }
    return out;
  }, [sizes, ids, measured]);
  const full = tops[ids.length];
  const height = Math.min(full, MAX_SCROLL_HEIGHT);
  const ratio = full > height && height > viewport ? (full - viewport) / (height - viewport) : 1;
  const offset = scrollTop * ratio;
  // The last box starting at or above the view's top.
  let low = 0;
  let high = ids.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (tops[middle] <= offset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  let last = low;
  while (last < ids.length && tops[last] < offset + viewport) {
    last += 1;
  }
  const first = Math.max(0, low - FIELD_OVERSCAN);
  last = Math.min(ids.length, last + FIELD_OVERSCAN);
  // The box at the view's top as last drawn, and how far into it.
  const anchor = useRef({ position: 0, into: 0 });

  const [observer] = useState(
    () =>
      new ResizeObserver((entries) => {
        const { heights, known, kinds, sum, count } = sizes;
        let changed = false;
        for (const entry of entries) {
          const node = entry.target as HTMLElement;
          const position = Number(node.dataset.position);
          const size = entry.borderBoxSize?.[0]?.blockSize ?? node.offsetHeight;
          if (!(position < heights.length) || size <= 0) {
            continue;
          }
          const kind = kinds[position];
          if (known[position] === 0) {
            known[position] = 1;
            count[kind] += 1;
          } else if (Math.abs(size - heights[position]) < 0.5) {
            continue;
          } else {
            sum[kind] -= heights[position];
          }
          sum[kind] += size;
          heights[position] = size;
          changed = true;
        }
        // Placed again before the frame is painted, so boxes never overlap.
        if (changed) {
          flushSync(() => setMeasured((value) => value + 1));
        }
      }),
  );
  useEffect(() => () => observer.disconnect(), [observer]);
  const measure = useCallback(
    (node: HTMLDivElement | null) => {
      if (node === null) {
        return;
      }
      observer.observe(node);
      return () => observer.unobserve(node);
    },
    [observer],
  );

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null) {
      return;
    }
    setViewport(host.clientHeight);
    const resize = new ResizeObserver(() => setViewport(host.clientHeight));
    resize.observe(host);
    return () => resize.disconnect();
  }, []);

  // Measuring moved the boxes: the one at the view's top goes back to where
  // it was drawn.
  useLayoutEffect(() => {
    const host = hostRef.current;
    const { position, into } = anchor.current;
    if (host === null || position >= ids.length) {
      return;
    }
    const target = Math.max(0, (tops[position] + into) / ratio);
    if (Math.abs(host.scrollTop - target) >= 1) {
      host.scrollTop = target;
      setScrollTop(host.scrollTop);
    }
  }, [tops]);

  useLayoutEffect(() => {
    anchor.current = { position: low, into: offset - tops[low] };
  });

  const boxes: ReactNode[] = [];
  for (let position = first; position < last; position += 1) {
    boxes.push(
      <div
        key={position}
        className="json-view-field"
        data-position={position}
        ref={measure}
        style={{ top: scrollTop + tops[position] - offset }}
      >
        <ExplorerField state={state} doc={doc} stored={stored} id={ids[position]} />
      </div>,
    );
  }
  return (
    <div
      className="json-view-list json-view-fields"
      ref={hostRef}
      tabIndex={0}
      aria-label={label}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div className="json-view-list-inner" style={{ height }}>
        {boxes}
      </div>
    </div>
  );
}

export function JsonExplorer({
  doc,
  stored,
  title,
  label,
  dialogRef,
  onDialogKeyDown,
  onCollapse,
  onClose,
  embedded,
  controlsTarget = null,
  onStats,
}: JsonExplorerProps) {
  const state = useMemo(() => stateOf(doc), [doc]);
  const { index, open } = state;
  // The open flags live in `open`; this counts their changes.
  const [version, setVersion] = useState(0);
  const [selected, setSelected] = useState(state.selected);
  const [raw, setRaw] = useState(false);
  const [query, setQuery] = useState("");
  const [needle, setNeedle] = useState("");
  const [matchAt, setMatchAt] = useState(-1);
  const [treeRequest, setTreeRequest] = useState<{ id: number; align: ScrollRequest["align"] } | null>(null);
  const [lineRequest, setLineRequest] = useState<ScrollRequest | null>(null);
  const [copied, setCopied] = useState<"path" | "value" | null>(null);
  const treeRef = useRef<HTMLDivElement | null>(null);
  const rawRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const crumbsRef = useRef<HTMLDivElement | null>(null);
  const copiedTimer = useRef(0);
  const [foldMenu, setFoldMenu] = useState<{ x: number; y: number; anchor: Element } | null>(null);
  const compact = embedded === true;

  const visible = useMemo(() => visibleIds(index, open), [index, open, version]);
  const lines = raw ? linesOf(state, doc, stored) : null;
  const lowerNeedle = needle.toLowerCase();
  const matches = useMemo(() => {
    if (needle === "") {
      return EMPTY;
    }
    return lines !== null ? searchLines(state, lines, lowerNeedle) : searchIndex(index, needle);
  }, [state, index, lines, needle, lowerNeedle]);
  const currentMatch = matchAt >= 0 && matchAt < matches.length ? matches[matchAt] : -1;
  const size = useMemo(() => (stored !== null ? formatBytes(utf8Length(stored)) : null), [stored]);
  // The value pane follows the pick in a deferred render: the tree paints
  // first, and stepping through large subtrees never waits on indenting them.
  const shown = useDeferredValue(selected, -1);
  const members = useMemo(() => (shown < 0 ? EMPTY : childIds(index, shown)), [index, shown]);
  const treeScroll = useMemo<ScrollRequest | null>(
    () => (treeRequest === null ? null : { position: positionOf(visible, treeRequest.id), align: treeRequest.align }),
    // A request scrolls once, against the rows it was made for.
    [treeRequest],
  );
  const chain = useMemo(() => lineage(index, selected), [index, selected]);

  useEffect(() => {
    state.selected = selected;
  }, [state, selected]);

  useEffect(() => {
    (raw ? rawRef : treeRef).current?.focus({ preventScroll: true });
  }, [raw]);

  useEffect(() => {
    const timer = window.setTimeout(() => setNeedle(query.trim()), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  // A new search goes to the first match from the pick (or the top of the text).
  useEffect(() => {
    if (matches.length === 0) {
      setMatchAt(-1);
      return;
    }
    const from = lines !== null ? 0 : selected;
    let at = 0;
    while (at < matches.length && matches[at] < from) {
      at += 1;
    }
    goToMatch(at === matches.length ? 0 : at);
  }, [matches]);

  // The breadcrumb ends at the picked node: keep that end in view.
  useLayoutEffect(() => {
    const crumbs = crumbsRef.current;
    if (crumbs !== null) {
      crumbs.scrollLeft = crumbs.scrollWidth;
    }
  }, [chain]);

  function select(id: number, align: ScrollRequest["align"] | null = null): void {
    setSelected(id);
    if (align !== null) {
      setTreeRequest({ id, align });
    }
  }

  function goToMatch(at: number): void {
    const target = matches[at];
    setMatchAt(at);
    if (lines !== null) {
      setLineRequest({ position: target, align: "center" });
      return;
    }
    openTo(index, open, target);
    setVersion((value) => value + 1);
    select(target, "center");
  }

  function step(delta: number): void {
    if (matches.length > 0) {
      goToMatch((Math.max(matchAt, 0) + delta + matches.length) % matches.length);
    }
  }

  // After closing nodes the pick moves up to the nearest node still shown.
  function keepPickShown(): void {
    const hidden = lineage(index, selected).find((id) => id !== selected && open[id] === 0);
    if (hidden !== undefined) {
      select(hidden);
    }
  }

  // Nodes opening or closing: their rows drop in or fade out, the rows below glide.
  const prepareRows = useRowMotion(treeRef);

  function changed(): void {
    prepareRows();
    setVersion((value) => value + 1);
    keepPickShown();
  }

  function toggle(id: number, subtree = false): void {
    const next = open[id] === 1 ? 0 : 1;
    if (subtree) {
      setSubtree(index, open, id, next);
    } else {
      open[id] = next;
    }
    changed();
  }

  function expandAll(): void {
    open.fill(1);
    changed();
  }

  function collapseAll(): void {
    openToDepth(index, open, 1);
    changed();
  }

  function expandToDepth(depth: number): void {
    openToDepth(index, open, depth);
    changed();
  }

  function copy(what: "path" | "value"): void {
    // The whole document goes out as stored; a node as its indented lines.
    let text: string;
    if (what === "path") {
      text = pathOf(index, selected);
    } else if (selected === 0 && stored !== null) {
      text = stored;
    } else if (isContainer(index, selected)) {
      const slice = sliceOf(state, doc, stored, selected);
      if (slice === null) {
        return;
      }
      text = sliceText(slice);
    } else {
      text = primitiveText(index.values[selected]);
    }
    void writeClipboard(text).then((ok) => {
      if (!ok) {
        return;
      }
      setCopied(what);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(null), 1200);
    });
  }

  function onTreeKey(event: KeyboardEvent<HTMLDivElement>): void {
    const position = positionOf(visible, selected);
    const container = isContainer(index, selected);
    const page = Math.max(1, Math.floor((treeRef.current?.clientHeight ?? ROW_HEIGHT) / ROW_HEIGHT) - 1);
    const at = (target: number) => visible[Math.min(visible.length - 1, Math.max(0, target))];
    let handled = true;
    if (event.key === "ArrowDown") {
      select(at(position + 1), "nearest");
    } else if (event.key === "ArrowUp") {
      select(at(position - 1), "nearest");
    } else if (event.key === "PageDown") {
      select(at(position + page), "nearest");
    } else if (event.key === "PageUp") {
      select(at(position - page), "nearest");
    } else if (event.key === "Home") {
      select(0, "nearest");
    } else if (event.key === "End") {
      select(at(visible.length - 1), "nearest");
    } else if (event.key === "ArrowRight") {
      if (container && open[selected] === 0) {
        toggle(selected, event.altKey);
      } else if (container && index.sizes[selected] > 0) {
        select(selected + 1, "nearest");
      }
    } else if (event.key === "ArrowLeft") {
      if (container && open[selected] === 1) {
        toggle(selected, event.altKey);
      } else if (index.parents[selected] >= 0) {
        select(index.parents[selected], "nearest");
      }
    } else if ((event.key === "Enter" || event.key === " ") && container && !event.metaKey && !event.ctrlKey) {
      toggle(selected);
    } else if (matchesBinding(event.nativeEvent, "Mod+c")) {
      copy("value");
    } else if (/^[1-9]$/.test(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey) {
      expandToDepth(Number(event.key));
    } else {
      handled = false;
    }
    if (handled) {
      event.preventDefault();
    }
  }

  const subtreeHint = t("{key}+클릭: 하위까지 모두 펼치기·접기", { key: IS_MAC ? "⌥" : "Alt" });

  useEffect(() => {
    onStats?.(index.count);
  }, [index, onStats]);

  const depths = DEPTHS.filter((depth) => depth <= Math.max(1, index.maxDepth));
  const modeSwitch = (
    <div className="segmented json-view-mode" role="group" aria-label={t("보기")}>
      <button type="button" className={raw ? "" : "active"} aria-pressed={!raw} onClick={() => setRaw(false)}>
        {t("트리")}
      </button>
      <button type="button" className={raw ? "active" : ""} aria-pressed={raw} onClick={() => setRaw(true)}>
        Raw
      </button>
    </div>
  );
  const searchBox = (
    <label className={`field-search json-view-search${compact ? " compact" : ""}`}>
      <SearchIcon size={12} />
      <input
        ref={searchRef}
        placeholder={raw ? t("원문 검색…") : t("키·값 검색…")}
        title={withHint(t("검색"), formatBinding("Mod+f"))}
        aria-label={t("검색")}
        value={query}
        spellCheck={false}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          // ⌘↩ is left to the dialog, which switches to the small view.
          if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
            event.preventDefault();
            // Pressed before the typing settles, the search runs now.
            if (query.trim() !== needle) {
              setNeedle(query.trim());
            } else {
              step(event.shiftKey ? -1 : 1);
            }
          } else if (event.key === "Escape" && query !== "") {
            event.preventDefault();
            event.stopPropagation();
            setQuery("");
          }
        }}
      />
      {needle !== "" ? (
        <span className={`json-view-count${matches.length === 0 ? " none" : ""}`}>
          {matches.length === 0
            ? t("결과 없음")
            : `${(matchAt + 1).toLocaleString()} / ${matches.length.toLocaleString()}`}
        </span>
      ) : null}
    </label>
  );
  const stepButtons = (
    <>
      <button
        type="button"
        className="icon-button"
        title={withHint(t("이전 결과"), "⇧↩")}
        aria-label={t("이전 결과")}
        disabled={matches.length === 0}
        onClick={() => step(-1)}
      >
        <ChevronDownIcon size={11} className="flip" />
      </button>
      <button
        type="button"
        className="icon-button"
        title={withHint(t("다음 결과"), "↩")}
        aria-label={t("다음 결과")}
        disabled={matches.length === 0}
        onClick={() => step(1)}
      >
        <ChevronDownIcon size={11} />
      </button>
    </>
  );
  const crumbs = (
    <div className="json-view-crumbs" ref={crumbsRef}>
      {chain.map((id, depth) => (
        <span key={id} className="json-view-crumb-step">
          {depth > 0 ? <span className="json-view-crumb-sep">›</span> : null}
          <button
            type="button"
            className={`json-view-crumb${id === selected ? " current" : ""}`}
            onClick={() => select(id, "center")}
          >
            {id === 0
              ? "$"
              : kindAt(index, index.parents[id]) === "array"
                ? `[${index.keys[id]}]`
                : index.keys[id]}
          </button>
        </span>
      ))}
    </div>
  );
  const foldItems = (): ContextMenuItem[] => [
    { label: t("모두 펼치기"), onSelect: expandAll },
    { label: t("모두 접기"), onSelect: collapseAll },
    ...depths.map((depth, at) => ({
      label: t("깊이 {depth}까지 펼치기", { depth }),
      separatorBefore: at === 0,
      onSelect: () => expandToDepth(depth),
    })),
  ];
  // Embedded: the controls in the host's toolbar, as few and small as they go.
  const hostControls =
    compact && controlsTarget !== null
      ? createPortal(
          <div className="json-view-controls">
            {modeSwitch}
            {searchBox}
            {stepButtons}
            {!raw ? (
              <button
                type="button"
                className="icon-button"
                title={t("펼치기·접기 (1–9: 그 깊이까지)")}
                aria-label={t("펼치기·접기")}
                aria-haspopup="menu"
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  setFoldMenu(foldMenu !== null ? null : { x: rect.left, y: rect.bottom + 4, anchor: event.currentTarget });
                }}
              >
                <UpDownIcon size={11} />
              </button>
            ) : (
              <span className="json-view-meta">{t("{count}줄", { count: (lines?.length ?? 0).toLocaleString() })}</span>
            )}
            {foldMenu !== null ? (
              <ContextMenu x={foldMenu.x} y={foldMenu.y} anchor={foldMenu.anchor} items={foldItems()} onClose={() => setFoldMenu(null)} />
            ) : null}
          </div>,
          controlsTarget,
        )
      : null;

  return (
    <div
      className={`json-view${embedded === true ? " embedded" : ""}`}
      ref={dialogRef}
      role={embedded === true ? "region" : "dialog"}
      aria-modal={embedded === true ? undefined : "true"}
      aria-label={label}
      tabIndex={-1}
      onContextMenu={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (matchesBinding(event.nativeEvent, "Mod+f")) {
          event.preventDefault();
          searchRef.current?.focus();
          searchRef.current?.select();
          return;
        }
        onDialogKeyDown?.(event);
      }}
    >
      {compact ? (
        hostControls
      ) : (
        <>
          <div className="json-view-head">
            <span className="json-view-title">{title}</span>
            <span className="json-view-meta">
              {t("노드 {count}개", { count: index.count.toLocaleString() })}
              {size !== null ? ` · ${size}` : ""}
            </span>
            <span className="spacer" />
            {modeSwitch}
            {onCollapse !== undefined ? (
              <button
                type="button"
                className="icon-button"
                title={withHint(t("작게 보기"), `Esc · ${formatBinding("Mod+Enter")}`)}
                aria-label={t("작게 보기")}
                onClick={onCollapse}
              >
                <ShrinkIcon size={11} />
              </button>
            ) : null}
            {onClose !== undefined ? (
              <button type="button" className="icon-button" title={t("닫기")} aria-label={t("닫기")} onClick={onClose}>
                <CloseIcon size={11} />
              </button>
            ) : null}
          </div>
          <div className="json-view-tools">
            {searchBox}
            {stepButtons}
            <span className="spacer" />
            {raw ? (
              <span className="json-view-meta">{t("{count}줄", { count: (lines?.length ?? 0).toLocaleString() })}</span>
            ) : (
              <>
                <button type="button" onClick={expandAll}>
                  {t("모두 펼치기")}
                </button>
                <button type="button" onClick={collapseAll}>
                  {t("모두 접기")}
                </button>
                <span className="json-view-depth-label">{t("깊이")}</span>
                <div className="segmented json-view-depth" role="group" aria-label={t("이 깊이까지 펼치기")}>
                  {depths.map((depth) => (
                    <button
                      type="button"
                      key={depth}
                      title={withHint(t("깊이 {depth}까지 펼치기", { depth }), String(depth))}
                      onClick={() => expandToDepth(depth)}
                    >
                      {depth}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </>
      )}
      {raw && lines !== null ? (
        <div className="json-view-body">
          <LinesView
            lines={lines}
            needle={lowerNeedle}
            current={currentMatch}
            request={lineRequest}
            label={t("원문")}
            listRef={rawRef}
          />
        </div>
      ) : (
        <>
          {compact ? null : (
            <div className="json-view-path">
              {crumbs}
              <button type="button" onClick={() => copy("path")}>
                <CopyIcon size={10} />
                {copied === "path" ? t("복사했습니다") : t("경로 복사")}
              </button>
              <button type="button" onClick={() => copy("value")} title={withHint(t("값 복사"), formatBinding("Mod+c"))}>
                <CopyIcon size={10} />
                {copied === "value" ? t("복사했습니다") : t("값 복사")}
              </button>
            </div>
          )}
          <div className="json-view-body">
            <VirtualList
              className="cell-pop-tree json-view-tree"
              listRef={treeRef}
              role="tree"
              aria-label={label}
              tabIndex={0}
              onKeyDown={onTreeKey}
              count={visible.length}
              rowHeight={ROW_HEIGHT}
              request={treeScroll}
              renderRow={(position, style) => {
                const id = visible[position];
                const kind = kindAt(index, id);
                const container = isContainer(index, id);
                const isOpen = open[id] === 1;
                const inArray = id > 0 && kindAt(index, index.parents[id]) === "array";
                return (
                  <div
                    key={id}
                    data-row-key={id}
                    role="treeitem"
                    aria-level={index.depths[id] + 1}
                    aria-selected={id === selected}
                    aria-expanded={container ? isOpen : undefined}
                    className={`cell-pop-row${id === selected ? " selected" : ""}${id === currentMatch ? " match" : ""}`}
                    style={{ ...style, paddingLeft: 10 + index.depths[id] * 16 }}
                    title={kind}
                    onMouseDown={() => select(id)}
                    onDoubleClick={() => {
                      if (container) {
                        toggle(id);
                      }
                    }}
                  >
                    {container ? (
                      <span
                        className={`cell-pop-chevron${isOpen ? " open" : ""}`}
                        title={subtreeHint}
                        onMouseDown={(event) => {
                          event.stopPropagation();
                          select(id);
                          toggle(id, event.altKey);
                        }}
                      >
                        <ChevronIcon size={10} />
                      </span>
                    ) : (
                      <span className="cell-pop-chevron-space" />
                    )}
                    <span className={`cell-pop-key${inArray ? " index" : ""}`}>
                      {id === 0 ? "ROOT" : inArray ? index.keys[id] : marked(index.keys[id], lowerNeedle)}
                    </span>
                    {container ? (
                      <span className="cell-pop-size">{containerSize(kind, index.sizes[id])}</span>
                    ) : (
                      <>
                        <span className="cell-pop-colon">:</span>
                        <span className={`cell-pop-value jv-${inkOf(kind, index.values[id])}`}>
                          {marked(inlineText(kind, index.values[id]), lowerNeedle)}
                        </span>
                      </>
                    )}
                  </div>
                );
              }}
            />
            {/* The picked node as the popover's right side shows it: an
                object's or array's members as field boxes, or the value alone. */}
            <div className="json-view-value">
              {compact ? (
                <div className="json-view-pane-head">
                  {crumbs}
                  <button
                    type="button"
                    className="icon-button"
                    title={copied === "path" ? t("복사했습니다") : t("경로 복사")}
                    aria-label={t("경로 복사")}
                    onClick={() => copy("path")}
                  >
                    <CopyIcon size={10} />
                    <span className="json-view-pane-tag">{t("경로")}</span>
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    title={copied === "value" ? t("복사했습니다") : withHint(t("값 복사"), formatBinding("Mod+c"))}
                    aria-label={t("값 복사")}
                    onClick={() => copy("value")}
                  >
                    <CopyIcon size={10} />
                    <span className="json-view-pane-tag">{t("값")}</span>
                  </button>
                </div>
              ) : null}
              {shown < 0 ? null : !isContainer(index, shown) ? (
                <div className="field-list json-view-single">
                  <ExplorerField key={shown} state={state} doc={doc} stored={stored} id={shown} />
                </div>
              ) : members.length === 0 ? (
                <div className="panel-empty">{kindAt(index, shown) === "array" ? "[]" : "{}"}</div>
              ) : (
                <FieldList key={shown} state={state} doc={doc} stored={stored} ids={members} label={t("값")} />
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

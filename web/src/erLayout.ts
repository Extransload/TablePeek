// Automatic placement of the ER diagram's table cards.
//
// Tables joined by foreign keys are laid out per connected group in columns
// (layers) by key direction: a referenced table sits left of the tables that
// refer to it. Within each layer the order is chosen by barycenter sweeps to
// cut crossings, then cards are pulled level with their neighbours. Very tall
// layers wrap into side-by-side columns and very wide groups fold into bands
// stacked downwards. Groups are packed in rows, largest first; tables without
// any key relation follow in a compact grid underneath, by name.

export interface LayoutNode {
  id: string;
  width: number;
  height: number;
}

// `from` holds the foreign key, `to` is the table it refers to.
export interface LayoutEdge {
  from: string;
  to: string;
}

export interface Point {
  x: number;
  y: number;
}

const LAYER_GAP = 110;
const SUBCOLUMN_GAP = 40;
const NODE_GAP = 28;
const GROUP_GAP = 90;
const SINGLES_GAP = 32;
const SWEEPS = 12;
// Groups wider than this may be folded into up to MAX_BANDS bands, aiming
// at a VIEW_ASPECT (width / height) picture.
const BAND_MIN_WIDTH = 3000;
const MAX_BANDS = 8;
const VIEW_ASPECT = 1.5;

interface Placed {
  positions: Map<string, Point>;
  width: number;
  height: number;
}

export function layoutDiagram(nodes: LayoutNode[], edges: LayoutEdge[]): Map<string, Point> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const parents = new Map<string, Set<string>>();
  const children = new Map<string, Set<string>>();
  for (const node of nodes) {
    parents.set(node.id, new Set());
    children.set(node.id, new Set());
  }
  for (const edge of edges) {
    if (edge.from === edge.to || !byId.has(edge.from) || !byId.has(edge.to)) {
      continue;
    }
    parents.get(edge.from)!.add(edge.to);
    children.get(edge.to)!.add(edge.from);
  }

  // Connected groups, each found from its first table by name.
  const sorted = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const seen = new Set<string>();
  const groups: string[][] = [];
  const singles: LayoutNode[] = [];
  for (const node of sorted) {
    if (seen.has(node.id)) {
      continue;
    }
    seen.add(node.id);
    if (parents.get(node.id)!.size === 0 && children.get(node.id)!.size === 0) {
      singles.push(node);
      continue;
    }
    const group: string[] = [];
    const queue = [node.id];
    while (queue.length > 0) {
      const id = queue.shift()!;
      group.push(id);
      for (const next of [...parents.get(id)!, ...children.get(id)!]) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    groups.push(group);
  }

  const placed = groups.map((group) => layoutGroup(group, byId, parents));
  const positions = new Map<string, Point>();

  // Groups go in rows, largest first, wrapping at a width that keeps the
  // whole picture roughly landscape.
  placed.sort((a, b) => b.width * b.height - a.width * a.height);
  const area = placed.reduce((sum, group) => sum + (group.width + GROUP_GAP) * (group.height + GROUP_GAP), 0);
  const singlesArea = singles.reduce((sum, node) => sum + (node.width + SINGLES_GAP) * (node.height + SINGLES_GAP), 0);
  const widest = Math.max(0, ...placed.map((group) => group.width));
  const rowWidth = Math.max(widest, Math.sqrt((area + singlesArea) * VIEW_ASPECT), 900);
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const group of placed) {
    if (x > 0 && x + group.width > rowWidth) {
      x = 0;
      y += rowHeight + GROUP_GAP;
      rowHeight = 0;
    }
    for (const [id, point] of group.positions) {
      positions.set(id, { x: point.x + x, y: point.y + y });
    }
    x += group.width + GROUP_GAP;
    rowHeight = Math.max(rowHeight, group.height);
  }
  const singlesTop = placed.length > 0 ? y + rowHeight + GROUP_GAP * 1.5 : 0;

  // Unrelated tables: equal columns, each card into the shortest one, which
  // keeps them in name order row by row.
  if (singles.length > 0) {
    const columnWidth = Math.max(...singles.map((node) => node.width)) + SINGLES_GAP;
    const count = Math.max(1, Math.min(singles.length, Math.floor((rowWidth + SINGLES_GAP) / columnWidth)));
    const bottoms = new Array<number>(count).fill(singlesTop);
    for (const node of singles) {
      let column = 0;
      for (let index = 1; index < count; index += 1) {
        if (bottoms[index] < bottoms[column] - 1) {
          column = index;
        }
      }
      positions.set(node.id, { x: column * columnWidth, y: bottoms[column] });
      bottoms[column] += node.height + SINGLES_GAP;
    }
  }
  return positions;
}

function layoutGroup(
  group: string[],
  byId: Map<string, LayoutNode>,
  parents: Map<string, Set<string>>,
): Placed {
  const members = new Set(group);

  // Break cycles: an edge that closes a loop in a depth-first walk is laid
  // out as if it pointed the other way.
  const up = new Map<string, string[]>(group.map((id) => [id, []]));
  const down = new Map<string, string[]>(group.map((id) => [id, []]));
  const state = new Map<string, 1 | 2>();
  for (const root of group) {
    if (state.has(root)) {
      continue;
    }
    const stack: { id: string; next: string[] }[] = [{ id: root, next: [...parents.get(root)!] }];
    state.set(root, 1);
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const parent = top.next.pop();
      if (parent === undefined) {
        state.set(top.id, 2);
        stack.pop();
        continue;
      }
      if (!members.has(parent)) {
        continue;
      }
      if (state.get(parent) === 1) {
        up.get(parent)!.push(top.id);
        down.get(top.id)!.push(parent);
        continue;
      }
      up.get(top.id)!.push(parent);
      down.get(parent)!.push(top.id);
      if (!state.has(parent)) {
        state.set(parent, 1);
        stack.push({ id: parent, next: [...parents.get(parent)!] });
      }
    }
  }

  // Layers: a table one right of the furthest table it refers to.
  const layer = new Map<string, number>();
  const visit = (id: string): number => {
    const known = layer.get(id);
    if (known !== undefined) {
      return known;
    }
    layer.set(id, 0);
    let value = 0;
    for (const parent of up.get(id)!) {
      value = Math.max(value, visit(parent) + 1);
    }
    layer.set(id, value);
    return value;
  };
  for (const id of group) {
    visit(id);
  }
  // A table nothing else is referred to by moves right, next to the nearest
  // table that refers to it, instead of waiting in the first layer.
  for (const id of group) {
    if (up.get(id)!.length === 0 && down.get(id)!.length > 0) {
      const nearest = Math.min(...down.get(id)!.map((child) => layer.get(child)!));
      layer.set(id, Math.max(0, nearest - 1));
    }
  }

  const depth = Math.max(...group.map((id) => layer.get(id)!)) + 1;
  const layers: string[][] = Array.from({ length: depth }, () => []);
  // First order: breadth-first from the busiest table, so related tables
  // start near each other.
  const busiest = [...group].sort(
    (a, b) => up.get(b)!.length + down.get(b)!.length - (up.get(a)!.length + down.get(a)!.length),
  )[0];
  const order: string[] = [busiest];
  const reached = new Set(order);
  for (let index = 0; index < order.length; index += 1) {
    const id = order[index];
    for (const next of [...up.get(id)!, ...down.get(id)!].sort()) {
      if (!reached.has(next)) {
        reached.add(next);
        order.push(next);
      }
    }
  }
  for (const id of order) {
    layers[layer.get(id)!].push(id);
  }

  const rank = new Map<string, number>();
  const setRanks = (): void => {
    for (const ids of layers) {
      ids.forEach((id, index) => rank.set(id, (index + 0.5) / ids.length));
    }
  };
  setRanks();
  const neighboursIn = (id: string, test: (other: number) => boolean): string[] =>
    [...up.get(id)!, ...down.get(id)!].filter((other) => test(layer.get(other)!));

  const reorder = (index: number, towards: -1 | 1): void => {
    const ids = layers[index];
    const keys = new Map<string, number>();
    for (const id of ids) {
      // The adjacent layer when it has neighbours, else any layer on that side.
      let others = neighboursIn(id, (other) => other === index + towards);
      if (others.length === 0) {
        others = neighboursIn(id, (other) => (towards < 0 ? other < index : other > index));
      }
      keys.set(
        id,
        others.length > 0 ? others.reduce((sum, other) => sum + rank.get(other)!, 0) / others.length : rank.get(id)!,
      );
    }
    ids.sort((a, b) => keys.get(a)! - keys.get(b)!);
    ids.forEach((id, position) => rank.set(id, (position + 0.5) / ids.length));
  };

  let best = layers.map((ids) => [...ids]);
  let bestCrossings = crossings(layers, layer, up, rank);
  for (let sweep = 0; sweep < SWEEPS && bestCrossings > 0; sweep += 1) {
    if (sweep % 2 === 0) {
      for (let index = 1; index < depth; index += 1) {
        reorder(index, -1);
      }
    } else {
      for (let index = depth - 2; index >= 0; index -= 1) {
        reorder(index, 1);
      }
    }
    const count = crossings(layers, layer, up, rank);
    if (count < bestCrossings) {
      bestCrossings = count;
      best = layers.map((ids) => [...ids]);
    }
  }
  best.forEach((ids, index) => {
    layers[index] = ids;
  });
  setRanks();

  // A layer taller than the group would otherwise be wide wraps into
  // side-by-side columns, keeping its order top to bottom, left to right.
  const area = group.reduce((sum, id) => {
    const node = byId.get(id)!;
    return sum + (node.width + LAYER_GAP) * (node.height + NODE_GAP);
  }, 0);
  const maxHeight = Math.max(1400, Math.sqrt(area / VIEW_ASPECT));

  const positions = new Map<string, Point>();
  const wrapped = new Set<number>();
  // Each layer's horizontal extent, for folding a wide group into bands.
  const blocks: { ids: string[]; x: number; width: number }[] = [];
  let x = 0;
  layers.forEach((ids, index) => {
    const start = x;
    const total =
      ids.reduce((sum, id) => sum + byId.get(id)!.height, 0) + Math.max(0, ids.length - 1) * NODE_GAP;
    const columns = Math.max(1, Math.ceil(total / maxHeight));
    if (columns > 1) {
      wrapped.add(index);
    }
    const perColumn = Math.ceil(ids.length / columns);
    for (let column = 0; column < columns; column += 1) {
      const slice = ids.slice(column * perColumn, (column + 1) * perColumn);
      const width = Math.max(0, ...slice.map((id) => byId.get(id)!.width));
      let y = 0;
      for (const id of slice) {
        positions.set(id, { x, y });
        y += byId.get(id)!.height + NODE_GAP;
      }
      x += width + (column < columns - 1 ? SUBCOLUMN_GAP : LAYER_GAP);
    }
    blocks.push({ ids, x: start, width: x - start - LAYER_GAP });
  });

  // Pull each card level with its neighbours on one side, keeping the
  // layer's order and spacing (least squares, by pool-adjacent-violators).
  const centre = (id: string): number => positions.get(id)!.y + byId.get(id)!.height / 2;
  const align = (index: number, towards: -1 | 1): void => {
    if (wrapped.has(index)) {
      return;
    }
    const ids = layers[index];
    const wanted: number[] = [];
    const weights: number[] = [];
    for (const id of ids) {
      const others = neighboursIn(id, (other) => (towards < 0 ? other < index : other > index)).filter(
        (other) => !wrapped.has(layer.get(other)!),
      );
      const half = byId.get(id)!.height / 2;
      if (others.length === 0) {
        wanted.push(positions.get(id)!.y);
        weights.push(0.05);
        continue;
      }
      const centres = others.map(centre).sort((a, b) => a - b);
      const middle = centres.length % 2 === 1
        ? centres[(centres.length - 1) / 2]
        : (centres[centres.length / 2 - 1] + centres[centres.length / 2]) / 2;
      wanted.push(middle - half);
      weights.push(1);
    }
    const tops = spaced(ids.map((id) => byId.get(id)!.height), wanted, weights);
    ids.forEach((id, position) => {
      positions.get(id)!.y = tops[position];
    });
  };
  for (let pass = 0; pass < 2; pass += 1) {
    for (let index = 1; index < depth; index += 1) {
      align(index, -1);
    }
    for (let index = depth - 2; index >= 0; index -= 1) {
      align(index, 1);
    }
  }
  for (let index = 1; index < depth; index += 1) {
    align(index, -1);
  }

  // A group far wider than tall (long chains of keys) is folded into bands
  // of whole layers stacked top to bottom, at the band count whose overall
  // shape fits a landscape view best.
  const extent = blocks.map((block) => {
    let top = Infinity;
    let bottom = -Infinity;
    for (const id of block.ids) {
      top = Math.min(top, positions.get(id)!.y);
      bottom = Math.max(bottom, positions.get(id)!.y + byId.get(id)!.height);
    }
    return { top, bottom };
  });
  const totalWidth = x - LAYER_GAP;
  const bandsFor = (count: number): number[][] => {
    const target = totalWidth / count;
    const bands: number[][] = [[]];
    blocks.forEach((block, index) => {
      const band = bands[bands.length - 1];
      if (band.length > 0 && block.x + block.width - blocks[band[0]].x > target * 1.05) {
        bands.push([index]);
      } else {
        band.push(index);
      }
    });
    return bands;
  };
  let bands = bandsFor(1);
  if (totalWidth > BAND_MIN_WIDTH) {
    let bestScore = 0;
    for (let count = 1; count <= Math.min(MAX_BANDS, blocks.length); count += 1) {
      const candidate = bandsFor(count);
      let width = 0;
      let height = -GROUP_GAP;
      for (const band of candidate) {
        const last = blocks[band[band.length - 1]];
        width = Math.max(width, last.x + last.width - blocks[band[0]].x);
        height +=
          Math.max(...band.map((index) => extent[index].bottom)) -
          Math.min(...band.map((index) => extent[index].top)) +
          GROUP_GAP;
      }
      const score = Math.min(VIEW_ASPECT / width, 1 / height);
      if (score > bestScore) {
        bestScore = score;
        bands = candidate;
      }
    }
  }

  let top = 0;
  let maxX = 0;
  for (const band of bands) {
    const left = blocks[band[0]].x;
    const bandTop = Math.min(...band.map((index) => extent[index].top));
    let bandBottom = top;
    for (const index of band) {
      for (const id of blocks[index].ids) {
        const point = positions.get(id)!;
        const node = byId.get(id)!;
        point.x -= left;
        point.y += top - bandTop;
        maxX = Math.max(maxX, point.x + node.width);
        bandBottom = Math.max(bandBottom, point.y + node.height);
      }
    }
    top = bandBottom + GROUP_GAP;
  }
  return { positions, width: maxX, height: top - GROUP_GAP };
}

// Tops for cards stacked in order with NODE_GAP between them, as close as
// possible (weighted least squares) to the tops wanted.
function spaced(heights: number[], wanted: number[], weights: number[]): number[] {
  // With offsets taken out the constraint is plain order: z[i] >= z[i-1].
  const offsets: number[] = [];
  let offset = 0;
  for (const height of heights) {
    offsets.push(offset);
    offset += height + NODE_GAP;
  }
  const blocks: { value: number; weight: number; count: number }[] = [];
  wanted.forEach((top, index) => {
    blocks.push({ value: top - offsets[index], weight: weights[index], count: 1 });
    while (blocks.length > 1 && blocks[blocks.length - 2].value > blocks[blocks.length - 1].value) {
      const last = blocks.pop()!;
      const prev = blocks[blocks.length - 1];
      const weight = prev.weight + last.weight;
      prev.value = (prev.value * prev.weight + last.value * last.weight) / weight;
      prev.weight = weight;
      prev.count += last.count;
    }
  });
  const tops: number[] = [];
  for (const block of blocks) {
    for (let index = 0; index < block.count; index += 1) {
      tops.push(block.value + offsets[tops.length]);
    }
  }
  return tops;
}

// Crossings between edges joining the same pair of adjacent layers.
function crossings(
  layers: string[][],
  layer: Map<string, number>,
  up: Map<string, string[]>,
  rank: Map<string, number>,
): number {
  let total = 0;
  for (let index = 1; index < layers.length; index += 1) {
    const pairs: [number, number][] = [];
    for (const id of layers[index]) {
      for (const parent of up.get(id)!) {
        if (layer.get(parent) === index - 1) {
          pairs.push([rank.get(parent)!, rank.get(id)!]);
        }
      }
    }
    for (let a = 0; a < pairs.length; a += 1) {
      for (let b = a + 1; b < pairs.length; b += 1) {
        if ((pairs[a][0] - pairs[b][0]) * (pairs[a][1] - pairs[b][1]) < 0) {
          total += 1;
        }
      }
    }
  }
  return total;
}

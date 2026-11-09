import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { mergeIntervals, type Interval } from '../src/intervals';

// Valid by construction: start plus a non-negative length. Never filter or fc.pre.
const interval: fc.Arbitrary<Interval> = fc
  .tuple(fc.integer({ min: -15, max: 15 }), fc.integer({ min: 0, max: 8 }))
  .map(([start, length]) => [start, start + length]);

const randomList = fc.array(interval, { maxLength: 12 });

// Place each next interval relative to the previous end so overlap, a shared
// endpoint, and a one-unit gap all show up often.
const clusteredList: fc.Arbitrary<Interval[]> = fc
  .tuple(
    fc.integer({ min: -10, max: 10 }),
    fc.array(
      fc.tuple(fc.integer({ min: -2, max: 3 }), fc.integer({ min: 0, max: 6 })),
      { minLength: 1, maxLength: 8 },
    ),
  )
  .map(([origin, steps]) => {
    const out: Interval[] = [];
    let prevEnd = origin;
    for (const [delta, length] of steps) {
      const start = prevEnd + delta;
      const end = start + length;
      out.push([start, end]);
      prevEnd = Math.max(prevEnd, end);
    }
    return out;
  });

// String sort and numeric sort disagree on these.
const lexTrap: fc.Arbitrary<Interval[]> = fc
  .constantFrom<Interval[]>(
    [
      [10, 12],
      [9, 9],
    ],
    [
      [-1, 0],
      [-5, 0],
    ],
    [
      [9, 9],
      [10, 10],
    ],
  )
  .chain(trap => fc.array(interval, { maxLength: 3 }).map(rest => [...trap, ...rest]));

const touchingPair: fc.Arbitrary<Interval[]> = fc
  .tuple(
    fc.integer({ min: -10, max: 10 }),
    fc.integer({ min: 0, max: 5 }),
    fc.integer({ min: 0, max: 5 }),
  )
  .map(([start, left, right]) => [
    [start, start + left],
    [start + left, start + left + right],
  ]);

const neighborPair: fc.Arbitrary<Interval[]> = fc
  .tuple(
    fc.integer({ min: -10, max: 10 }),
    fc.integer({ min: 0, max: 5 }),
    fc.integer({ min: 0, max: 5 }),
  )
  .map(([start, left, right]) => [
    [start, start + left],
    [start + left + 1, start + left + 1 + right],
  ]);

// A later interval sits strictly inside an earlier one, so a bug that keeps
// the newer end drops the tail of the wider interval.
const containedTail: fc.Arbitrary<Interval[]> = fc
  .tuple(fc.integer({ min: -10, max: 10 }), fc.integer({ min: 3, max: 8 }))
  .map(([start, length]) => [
    [start, start + length],
    [start + 1, start + 2],
  ]);

const intervalList = fc.oneof(
  randomList,
  clusteredList,
  lexTrap,
  touchingPair,
  neighborPair,
  containedTail,
);

// Gaps are at least 1, so intervals neither overlap nor touch. Gap 1 is the
// integer-neighbor case ([1, 2] and [3, 4]), which must stay unmerged.
const disjointList: fc.Arbitrary<Interval[]> = fc
  .array(fc.tuple(fc.integer({ min: 1, max: 4 }), fc.integer({ min: 0, max: 6 })), { maxLength: 8 })
  .chain(parts =>
    fc.integer({ min: -20, max: 20 }).map(origin => {
      const out: Interval[] = [];
      let cursor = origin;
      for (const [gap, length] of parts) {
        const start = cursor + gap;
        const end = start + length;
        out.push([start, end]);
        cursor = end;
      }
      return out;
    }),
  );

const rolls = fc.array(fc.nat(), { minLength: 8, maxLength: 8 });

function copyIntervals(xs: readonly Interval[]): Interval[] {
  return xs.map(([start, end]) => [start, end]);
}

function covers(xs: readonly Interval[], point: number): boolean {
  return xs.some(([start, end]) => start <= point && point <= end);
}

function probePoints(xs: readonly Interval[]): number[] {
  if (xs.length === 0) return [-0.5, 0, 0.5];
  let lo = Infinity;
  let hi = -Infinity;
  for (const [start, end] of xs) {
    lo = Math.min(lo, start);
    hi = Math.max(hi, end);
  }
  const points: number[] = [];
  for (let x = lo - 1; x <= hi + 1; x++) points.push(x, x + 0.5);
  return points;
}

function shuffle(xs: readonly Interval[], noise: readonly number[]): Interval[] {
  const out = copyIntervals(xs);
  for (let i = out.length - 1; i > 0; i--) {
    const j = noise[i % noise.length] % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

describe('mergeIntervals', () => {
  // Pattern: invariant. Every input interval lies inside some output interval.
  it('every input interval lies inside some output interval', () => {
    fc.assert(
      fc.property(intervalList, xs => {
        const out = mergeIntervals(xs);
        const uncovered = xs.filter(([s, e]) => !out.some(([a, b]) => a <= s && e <= b));
        expect(uncovered).toEqual([]);
      }),
    );
  });

  // Pattern: invariant. The output is sorted, and consecutive intervals neither overlap nor touch.
  it('returns sorted intervals that do not overlap or touch', () => {
    fc.assert(
      fc.property(intervalList, xs => {
        const out = mergeIntervals(copyIntervals(xs));
        for (let i = 0; i < out.length; i++) {
          expect(out[i][0]).toBeLessThanOrEqual(out[i][1]);
          if (i > 0) expect(out[i - 1][1]).toBeLessThan(out[i][0]);
        }
      }),
    );
  });

  // Pattern: invariant. The input array and the intervals in it are left unchanged.
  it('does not modify the input', () => {
    fc.assert(
      fc.property(intervalList, xs => {
        const snapshot = copyIntervals(xs);
        mergeIntervals(xs);
        expect(xs).toEqual(snapshot);
      }),
    );
  });

  // Pattern: differential. A point is covered by the input if and only if it is covered by the output.
  it('covers exactly the same points as the input', () => {
    fc.assert(
      fc.property(intervalList, xs => {
        const out = mergeIntervals(copyIntervals(xs));
        for (const point of probePoints(xs)) {
          expect(covers(out, point)).toBe(covers(xs, point));
        }
      }),
    );
  });

  // Pattern: metamorphic. Shuffling the input does not change the output.
  it('shuffling the input does not change the output', () => {
    fc.assert(
      fc.property(intervalList, rolls, (xs, noise) => {
        const out = mergeIntervals(copyIntervals(xs));
        const shuffled = mergeIntervals(shuffle(xs, noise));
        expect(shuffled).toEqual(out);
      }),
    );
  });

  // Pattern: algebraic. merge(merge(x)) equals merge(x).
  it('merge(merge(x)) equals merge(x)', () => {
    fc.assert(
      fc.property(intervalList, xs => {
        const once = mergeIntervals(copyIntervals(xs));
        const twice = mergeIntervals(copyIntervals(once));
        expect(twice).toEqual(once);
      }),
    );
  });

  // Pattern: conditional. If the input is already disjoint and non-touching, the output is those same intervals, sorted.
  it('keeps already-disjoint non-touching intervals, sorted', () => {
    fc.assert(
      fc.property(disjointList, xs => {
        const out = mergeIntervals(copyIntervals(xs));
        const sorted = copyIntervals(xs).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        expect(out).toEqual(sorted);
      }),
    );
  });
});

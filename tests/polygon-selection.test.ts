import { describe, it, expect } from 'vitest';
import { runInNewContext } from 'node:vm';
import { polygonScript } from '../src/tools/polygon-selection-tools.js';

const points = [
  [10, 10],
  [80, 10],
  [10, 80],
];
describe('polygon selection', () => {
  it.each([
    [],
    [[1, 1]],
    [
      [0, 0],
      [1, 1],
      [2, 2],
    ],
    [
      [0, 0],
      [Infinity, 4],
      [5, 6],
    ],
    [
      ['injection', 1],
      [2, 4],
      [4, 1],
    ],
  ])('rejects malformed/degenerate input %j', (value) => {
    expect(() => polygonScript({ points: value })).toThrow();
  });
  it.each(['replace', 'add', 'subtract', 'intersect'])(
    'passes %s and original pixel coordinates to Photoshop',
    (mode) => {
      let received: unknown[] = [];
      const context = {
        app: {
          documents: [1],
          activeDocument: {
            id: 42,
            width: { as: () => 100 },
            height: { as: () => 100 },
            selection: {
              select: (...args: unknown[]) => {
                received = args;
              },
              bounds: [10, 10, 80, 80].map((n) => ({ as: () => n })),
            },
          },
        },
        SelectionType: { REPLACE: 1, EXTEND: 2, DIMINISH: 3, INTERSECT: 4 },
      };
      const result = runInNewContext(
        `(function(){${polygonScript({ points, mode, feather: 2 })}})()`,
        context
      );
      expect(received).toEqual([
        points,
        { replace: 1, add: 2, subtract: 3, intersect: 4 }[mode],
        2,
        true,
      ]);
      expect(result.bounds).toEqual([10, 10, 80, 80]);
    }
  );
  it('rejects invalid options', () => {
    for (const extra of [
      { mode: 'code' },
      { feather: -1 },
      { feather: NaN },
      { anti_alias: 'yes' },
    ])
      expect(() => polygonScript({ points, ...extra })).toThrow();
  });
  it('refuses out-of-canvas coordinates before changing selection', () => {
    let called = false;
    expect(() =>
      runInNewContext(`(function(){${polygonScript({ points })}})()`, {
        app: {
          documents: [1],
          activeDocument: {
            width: { as: () => 20 },
            height: { as: () => 20 },
            selection: {
              select: () => {
                called = true;
              },
            },
          },
        },
      })
    ).toThrow(/canvas/);
    expect(called).toBe(false);
  });
});

import { expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { refineSelectionScript } from '../src/tools/refine-selection-tools.js';

it('rejects malformed options before reaching Photoshop', () => {
  for (const args of [
    { radius: NaN },
    { radius: 251 },
    { radius: -1 },
    { smooth: 0.5 },
    { contrast: 101 },
    { shift_edge: -101 },
    { feather: Infinity },
    { smart_radius: 'true' },
    { radius: '2;alert(1)' },
  ])
    expect(() => refineSelectionScript(args)).toThrow();
});
it('refines the selection without changing pixels or showing a dialog', () => {
  const descriptors: Record<string, unknown> = {};
  let called: unknown[] = [];
  class Descriptor {
    putUnitDouble(k: string, u: string, v: unknown) {
      descriptors[k] = [u, v];
    }
    putInteger(k: string, v: unknown) {
      descriptors[k] = v;
    }
    putBoolean(k: string, v: unknown) {
      descriptors[k] = v;
    }
    putEnumerated(k: string, t: string, v: unknown) {
      descriptors[k] = v;
    }
  }
  const result = runInNewContext(
    `(function(){${refineSelectionScript({ radius: 3, shift_edge: -2 })}})()`,
    {
      app: {
        documents: [1],
        activeDocument: {
          id: 88,
          selection: { bounds: [1, 2, 30, 40].map((n) => ({ as: () => n })) },
        },
      },
      ActionDescriptor: Descriptor,
      stringIDToTypeID: (s: string) => s,
      charIDToTypeID: (s: string) => s,
      DialogModes: { NO: 0 },
      executeAction: (...args: unknown[]) => {
        called = args;
      },
    }
  );
  expect(called[0]).toBe('smartBrushWorkspace');
  expect(called[2]).toBe(0);
  expect(descriptors.smartBrushRadius).toBe(3);
  expect(descriptors.smartBrushShiftEdge).toEqual(['#Prc', -2]);
  expect(descriptors.smartBrushDecontaminate).toBe(false);
  expect(descriptors.refineEdgeOutput).toBe('selectionOutputToSelection');
  expect(result.document_id).toBe(88);
});
it('fails without a selection before invoking the action', () => {
  let action = false;
  expect(() =>
    runInNewContext(`(function(){${refineSelectionScript({})}})()`, {
      app: {
        documents: [1],
        activeDocument: {
          selection: {
            get bounds() {
              throw Error('empty');
            },
          },
        },
      },
      executeAction: () => {
        action = true;
      },
    })
  ).toThrow(/selection required/);
  expect(action).toBe(false);
});

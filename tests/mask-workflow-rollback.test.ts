import { expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { normalizeMaskPlan, maskWorkflowScript } from '../src/tools/mask-workflow-tools.js';
it('reports and rolls back an injected native failure after an earlier patch completed', () => {
  const plan = normalizeMaskPlan({
    document_id: 1,
    operation_id: 'rollback',
    layer_name: 'mask',
    patches: [
      {
        points: [
          [1, 1],
          [5, 1],
          [5, 5],
        ],
        value: 0,
        refine: false,
      },
      {
        points: [
          [6, 6],
          [9, 6],
          [9, 9],
        ],
        value: 255,
        refine: false,
      },
    ],
    preview_regions: [[0, 0, 10, 10]],
  });
  let maskValue = 255,
    selected = false,
    selects = 0,
    rolled = false;
  const layer = {
    id: 3,
    name: 'mask',
    visible: true,
    allLocked: false,
    typename: 'ArtLayer',
    parent: null,
  };
  const doc = {
    id: 1,
    mode: 'rgb',
    layers: [layer],
    activeLayer: layer,
    activeChannels: [{}],
    channels: [{ kind: 'component' }],
    width: { as: () => 10 },
    height: { as: () => 10 },
    get activeHistoryState() {
      return { maskValue };
    },
    set activeHistoryState(v: { maskValue: number }) {
      maskValue = v.maskValue;
      rolled = true;
    },
    selection: {
      get bounds() {
        if (!selected) throw Error('No selection');
        return [0, 0, 5, 5];
      },
      select() {
        if (++selects === 2) throw Error('Injected native failure');
        selected = true;
      },
      fill(color: { rgb: { red: number } }) {
        maskValue = color.rgb.red;
      },
      deselect() {
        selected = false;
      },
    },
  };
  class Ref {
    putIdentifier() {}
    putEnumerated() {}
  }
  class Desc {
    putReference() {}
    putBoolean() {}
  }
  // Substitute Photoshop's native suspendHistory evaluator, not workflow control flow.
  const script = maskWorkflowScript(plan).replace(
    'doc.suspendHistory(',
    '(function(name,code){eval(code)})('
  );
  const result = runInNewContext(`(function(){${script}})()`, {
    app: { documents: [doc], activeDocument: doc },
    DocumentMode: { RGB: 'rgb' },
    charIDToTypeID: (s: string) => s,
    stringIDToTypeID: (s: string) => s,
    ActionReference: Ref,
    ActionDescriptor: Desc,
    executeActionGet: () => ({ hasKey: () => true, getBoolean: () => true }),
    executeAction: () => {},
    DialogModes: { NO: 0 },
    ChannelType: { COMPONENT: 'component' },
    SelectionType: { REPLACE: 0 },
    ColorBlendMode: { NORMAL: 0 },
    SolidColor: class {
      rgb = { red: 0, green: 0, blue: 0 };
    },
  });
  expect(result.ok).toBe(false);
  expect(result.completed).toBe(1);
  expect(result.stage).toBe('polygon');
  expect(result.rolled_back).toBe(true);
  expect(rolled).toBe(true);
  expect(maskValue).toBe(255);
});

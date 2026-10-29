import { expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { ExtendScriptSnippets } from '../src/api/extendscript.js';
import {
  maskHelpers,
  detailPreviewScript,
  fillMaskScript,
  loadSelectionScript,
} from '../src/tools/local-mask-tools.js';

it('rejects invalid mask edits and preview geometry before Photoshop access', () => {
  for (const args of [
    { layer_name: 'x', value: NaN },
    { layer_name: 'x', value: 256 },
    { layer_name: 'x', value: 0, opacity: 0 },
    { layer_name: 'x', value: '0' },
    { layer_name: '', value: 1 },
  ])
    expect(() => fillMaskScript(args)).toThrow();
  for (const args of [
    { source: 'code' },
    { region: [0, 0, NaN, 10] },
    { region: [5, 0, 4, 10] },
    { region: [0, 0, 10] },
    { region: [0, 0, 1.5, 10] },
    { native_pixels: 'true' },
    { max_dimension_px: 100000 },
    { source: 'layer_mask' },
  ])
    expect(() => detailPreviewScript(args, '/tmp/test.jpg')).toThrow();
  expect(() => loadSelectionScript({ source: 'other' })).toThrow();
});

it('treats an alpha channel name as data, not JSX', () => {
  const dangerous = 'x"; throw new Error("injected"); //\n\u2028';
  const channel = { name: dangerous, kind: 'alpha' };
  let loaded: unknown;
  const result = runInNewContext(
    `(function(){${loadSelectionScript({ source: 'alpha_channel', channel_name: dangerous })}})()`,
    {
      app: {
        documents: [1],
        activeDocument: {
          channels: [channel],
          id: 1,
          selection: {
            load: (c: unknown) => {
              loaded = c;
            },
            bounds: [1, 2, 3, 4].map((n) => ({ as: () => n })),
          },
        },
      },
      charIDToTypeID: (s: string) => s,
      stringIDToTypeID: (s: string) => s,
      ChannelType: { COMPONENT: 'component' },
      SelectionType: { REPLACE: 1 },
    }
  );
  expect(loaded).toBe(channel);
  expect(result.name).toBe(dangerous);
});

it('refuses a missing selection before selecting or filling mask channels', () => {
  let actions = 0;
  const layer = { name: 'target', id: 1 };
  expect(() =>
    runInNewContext(`(function(){${fillMaskScript({ layer_name: 'target', value: 0 })}})()`, {
      app: {
        documents: [1],
        activeDocument: {
          layers: [layer],
          selection: {
            get bounds() {
              throw Error('none');
            },
          },
        },
      },
      charIDToTypeID: (s: string) => s,
      stringIDToTypeID: (s: string) => s,
      ActionReference: class {
        putIdentifier() {}
      },
      executeActionGet: () => ({ hasKey: () => true, getBoolean: () => true }),
      executeAction: () => {
        actions++;
      },
    })
  ).toThrow(/refusing whole-mask fill/);
  expect(actions).toBe(0);
});

it('rejects ambiguous recursive layer names', () => {
  expect(() =>
    runInNewContext(`(function(){${fillMaskScript({ layer_name: 'same', value: 0 })}})()`, {
      app: {
        documents: [1],
        activeDocument: {
          layers: [
            { name: 'same' },
            { name: 'group', typename: 'LayerSet', layers: [{ name: 'same' }] },
          ],
        },
      },
      charIDToTypeID: (s: string) => s,
      stringIDToTypeID: (s: string) => s,
    })
  ).toThrow(/exactly one/);
});

it('rejects oversized native crops before duplicating a document', () => {
  let duplicates = 0;
  expect(() =>
    runInNewContext(
      `(function(){${detailPreviewScript({ region: [0, 0, 3000, 3000] }, '/tmp/test.jpg')}})()`,
      {
        app: {
          documents: [1],
          activeDocument: {
            width: { as: () => 4000 },
            height: { as: () => 4000 },
            duplicate: () => {
              duplicates++;
            },
          },
        },
        charIDToTypeID: (s: string) => s,
        stringIDToTypeID: (s: string) => s,
      }
    )
  ).toThrow(/Native-pixel preview/);
  expect(duplicates).toBe(0);
});

it('does not convert or close the source when Photoshop fails to create a mask preview document', () => {
  let conversions = 0,
    closes = 0;
  const layer = { id: 4, name: 'target' };
  const doc = {
    id: 1,
    layers: [layer],
    activeLayer: layer,
    activeChannels: [],
    width: { as: () => 100 },
    height: { as: () => 100 },
    changeMode: () => {
      conversions++;
    },
    close: () => {
      closes++;
    },
  };
  class Ref {
    putIdentifier() {}
    putEnumerated() {}
  }
  class Desc {
    putReference() {}
    putBoolean() {}
    putObject() {}
    putString() {}
  }
  expect(() =>
    runInNewContext(
      `(function(){${detailPreviewScript({ source: 'layer_mask', layer_name: 'target' }, '/tmp/test.jpg')}})()`,
      {
        app: { documents: [doc], activeDocument: doc },
        charIDToTypeID: (s: string) => s,
        stringIDToTypeID: (s: string) => s,
        ActionReference: Ref,
        ActionDescriptor: Desc,
        DialogModes: { NO: 0 },
        executeActionGet: () => ({ hasKey: () => true, getBoolean: () => true }),
        executeAction: () => {},
      }
    )
  ).toThrow(/did not duplicate/);
  expect(conversions).toBe(0);
  expect(closes).toBe(0);
});

it('delete/apply explicitly target the pixel mask rather than the active channel', () => {
  for (const apply of [false, true]) {
    let exists = true;
    let applied: unknown;
    const references: unknown[] = [];
    class Ref {
      putIdentifier(...args: unknown[]) {
        references.push(args);
      }
      putEnumerated(...args: unknown[]) {
        references.push(args);
      }
    }
    class Desc {
      putReference() {}
      putBoolean(_key: string, value: boolean) {
        applied = value;
      }
    }
    const script = apply
      ? ExtendScriptSnippets.applyLayerMask()
      : ExtendScriptSnippets.deleteLayerMask();
    runInNewContext(`(function(){${script}})()`, {
      app: {
        documents: [1],
        activeDocument: { activeLayer: { id: 42 } },
        charIDToTypeID: (s: string) => s,
        stringIDToTypeID: (s: string) => s,
      },
      charIDToTypeID: (s: string) => s,
      stringIDToTypeID: (s: string) => s,
      ActionReference: Ref,
      ActionDescriptor: Desc,
      DialogModes: { NO: 0 },
      executeActionGet: () => ({ hasKey: () => true, getBoolean: () => exists }),
      executeAction: () => {
        exists = false;
      },
    });
    expect(applied).toBe(apply);
    expect(references).toContainEqual(['Chnl', 'Chnl', 'Msk ']);
    expect(references).toContainEqual(['Lyr ', 42]);
  }
});

it('missing pixel masks fail before destructive actions', () => {
  let actions = 0;
  for (const script of [
    ExtendScriptSnippets.applyLayerMask(),
    ExtendScriptSnippets.deleteLayerMask(),
  ]) {
    expect(() =>
      runInNewContext(`(function(){${script}})()`, {
        app: {
          documents: [1],
          activeDocument: { activeLayer: { id: 42 } },
          charIDToTypeID: (s: string) => s,
          stringIDToTypeID: (s: string) => s,
        },
        charIDToTypeID: (s: string) => s,
        stringIDToTypeID: (s: string) => s,
        ActionReference: class {
          putIdentifier() {}
        },
        executeActionGet: () => ({ hasKey: () => true, getBoolean: () => false }),
        executeAction: () => {
          actions++;
        },
      })
    ).toThrow(/no pixel mask/);
  }
  expect(actions).toBe(0);
});

it('reports component-channel fallback when Photoshop cannot expose the active mask channels', () => {
  const rgb = { kind: 'component' },
    alpha = { kind: 'alpha' };
  const result = runInNewContext(`(function(){${maskHelpers}return captureChannels();})()`, {
    app: {
      documents: [1],
      activeDocument: {
        channels: [rgb, alpha],
        get activeChannels() {
          throw Error('Get unavailable');
        },
      },
    },
    charIDToTypeID: (x: string) => x,
    stringIDToTypeID: (x: string) => x,
    ChannelType: { COMPONENT: 'component' },
  });
  expect(result.exact).toBe(false);
  expect(result.channels).toEqual([rgb]);
});

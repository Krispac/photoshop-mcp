import { expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import {
  integrityScript,
  smartFilterScript,
  prepareFullFrameScript,
} from '../src/tools/smart-filter-tools.js';

const args = { layer_name: 'Subject' };

class Ref {
  id?: number;
  index?: number;
  putIdentifier(_k: string, id: number) {
    this.id = id;
  }
  putIndex(_k: string, index: number) {
    this.index = index;
  }
}
class Desc {
  values = new Map<string, unknown>();
  putReference(k: string, v: unknown) {
    this.values.set(k, v);
  }
  putObject(k: string, type: string, v: unknown) {
    if (v && typeof v === 'object') (v as { type?: string }).type = type;
    this.values.set(k, v);
  }
  putUnitDouble(k: string, _unit: string, v: number) {
    this.values.set(k, v);
  }
  putBoolean(k: string, v: boolean) {
    this.values.set(k, v);
  }
  hasKey(k: string) {
    return this.values.has(k);
  }
  getType(k: string) {
    return this.values.get(k) instanceof List ? 'list' : 'object';
  }
  getList(k: string) {
    return this.values.get(k) as List;
  }
  getObjectValue(k: string) {
    return this.values.get(k) as Desc;
  }
  getObjectType(k: string) {
    return (this.values.get(k) as Desc & { type?: string }).type!;
  }
  getUnitDoubleValue(k: string) {
    return this.values.get(k) as number;
  }
  getBoolean(k: string) {
    return this.values.get(k) as boolean;
  }
}
class List {
  constructor(public items: Desc[]) {}
  get count() {
    return this.items.length;
  }
  getObjectValue(i: number) {
    return this.items[i];
  }
}
function filter(radius: number, metadata = 'retain-me') {
  const data = new Desc();
  data.putUnitDouble('radius', '#Pxl', radius);
  const item = new Desc() as Desc & { type?: string };
  item.type = 'GsnB';
  item.putObject('filter', 'GsnB', data);
  item.putBoolean('enabled', true);
  item.putObject('privateMetadata', 'metadata', Object.assign(new Desc(), { metadata }));
  return item;
}

function run(
  script: string,
  setup: {
    kind?: string;
    hidden?: boolean;
    locked?: boolean;
    selection?: boolean;
    descriptor?: Desc;
  }
) {
  const item = filter(1.5);
  const list = new List([item]);
  const descriptor = setup.descriptor ?? new Desc();
  if (!setup.descriptor) descriptor.putList = undefined;
  const smart = new Desc();
  smart.putList = function (k: string, v: List) {
    this.values.set(k, v);
  };
  smart.putList('filterFXList', list);
  if (!setup.descriptor) descriptor.values.set('smartObjectMore', smart);
  const layer = {
    name: 'Subject',
    id: 7,
    kind: setup.kind ?? 'smartobject',
    visible: setup.hidden ? false : true,
    allLocked: setup.locked ?? false,
    typename: 'ArtLayer',
    parent: null,
  };
  const doc = {
    id: 1,
    layers: [layer],
    channels: [{ kind: 'component' }],
    width: { as: () => 100 },
    height: { as: () => 80 },
    activeLayer: { name: 'Original active', id: 2 },
    activeChannels: ['composite'],
    selection: {
      get bounds() {
        if (setup.selection) return [0, 0, 1, 1];
        throw Error('empty');
      },
    },
  };
  let actions = 0;
  let setDescriptor: Desc | undefined;
  const result = runInNewContext(`(function(){${script}})()`, {
    app: { documents: [doc], activeDocument: doc },
    LayerKind: { SMARTOBJECT: 'smartobject', NORMAL: 'normal' },
    ChannelType: { COMPONENT: 'component' },
    DescValueType: { LISTTYPE: 'list', OBJECTTYPE: 'object' },
    DialogModes: { NO: 0 },
    ActionDescriptor: Desc,
    ActionReference: Ref,
    charIDToTypeID: (x: string) => (x === 'Rds ' ? 'radius' : x),
    stringIDToTypeID: (x: string) => x,
    typeIDToStringID: (x: string) => (x === 'GsnB' ? 'gaussianBlur' : x),
    executeActionGet: () => descriptor,
    executeAction: (_id: string, d: Desc) => {
      actions++;
      setDescriptor = d;
    },
  });
  return { result, actions, item, setDescriptor, layer, doc };
}

it('validates names, radii, and explicit filter index before script execution', () => {
  for (const layer_name of ['', 'x'.repeat(1001)])
    expect(() => smartFilterScript({ layer_name }, 'get')).toThrow();
  for (const radius_px of [NaN, 0, 250.1, '2'])
    expect(() => smartFilterScript({ ...args, radius_px }, 'add')).toThrow();
  for (const filter_index of [0, 1.2, 1001])
    expect(() =>
      smartFilterScript({ ...args, filter_index, expected_radius_px: 1, radius_px: 2 }, 'set')
    ).toThrow();
  expect(() =>
    smartFilterScript({ ...args, filter_index: 1, expected_radius_px: 0, radius_px: 2 }, 'set')
  ).toThrow();
});

it('rejects non-Smart-Object, hidden, locked, and selected targets before any action', () => {
  const edit = smartFilterScript({ ...args, radius_px: 2 }, 'add');
  for (const setup of [
    { kind: 'normal' },
    { hidden: true },
    { locked: true },
    { selection: true },
  ]) {
    expect(() => run(edit, setup)).toThrow();
    // All these preconditions are checked before executeAction in Photoshop.
    expect(edit.indexOf('guard(layer)')).toBeLessThan(edit.indexOf("executeAction(c('GsnB')"));
  }
});

it('reports unsupported filter descriptors as errors rather than an empty stack', () => {
  const unsupported = new Desc();
  unsupported.values.set('filterFX', new Desc());
  expect(() => run(smartFilterScript(args, 'get'), { descriptor: unsupported })).toThrow(
    /Unsupported Smart Filter descriptor/
  );
});

it('reads exact-name filters without selecting or changing layer/channel context', () => {
  const out = run(smartFilterScript(args, 'get'), {});
  expect(out.result.filters).toEqual([
    { filter_index: 1, filter_type: 'gaussianBlur', radius_px: 1.5, enabled: true },
  ]);
  expect(out.actions).toBe(0);
  expect(out.doc.activeLayer.name).toBe('Original active');
  expect(out.doc.activeChannels).toEqual(['composite']);
  expect(() => run(smartFilterScript({ layer_name: 'missing' }, 'get'), {})).toThrow(/exactly one/);
});

it('updates the selected filter while preserving its full item descriptor and metadata', () => {
  const out = run(
    smartFilterScript({ ...args, filter_index: 1, expected_radius_px: 1.5, radius_px: 4 }, 'set'),
    {}
  );
  expect(out.item.getBoolean('enabled')).toBe(true);
  expect(out.item.getObjectValue('privateMetadata').metadata).toBe('retain-me');
  expect(out.item.getObjectValue('filter').getUnitDoubleValue('radius')).toBe(4);
  expect(out.setDescriptor).toBeDefined();
  expect(out.doc.activeChannels).toEqual(['composite']);
});

it('builds integrity output with both bounds and explicit limits on the claim', () => {
  const script = integrityScript(args);
  expect(script).toContain("bounds('bounds')");
  expect(script).toContain("bounds('boundsNoMask')");
  expect(script).toContain('Bounds cannot prove original or complete image content');
});

it('rejects a cropped source before preparing a full-frame effect layer', () => {
  const bounds = new Desc();
  for (const [k, v] of Object.entries({ left: 10, top: 0, right: 90, bottom: 80 }))
    bounds.values.set(k, v);
  const d = new Desc();
  d.values.set('boundsNoMask', bounds);
  expect(() =>
    run(prepareFullFrameScript({ source_layer_name: 'Subject', new_layer_name: 'Effect' }), {
      kind: 'normal',
      descriptor: d,
    })
  ).toThrow(/full canvas/);
  expect(() =>
    prepareFullFrameScript({ source_layer_name: 'Subject', new_layer_name: '' })
  ).toThrow();
});

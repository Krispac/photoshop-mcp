// Disposable synthetic RGB16 TIFF only. Never points at a user photo.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { runRetouchJob } from './run-retouch-job.mjs';
const w = 160,
  h = 160,
  entries = 10,
  base = 8 + 2 + entries * 12 + 4,
  bits = base,
  dataOffset = base + 6,
  b = Buffer.alloc(dataOffset + w * h * 6);
b.write('II');
b.writeUInt16LE(42, 2);
b.writeUInt32LE(8, 4);
b.writeUInt16LE(entries, 8);
[
  [256, 4, 1, w],
  [257, 4, 1, h],
  [258, 3, 3, bits],
  [259, 3, 1, 1],
  [262, 3, 1, 2],
  [273, 4, 1, dataOffset],
  [277, 3, 1, 3],
  [278, 4, 1, h],
  [279, 4, 1, w * h * 6],
  [284, 3, 1, 1],
].forEach(([tag, type, n, v], i) => {
  const o = 10 + i * 12;
  b.writeUInt16LE(tag, o);
  b.writeUInt16LE(type, o + 2);
  b.writeUInt32LE(n, o + 4);
  b.writeUInt32LE(v, o + 8);
});
for (let k = 0; k < 3; k++) b.writeUInt16LE(16, bits + k * 2);
for (let y = 0; y < h; y++)
  for (let x = 0; x < w; x++)
    for (let k = 0; k < 3; k++)
      b.writeUInt16LE(
        (x < 80 ? 11000 : 46000) + y * 50 + k * 1500,
        dataOffset + (y * w + x) * 6 + k * 2
      );
const dir = await mkdtemp(join(tmpdir(), 'retouch-job-fixture-')),
  input = join(dir, 'source.tif'),
  psd = join(dir, 'fixture.psd');
await writeFile(input, b);
const c = new Client({ name: 'retouch-job-fixture', version: '1' });
const tr = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/index.js'],
  cwd: process.cwd(),
  env: { ...process.env, PSMCP_UPDATE_CHECK: '0', PSMCP_FEEDBACK: '0', LOG_LEVEL: '3' },
  stderr: 'pipe',
});
const parse = (r) =>
  JSON.parse(
    r.content
      .filter((x) => x.type === 'text')
      .map((x) => x.text)
      .join('\n')
  );
const call = async (name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  if (r.isError) throw Error(name + ' failed');
  return r;
};
let original, testId, reopenedId;
try {
  await c.connect(tr);
  await call('photoshop_ping');
  original = parse(await call('photoshop_get_state')).document.id;
  await call('photoshop_open_image', { filePath: input });
  let s = parse(await call('photoshop_get_state'));
  testId = s.document.id;
  assert.match(s.document.bitsPerChannel, /SIXTEEN/);
  const source = s.activeLayer.name;
  const runnerClient = { callTool: async (req, ...rest) => c.callTool(req, ...rest) };
  const sourcePreview = async (file) => {
    const r = await call('photoshop_get_detail_preview', {
      document_id: testId,
      source: 'raster_layer',
      layer_name: source,
    });
    await writeFile(file, Buffer.from(r.content.find((x) => x.type === 'image').data, 'base64'));
  };
  await sourcePreview('/tmp/retouch-fixture-source-before.jpg');
  const prepare = {
    operation_id: 'fixture-prepare',
    action: 'prepare',
    document_id: testId,
    source_layer_name: source,
    expected: { width: w, height: h, layer_names: [source] },
    effect: { layer_name: 'Fixture blur', radius_px: 3 },
    grain: { name: 'Fixture grain', amount: 1, opacity: 20 },
    lights: [{ name: 'Fixture light', exposure: 0.15, opacity: 100 }],
  };
  assert.equal((await runRetouchJob(prepare, runnerClient)).ok, true);
  const patch = {
    operation_id: 'fixture-patch',
    action: 'patch',
    document_id: testId,
    patches: [
      {
        operation_id: 'fixture-mask',
        layer_name: 'Fixture blur',
        source_layer_name: source,
        patches: [
          {
            points: [
              [25, 25],
              [70, 25],
              [70, 70],
              [25, 70],
            ],
            value: 255,
            refine: false,
          },
        ],
        preview_regions: [[0, 0, 100, 100]],
      },
    ],
  };
  assert.equal((await runRetouchJob(patch, runnerClient)).ok, true);
  const inspect = {
    operation_id: 'fixture-inspect',
    action: 'inspect',
    document_id: testId,
    previews: [
      { source: 'composite' },
      { source: 'layer_mask', layer_name: 'Fixture blur' },
      { source: 'raster_layer', layer_name: source },
    ],
  };
  assert.equal((await runRetouchJob(inspect, runnerClient)).image_count, 3);
  const finish = {
    operation_id: 'fixture-finish',
    action: 'finish',
    document_id: testId,
    effect: { layer_name: 'Fixture blur', radius_px: 3 },
    grain: { name: 'Fixture grain' },
    grain_masks: ['Fixture blur'],
    reviewed: true,
    save_path: psd,
  };
  assert.equal((await runRetouchJob(finish, runnerClient)).ok, true);
  const savedState = parse(await call('photoshop_get_state'));
  assert.equal(savedState.document.id, testId);
  assert.equal(await realpath(savedState.document.path), await realpath(psd));
  assert.equal(savedState.document.saved, true);
  await sourcePreview('/tmp/retouch-fixture-source-after.jpg');
  const finalState = parse(await call('photoshop_get_state'));
  assert.equal(
    finalState.document.layers.find((x) => x.name === 'Fixture light').kind,
    'LayerKind.EXPOSURE'
  );
  const maskPreview = async (name, file) => {
    const r = await call('photoshop_get_detail_preview', {
      document_id: testId,
      source: 'layer_mask',
      layer_name: name,
    });
    await writeFile(file, Buffer.from(r.content.find((x) => x.type === 'image').data, 'base64'));
  };
  await maskPreview('Fixture blur', '/tmp/retouch-fixture-blur-mask.jpg');
  await maskPreview('Fixture grain', '/tmp/retouch-fixture-grain-mask.jpg');
  await call('photoshop_close_document', { document_id: testId, save: false });
  testId = null;
  await call('photoshop_open_image', { filePath: psd });
  reopenedId = parse(await call('photoshop_get_state')).document.id;
  assert.notEqual(reopenedId, original);
  const reopenedFilters = parse(
    await call('photoshop_get_smart_filters', {
      document_id: reopenedId,
      layer_name: 'Fixture blur',
    })
  );
  assert.equal(reopenedFilters.details.filter_count, 1);
  assert.equal(reopenedFilters.details.filters[0].radius_px, 3);
  await call('photoshop_close_document', { document_id: reopenedId, save: false });
  reopenedId = null;
} finally {
  try {
    if (testId)
      await c.callTool({
        name: 'photoshop_close_document',
        arguments: { document_id: testId, save: false },
      });
    if (reopenedId)
      await c.callTool({
        name: 'photoshop_close_document',
        arguments: { document_id: reopenedId, save: false },
      });
    if (original)
      await c.callTool({
        name: 'photoshop_set_active_document',
        arguments: { document_id: original },
      });
  } finally {
    await c.close();
    await rm(dir, { recursive: true, force: true });
  }
}
console.log(
  JSON.stringify({
    ok: true,
    synthetic_fixture: true,
    closed_test_documents: true,
    original_document_restored: true,
  })
);

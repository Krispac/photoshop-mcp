import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFile, unlink } from 'node:fs/promises';
import assert from 'node:assert/strict';
// Synthetic full-frame RGB16 TIFF. No user image is read or modified.
const w = 160,
  h = 160,
  entries = 10,
  base = 8 + 2 + entries * 12 + 4,
  bits = base,
  dataOffset = base + 6;
const b = Buffer.alloc(dataOffset + w * h * 6);
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
const input = '/tmp/smart-filter-fixture.tif',
  psd = '/tmp/smart-filter-fixture.psd';
await writeFile(input, b);
const c = new Client({ name: 'smart-filter-fixture', version: '1' });
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
  if (r.isError) throw Error(name + ': ' + JSON.stringify(r));
  return r;
};
let id, original;
const filterArgs = () => ({ document_id: id, layer_name: 'Smart fixture' });
async function preview(source, label, layer = 'Smart fixture') {
  const r = await call('photoshop_get_detail_preview', {
    document_id: id,
    source,
    layer_name: layer,
    region: [0, 0, w, h],
  });
  assert.equal(parse(r).scale, 1);
  await writeFile(
    '/tmp/smart-filter-' + label + '.jpg',
    Buffer.from(r.content.find((x) => x.type === 'image').data, 'base64')
  );
}
async function rejected(name, args) {
  const r = await c.callTool({ name, arguments: args });
  assert.equal(r.isError, true, name);
}
try {
  await c.connect(tr);
  await call('photoshop_ping');
  original = parse(await call('photoshop_get_state')).document.id;
  await call('photoshop_open_image', { filePath: input });
  id = parse(await call('photoshop_get_state')).document.id;
  assert.match(parse(await call('photoshop_get_state')).document.bitsPerChannel, /SIXTEEN/);
  const baseName=parse(await call('photoshop_get_state')).activeLayer.name;
  await call('photoshop_prepare_full_frame_smart_layer',{document_id:id,source_layer_name:baseName,new_layer_name:'Smart fixture'});
  await call('photoshop_select_layer_by_name',{document_id:id,name:'Smart fixture'});
  let r = parse(await call('photoshop_get_smart_filters', filterArgs()));
  assert.equal(r.details.filter_count, 0);
  await rejected('photoshop_apply_gaussian_blur', { document_id: id, radius: 3 });
  await call('photoshop_select_rectangle', {
    document_id: id,
    left: 20,
    top: 20,
    right: 120,
    bottom: 120,
  });
  await rejected('photoshop_add_gaussian_smart_filter', { ...filterArgs(), radius_px: 3 });
  await call('photoshop_deselect', { document_id: id });
  await call('photoshop_add_gaussian_smart_filter', { ...filterArgs(), radius_px: 3 });
  r = parse(await call('photoshop_add_gaussian_smart_filter', { ...filterArgs(), radius_px: 8 }));
  assert.equal(r.details.filter_count, 2);
  const ix = r.details.filters.find((x) => x.radius_px === 3).filter_index;
  await rejected('photoshop_set_gaussian_smart_filter', {
    ...filterArgs(),
    filter_index: ix,
    expected_radius_px: 9,
    radius_px: 5,
  });
  r = parse(
    await call('photoshop_set_gaussian_smart_filter', {
      ...filterArgs(),
      filter_index: ix,
      expected_radius_px: 3,
      radius_px: 5,
    })
  );
  assert.equal(r.details.filter_count, 2);
  assert.deepEqual(r.details.filters.map((f) => f.radius_px).sort(), [5, 8]);
  const expected = r.details.filters;
  await call('photoshop_select_rectangle', {
    document_id: id,
    left: 20,
    top: 20,
    right: 120,
    bottom: 120,
  });
  await call('photoshop_create_layer_mask', { document_id: id });
  await call('photoshop_deselect', { document_id: id });
  await preview('composite', 'before');
  await preview('layer_mask', 'mask-before');
  await call('photoshop_select_rectangle', {
    document_id: id,
    left: 100,
    top: 30,
    right: 140,
    bottom: 80,
  });
  await call('photoshop_fill_layer_mask', { ...filterArgs(), value: 255 });
  await call('photoshop_deselect', { document_id: id });
  await preview('layer_mask', 'expanded');
  r = parse(await call('photoshop_get_layer_integrity', filterArgs()));
  assert.equal(r.details.kind, 'LayerKind.SMARTOBJECT');
  assert.equal(r.details.has_user_mask, true);
  assert.deepEqual(r.details.bounds_no_mask, [0, 0, w, h]);
  await preview('composite', 'saved-before');
  await preview('layer_mask', 'saved-mask-before');
  await call('photoshop_save_document', { document_id: id, path: psd, format: 'PSD' });
  await call('photoshop_close_document', { document_id: id, save: false });
  id = null;
  await call('photoshop_open_image', { filePath: psd });
  id = parse(await call('photoshop_get_state')).document.id;
  r = parse(await call('photoshop_get_smart_filters', filterArgs()));
  assert.deepEqual(r.details.filters, expected);
  await preview('composite', 'saved-after');
  await preview('layer_mask', 'saved-mask-after');
  // Group mask preview used by executor: reproduce on fixture, not book PSD.
  await call('photoshop_recipe_organize_layers', {
    document_id: id,
    naming_scheme: 'preserve',
    auto_group: true,
  });
  await call('photoshop_select_layer_by_name', { document_id: id, name: 'Smart Objects' });
  await call('photoshop_select_rectangle', {
    document_id: id,
    left: 10,
    top: 10,
    right: 150,
    bottom: 150,
  });
  await call('photoshop_create_layer_mask', { document_id: id });
  await call('photoshop_deselect', { document_id: id });
  await preview('layer_mask', 'group-mask', 'Smart Objects');
  console.log(
    'PASS RGB16: SO preserved, add/set/read same stack, stale-radius and selection guards, external mask expansion, full pixel bounds, PSD reopen params/masks, group-mask preview'
  );
} finally {
  if (id)
    try {
      await call('photoshop_close_document', { document_id: id, save: false });
    } catch {}
  if (original)
    try {
      await call('photoshop_set_active_document', { document_id: original });
    } catch {}
  await c.close();
  await unlink(input).catch(() => {});
  await unlink(psd).catch(() => {});
}

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const client = new Client({ name: 'local-mask-workflow-test', version: '1' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/index.js'],
  cwd: process.cwd(),
  env: { ...process.env, PSMCP_UPDATE_CHECK: '0', PSMCP_FEEDBACK: '0', LOG_LEVEL: '3' },
  stderr: 'pipe',
});
const parse = (r) =>
  JSON.parse(
    r.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n')
  );
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw Error(JSON.stringify(r));
  return r;
};
let original, id;
const preview = async (source, label) => {
  const r = await call('photoshop_get_detail_preview', {
    document_id: id,
    source,
    layer_name: 'Mask fixture',
    region: [0, 0, 200, 200],
  });
  const metadata = parse(r);
  assert.equal(metadata.native_pixels, true);
  assert.equal(metadata.scale, 1);
  assert.deepEqual(metadata.region, [0, 0, 200, 200]);
  await writeFile(
    `/tmp/mask-workflow-${label}.jpg`,
    Buffer.from(r.content.find((c) => c.type === 'image').data, 'base64')
  );
  return metadata;
};
try {
  await client.connect(transport);
  await call('photoshop_ping');
  original = parse(await call('photoshop_get_state')).document?.id;
  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const n of [
    'photoshop_load_selection',
    'photoshop_fill_layer_mask',
    'photoshop_get_detail_preview',
  ])
    assert(names.includes(n));
  await call('photoshop_create_document', { width: 200, height: 200 });
  id = parse(await call('photoshop_get_state')).document.id;
  await call('photoshop_fill_layer', { document_id: id, red: 80, green: 90, blue: 100 });
  await call('photoshop_create_layer', { document_id: id, name: 'Mask fixture' });
  await call('photoshop_fill_layer', { document_id: id, red: 220, green: 160, blue: 100 });
  await preview('composite', 'rgb-before');
  await call('photoshop_select_rectangle', {
    document_id: id,
    left: 20,
    top: 20,
    right: 180,
    bottom: 180,
  });
  await call('photoshop_create_layer_mask', { document_id: id });
  await call('photoshop_select_rectangle', {
    document_id: id,
    left: 70,
    top: 70,
    right: 130,
    bottom: 130,
  });
  await call('photoshop_save_selection', { document_id: id, channel_name: 'Original patch' });
  await call('photoshop_create_layer', { document_id: id, name: 'Context fixture' });
  let r = parse(
    await call('photoshop_fill_layer_mask', {
      document_id: id,
      layer_name: 'Mask fixture',
      value: 0,
    })
  );
  assert.equal(r.details.context_restored, true);
  await preview('layer_mask', 'black');
  r = parse(
    await call('photoshop_fill_layer_mask', {
      document_id: id,
      layer_name: 'Mask fixture',
      value: 128,
      opacity: 50,
    })
  );
  assert.equal(r.details.context_restored, true);
  await preview('layer_mask', 'gray');
  assert.equal(
    parse(await call('photoshop_get_state', { document_id: id })).activeLayer.name,
    'Context fixture'
  );
  r = parse(await call('photoshop_get_selection_bounds', { document_id: id }));
  assert.deepEqual(r.details.bounds, {
    left: 70,
    top: 70,
    right: 130,
    bottom: 130,
    width: 60,
    height: 60,
  });
  await call('photoshop_deselect', { document_id: id });
  const empty = await client.callTool({
    name: 'photoshop_fill_layer_mask',
    arguments: { document_id: id, layer_name: 'Mask fixture', value: 255 },
  });
  assert.equal(empty.isError, true);
  r = parse(
    await call('photoshop_load_selection', {
      document_id: id,
      source: 'alpha_channel',
      channel_name: 'Original patch',
    })
  );
  assert.deepEqual(r.details.bounds, [70, 70, 130, 130]);
  r = parse(
    await call('photoshop_load_selection', {
      document_id: id,
      source: 'layer_mask',
      layer_name: 'Mask fixture',
    })
  );
  assert.deepEqual(r.details.bounds, [20, 20, 180, 180]);
  await call('photoshop_select_layer_by_name', { document_id: id, name: 'Mask fixture' });
  await call('photoshop_set_layer_visibility', { document_id: id, visible: false });
  const hiddenEdit = await client.callTool({
    name: 'photoshop_fill_layer_mask',
    arguments: { document_id: id, layer_name: 'Mask fixture', value: 255, opacity: 10 },
  });
  assert.equal(hiddenEdit.isError, true);
  await preview('layer_mask', 'hidden');
  assert.equal(
    parse(await call('photoshop_get_state', { document_id: id })).activeLayer.visible,
    false
  );
  const invalid = await client.callTool({
    name: 'photoshop_get_detail_preview',
    arguments: { document_id: id, region: [0, 0, 300, 300] },
  });
  assert.equal(invalid.isError, true);
  await call('photoshop_set_layer_visibility', { document_id: id, visible: true });
  await call('photoshop_delete_layer_mask', { document_id: id });
  await call('photoshop_deselect', { document_id: id });
  await preview('composite', 'rgb-after');
  const missing = await client.callTool({
    name: 'photoshop_fill_layer_mask',
    arguments: { document_id: id, layer_name: 'Mask fixture', value: 0 },
  });
  assert.equal(missing.isError, true);
  const noMask = await client.callTool({
    name: 'photoshop_get_detail_preview',
    arguments: { document_id: id, source: 'layer_mask', layer_name: 'Mask fixture' },
  });
  assert.equal(noMask.isError, true);
  await call('photoshop_select_rectangle', {
    document_id: id,
    left: 20,
    top: 20,
    right: 180,
    bottom: 180,
  });
  await call('photoshop_create_layer_mask', { document_id: id });
  await call('photoshop_deselect', { document_id: id });
  await preview('composite', 'apply-before');
  await call('photoshop_apply_layer_mask', { document_id: id });
  await preview('composite', 'apply-after');
  const appliedMask = await client.callTool({
    name: 'photoshop_load_selection',
    arguments: { document_id: id, source: 'layer_mask', layer_name: 'Mask fixture' },
  });
  assert.equal(appliedMask.isError, true);
  console.log(
    'PASS: mask fill, gray opacity, alpha/mask reload, 1:1 preview, selection/context preservation, hidden-layer preservation, delete/apply mask, missing-mask/no-selection/crop guards'
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
  await client.close();
}

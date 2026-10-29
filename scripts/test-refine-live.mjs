import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert/strict';
const client = new Client({ name: 'refine-smoke', version: '1' });
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
try {
  await client.connect(transport);
  await call('photoshop_ping');
  original = parse(await call('photoshop_get_state')).document?.id;
  assert(
    (await client.listTools()).tools.some((t) => t.name === 'photoshop_refine_selection_edges')
  );
  await call('photoshop_create_document', { width: 200, height: 200 });
  id = parse(await call('photoshop_get_state')).document.id;
  await call('photoshop_fill_layer', { document_id: id, red: 20, green: 150, blue: 20 });
  await call('photoshop_select_rectangle', {
    document_id: id,
    left: 50,
    top: 50,
    right: 150,
    bottom: 150,
  });
  await call('photoshop_fill_layer', { document_id: id, red: 230, green: 160, blue: 100 });
  await call('photoshop_deselect', { document_id: id });
  const empty = await client.callTool({
    name: 'photoshop_refine_selection_edges',
    arguments: { document_id: id },
  });
  assert.equal(empty.isError, true);
  const preview = await call('photoshop_get_preview', { document_id: id, max_dimension_px: 200 });
  const img = preview.content.find((c) => c.type === 'image');
  if (img) {
    (await import('node:fs/promises')).writeFile(
      '/tmp/refine-fixture.jpg',
      Buffer.from(img.data, 'base64')
    );
  }
  await call('photoshop_select_rectangle', {
    document_id: id,
    left: 55,
    top: 55,
    right: 145,
    bottom: 145,
  });
  const r = parse(
    await call('photoshop_refine_selection_edges', {
      document_id: id,
      radius: 12,
      smart_radius: true,
    })
  );
  assert.equal(r.details.document_id, id);
  assert(r.details.bounds);
  console.log('LIVE REFINE', JSON.stringify(r));
  assert.deepEqual(r.details.bounds, [50, 50, 150, 150]);
  await call('photoshop_select_rectangle', {
    document_id: id,
    left: 45,
    top: 45,
    right: 155,
    bottom: 155,
  });
  const outside = parse(
    await call('photoshop_refine_selection_edges', { document_id: id, radius: 12 })
  );
  assert(outside.details.bounds && outside.details.bounds.every((n) => n >= 0 && n <= 200));
  const finalState = parse(await call('photoshop_get_state', { document_id: id }));
  assert.equal(finalState.document.layerCount, 1);
  assert.equal(finalState.activeLayer.isBackground, true);
  const after = await call('photoshop_get_preview', { document_id: id, max_dimension_px: 200 });
  await (
    await import('node:fs/promises')
  ).writeFile(
    '/tmp/refine-fixture-after.jpg',
    Buffer.from(after.content.find((c) => c.type === 'image').data, 'base64')
  );
  console.log(
    'PASS: real Refine Edge executed without UI; empty-selection failure; selection changed on contrasting image'
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

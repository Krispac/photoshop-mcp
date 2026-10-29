import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert/strict';
const client = new Client({ name: 'polygon-smoke', version: '1' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/index.js'],
  cwd: process.cwd(),
  env: { ...process.env, PSMCP_UPDATE_CHECK: '0', PSMCP_FEEDBACK: '0', LOG_LEVEL: '3' },
  stderr: 'pipe',
});
let original;
const fixtures = [];
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw Error(JSON.stringify(r));
  return r;
};
const parsed = (r) =>
  JSON.parse(
    r.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n')
  );
try {
  await client.connect(transport);
  await call('photoshop_ping');
  assert((await client.listTools()).tools.some((t) => t.name === 'photoshop_select_polygon'));
  original = parsed(await call('photoshop_get_state')).document?.id;
  await call('photoshop_create_document', { width: 200, height: 200 });
  const id = parsed(await call('photoshop_get_state')).document.id;
  fixtures.push(id);
  await call('photoshop_create_document', { width: 100, height: 100 });
  fixtures.push(parsed(await call('photoshop_get_state')).document.id);
  const select = async (points, mode = 'replace', extra = {}) =>
    parsed(
      await call('photoshop_select_polygon', {
        document_id: id,
        points,
        mode,
        anti_alias: false,
        ...extra,
      })
    ).details;
  let r = await select([
    [10, 10],
    [80, 10],
    [10, 80],
  ]);
  assert.equal(r.document_id, id);
  assert.deepEqual(r.bounds, [10, 10, 80, 80]);
  r = await select(
    [
      [90, 90],
      [100, 90],
      [100, 100],
      [90, 100],
    ],
    'add'
  );
  assert.deepEqual(r.bounds, [10, 10, 100, 100]);
  await select([
    [10, 10],
    [80, 10],
    [10, 80],
  ]);
  r = await select(
    [
      [0, 0],
      [50, 0],
      [50, 100],
      [0, 100],
    ],
    'subtract'
  );
  assert.deepEqual(r.bounds, [50, 10, 80, 40]);
  r = await select(
    [
      [55, 0],
      [70, 0],
      [70, 100],
      [55, 100],
    ],
    'intersect'
  );
  assert.deepEqual(r.bounds, [55, 10, 70, 35]);
  r = await select(
    [
      [150, 150],
      [180, 150],
      [150, 180],
    ],
    'intersect'
  );
  assert.equal(r.bounds, null);
  r = await select(
    [
      [50, 50],
      [100, 50],
      [50, 100],
    ],
    'replace',
    { feather: 2, anti_alias: true }
  );
  assert(r.bounds);
  const bad = await client.callTool({
    name: 'photoshop_select_polygon',
    arguments: {
      document_id: id,
      points: [
        [0, 0],
        [999, 1],
        [1, 999],
      ],
    },
  });
  assert.equal(bad.isError, true);
  console.log(
    'PASS: MCP discovery; replace/add/subtract/intersect/empty; feather; invalid bounds; explicit target while another document active'
  );
} finally {
  for (const id of fixtures.reverse())
    try {
      await call('photoshop_close_document', { document_id: id, save: false });
    } catch {}
  if (original)
    try {
      await call('photoshop_set_active_document', { document_id: original });
    } catch {}
  await client.close();
}

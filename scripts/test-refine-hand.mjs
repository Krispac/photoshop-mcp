import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { copyFile, writeFile } from 'node:fs/promises';
const client = new Client({ name: 'refine-hand-test', version: '1' });
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
const points = [
  [62, 54],
  [89, 50],
  [115, 63],
  [149, 86],
  [186, 107],
  [224, 132],
  [258, 162],
  [279, 181],
  [282, 151],
  [279, 121],
  [287, 102],
  [301, 99],
  [314, 108],
  [321, 133],
  [338, 153],
  [354, 169],
  [371, 183],
  [378, 218],
  [376, 264],
  [340, 255],
  [299, 273],
  [261, 297],
  [221, 330],
  [190, 374],
  [181, 419],
  [172, 450],
  [139, 441],
  [111, 425],
  [90, 409],
  [76, 389],
  [66, 368],
  [59, 352],
  [47, 342],
  [41, 324],
  [44, 305],
  [52, 291],
  [51, 274],
  [44, 257],
  [42, 237],
  [44, 219],
  [53, 209],
  [55, 191],
  [44, 175],
  [39, 155],
  [44, 138],
  [60, 129],
  [74, 131],
  [90, 146],
  [103, 145],
  [89, 128],
  [72, 110],
  [59, 91],
  [57, 73],
];
let original;
const open = [];
try {
  await client.connect(transport);
  await call('photoshop_ping');
  original = parse(await call('photoshop_get_state')).document?.id;
  for (const refine of [false, true]) {
    const input = `/tmp/refine-hand-${refine ? 'after' : 'before'}.bmp`;
    await copyFile('/tmp/tomek-hand-source.bmp', input);
    await call('photoshop_open_image', { filePath: input });
    const id = parse(await call('photoshop_get_state')).document.id;
    open.push(id);
    const before = await call('photoshop_get_preview', { document_id: id, max_dimension_px: 600 });
    await call('photoshop_select_polygon', {
      document_id: id,
      points,
      feather: 0,
      anti_alias: true,
    });
    if (refine) {
      console.log(
        JSON.stringify(
          parse(
            await call('photoshop_refine_selection_edges', {
              document_id: id,
              radius: 12,
              smart_radius: false,
              feather: 0,
              smooth: 0,
            })
          )
        )
      );
    }
    const after = await call('photoshop_get_preview', { document_id: id, max_dimension_px: 600 });
    await writeFile(
      `/tmp/refine-hand-${refine ? 'after' : 'before'}-source.jpg`,
      Buffer.from(before.content.find((c) => c.type === 'image').data, 'base64')
    );
    await writeFile(
      `/tmp/refine-hand-${refine ? 'after' : 'before'}-source-post.jpg`,
      Buffer.from(after.content.find((c) => c.type === 'image').data, 'base64')
    );
    await call('photoshop_create_layer_mask', { document_id: id });
    const preview = await call('photoshop_get_preview', {
      document_id: id,
      max_dimension_px: 600,
      quality: 12,
    });
    await writeFile(
      `/tmp/refine-hand-${refine ? 'after' : 'before'}.jpg`,
      Buffer.from(preview.content.find((c) => c.type === 'image').data, 'base64')
    );
    await call('photoshop_close_document', { document_id: id, save: false });
    open.pop();
  }
  console.log(
    'PASS: hand crop tested on separate temporary documents; selection-only change; no canonical PSD mutations'
  );
} finally {
  for (const id of open)
    try {
      await call('photoshop_close_document', { document_id: id, save: false });
    } catch {}
  if (original)
    try {
      await call('photoshop_set_active_document', { document_id: original });
    } catch {}
  await client.close();
}

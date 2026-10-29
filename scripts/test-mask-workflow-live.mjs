import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFile, mkdtemp, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
const c = new Client({ name: 'mask-workflow-comparison', version: '1' });
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
      .filter((x) => x.type === 'text')
      .map((x) => x.text)
      .join('\n')
  );
const call = async (name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  if (r.isError) throw Error(name + ': ' + JSON.stringify(r));
  return r;
};
let original, id;
const docs = [];
const stats = [];
const patches = [
  {
    points: [
      [55, 55],
      [145, 55],
      [145, 145],
      [55, 145],
    ],
    value: 0,
    refine: true,
    refine_settings: { radius: 2 },
  },
  {
    points: [
      [20, 20],
      [45, 20],
      [45, 45],
      [20, 45],
    ],
    value: 128,
    opacity: 50,
    refine: false,
  },
  {
    points: [
      [60, 60],
      [140, 60],
      [140, 140],
      [60, 140],
    ],
    value: 255,
    refine: false,
  },
];
const regions = [
  [0, 0, 100, 100],
  [100, 100, 200, 200],
];
async function fixture() {
  await call('photoshop_create_document', { width: 200, height: 200 });
  id = parse(await call('photoshop_get_state')).document.id;
  docs.push(id);
  await call('photoshop_rename_layer', { document_id: id, name: 'BASE' });
  await call('photoshop_fill_layer', { document_id: id, red: 70, green: 80, blue: 90 });
  await call('photoshop_select_rectangle', {
    document_id: id,
    left: 50,
    top: 50,
    right: 150,
    bottom: 150,
  });
  await call('photoshop_fill_layer', { document_id: id, red: 220, green: 170, blue: 130 });
  await call('photoshop_deselect', { document_id: id });
  await call('photoshop_prepare_full_frame_smart_layer', {
    document_id: id,
    source_layer_name: 'BASE',
    new_layer_name: 'MASK',
  });
  await call('photoshop_add_gaussian_smart_filter', {
    document_id: id,
    layer_name: 'MASK',
    radius_px: 3,
  });
  await call('photoshop_select_layer_by_name', { document_id: id, name: 'MASK' });
  await call('photoshop_create_layer_mask', { document_id: id });
  await call('photoshop_select_layer_by_name', { document_id: id, name: 'BASE' });
}
async function saveImages(result, label) {
  const ims = result.content.filter((x) => x.type === 'image');
  assert.equal(ims.length, 6);
  for (let i = 0; i < ims.length; i++)
    await writeFile(`/tmp/mask-workflow-${label}-${i}.jpg`, Buffer.from(ims[i].data, 'base64'));
}
try {
  await c.connect(transport);
  await call('photoshop_ping');
  original = parse(await call('photoshop_get_state')).document.id;
  const catalog = await c.listTools();
  const used = [
    'photoshop_select_polygon',
    'photoshop_select_layer_by_name',
    'photoshop_refine_selection_edges',
    'photoshop_fill_layer_mask',
    'photoshop_deselect',
    'photoshop_get_detail_preview',
  ];
  console.log(
    'schema_bytes',
    JSON.stringify({
      primitives: JSON.stringify(catalog.tools.filter((x) => used.includes(x.name))).length,
      workflow: JSON.stringify(catalog.tools.find((x) => x.name === 'photoshop_run_mask_workflow'))
        .length,
    })
  );
  await fixture();
  let start = performance.now(),
    calls = 0,
    bytes = 0;
  const primitive = async (name, args = {}) => {
    calls++;
    const r = await call(name, { document_id: id, ...args });
    bytes += JSON.stringify(r).length;
    return r;
  };
  for (const p of patches) {
    await primitive('photoshop_select_polygon', { points: p.points, feather: p.feather ?? 0 });
    if (p.refine) {
      await primitive('photoshop_select_layer_by_name', { name: 'BASE' });
      await primitive('photoshop_refine_selection_edges', p.refine_settings);
    }
    await primitive('photoshop_fill_layer_mask', {
      layer_name: 'MASK',
      value: p.value,
      opacity: p.opacity ?? 100,
    });
  }
  await primitive('photoshop_deselect');
  const content = [];
  for (const region of regions)
    for (const source of ['raster_layer', 'composite', 'layer_mask']) {
      const r = await primitive('photoshop_get_detail_preview', {
        source,
        layer_name: source === 'raster_layer' ? 'BASE' : 'MASK',
        region,
        native_pixels: true,
      });
      content.push(...r.content.filter((x) => x.type === 'image'));
    }
  stats.push({
    mode: 'primitives_without_model_wait',
    calls,
    ms: Math.round(performance.now() - start),
    response_bytes: bytes,
  });
  await saveImages({ content }, 'primitive');
  await fixture();
  start = performance.now();
  const args = {
    document_id: id,
    operation_id: 'fixture-apply',
    layer_name: 'MASK',
    source_layer_name: 'BASE',
    patches,
    preview_regions: regions,
  };
  const macro = await call('photoshop_run_mask_workflow', args);
  stats.push({
    mode: 'workflow',
    calls: 1,
    ms: Math.round(performance.now() - start),
    response_bytes: JSON.stringify(macro).length,
    receipt: parse(macro),
  });
  await saveImages(macro, 'macro');
  assert.equal(parse(macro).completed, 3);
  const replay = await call('photoshop_run_mask_workflow', args);
  assert.equal(parse(replay).replayed, true);
  assert.equal(
    replay.content.some((x) => x.type === 'image'),
    false
  );
  const conflict = await c.callTool({
    name: 'photoshop_run_mask_workflow',
    arguments: { ...args, patches: [] },
  });
  assert.equal(conflict.isError, true);
  // One undo removes the entire mask batch; inspect-only captures the restored white mask.
  await call('photoshop_undo', { document_id: id });
  const inspect = await call('photoshop_run_mask_workflow', {
    ...args,
    operation_id: 'fixture-after-undo',
    patches: [],
  });
  assert.equal(parse(inspect).mask_changed, false);
  await saveImages(inspect, 'undo');
  const jobDir = await mkdtemp(join(tmpdir(), 'mask-workflow-live-job-'));
  try {
    const job = join(jobDir, 'job.json');
    await writeFile(job, JSON.stringify({ ...args, operation_id: 'durable-cli' }));
    const execute = promisify(execFile);
    const first = JSON.parse(
      (
        await execute(process.execPath, ['scripts/run-mask-workflow.mjs', job], {
          cwd: process.cwd(),
        })
      ).stdout
    );
    assert.equal(first.status, 'complete');
    assert.equal(first.preview_paths.length, 6);
    const second = JSON.parse(
      (
        await execute(process.execPath, ['scripts/run-mask-workflow.mjs', job], {
          cwd: process.cwd(),
        })
      ).stdout
    );
    assert.equal(second.replayed_from_disk, true);
    for (let i = 0; i < 6; i++)
      await copyFile(first.preview_paths[i], `/tmp/mask-workflow-runner-${i}.jpg`);
    const r = await call('photoshop_run_mask_workflow', {
      ...args,
      operation_id: 'after-durable-replay',
      patches: [],
    });
    await saveImages(r, 'replay');
    console.log('PASS durable CLI replay across independent server processes');
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
  console.log(
    JSON.stringify({
      status: 'PASS',
      stats,
      scope:
        'Same synthetic image, geometry/refine/fill and six previews. No model latency or token/cost measurement. Verify decoded pixels separately.',
    })
  );
} finally {
  for (const d of docs)
    try {
      await call('photoshop_close_document', { document_id: d, save: false });
    } catch {}
  if (original)
    try {
      await call('photoshop_set_active_document', { document_id: original });
    } catch {}
  await c.close();
}

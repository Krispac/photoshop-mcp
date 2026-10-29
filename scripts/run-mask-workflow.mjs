import { readFile, writeFile, mkdir, rename, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function invokeReadyMaskWorkflow(client, args) {
  const probe = await client.callTool({ name: 'photoshop_ping', arguments: {} });
  if (probe.isError)
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: false,
            code: 'readiness_failed',
            status: 'readiness_failed',
            mask_changed: false,
            completed: 0,
            message: 'Photoshop readiness probe failed; no mask workflow was submitted',
          }),
        },
      ],
    };
  return client.callTool({ name: 'photoshop_run_mask_workflow', arguments: args }, undefined, {
    timeout: 180000,
  });
}
async function execute(args) {
  const client = new Client({ name: 'mask-workflow-runner', version: '1' });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['dist/index.js'],
        cwd: root,
        env: { ...process.env, PSMCP_UPDATE_CHECK: '0', PSMCP_FEEDBACK: '0', LOG_LEVEL: '3' },
        stderr: 'pipe',
      })
    );
    return await invokeReadyMaskWorkflow(client, args);
  } finally {
    await client.close();
  }
}
export async function runMaskJob(jobPath, invoke = execute, normalizeOverride) {
  const normalizeMaskPlan =
    normalizeOverride ?? (await import('../dist/tools/mask-workflow-tools.js')).normalizeMaskPlan;
  const p = normalizeMaskPlan(JSON.parse(await readFile(jobPath, 'utf8')));
  const args = {
    document_id: p.document_id,
    operation_id: p.operation_id,
    layer_name: p.layer_name,
    ...(p.source_layer_name ? { source_layer_name: p.source_layer_name } : {}),
    patches: p.patches.map(({ settings, ...patch }) => ({ ...patch, refine_settings: settings })),
    preview_regions: p.regions,
  };
  return runDurableOperation(jobPath, args, invoke);
}

// Shared local receipt runner; callers supply a fixed, validated operation, never arbitrary tools.
export async function runDurableOperation(jobPath, args, invoke, receiptFolder = '.mcp-mask-runs') {
  const p = args;
  const hash = createHash('sha256').update(JSON.stringify(args)).digest('hex'),
    dir = join(dirname(resolve(jobPath)), receiptFolder),
    path = join(dir, p.operation_id + '.json');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if ((await lstat(dir)).isSymbolicLink()) throw Error('Receipt directory cannot be a symlink');
  let receipt = {
    operation_id: p.operation_id,
    document_id: p.document_id,
    hash,
    status: 'submitted',
    do_not_retry: true,
    started_at: new Date().toISOString(),
  };
  try {
    await writeFile(path, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const prior = JSON.parse(await readFile(path, 'utf8'));
    if (prior.hash !== hash) throw Error('Existing operation_id has a different plan');
    return { ...prior, replayed_from_disk: true, receipt_path: path };
  }
  async function save() {
    const temp = path + '.' + randomUUID() + '.tmp';
    await writeFile(temp, JSON.stringify(receipt, null, 2), { mode: 0o600 });
    await rename(temp, path);
  }
  const start = Date.now();
  let response;
  try {
    response = await invoke(args);
  } catch (e) {
    receipt = {
      ...receipt,
      status: 'unknown',
      ok: false,
      message: 'MCP transport failed; inspect Photoshop before any new operation',
      runner_ms: Date.now() - start,
    };
    await save();
    return { ...receipt, receipt_path: path };
  }
  const raw = response.content
    ?.filter((x) => x.type === 'text')
    .map((x) => x.text)
    .join('\n');
  let result;
  try {
    result = JSON.parse(raw);
  } catch {
    receipt = {
      ...receipt,
      status: 'unknown',
      ok: false,
      message: 'Unparseable MCP receipt; do not reapply',
      runner_ms: Date.now() - start,
    };
    await save();
    return { ...receipt, receipt_path: path };
  }
  receipt = { ...receipt, ...result, hash, runner_ms: Date.now() - start, preview_paths: [] };
  // Persist the apply receipt BEFORE writing images: a disk failure must not lead to reapplication.
  await save();
  try {
    let i = 0;
    for (const image of response.content.filter((x) => x.type === 'image')) {
      const path = join(dir, `${p.operation_id}-${i++}.jpg`);
      await writeFile(path, Buffer.from(image.data, 'base64'), { flag: 'wx', mode: 0o600 });
      receipt.preview_paths.push(path);
    }
    await save();
  } catch {
    receipt = {
      ...receipt,
      ok: false,
      status: 'preview_write_failed',
      message: 'Apply receipt retained; recover previews with an inspect-only job',
    };
    await save();
  }
  return { ...receipt, receipt_path: path };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (!process.argv[2])
      throw Error('Usage: node scripts/run-mask-workflow.mjs /absolute/job.json');
    const r = await runMaskJob(process.argv[2]);
    console.log(JSON.stringify(r, null, 2));
    if (r.ok !== true) process.exitCode = 1;
  } catch (e) {
    console.error(JSON.stringify({ ok: false, message: String(e) }));
    process.exitCode = 1;
  }
}

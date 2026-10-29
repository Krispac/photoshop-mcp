import { it, expect } from 'vitest';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The CLI uses the same compiled builder exercised by the live workflow fixture.
import { runMaskJob, invokeReadyMaskWorkflow } from '../scripts/run-mask-workflow.mjs';
import { normalizeMaskPlan } from '../src/tools/mask-workflow-tools.js';
const args = {
  document_id: 1,
  operation_id: 'test',
  layer_name: 'mask',
  patches: [],
  preview_regions: [[0, 0, 10, 10]],
};
it('keeps durable receipts and does not resubmit a completed or unknown operation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mask-runner-test-'));
  try {
    const file = join(dir, 'job.json');
    await writeFile(file, JSON.stringify(args));
    let n = 0;
    const invoke = async () => {
      n++;
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 'complete' }) }],
      };
    };
    expect((await runMaskJob(file, invoke, normalizeMaskPlan)).ok).toBe(true);
    expect((await runMaskJob(file, invoke, normalizeMaskPlan)).replayed_from_disk).toBe(true);
    expect(n).toBe(1);
    await writeFile(file, JSON.stringify({ ...args, operation_id: 'unknown' }));
    const fail = async () => {
      n++;
      throw Error('lost transport');
    };
    expect((await runMaskJob(file, fail, normalizeMaskPlan)).status).toBe('unknown');
    expect((await runMaskJob(file, fail, normalizeMaskPlan)).replayed_from_disk).toBe(true);
    expect(n).toBe(2);
    const receipt = JSON.parse(await readFile(join(dir, '.mcp-mask-runs', 'unknown.json'), 'utf8'));
    expect(receipt.do_not_retry).toBe(true);
    await writeFile(file, JSON.stringify({ ...args, layer_name: 'other' }));
    await expect(runMaskJob(file, invoke, normalizeMaskPlan)).rejects.toThrow(/different plan/);
    expect(n).toBe(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('does not submit a mutation after a failed readiness probe', async () => {
  let calls = 0;
  const response = await invokeReadyMaskWorkflow(
    {
      callTool: async (request) => {
        calls++;
        expect(request.name).toBe('photoshop_ping');
        return { isError: true, content: [{ type: 'text', text: 'scratch_disk_full' }] };
      },
    },
    args
  );
  expect(calls).toBe(1);
  const receipt = JSON.parse(response.content[0].text);
  expect(receipt.status).toBe('readiness_failed');
  expect(receipt.mask_changed).toBe(false);
});

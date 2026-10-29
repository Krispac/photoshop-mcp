import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runDurableRetouchJob as durable,
  runRetouchJob as run,
} from '../scripts/run-retouch-job.mjs';
import { normalizeMaskPlan } from '../src/tools/mask-workflow-tools.js';
import { detailPreviewScript } from '../src/tools/local-mask-tools.js';
const validators = { normalizeMaskPlan, detailPreviewScript };
const runRetouchJob = (job, client) => run(job, client, validators);
const runDurableRetouchJob = (path, invoke) => durable(path, invoke, validators);

const job = (overrides: Record<string, unknown> = {}) => ({
  operation_id: 'op-1',
  action: 'prepare',
  document_id: 7,
  source_layer_name: 'RAW',
  expected: { width: 100, height: 80, layer_names: ['RAW'] },
  effect: { layer_name: 'Blur', radius_px: 4 },
  ...overrides,
});
function fake(
  state: any = {
    document: {
      id: 7,
      colorMode: 'DocumentMode.RGB',
      bitsPerChannel: 'BitsPerChannelType.SIXTEEN',
      width: 100,
      height: 80,
      hasSelection: false,
      layers: [{ name: 'RAW', kind: 'LayerKind.NORMAL' }],
    },
    hasSelection: false,
  }
) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      callTool: async ({ name, arguments: args }: any) => {
        if (name === 'photoshop_save_document') {
          state.document.path = args.path;
          state.document.saved = true;
        }
        if (name === 'photoshop_get_layer_integrity')
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ok: true,
                  details: {
                    kind: 'LayerKind.NORMAL',
                    has_user_mask: false,
                    bounds_no_mask: [0, 0, 100, 80],
                  },
                }),
              },
            ],
          };
        if (name === 'photoshop_get_state')
          return { content: [{ type: 'text', text: JSON.stringify(state) }] };
        calls.push(name);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
      },
    } as any,
  };
}
describe('local retouch job runner', () => {
  it('validates whole job before making native calls; invalid later plan is zero calls', async () => {
    const f = fake();
    await expect(
      runRetouchJob(
        job({
          action: 'patch',
          patches: [
            {
              operation_id: 'patch-1',
              layer_name: 'Blur',
              source_layer_name: 'RAW',
              patches: [
                {
                  points: [
                    [1, 1],
                    [9, 1],
                    [9, 9],
                    [1, 9],
                  ],
                  value: 0,
                },
              ],
              preview_regions: [[0, 0, 10, 10]],
            },
            {
              operation_id: 'patch-2',
              layer_name: 'Blur',
              patches: [
                {
                  points: [
                    [1, 1],
                    [9, 1],
                    [9, 9],
                    [1, 9],
                  ],
                  value: 0,
                },
              ],
              preview_regions: [[0, 0, 10, 10]],
            },
          ],
        }),
        f.client
      )
    ).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });
  it('preflights selection, source names and document identity before mutation', async () => {
    const selected = fake({
      document: {
        id: 7,
        colorMode: 'DocumentMode.RGB',
        bitsPerChannel: 'BitsPerChannelType.SIXTEEN',
        width: 100,
        height: 80,
        hasSelection: true,
        layers: [{ name: 'RAW' }],
      },
      hasSelection: true,
    });
    await expect(runRetouchJob(job(), selected.client)).rejects.toThrow(/Deselect/);
    expect(selected.calls).toEqual(['photoshop_ping']);
    const missing = fake({
      document: {
        id: 7,
        colorMode: 'DocumentMode.RGB',
        bitsPerChannel: 'BitsPerChannelType.SIXTEEN',
        width: 100,
        height: 80,
        hasSelection: false,
        layers: [],
      },
      hasSelection: false,
    });
    await expect(runRetouchJob(job(), missing.client)).rejects.toThrow(
      /Expected layer name missing/
    );
    expect(missing.calls).toEqual(['photoshop_ping', 'photoshop_get_layers']);
    const wrong = fake({
      document: {
        id: 8,
        colorMode: 'DocumentMode.RGB',
        bitsPerChannel: 'BitsPerChannelType.SIXTEEN',
        hasSelection: false,
      },
      hasSelection: false,
    });
    await expect(runRetouchJob(job(), wrong.client)).rejects.toThrow(/mismatch/);
    expect(wrong.calls).toEqual(['photoshop_ping']);
  });
  it('uses a single injected MCP client, fixed prepare order and explicit editable mask/noise/light parameters', async () => {
    const f = fake();
    const result = await runRetouchJob(
      job({
        lights: [{ name: 'Face', exposure: 0.3, opacity: 45, blend_mode: 'LUMINOSITY' }],
        grain: { name: 'Grain', amount: 2, opacity: 20 },
      }),
      f.client
    );
    expect(result.ok).toBe(true);
    expect(f.calls).toEqual([
      'photoshop_ping',
      'photoshop_get_layers',
      'photoshop_prepare_full_frame_smart_layer',
      'photoshop_add_gaussian_smart_filter',
      'photoshop_select_all',
      'photoshop_select_layer_by_name',
      'photoshop_create_layer_mask',
      'photoshop_select_all',
      'photoshop_fill_layer_mask',
      'photoshop_deselect',
      'photoshop_adjust_exposure',
      'photoshop_rename_layer',
      'photoshop_set_layer_opacity',
      'photoshop_set_layer_blend_mode',
      'photoshop_select_all',
      'photoshop_fill_layer_mask',
      'photoshop_deselect',
      'photoshop_create_layer',
      'photoshop_select_all',
      'photoshop_fill_layer',
      'photoshop_deselect',
      'photoshop_apply_noise',
      'photoshop_set_layer_blend_mode',
      'photoshop_set_layer_opacity',
      'photoshop_select_all',
      'photoshop_create_layer_mask',
      'photoshop_select_all',
      'photoshop_fill_layer_mask',
      'photoshop_deselect',
    ]);
  });
  it('replays identical durable receipts across invocation and never retries unknown failures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'retouch-runner-'));
    try {
      const path = join(dir, 'job.json');
      await writeFile(path, JSON.stringify(job()));
      let invoked = 0;
      const invoke = async () => {
        invoked++;
        const e = Error('transport timeout');
        (e as any).code = 'ETIMEDOUT';
        (e as any).completed_steps = 2;
        (e as any).completed_tools = ['prepare', 'filter'];
        throw e;
      };
      const first = await runDurableRetouchJob(path, invoke);
      const second = await runDurableRetouchJob(path, invoke);
      expect(first.status).toBe('unknown');
      expect(first.completed_steps).toBe(2);
      expect(second.replayed_from_disk).toBe(true);
      expect(invoked).toBe(1);
      await expect(
        runDurableRetouchJob(path, async () => {
          throw Error('should not run');
        })
      ).resolves.toMatchObject({ replayed_from_disk: true });
      await writeFile(path, JSON.stringify(job({ effect: { layer_name: 'Other', radius_px: 4 } })));
      await expect(runDurableRetouchJob(path, invoke)).rejects.toThrow(/different plan/);
      expect(
        JSON.parse(await readFile(join(dir, '.mcp-retouch-runs', 'op-1.json'), 'utf8'))
          .completed_tools
      ).toEqual(['prepare', 'filter']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('keeps preview, save and partial outcomes distinct without retries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'retouch-runner-status-'));
    try {
      const previewPath = join(dir, 'preview.json');
      await writeFile(
        previewPath,
        JSON.stringify({
          operation_id: 'preview-1',
          action: 'inspect',
          document_id: 7,
          previews: [{ source: 'composite' }],
        })
      );
      const failedPreview = await runDurableRetouchJob(previewPath, async () => {
        const e: any = Error('preview rejected');
        e.kind = 'native_tool_error';
        e.tool = 'photoshop_get_detail_preview';
        throw e;
      });
      expect(failedPreview.status).toBe('failed_preview');
      const savePath = join(dir, 'save.json');
      await writeFile(
        savePath,
        JSON.stringify({
          operation_id: 'save-1',
          action: 'finish',
          document_id: 7,
          effect: { layer_name: 'Blur', radius_px: 4 },
          reviewed: true,
          save_path: '/tmp/retouch-output.psd',
        })
      );
      const failedSave = await runDurableRetouchJob(savePath, async () => {
        const e: any = Error('save rejected');
        e.kind = 'native_tool_error';
        e.tool = 'photoshop_save_document';
        throw e;
      });
      expect(failedSave.status).toBe('failed_save');
      const patchPath = join(dir, 'patch.json');
      await writeFile(
        patchPath,
        JSON.stringify({
          operation_id: 'patch-1',
          action: 'prepare',
          document_id: 7,
          source_layer_name: 'RAW',
          effect: { layer_name: 'Blur', radius_px: 4 },
        })
      );
      const partial = await runDurableRetouchJob(patchPath, async () => {
        const e: any = Error('native operation failed');
        e.kind = 'native_tool_error';
        e.tool = 'photoshop_add_gaussian_smart_filter';
        e.completed_steps = 1;
        e.completed_tools = ['photoshop_prepare_full_frame_smart_layer'];
        e.native_result = { completed: 0, rolled_back: true };
        throw e;
      });
      expect(partial.status).toBe('partial_apply');
      expect(partial.completed_tools).toEqual(['photoshop_prepare_full_frame_smart_layer']);
      expect(partial.native_result.rolled_back).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

it('rejects malformed inspect regions and duplicate new names before touching Photoshop', async () => {
  const f = fake();
  await expect(
    runRetouchJob(
      job({
        action: 'inspect',
        previews: [
          { source: 'composite', region: [0, 0, 20, 20] },
          { source: 'composite', region: [0, 0, -1, 20] },
        ],
      }),
      f.client
    )
  ).rejects.toThrow();
  await expect(
    runRetouchJob(job({ lights: [{ name: 'Blur', exposure: 0.1 }] }), f.client)
  ).rejects.toThrow(/unique/);
  expect(f.calls).toEqual([]);
});
it('uses one initial state check and pins every later operation', async () => {
  const f = fake();
  const all: any[] = [];
  const client = {
    callTool: async (r: any, ...rest: any[]) => {
      all.push(r);
      return f.client.callTool(r, ...rest);
    },
  };
  await runRetouchJob(job(), client);
  expect(all.filter((x) => x.name === 'photoshop_get_state')).toHaveLength(1);
  for (const r of all.filter((x) => !['photoshop_ping', 'photoshop_get_state'].includes(x.name)))
    expect(r.arguments.document_id).toBe(7);
  expect(
    all.some((x) => x.name === 'photoshop_select_layer_by_name' && x.arguments.name === 'RAW')
  ).toBe(false);
});
it('clears stale grain geometry before copying the current soft mask and saves only after verification', async () => {
  const f = fake({
    document: {
      id: 7,
      colorMode: 'DocumentMode.RGB',
      bitsPerChannel: 'BitsPerChannelType.SIXTEEN',
      width: 100,
      height: 80,
      hasSelection: false,
      layers: [{ name: 'RAW' }, { name: 'Blur' }, { name: 'Grain' }],
    },
  });
  const all: any[] = [];
  const client = {
    callTool: async (r: any) => {
      all.push(r);
      let details: any;
      if (r.name === 'photoshop_get_smart_filters')
        details = { filter_count: 1, filters: [{ filter_type: 'gaussianBlur', radius_px: 4 }] };
      if (r.name === 'photoshop_get_layer_integrity')
        details = {
          kind: 'LayerKind.SMARTOBJECT',
          has_user_mask: true,
          bounds_no_mask: [0, 0, 100, 80],
          canvas: { width: 100, height: 80 },
        };
      if (r.name === 'photoshop_load_selection') details = { bounds: [1, 1, 10, 10] };
      return details
        ? { content: [{ type: 'text', text: JSON.stringify({ ok: true, details }) }] }
        : f.client.callTool(r);
    },
  };
  await runRetouchJob(
    job({
      action: 'finish',
      grain: { name: 'Grain' },
      grain_masks: ['Blur'],
      reviewed: true,
      save_path: '/tmp/retouch-unit-no-real-save-8e3a.psd',
    }),
    client
  );
  expect(
    all.filter((r) => r.name === 'photoshop_fill_layer_mask').map((r) => r.arguments.value)
  ).toEqual([0, 255]);
  expect(all.at(-2)).toMatchObject({
    name: 'photoshop_save_document',
    arguments: { format: 'PSD', as_copy: false, document_id: 7 },
  });
  expect(all.at(-1).name).toBe('photoshop_get_state');
});
it('treats native script timeout as unknown and never resubmits it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'retouch-timeout-'));
  try {
    const path = join(dir, 'job.json');
    await writeFile(path, JSON.stringify(job()));
    let calls = 0;
    const invoke = async () => {
      calls++;
      const e: any = Error('native timeout');
      e.kind = 'native_tool_error';
      e.native_result = { code: 'extendscript_timeout' };
      throw e;
    };
    expect((await runDurableRetouchJob(path, invoke)).status).toBe('unknown');
    expect((await runDurableRetouchJob(path, invoke)).replayed_from_disk).toBe(true);
    expect(calls).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

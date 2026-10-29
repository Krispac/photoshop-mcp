import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runSnippet: vi.fn(),
  preview: vi.fn(),
}));

vi.mock('../src/tools/atomic-shared.js', () => ({
  runSnippet: mocks.runSnippet,
  parseSnippetResult: (x: unknown) => x,
}));
vi.mock('../src/tools/local-mask-tools.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tools/local-mask-tools.js')>();
  return {
    ...actual,
    createLocalMaskTools: () => [
      { tool: { name: 'photoshop_get_detail_preview' }, handler: mocks.preview },
    ],
  };
});

import {
  createMaskWorkflowTools,
  maskWorkflowScript,
  normalizeMaskPlan,
} from '../src/tools/mask-workflow-tools.js';

const base = {
  document_id: 12,
  operation_id: 'mask-pilot-01',
  layer_name: 'portrait mask',
  source_layer_name: 'untouched base',
  patches: [
    {
      points: [
        [1, 1],
        [10, 1],
        [10, 10],
      ],
      value: 0,
      refine: true,
    },
  ],
  preview_regions: [[0, 0, 20, 20]],
};
const tool = () => createMaskWorkflowTools({} as never)[0].handler;
const result = (r: Awaited<ReturnType<ReturnType<typeof tool>>>) =>
  JSON.parse(r.content.find((x) => x.type === 'text')!.text);

beforeEach(() => {
  mocks.runSnippet.mockReset();
  mocks.preview.mockReset();
  mocks.runSnippet.mockResolvedValue({ ok: true, completed: 1, mask_changed: true });
  mocks.preview.mockResolvedValue({
    content: [{ type: 'image', data: 'preview', mimeType: 'image/jpeg' }],
  });
});

it('validates the entire batch before Photoshop access, including a bad second patch', async () => {
  const handler = tool();
  const invalidSecond = { ...base, patches: [base.patches[0], { ...base.patches[0], value: 256 }] };
  const r = result(await handler(invalidSecond));
  expect(r.phase).toBe('validation');
  expect(mocks.runSnippet).not.toHaveBeenCalled();
  for (const bad of [
    { ...base, operation_id: 'bad id' },
    { ...base, preview_regions: [[1000, 1000, 1020, 1020]] },
    { ...base, arbitrary_code: 'no' },
    { ...base, patches: [{ ...base.patches[0], refine_settings: { radius: 0.5 } }] },
    { ...base, patches: [{ ...base.patches[0], refine_settings: { decontaminate: true } }] },
    { ...base, layer_name: '' },
    { ...base, document_id: 0 },
    { ...base, preview_regions: [[0, 0, 20, 20, 1]] },
    {
      ...base,
      patches: [
        {
          ...base.patches[0],
          points: [
            [0, 0],
            [1, 1],
          ],
          value: 1,
        },
      ],
    },
    { ...base, patches: [{ ...base.patches[0], refine: 'yes' }] },
  ])
    expect(() => normalizeMaskPlan(bad)).toThrow();
  expect(mocks.runSnippet).not.toHaveBeenCalled();
});

it('validates layer/source names, patch limits, numeric controls, and whole-canvas script guards', () => {
  expect(() => normalizeMaskPlan({ ...base, layer_name: 'x'.repeat(1001) })).toThrow();
  expect(() => normalizeMaskPlan({ ...base, source_layer_name: '' })).toThrow();
  expect(() => normalizeMaskPlan({ ...base, patches: Array(13).fill(base.patches[0]) })).toThrow();
  expect(() =>
    normalizeMaskPlan({ ...base, patches: [{ ...base.patches[0], feather: -1 }] })
  ).toThrow();
  expect(() =>
    normalizeMaskPlan({ ...base, patches: [{ ...base.patches[0], opacity: 0 }] })
  ).toThrow();
  expect(() =>
    normalizeMaskPlan({ ...base, patches: [{ ...base.patches[0], refine_settings: [] }] })
  ).toThrow();
  const script = maskWorkflowScript(normalizeMaskPlan(base));
  expect(script).toContain("if(doc.id!==12)throw Error('Document changed')");
  expect(script).toContain('Preview region outside canvas or 1:1 limit');
  expect(script).toContain('Patch point outside canvas');
});

it('replays the same operation id and plan from its receipt without applying again', async () => {
  const handler = tool();
  const first = result(await handler(base));
  const replay = result(await handler(base));
  expect(first.status).toBe('complete');
  expect(replay.replayed).toBe(true);
  expect(mocks.runSnippet).toHaveBeenCalledTimes(1);
});

it('rejects reuse of an operation id for a changed plan', async () => {
  const handler = tool();
  await handler(base);
  const changed = { ...base, patches: [{ ...base.patches[0], value: 128 }] };
  const replay = result(await handler(changed));
  expect(replay.message).toMatch(/different plan/);
  expect(mocks.runSnippet).toHaveBeenCalledTimes(1);
});

it('caches a transport failure as apply_unknown and never retries it', async () => {
  mocks.runSnippet.mockRejectedValueOnce(new Error('socket closed'));
  const handler = tool();
  const first = result(await handler(base));
  const replay = result(await handler(base));
  expect(first.status).toBe('apply_unknown');
  expect(first.do_not_retry).toBe(true);
  expect(replay.replayed).toBe(true);
  expect(mocks.runSnippet).toHaveBeenCalledTimes(1);
});

it('retains an applied receipt after preview failure and does not reapply on replay', async () => {
  mocks.preview.mockRejectedValueOnce(new Error('preview unavailable'));
  const handler = tool();
  const first = result(await handler(base));
  const replay = result(await handler(base));
  expect(first.status).toBe('applied_preview_failed');
  expect(first.do_not_retry).toBe(true);
  expect(replay.replayed).toBe(true);
  expect(mocks.runSnippet).toHaveBeenCalledTimes(1);
});

it('locks concurrent operations while the first apply is in flight', async () => {
  let release!: (value: unknown) => void;
  mocks.runSnippet.mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve;
    })
  );
  const handler = tool();
  const pending = handler(base);
  await Promise.resolve();
  const second = result(await handler({ ...base, operation_id: 'other-operation' }));
  expect(second.message).toMatch(/already running/);
  release({ ok: true, completed: 1, mask_changed: true });
  expect(result(await pending).status).toBe('complete');
  expect(mocks.runSnippet).toHaveBeenCalledTimes(1);
});

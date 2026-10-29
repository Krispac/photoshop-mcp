import { readFile, stat, realpath } from 'node:fs/promises';
import { dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { runDurableOperation } from './run-mask-workflow.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const identity = async (p) => {
  try {
    return (await realpath(p)).normalize('NFC');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return resolve(p).normalize('NFC');
  }
};
const Name = z
  .string()
  .min(1)
  .max(1000)
  .refine((x) => x.trim().length > 0);
const Id = z.string().regex(/^[a-zA-Z0-9_.-]{1,80}$/);
const Effect = z
  .object({
    layer_name: Name,
    radius_px: z.number().min(0.1).max(250),
    mask_alpha: Name.optional(),
  })
  .strict();
const Light = z
  .object({
    name: Name,
    exposure: z.number().min(-20).max(20),
    opacity: z.number().min(0).max(100).default(100),
    blend_mode: z.enum(['NORMAL', 'LUMINOSITY']).default('LUMINOSITY'),
  })
  .strict();
const Grain = z
  .object({
    name: Name,
    amount: z.number().min(0.1).max(400).default(6),
    opacity: z.number().min(0).max(100).default(50),
    distribution: z.enum(['UNIFORM', 'GAUSSIAN']).default('GAUSSIAN'),
  })
  .strict();
const Patch = z
  .object({
    operation_id: Id,
    layer_name: Name,
    source_layer_name: Name.optional(),
    patches: z.array(z.unknown()),
    preview_regions: z.array(z.unknown()),
  })
  .strict();
const Preview = z
  .object({
    source: z.enum(['composite', 'layer_mask', 'raster_layer']),
    layer_name: Name.optional(),
    region: z.array(z.number()).optional(),
    native_pixels: z.boolean().optional(),
    max_dimension_px: z.number().optional(),
  })
  .strict();
const Schema = z
  .object({
    operation_id: Id,
    action: z.enum(['prepare', 'patch', 'inspect', 'finish']),
    document_id: z.number().int().positive(),
    source_layer_name: Name.optional(),
    expected: z
      .object({
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        layer_names: z.array(Name).optional(),
      })
      .strict()
      .default({}),
    effect: Effect.optional(),
    lights: z.array(Light).max(8).default([]),
    grain: Grain.optional(),
    grain_masks: z.array(Name).max(1).default([]),
    patches: z.array(Patch).max(12).default([]),
    previews: z.array(Preview).max(8).default([]),
    save_path: z.string().optional(),
    reviewed: z.boolean().optional(),
  })
  .strict();
async function loadValidators() {
  const [m, p] = await Promise.all([
    import('../dist/tools/mask-workflow-tools.js'),
    import('../dist/tools/local-mask-tools.js'),
  ]);
  return { normalizeMaskPlan: m.normalizeMaskPlan, detailPreviewScript: p.detailPreviewScript };
}
export function validateRetouchJob(raw, { normalizeMaskPlan, detailPreviewScript }) {
  const j = Schema.parse(raw);
  if (j.action === 'prepare') {
    if (!j.source_layer_name || !j.effect) throw Error('prepare requires source and effect');
    const names = [
      j.source_layer_name,
      j.effect.layer_name,
      ...j.lights.map((x) => x.name),
      ...(j.grain ? [j.grain.name] : []),
    ];
    if (new Set(names).size !== names.length) throw Error('New layer names must be unique');
  }
  if (j.action === 'patch') {
    if (!j.patches.length) throw Error('patch requires patches');
    if (new Set(j.patches.map((p) => p.operation_id)).size !== j.patches.length)
      throw Error('Patch IDs must be unique');
    for (const p of j.patches) normalizeMaskPlan({ ...p, document_id: j.document_id });
  }
  if (j.action === 'inspect') {
    if (!j.previews.length) throw Error('inspect requires previews');
    for (const p of j.previews) detailPreviewScript(p, '/unused-validation.jpg');
  }
  if (j.action === 'finish') {
    if (!j.effect || j.reviewed !== true) throw Error('finish requires effect and reviewed:true');
    if (!j.save_path || !isAbsolute(j.save_path) || !j.save_path.toLowerCase().endsWith('.psd'))
      throw Error('Absolute .psd save_path required');
    if (j.grain && j.grain_masks.includes(j.grain.name))
      throw Error('Grain mask source must differ from its target');
    if (j.grain_masks.length && !j.grain) throw Error('grain mask refresh requires grain');
  }
  return j;
}
const parse = (r) => {
  if (r.isError) throw Error(`MCP ${r.code ?? 'tool_error'}`);
  const t =
    r.content
      ?.filter((x) => x.type === 'text')
      .map((x) => x.text)
      .join('\n') ?? '';
  try {
    return JSON.parse(t);
  } catch {
    return { text: t };
  }
};
const flatten = (layers) =>
  (layers ?? []).flatMap((x) => [
    { name: x.name, kind: x.kind, visible: x.visible, locked: x.allLocked },
    ...flatten(x.layers),
  ]);
export async function runRetouchJob(job, client, validators) {
  validators ??= await loadValidators();
  const { normalizeMaskPlan } = validators;
  const j = validateRetouchJob(job, validators),
    calls = [],
    completedTools = [],
    images = [],
    warnings = [];
  const call = async (tool, args = {}) => {
    const timed = { tool, args, ms: 0 };
    calls.push(timed);
    const started = Date.now();
    let r;
    try {
      r = await client.callTool(
        {
          name: tool,
          arguments:
            tool === 'photoshop_run_mask_workflow' ? args : { ...args, document_id: j.document_id },
        },
        undefined,
        { timeout: 180000 }
      );
    } catch (e) {
      e.kind = 'unknown_transport';
      throw e;
    }
    timed.ms = Date.now() - started;
    if (r.isError) {
      const raw =
        r.content
          ?.filter((x) => x.type === 'text')
          .map((x) => x.text)
          .join('\n') ?? '';
      let nativeResult;
      try {
        nativeResult = JSON.parse(raw);
      } catch {}
      const e = Error(`${tool} failed`);
      e.kind = 'native_tool_error';
      e.tool = tool;
      e.native_result = nativeResult;
      throw e;
    }
    const result = parse(r);
    if (result.ok === false) throw Error(`${tool} returned ok:false`);
    for (const x of r.content ?? []) if (x.type === 'image') images.push(x);
    completedTools.push(tool);
    if ((result.details ?? result).context_restored === false) {
      warnings.push({
        tool,
        context_restored: false,
        channel_restore: (result.details ?? result).channel_restore,
      });
      const state = parse(
        await client.callTool({
          name: 'photoshop_get_state',
          arguments: { document_id: j.document_id },
        })
      );
      if (state.document?.id !== j.document_id) throw Error('Context fallback lost document');
    }
    return result;
  };
  const ping = await client.callTool({ name: 'photoshop_ping', arguments: {} }, undefined, {
    timeout: 180000,
  });
  if (ping.isError) throw Error('Photoshop readiness probe failed');
  const state = parse(
    await client.callTool({ name: 'photoshop_get_state', arguments: {} }, undefined, {
      timeout: 180000,
    })
  );
  const d = state.document;
  if (!d || d.id !== j.document_id) throw Error('Active document_id mismatch');
  if (
    !String(d.colorMode).endsWith('RGB') ||
    !['16', 'BitsPerChannelType.SIXTEEN'].includes(String(d.bitsPerChannel))
  )
    throw Error('Expected RGB 16-bit working document');
  if (
    (j.expected.width !== undefined && d.width !== j.expected.width) ||
    (j.expected.height !== undefined && d.height !== j.expected.height)
  )
    throw Error('Document dimensions mismatch');
  if (state.hasSelection ?? d.hasSelection) throw Error('Deselect before retouch job');
  const completeLayers = await call('photoshop_get_layers');
  const layers = flatten(completeLayers.layers ?? completeLayers.details?.layers ?? d.layers),
    names = layers.map((x) => x.name);
  if (j.expected.layer_names && j.expected.layer_names.some((x) => !names.includes(x)))
    throw Error('Expected layer name missing');
  const unique = (n) => {
    const m = layers.filter((x) => x.name === n);
    if (m.length !== 1) throw Error(`Layer name must be unique: ${n}`);
    return m[0];
  };
  const collision = (n) => {
    if (names.includes(n)) throw Error(`Layer name collision: ${n}`);
  };
  if (j.action === 'prepare') {
    unique(j.source_layer_name);
    const q = await call('photoshop_get_layer_integrity', { layer_name: j.source_layer_name });
    const info = q.details ?? q;
    if (
      info.kind !== 'LayerKind.NORMAL' ||
      info.has_user_mask ||
      !info.bounds_no_mask ||
      info.bounds_no_mask.some((n, i) => Math.abs(n - [0, 0, d.width, d.height][i]) > 0.5)
    )
      throw Error('Source must be an unmasked full-frame raster');
    collision(j.effect.layer_name);
    for (const x of j.lights ?? []) collision(x.name);
    if (j.grain) collision(j.grain.name);
  }
  if (j.action === 'patch')
    for (const p of j.patches) {
      unique(p.layer_name);
      if (p.source_layer_name) unique(p.source_layer_name);
    }
  if (j.action === 'inspect')
    for (const p of j.previews) {
      if (p.source !== 'composite') unique(p.layer_name);
    }
  if (j.action === 'finish') {
    unique(j.effect.layer_name);
    if (j.grain) unique(j.grain.name);
    for (const mask of j.grain_masks ?? []) unique(mask);
    if (
      d.path?.toLowerCase().endsWith('.psd') &&
      (await identity(d.path)) !== (await identity(j.save_path))
    )
      throw Error('Save must use the same canonical PSD');
    try {
      const target = await stat(j.save_path);
      if (!d.path || (await identity(d.path)) !== (await identity(j.save_path)) || !target.isFile())
        throw Error('Save target already exists and is not this document');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  const step = async (tool, args) => call(tool, args);
  try {
    if (j.action === 'prepare') {
      if (j.effect.mask_alpha) {
        await step('photoshop_load_selection', {
          source: 'alpha_channel',
          channel_name: j.effect.mask_alpha,
        });
        await step('photoshop_deselect');
      }
      await step('photoshop_prepare_full_frame_smart_layer', {
        source_layer_name: j.source_layer_name,
        new_layer_name: j.effect.layer_name,
      });
      await step('photoshop_add_gaussian_smart_filter', {
        layer_name: j.effect.layer_name,
        radius_px: j.effect.radius_px,
      });
      // Create an editable external mask, then fill the whole mask black. Selection is cleared on success.
      await step('photoshop_select_all');
      await step('photoshop_select_layer_by_name', { name: j.effect.layer_name });
      await step('photoshop_create_layer_mask');
      await step('photoshop_select_all');
      await step('photoshop_fill_layer_mask', { layer_name: j.effect.layer_name, value: 0 });
      await step('photoshop_deselect');
      if (j.effect.mask_alpha) {
        const loaded = await step('photoshop_load_selection', {
          source: 'alpha_channel',
          channel_name: j.effect.mask_alpha,
        });
        if ((loaded.details ?? loaded).bounds)
          await step('photoshop_fill_layer_mask', { layer_name: j.effect.layer_name, value: 255 });
        await step('photoshop_deselect');
      }
      for (const light of j.lights ?? []) {
        await step('photoshop_adjust_exposure', { exposure: light.exposure, offset: 0, gamma: 1 });
        await step('photoshop_rename_layer', { name: light.name });
        await step('photoshop_set_layer_opacity', { opacity: light.opacity });
        await step('photoshop_set_layer_blend_mode', { blendMode: light.blend_mode });
        await step('photoshop_select_all');
        await step('photoshop_fill_layer_mask', { layer_name: light.name, value: 0 });
        await step('photoshop_deselect');
      }
      if (j.grain) {
        await step('photoshop_create_layer', { name: j.grain.name });
        await step('photoshop_select_all');
        await step('photoshop_fill_layer', { red: 128, green: 128, blue: 128 });
        await step('photoshop_deselect');
        await step('photoshop_apply_noise', {
          amount: j.grain.amount,
          distribution: j.grain.distribution ?? 'GAUSSIAN',
          monochromatic: true,
        });
        await step('photoshop_set_layer_blend_mode', { blendMode: 'SOFTLIGHT' });
        await step('photoshop_set_layer_opacity', { opacity: j.grain.opacity });
        await step('photoshop_select_all');
        await step('photoshop_create_layer_mask');
        await step('photoshop_select_all');
        await step('photoshop_fill_layer_mask', { layer_name: j.grain.name, value: 0 });
        await step('photoshop_deselect');
      }
    } else if (j.action === 'patch') {
      for (const p of j.patches) {
        const plan = normalizeMaskPlan({
          document_id: j.document_id,
          operation_id: p.operation_id,
          layer_name: p.layer_name,
          source_layer_name: p.source_layer_name,
          patches: p.patches,
          preview_regions: p.preview_regions,
        });
        await call('photoshop_run_mask_workflow', {
          document_id: j.document_id,
          operation_id: p.operation_id,
          layer_name: plan.layer_name,
          ...(plan.source_layer_name ? { source_layer_name: plan.source_layer_name } : {}),
          patches: plan.patches.map(({ settings, ...x }) => ({ ...x, refine_settings: settings })),
          preview_regions: plan.regions,
        });
      }
    } else if (j.action === 'inspect') {
      for (const p of j.previews) await call('photoshop_get_detail_preview', p);
    } else {
      for (const mask of j.grain_masks ?? []) {
        if (!j.grain?.name) throw Error('finish grain mask refresh requires grain.name');
        await step('photoshop_select_all');
        await step('photoshop_fill_layer_mask', { layer_name: j.grain.name, value: 0 });
        await step('photoshop_deselect');
        const loaded = await step('photoshop_load_selection', {
          source: 'layer_mask',
          layer_name: mask,
        });
        if ((loaded.details ?? loaded).bounds)
          await step('photoshop_fill_layer_mask', { layer_name: j.grain.name, value: 255 });
        await step('photoshop_deselect');
      }
      const filters = await step('photoshop_get_smart_filters', {
        layer_name: j.effect.layer_name,
      });
      const f = filters.details ?? filters;
      if (
        f.filter_count !== 1 ||
        f.filters?.[0]?.filter_type !== 'gaussianBlur' ||
        Math.abs(f.filters[0].radius_px - (j.effect.radius_px ?? NaN)) > 0.0001
      )
        throw Error('Smart Filter stack verification failed');
      const integrity = await step('photoshop_get_layer_integrity', {
        layer_name: j.effect.layer_name,
      });
      const q = integrity.details ?? integrity,
        b = q.bounds_no_mask,
        c = q.canvas;
      if (
        !Array.isArray(b) ||
        !c ||
        Math.abs(b[0]) > 0.5 ||
        Math.abs(b[1]) > 0.5 ||
        Math.abs(b[2] - c.width) > 0.5 ||
        Math.abs(b[3] - c.height) > 0.5 ||
        q.kind !== 'LayerKind.SMARTOBJECT' ||
        q.has_user_mask !== true
      )
        throw Error('Full-frame Smart Object and external mask verification failed');
      await step('photoshop_save_document', { path: j.save_path, format: 'PSD', as_copy: false });
      const saved = await step('photoshop_get_state');
      if (
        saved.document?.id !== j.document_id ||
        saved.document.saved !== true ||
        (await identity(saved.document.path ?? '')) !== (await identity(j.save_path))
      )
        throw Object.assign(Error('Canonical save needs inspection; do not repeat it'), {
          save_state: saved.document,
        });
    }
  } catch (e) {
    e.completed_steps = completedTools.length;
    e.completed_tools = completedTools;
    throw e;
  }
  return {
    ok: true,
    action: j.action,
    document_id: j.document_id,
    completed_steps: calls.length,
    calls: calls.map((x) => x.tool),
    step_times: calls.map(({ tool, ms }) => ({ tool, ms })),
    tool_ms: calls.reduce((n, x) => n + x.ms, 0),
    warnings,
    image_count: images.length,
    image_data: images.map((x) => x.data),
  };
}
async function execute(job) {
  const c = new Client({ name: 'retouch-job-runner', version: '1' });
  try {
    await c.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['dist/index.js'],
        cwd: root,
        env: {
          ...process.env,
          PSMCP_UPDATE_CHECK: '0',
          PSMCP_FEEDBACK: '0',
          LOG_LEVEL: '3',
          PHOTOSHOP_SCRIPT_TIMEOUT: '120000',
        },
        stderr: 'pipe',
      })
    );
    return await runRetouchJob(job, c);
  } finally {
    await c.close();
  }
}
export async function runDurableRetouchJob(jobPath, invoke = execute, validators) {
  validators ??= await loadValidators();
  const job = validateRetouchJob(JSON.parse(await readFile(jobPath, 'utf8')), validators);
  return runDurableOperation(
    jobPath,
    job,
    async (j) => {
      try {
        const r = await invoke(j);
        const images = (r.image_data ?? []).map((data) => ({
          type: 'image',
          mimeType: 'image/jpeg',
          data,
        }));
        delete r.image_data;
        return {
          content: [
            ...images,
            { type: 'text', text: JSON.stringify({ ...r, status: 'completed' }) },
          ],
        };
      } catch (e) {
        const code = e.native_result?.code;
        const status =
          e.kind === 'unknown_transport' ||
          e.code === 'ETIMEDOUT' ||
          ['extendscript_timeout', 'timeout'].includes(code)
            ? 'unknown'
            : e.kind === 'native_tool_error'
              ? j.action === 'inspect'
                ? 'failed_preview'
                : e.tool === 'photoshop_save_document'
                  ? 'failed_save'
                  : e.completed_steps
                    ? 'partial_apply'
                    : 'known_error'
              : e.completed_steps
                ? 'partial_apply'
                : 'preflight_failed';
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: false,
                status,
                message: String(e),
                completed_steps: e.completed_steps ?? 0,
                completed_tools: e.completed_tools ?? [],
                ...(e.native_result ? { native_result: e.native_result } : {}),
              }),
            },
          ],
        };
      }
    },
    '.mcp-retouch-runs'
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (!process.argv[2]) throw Error('Usage: node scripts/run-retouch-job.mjs /absolute/job.json');
    const r = await runDurableRetouchJob(process.argv[2]);
    console.log(JSON.stringify(r, null, 2));
    if (!r.ok) process.exitCode = 1;
  } catch (e) {
    console.error(JSON.stringify({ ok: false, message: String(e) }));
    process.exitCode = 1;
  }
}

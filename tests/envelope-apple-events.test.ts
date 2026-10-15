import { describe, expect, it } from 'vitest';
import { classifyError, refineTimeoutEnvelope } from '../src/errors/envelope.js';

const osascriptFailure = (detail: string) =>
  `Command failed: osascript "/var/folders/xy/T/photoshop-applescript-1.scpt"\n` +
  `/var/folders/xy/T/photoshop-applescript-1.scpt:70:106: execution error: ${detail}\n`;

describe('classifyError on macOS osascript failures (#72)', () => {
  it.each([
    ['Adobe Photoshop 2026 got an error: Application isn’t running. (-600)', 'photoshop_unreachable'],
    ['An error of type -10810 has occurred. (-10810)', 'photoshop_unreachable'],
    ['An error of type -10827 has occurred. (-10827)', 'photoshop_unreachable'],
    ['Programm läuft nicht. (-600)', 'photoshop_unreachable'],
    ['Not authorized to send Apple events to Adobe Photoshop 2026. (-1743)', 'automation_permission_denied'],
    ['Can’t get application "Adobe Photoshop 2026". (-1728)', 'photoshop_app_not_resolved'],
  ])('%s → %s', (detail, code) => {
    const envelope = classifyError(osascriptFailure(detail));
    expect(envelope.code).toBe(code);
    expect(envelope.message).toContain(detail);
    expect(envelope.suggested_next_tool).toBeDefined();
  });

  it('keeps AppleEvent timeouts as extendscript_timeout', () => {
    expect(classifyError(osascriptFailure('AppleEvent timed out. (-1712)')).code).toBe(
      'extendscript_timeout'
    );
  });

  it('leaves ExtendScript runtime errors alone', () => {
    expect(classifyError('ERROR: Error 8: Syntax error.').code).toBe('extendscript_runtime_error');
  });

  it('does not send script timeouts to the UXP bridge, which cannot run tool scripts', () => {
    const refined = refineTimeoutEnvelope('photoshop_get_state', classifyError('Script execution timeout'));
    expect(refined.message).not.toMatch(/uxp_bridge_reachable/);
    expect(refined.message).toMatch(/scripting path/);
  });
});

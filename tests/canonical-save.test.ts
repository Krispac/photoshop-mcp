import { expect, it } from 'vitest';
import { ExtendScriptSnippets } from '../src/api/extendscript.js';
it('keeps PSD export-copy default but can save the working document without path injection', () => {
  const path = '/tmp/quote"-\\-test.psd';
  for (const requested of [undefined, true, false]) {
    let seen: any;
    const doc = {
      saveAs: (file: any, _options: any, copy: boolean) => {
        seen = { path: file.fsName, copy };
      },
    };
    const File = function (this: any, p: string) {
      this.fsName = p;
    };
    const Options = function () {};
    const script =
      requested === undefined
        ? ExtendScriptSnippets.saveAsPSD(path)
        : ExtendScriptSnippets.saveAsPSD(path, requested);
    new Function('app', 'File', 'PhotoshopSaveOptions', script)(
      { documents: [doc], activeDocument: doc },
      File,
      Options
    );
    expect(seen).toEqual({ path, copy: requested !== false });
  }
});

import { readFileSync } from 'node:fs';
import { TypeSafeClient, choice } from '@typesafe-ai/sdk';
const key = readFileSync(0, 'utf8').trim();
if (!/^[\x21-\x7e]+$/.test(key)) {
  console.log(JSON.stringify({ failed: true, key_format_ascii_no_whitespace: false }));
  process.exit(1);
}
const client = new TypeSafeClient({
  apiKey: key,
  timeout: 5000,
  retry: { maxRetries: 0 },
  logLevel: 'off',
});
const cases = [
  {
    text: 'Zwiększ istniejące rozmycie z 3 do 6 pikseli. Maska bez zmian.',
    expected: 'filter_radius',
  },
  { text: 'Przy palcu maska zasłania fragment skóry. Popraw tylko obrys.', expected: 'mask_edit' },
  {
    text: 'Odczyt maski grupy zgłasza błąd API. Nie wiadomo, czy korekta się zapisała.',
    expected: 'tool_failure',
  },
  {
    text: 'Twarz jest za ciemna i chłodniejsza od dłoni. Granice maski są dobre.',
    expected: 'tone_color',
  },
  {
    text: 'Na brzegu widać jasną obwódkę, ale nie wiemy, czy była już w źródle. Najpierw ustal to.',
    expected: 'inspect_source',
  },
  {
    text: 'Wyłączyłem maskę: widać tylko wyciętą postać na przezroczystości, nie ma pełnego obrazu.',
    expected: 'layer_structure',
  },
];
const criteria = {
  filter_radius: 'Change radius of existing editable filter; preserve mask',
  mask_edit: 'Local correction of existing mask boundary',
  tool_failure: 'Stop and escalate broken or uncertain API operation to coordinator',
  tone_color: 'Adjust light or color using adjustment layers',
  inspect_source: 'Compare original source before deciding whether boundary is artificial',
  layer_structure: 'Layer lacks recoverable original content; workflow construction issue',
};
const samples = [];
try {
  for (const x of cases) {
    const start = performance.now();
    const r = await client.systemOne({
      state: { feedback: x.text },
      questions: {
        next: choice(
          'Choose the single next stage for this retouch feedback. Do not perform the stage.',
          criteria
        ),
      },
    });
    samples.push({
      expected: x.expected,
      actual: r.answers.next.choice,
      ms: Math.round(performance.now() - start),
    });
  }
  const times = samples.map((x) => x.ms).sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      cases: samples.length,
      correct: samples.filter((x) => x.expected === x.actual).length,
      p50_ms: (times[2] + times[3]) / 2,
      max_ms: times.at(-1),
      samples,
      scope: 'Read-only text routing, no photos sent, no Photoshop actions',
    })
  );
} catch (e) {
  console.log(
    JSON.stringify({
      failed: true,
      error_name: e?.name,
      status: e?.status,
      cause_name: e?.cause?.name,
      cause_code: e?.cause?.code,
      completed_cases: samples.length,
    })
  );
  process.exitCode = 1;
}

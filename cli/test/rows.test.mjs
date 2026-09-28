import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The task file `blind post-tasks` reads: the CSV parser, the JSONL reader,
 * and the per-row checks, each problem named by its line.
 */
const { parseCsv, csvField, readTaskFile, toTaskRows, describeProblems } = await import('../dist/rows.js');

const USDC = { decimals: 6, symbol: 'USDC' };
const dir = mkdtempSync(join(tmpdir(), 'blind-rows-'));
const file = (name, content) => { const p = join(dir, name); writeFileSync(p, content); return p; };
const rowsOf = (name, content) => {
  const p = file(name, content);
  return toTaskRows(p, readTaskFile(p).rows, USDC);
};

test('parseCsv: quoted commas, doubled quotes, line breaks inside quotes, CRLF, a BOM and a trailing newline', () => {
  const records = parseCsv('\uFEFFa,b,c\r\n"x, y","say ""hi""","line one\r\nline two"\r\n3,,\n');
  assert.deepEqual(records.map((r) => r.fields), [['a', 'b', 'c'], ['x, y', 'say "hi"', 'line one\nline two'], ['3', '', '']]);
  // The third record starts on line 4: the quoted field spans lines 2 and 3.
  assert.deepEqual(records.map((r) => r.line), [1, 2, 4]);
});

test('parseCsv: spaces around a quoted field are dropped; a last line without a newline still counts', () => {
  assert.deepEqual(parseCsv('a, "b" ,c').map((r) => r.fields), [['a', 'b', 'c']]);
  assert.deepEqual(parseCsv('a,b\n1,2').map((r) => r.fields), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('""').map((r) => r.fields), [['']]);
});

test('parseCsv: refuses malformed quoting, naming the line', () => {
  assert.throws(() => parseCsv('a\n"never closed'), (e) => e.code === 'BAD_CSV' && /Line 2/.test(e.message));
  assert.throws(() => parseCsv('a\nab"c'), (e) => e.code === 'BAD_CSV' && /Line 2.*quote inside/.test(e.message));
  assert.throws(() => parseCsv('"a"b'), (e) => e.code === 'BAD_CSV' && /after a closing quote/.test(e.message));
});

test('csvField quotes what needs it, and parseCsv reads it back', () => {
  const values = ['plain', 'a,b', 'say "hi"', 'two\nlines', '', 42];
  const line = values.map(csvField).join(',');
  assert.deepEqual(parseCsv(line)[0].fields, values.map(String));
});

test('a CSV file: headers ignore case, spaces and dashes; defaults fill in; blank lines are skipped', () => {
  const { tasks, problems } = rowsOf('ok.csv', [
    'Instructions,Reward,Routing Summary,capabilities,privacy',
    '"Summarise the paper, in five bullets.",2.5,Paper summary,web_research;summarization,public',
    '',
    'Translate this page into French.,0.000001,,,',
  ].join('\n'));
  assert.deepEqual(problems, []);
  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks[0].params, {
    instructions: 'Summarise the paper, in five bullets.',
    amountRaw: 2_500_000n,
    durationSeconds: 86_400,
    privacy: 'public',
    verificationMode: 'auto',
    locationZone: 'global',
    requiredCapabilities: ['web_research', 'summarization'],
    routingSummary: 'Paper summary',
  });
  assert.equal(tasks[1].params.privacy, 'private');
  assert.equal(tasks[1].amountRaw, 1n);
  assert.deepEqual(tasks.map((t) => t.line), [2, 4]);
});

test('every bad row is reported with its line, not just the first', () => {
  const brief = file('brief.md', 'A brief kept in its own file.');
  const { tasks, problems } = rowsOf('bad.csv', [
    'instructions,instructions_file,reward,amount,duration,privacy,verification,target,routing_summary',
    ',,1,,,,,,', // no brief
    'x,,1,2,,,,,', // reward and amount
    'x,,1.0000001,,,,,,', // too many decimals
    'x,,,1.5,,,,,', // amount not whole
    'x,,0,,,,,,', // nothing escrowed
    'x,,1,,60,,,,', // too short
    'x,,1,,,secret,,,', // privacy
    'x,,1,,,,always,,', // verification
    'x,,1,,,,,bob,', // target
    `x,,1,,,,,,${'s'.repeat(501)}`, // summary too long
    `,${brief},1,,,,,,`, // brief from a file: fine
    `x,${brief},1,,,,,,`, // both
    ',missing.md,1,,,,,,', // unreadable brief file
  ].join('\n'));
  assert.deepEqual(problems.map((p) => p.line), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14]);
  assert.match(problems[0].message, /no instructions/);
  assert.match(problems[1].message, /exactly one of reward/);
  assert.match(problems[2].message, /at most 6 decimals/);
  assert.match(problems[4].message, /above 0/);
  assert.match(problems[5].message, /3600/);
  assert.match(problems[9].message, /at most 500/);
  assert.match(problems[11].message, /could not be read/);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].params.instructions, 'A brief kept in its own file.');
  const text = describeProblems('bad.csv', problems, 3);
  assert.match(text, /12 rows in bad.csv cannot be posted, so nothing was sent/);
  assert.match(text, /… and 9 more/);
});

test('an unknown or repeated column is refused before any row is read', () => {
  assert.throws(() => rowsOf('typo.csv', 'instructions,rewards\nx,1'), (e) => e.code === 'BAD_COLUMNS' && /"rewards"/.test(e.message));
  assert.throws(() => rowsOf('dup.csv', 'instructions,reward,Reward\nx,1,2'), (e) => e.code === 'BAD_COLUMNS' && /twice/.test(e.message));
  assert.throws(() => rowsOf('wide.csv', 'instructions,reward\nx,1,extra'), (e) => e.code === 'BAD_CSV' && /Line 2/.test(e.message));
  assert.throws(() => rowsOf('empty.csv', '\n\n'), (e) => e.code === 'EMPTY_FILE');
});

test('a JSONL file takes the same columns, with capabilities as a list', () => {
  const { tasks, problems } = rowsOf('ok.jsonl', [
    JSON.stringify({ instructions: 'Summarise this.', amount: 2500000, capabilities: ['summarization'], privacy: 'public' }),
    '',
    JSON.stringify({ instructions: 'Translate this.', reward: '1', duration: 7200, target: '0x' + 'ab'.repeat(20) }),
  ].join('\n'));
  assert.deepEqual(problems, []);
  assert.equal(tasks[0].amountRaw, 2_500_000n);
  assert.deepEqual(tasks[0].params.requiredCapabilities, ['summarization']);
  assert.equal(tasks[1].params.durationSeconds, 7200);
  assert.equal(tasks[1].params.targetExecutor, '0x' + 'ab'.repeat(20));
  assert.deepEqual(tasks.map((t) => t.line), [1, 3]);
  assert.throws(() => rowsOf('bad.jsonl', '{"instructions":"x","reward":1}\nnot json'), (e) => e.code === 'BAD_JSONL' && /Line 2/.test(e.message));
  assert.throws(() => rowsOf('keys.jsonl', '{"instructions":"x","price":1}'), (e) => e.code === 'BAD_COLUMNS' && /"price"/.test(e.message));
});

test('fingerprints: stable across runs, different for a second copy of the same row', () => {
  const content = 'instructions,reward\nSame task.,1\nSame task.,1\nOther task.,1\n';
  const a = rowsOf('fp-a.csv', content).tasks.map((t) => t.fingerprint);
  const b = rowsOf('fp-b.csv', content).tasks.map((t) => t.fingerprint);
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, 3, 'the second copy is its own task');
});

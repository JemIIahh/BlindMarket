import { describe, expect, it } from 'vitest';
import {
  EXAMPLE_CSV, MAX_ROWS, applyTemplate, briefTitle, bulkTotals, checkRows, detectFormat, fillTemplate,
  parseBulkText, parseCsvRecords, plannedTransactions, resultsCsv, rowFingerprint, templateVariables, validateRow,
} from './bulkRows';

const USDC = { decimals: 6, symbol: 'USDC' };
const check = (raw: Record<string, string>) => validateRow(raw, 1, USDC.decimals, USDC.symbol);

describe('parseCsvRecords (RFC 4180)', () => {
  it('reads quoted commas, doubled quotes and line breaks inside quotes', () => {
    expect(parseCsvRecords('a,b\n"x, y","say ""hi""\nthere"\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"\nthere'],
    ]);
  });

  it('takes CRLF, drops a BOM and skips blank lines', () => {
    expect(parseCsvRecords('\uFEFFa,b\r\n\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('keeps empty fields, and a last record with no newline', () => {
    expect(parseCsvRecords('a,,c\n,,\n1,2,3')).toEqual([['a', '', 'c'], ['', '', ''], ['1', '2', '3']]);
  });

  it('refuses an unterminated quote and text after a closing quote', () => {
    expect(() => parseCsvRecords('a\n"never closed')).toThrow('never closed');
    expect(() => parseCsvRecords('a\n"x"y')).toThrow('after a closing quote');
  });
});

describe('parseBulkText', () => {
  it('detects JSONL by name or by its first character', () => {
    expect(detectFormat('{"a":1}')).toBe('jsonl');
    expect(detectFormat('a,b', 'tasks.jsonl')).toBe('jsonl');
    expect(detectFormat('{"a":1}', 'tasks.csv')).toBe('csv');
    expect(detectFormat('instructions,reward')).toBe('csv');
  });

  it('maps CSV columns case-insensitively and lists unknown ones', () => {
    const parsed = parseBulkText('Instructions,REWARD,Colour\nDo it,1,red\n');
    expect(parsed.rows).toEqual([{ instructions: 'Do it', reward: '1', colour: 'red' }]);
    expect(parsed.unknownColumns).toEqual(['colour']);
    expect(parsed.issues).toEqual([]);
  });

  it('flags a row with more values than the header, and a repeated column', () => {
    expect(parseBulkText('instructions,reward\na,1,extra\n').issues[0].message).toContain('3 values');
    expect(parseBulkText('reward,reward\n1,2\n').issues[0].message).toContain('appears twice');
  });

  it('reads JSONL, joining capability arrays with ;', () => {
    const parsed = parseBulkText('{"instructions":"A","reward":2,"capabilities":["translation","summarization"]}\n\n{"Instructions":"B","amount":"5"}\n');
    expect(parsed.format).toBe('jsonl');
    expect(parsed.rows).toEqual([
      { instructions: 'A', reward: '2', capabilities: 'translation;summarization' },
      { instructions: 'B', amount: '5' },
    ]);
  });

  it('reports a JSONL line that is not an object', () => {
    const parsed = parseBulkText('{"instructions":"A","reward":1}\n[1,2]\nnot json\n');
    expect(parsed.issues.map((i) => i.row)).toEqual([2, 3]);
  });

  it(`refuses more than ${MAX_ROWS} rows`, () => {
    const text = 'instructions,reward\n' + Array.from({ length: MAX_ROWS + 1 }, (_, i) => `t${i},1`).join('\n');
    const parsed = parseBulkText(text);
    expect(parsed.rows).toEqual([]);
    expect(parsed.issues[0].message).toContain('Split it');
  });

  it('parses the example file the page offers', () => {
    const parsed = parseBulkText(EXAMPLE_CSV, 'example.csv');
    expect(parsed.issues).toEqual([]);
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.rows[1].instructions).toContain('"Light, warm and made to last."');
  });
});

describe('validateRow', () => {
  it('fills the defaults', () => {
    const { value, problems } = check({ instructions: 'Do the thing', reward: '2.5' });
    expect(problems).toEqual([]);
    expect(value).toEqual({
      row: 1, instructions: 'Do the thing', amountRaw: 2_500_000n, durationSeconds: 86_400,
      privacy: 'private', verification: 'auto', zone: 'global', capabilities: [],
    });
  });

  it('takes an amount in the smallest unit, and every optional column', () => {
    const { value } = check({
      instructions: 'x', amount: '42', duration: '3600', privacy: 'PUBLIC', verification: 'manual', zone: 'EU',
      routing_summary: 'short', capabilities: 'translation; summarization;translation', target: '0x' + 'Ab'.repeat(20),
    });
    expect(value).toMatchObject({
      amountRaw: 42n, durationSeconds: 3600, privacy: 'public', verification: 'manual', zone: 'EU',
      routingSummary: 'short', capabilities: ['translation', 'summarization'], target: '0x' + 'ab'.repeat(20),
    });
  });

  it.each([
    [{ reward: '1' }, 'brief'],
    [{ instructions: 'x' }, 'Give a reward'],
    [{ instructions: 'x', reward: '1', amount: '1' }, 'not both'],
    [{ instructions: 'x', reward: '1.1234567' }, '7 decimals'],
    [{ instructions: 'x', reward: 'lots' }, 'not a number'],
    [{ instructions: 'x', amount: '1.5' }, 'whole number'],
    [{ instructions: 'x', reward: '0' }, 'more than zero'],
    [{ instructions: 'x', reward: '1', duration: '60' }, 'between 3600'],
    [{ instructions: 'x', reward: '1', duration: '9999999' }, 'between 3600'],
    [{ instructions: 'x', reward: '1', privacy: 'secret' }, 'public or private'],
    [{ instructions: 'x', reward: '1', verification: 'agent' }, 'auto or manual'],
    [{ instructions: 'x', reward: '1', capabilities: 'juggling' }, 'Unknown capabilities: juggling'],
    [{ instructions: 'x', reward: '1', target: '0x123' }, 'not a 0x wallet'],
    [{ instructions: 'x', reward: '1', instructions_file: 'a.txt' }, 'CLI only'],
    [{ instructions: 'x'.repeat(20_001), reward: '1' }, 'the most is'],
  ])('rejects %j', (raw, fragment) => {
    const { value, problems } = check(raw as Record<string, string>);
    expect(value).toBeUndefined();
    expect(problems.join(' ')).toContain(fragment);
  });
});

describe('templates', () => {
  it('fills {{variables}} case-insensitively and reports missing ones', () => {
    expect(fillTemplate('Translate {{ Text }} into {{lang}}', { text: 'hello', lang: 'French' })).toEqual({ text: 'Translate hello into French', missing: [] });
    expect(fillTemplate('Hi {{name}}', {}).missing).toEqual(['name']);
    expect(templateVariables('{{a}} {{ B }} {{a}}')).toEqual(['a', 'b']);
  });

  it("builds rows from a template, keeping a row's own brief and taking the suggested reward", () => {
    const { rows, issues } = applyTemplate(
      [{ city: 'Lagos' }, { instructions: 'Own brief', reward: '3' }, {}],
      { description: 'List cafés in {{city}}', suggested_reward: '1.5' },
    );
    expect(rows[0]).toEqual({ city: 'Lagos', instructions: 'List cafés in Lagos', reward: '1.5' });
    expect(rows[1]).toEqual({ instructions: 'Own brief', reward: '3' });
    expect(issues).toEqual([{ row: 3, message: 'No value for {{city}}.' }]);
  });
});

describe('checkRows', () => {
  it('keeps valid rows with a fingerprint and flags duplicates', async () => {
    const { rows, issues } = await checkRows([
      { instructions: 'A', reward: '1' },
      { instructions: 'B', reward: 'x' },
      { instructions: 'A', reward: '1' },
    ], USDC.decimals, USDC.symbol);
    expect(rows.map((r) => r.row)).toEqual([1]);
    expect(rows[0].fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(issues).toEqual([
      { row: 2, message: 'The reward "x" is not a number.' },
      { row: 3, message: 'Same as row 1; remove the duplicate.' },
    ]);
  });

  it('fingerprints by content, not by position', async () => {
    const a = check({ instructions: 'A', reward: '1' }).value!;
    const b = { ...a, row: 9 };
    expect(await rowFingerprint(a)).toBe(await rowFingerprint(b));
    expect(await rowFingerprint(a)).not.toBe(await rowFingerprint({ ...a, amountRaw: 2n }));
  });
});

describe('totals and plan', () => {
  it('adds up the escrow and the privacy split', () => {
    const rows = [check({ instructions: 'a', reward: '1', privacy: 'public' }).value!, check({ instructions: 'b', reward: '2.5' }).value!];
    expect(bulkTotals(rows)).toEqual({ count: 2, totalRaw: 3_500_000n, publicCount: 1, privateCount: 1 });
  });

  it('plans one transaction per task, or one per chunk with batch create', () => {
    const none = { supported: false, maxBatch: 0 };
    expect(plannedTransactions(500, { batch: none, chunkSize: 20, needsApproval: true, promptsPerTx: true })).toEqual({ transactions: 501, walletPrompts: 501, chunk: 1 });
    expect(plannedTransactions(500, { batch: { supported: true, maxBatch: 50 }, chunkSize: 20, needsApproval: true, promptsPerTx: false })).toEqual({ transactions: 26, walletPrompts: 0, chunk: 20 });
    expect(plannedTransactions(45, { batch: { supported: true, maxBatch: 10 }, chunkSize: 20, needsApproval: false, promptsPerTx: true })).toEqual({ transactions: 5, walletPrompts: 5, chunk: 10 });
    expect(plannedTransactions(0, { batch: none, chunkSize: 20, needsApproval: true, promptsPerTx: true }).transactions).toBe(0);
  });
});

describe('results and titles', () => {
  it('writes a results CSV with escaped cells', () => {
    expect(resultsCsv([{ row: 1, status: 'done', taskHash: '0xh', taskId: '7', txHash: '0xt' }, { row: 2, status: 'failed', error: 'no, "really"' }]))
      .toBe('row,status,task_hash,task_id,tx_hash,error\n1,done,0xh,7,0xt,\n2,failed,,,,"no, ""really"""\n');
  });

  it('titles a brief by its first non-empty line', () => {
    expect(briefTitle('\n  Summarise this\nmore')).toBe('Summarise this');
    expect(briefTitle('x'.repeat(100), 10)).toBe('xxxxxxxxx…');
  });
});

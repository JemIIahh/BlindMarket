import { createInterface } from 'readline';
import { CliError } from './errors.js';

const interactive = () => process.stdin.isTTY === true;

/** Ask for a line on the terminal. */
export async function ask(question: string): Promise<string> {
  if (!interactive()) throw new CliError('NOT_INTERACTIVE', `${question.trim()} needs a terminal. Pass it as a flag or environment variable instead.`);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await new Promise<string>((resolve) => rl.question(question, resolve));
  } finally {
    rl.close();
  }
}

/** Ask for a secret without echoing it. */
export async function askHidden(question: string): Promise<string> {
  if (!interactive()) throw new CliError('NOT_INTERACTIVE', `${question.trim()} needs a terminal. Pass it through its environment variable instead.`);
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
  let prompted = false;
  out._writeToOutput = (s: string) => {
    // Echo the prompt once, never what is typed.
    if (!prompted) { out.output.write(s); prompted = true; }
  };
  try {
    return await new Promise<string>((resolve) => rl.question(question, resolve));
  } finally {
    rl.close();
    process.stderr.write('\n');
  }
}

/**
 * Ask before a spend. `yes` (the --yes flag) answers for scripts; without it
 * and without a terminal nothing is spent.
 */
export async function confirm(question: string, yes: boolean | undefined): Promise<void> {
  if (yes) return;
  if (!interactive()) throw new CliError('CONFIRM_REQUIRED', `${question} Nothing was sent. Re-run with --yes to confirm without a terminal.`);
  const answer = (await ask(`${question} [y/N] `)).trim().toLowerCase();
  if (answer !== 'y' && answer !== 'yes') throw new CliError('CANCELLED', 'Cancelled. Nothing was sent.');
}

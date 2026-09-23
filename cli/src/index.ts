#!/usr/bin/env node
import { buildProgram } from './program.js';

buildProgram().parseAsync(process.argv).catch((e: unknown) => {
  const err = e as { code?: string; message?: string };
  console.error(err.code ? `${err.code}: ${err.message}` : (err.message ?? String(e)));
  process.exit(1);
});

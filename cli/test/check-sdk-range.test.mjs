import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The publish guard (prepublishOnly). `deploy-agent --count` needs SDK
 * deployAgents, new in 0.10.0, and CI builds against the local sdk, so only
 * this guard stops a CLI whose range still allows 0.9 from being published.
 */

const { MIN_MINOR, rangeProblem } = await import('../scripts/check-sdk-range.mjs');

test('the publish guard refuses an SDK range that allows a release without deployAgents', () => {
  assert.equal(MIN_MINOR, 10);
  assert.match(rangeProblem('^0.9.0'), /needs "@blindmarket\/sdk": "\^0\.10\.0" or later/);
  assert.match(rangeProblem('^0.8.1'), /\^0\.10\.0/);
  assert.equal(rangeProblem('^0.10.0'), null);
  assert.equal(rangeProblem('^0.11.2'), null);
  assert.equal(rangeProblem('^1.0.0'), null);
});

test('the publish guard refuses a range that is not a caret range', () => {
  assert.notEqual(rangeProblem('*'), null);
  assert.notEqual(rangeProblem('file:../sdk'), null);
  assert.notEqual(rangeProblem(''), null);
});

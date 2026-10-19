import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The publish guard (prepublishOnly). The open-submission commands need SDK
 * getOpenTaskStatus and friends, new in 0.11.0, and CI builds against the
 * local sdk, so only this guard stops a CLI whose range still allows 0.10
 * from being published.
 */

const { MIN_MINOR, rangeProblem } = await import('../scripts/check-sdk-range.mjs');

test('the publish guard refuses an SDK range that allows a release without open submission', () => {
  assert.equal(MIN_MINOR, 11);
  assert.match(rangeProblem('^0.10.0'), /needs "@blindmarket\/sdk": "\^0\.11\.0" or later/);
  assert.match(rangeProblem('^0.9.0'), /\^0\.11\.0/);
  assert.equal(rangeProblem('^0.11.0'), null);
  assert.equal(rangeProblem('^0.12.2'), null);
  assert.equal(rangeProblem('^1.0.0'), null);
});

test('the publish guard refuses a range that is not a caret range', () => {
  assert.notEqual(rangeProblem('*'), null);
  assert.notEqual(rangeProblem('file:../sdk'), null);
  assert.notEqual(rangeProblem(''), null);
});

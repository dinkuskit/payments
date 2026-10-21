import assert from 'node:assert/strict';
import test from 'node:test';
import { describeStatusCheckFailure, readStatusCheckFailure } from '../src/registry/check-failure.ts';

test('status failure descriptions accept only closed stages and valid HTTP statuses', () => {
  for (const stage of ['read_control', 'read_key', 'fetch_pass', 'decode_pass', 'fetch_status', 'decode_status', 'recheck_control']) {
    assert.deepEqual(readStatusCheckFailure({ stage }), { stage });
    assert.match(describeStatusCheckFailure({ stage }), new RegExp(`Support code: status_${stage}`));
  }
  assert.deepEqual(readStatusCheckFailure({ stage: 'fetch_status', httpStatus: 503 }), { stage: 'fetch_status', httpStatus: 503 });
  for (const value of [null, [], { stage: '__proto__' }, { stage: 'private' },
    { stage: 'fetch_status', error: 'private' }, { stage: 'fetch_status', httpStatus: '503' },
    { stage: 'fetch_status', httpStatus: 99 }, { stage: 'fetch_status', httpStatus: 600 },
    { stage: 'fetch_status', httpStatus: 503.5 }]) {
    assert.equal(readStatusCheckFailure(value), null);
    assert.doesNotMatch(describeStatusCheckFailure(value), /private|__proto__|Support code/);
  }
});

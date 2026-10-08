import assert from 'node:assert/strict';
import test from 'node:test';
import { createHostedHandler } from '../src/hosted/http.ts';

const principal = { accountId: 'synthetic-owner', siteId: 'synthetic-site' };
function fixture() {
  let connects = 0;
  const handler = createHostedHandler({
    authenticate: async () => principal,
    service: () => ({ connect: async () => { connects++; return { state: 'setup_required', mode: 'test' }; } }),
  });
  return { handler, connects: () => connects };
}
function streamed(chunks) {
  return new Request('https://payments.example.invalid/v1/connect', {
    method: 'POST', duplex: 'half', body: new ReadableStream({
      start(controller) { for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk)); controller.close(); },
    }),
  });
}

test('connect accepts an exhausted empty POST stream as no input', async () => {
  const f = fixture();
  for (const chunks of [[], [[]], [[], []]]) {
    assert.equal((await f.handler(streamed(chunks))).status, 200);
  }
  assert.equal(f.connects(), 3);
});

test('connect rejects the first content byte without buffering caller input', async () => {
  const f = fixture();
  let canceled = false;
  const request = new Request('https://payments.example.invalid/v1/connect', {
    method: 'POST', duplex: 'half', body: new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([32])); },
      cancel() { canceled = true; },
    }),
  });
  const response = await f.handler(request);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'unexpected_input' });
  assert.equal(canceled, true);
  assert.equal(f.connects(), 0);
  assert.equal((await f.handler(streamed([[], [123], []]))).status, 400);
});

test('connect authenticates before inspecting a caller body stream', async () => {
  let touchedService = false;
  const handler = createHostedHandler({
    authenticate: async () => { throw new Error('unauthorized'); },
    service: () => { touchedService = true; throw new Error('must_not_run'); },
  });
  const request = streamed([[123]]);
  assert.equal((await handler(request)).status, 401);
  assert.equal(request.bodyUsed, false);
  assert.equal(touchedService, false);
});

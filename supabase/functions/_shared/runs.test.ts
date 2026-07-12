import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateRunGate, RUN_LIMITS } from './runs';

test('run gate: allows a first run', () => {
  assert.deepEqual(evaluateRunGate({ activeCount: 0, todayCount: 0 }), { ok: true });
  assert.deepEqual(evaluateRunGate({ activeCount: 0, todayCount: RUN_LIMITS.maxPerDay - 1 }), { ok: true });
});

test('run gate: an active run blocks a new one (409)', () => {
  const gate = evaluateRunGate({ activeCount: 1, todayCount: 0 });
  assert.equal(gate.ok, false);
  assert.equal(gate.ok === false && gate.status, 409);
});

test('run gate: the daily cap blocks even with no active run (429)', () => {
  const gate = evaluateRunGate({ activeCount: 0, todayCount: RUN_LIMITS.maxPerDay });
  assert.equal(gate.ok, false);
  assert.equal(gate.ok === false && gate.status, 429);
});

test('run gate: active cap takes precedence over the daily cap', () => {
  const gate = evaluateRunGate({ activeCount: 1, todayCount: RUN_LIMITS.maxPerDay });
  assert.equal(gate.ok === false && gate.status, 409, 'the more immediate reason wins');
});

test('run gate: custom limits are honored', () => {
  const limits = { maxActive: 3, maxPerDay: 100, staleHours: 2 };
  assert.deepEqual(evaluateRunGate({ activeCount: 2, todayCount: 0 }, limits), { ok: true });
  assert.equal(evaluateRunGate({ activeCount: 3, todayCount: 0 }, limits).ok, false);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BASE_BACKOFF_MS,
  CRAWL_BUDGET_MINUTES,
  JOB_OVERHEAD_MINUTES,
  JOB_TIMEOUT_MINUTES,
  MAX_ATTEMPTS,
  MAX_WAIT_MINUTES,
  backoffAfter,
  campaignWindow,
  classifyRun,
  decide,
  nextSlotPayload
} from '../scripts/publish-retry-gate.mjs';

/**
 * The retry ladder is where a mistake costs a whole night: a gate that says
 * "run" too often stacks ten crawls, and one that says "skip" too often leaves
 * the subscription a day stale. Both directions are pinned here.
 */

const WORKFLOW = 'scheduled-subscription.yml';
const REPO = 'owner/repo';
const ANCHOR = Date.UTC(2026, 10, 25, 20, 15, 0);

/** A fake GitHub API with just enough shape for the gate. */
function fakeApi(runs, jobsByRun = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/runs')) {
      return { ok: true, json: async () => ({ workflow_runs: runs }) };
    }
    const match = /\/runs\/(\d+)\/jobs$/.exec(parsed.pathname);
    if (match) {
      return { ok: true, json: async () => ({ jobs: [{ steps: jobsByRun[match[1]] ?? [] }] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetchImpl, calls };
}

function run(id, createdAt, options = {}) {
  const { event = 'schedule', status = 'completed', updatedAt } = options;
  return {
    id,
    event,
    status,
    conclusion: status === 'completed' ? 'success' : null,
    created_at: new Date(createdAt).toISOString(),
    updated_at: new Date(updatedAt ?? createdAt + 76 * 60_000).toISOString()
  };
}

const PUBLISHED_STEPS = [
  { name: 'Measure', conclusion: 'success' },
  { name: 'Report a held night', conclusion: 'skipped' },
  { name: 'Publish', conclusion: 'success' },
  { name: 'Verify what is actually served', conclusion: 'success' }
];
const HELD_STEPS = [
  { name: 'Measure', conclusion: 'success' },
  { name: 'Report a held night', conclusion: 'success' },
  { name: 'Publish', conclusion: 'skipped' },
  { name: 'Verify what is actually served', conclusion: 'skipped' }
];

const base = { repository: REPO, workflow: WORKFLOW, token: 't', currentRunId: '999', eventName: 'schedule' };

test('the campaign window is anchored at 20:15 UTC and lasts a day', () => {
  const inside = campaignWindow(ANCHOR + 60 * 60_000);
  assert.equal(inside.startMs, ANCHOR);
  assert.equal(inside.endMs, ANCHOR + 24 * 60 * 60_000);
  const before = campaignWindow(ANCHOR - 60 * 60_000);
  assert.equal(before.startMs, ANCHOR - 24 * 60 * 60_000);
});

test('the pause doubles from thirty minutes', () => {
  assert.equal(backoffAfter(0), 0);
  assert.equal(backoffAfter(1), BASE_BACKOFF_MS);
  assert.equal(backoffAfter(2), 2 * BASE_BACKOFF_MS);
  assert.equal(backoffAfter(3), 4 * BASE_BACKOFF_MS);
  assert.equal(backoffAfter(4), 8 * BASE_BACKOFF_MS);
});

test('the first cron slot of the campaign runs and chains', async () => {
  const { fetchImpl } = fakeApi([]);
  const decision = await decide({ ...base, nowMs: ANCHOR + 5 * 60_000, fetchImpl });
  assert.equal(decision.run, true);
  assert.equal(decision.chain, true);
  assert.equal(decision.attempt, 1);
  assert.equal(decision.waitMinutes, 0);
});

test('a cron slot inside the first pause waits for the next one', async () => {
  const first = run(1, ANCHOR + 5 * 60_000, { updatedAt: ANCHOR + 80 * 60_000 });
  const { fetchImpl } = fakeApi([first], { 1: HELD_STEPS });
  const decision = await decide({ ...base, nowMs: ANCHOR + 95 * 60_000, fetchImpl });
  assert.equal(decision.run, false, 'fifteen minutes after the attempt is inside the thirty-minute pause');
  assert.equal(decision.chain, false);
  assert.match(decision.reason, /30 min/);
});

test('a cron slot after the first pause runs again', async () => {
  const first = run(1, ANCHOR + 5 * 60_000, { updatedAt: ANCHOR + 80 * 60_000 });
  const { fetchImpl } = fakeApi([first], { 1: HELD_STEPS });
  const decision = await decide({ ...base, nowMs: ANCHOR + 115 * 60_000, fetchImpl });
  assert.equal(decision.run, true);
  assert.equal(decision.attempt, 2);
});

test('a chained slot waits until its due time instead of skipping', async () => {
  // The parent dispatches immediately; the child sleeps out the pause. This is
  // what keeps the ladder inside one night even when no cron fires again.
  const parent = run(1, ANCHOR + 5 * 60_000, { updatedAt: ANCHOR + 80 * 60_000 });
  const { fetchImpl } = fakeApi([parent], { 1: HELD_STEPS });
  const dueAt = ANCHOR + 110 * 60_000;
  const decision = await decide({
    ...base,
    eventName: 'repository_dispatch',
    payload: { attempt: 2, due_at: new Date(dueAt).toISOString(), parent_run_id: '1' },
    nowMs: ANCHOR + 80 * 60_000,
    fetchImpl
  });
  assert.equal(decision.run, true);
  assert.equal(decision.attempt, 2);
  assert.equal(decision.waitMinutes, 30);
});

test('a chained slot is not blocked by its own parent still reading in_progress', async () => {
  const parent = run(1, ANCHOR + 5 * 60_000, { status: 'in_progress', updatedAt: ANCHOR + 80 * 60_000 });
  const { fetchImpl } = fakeApi([parent]);
  const decision = await decide({
    ...base,
    eventName: 'repository_dispatch',
    payload: { attempt: 2, due_at: new Date(ANCHOR + 110 * 60_000).toISOString(), parent_run_id: '1' },
    nowMs: ANCHOR + 80 * 60_000,
    fetchImpl
  });
  assert.equal(decision.run, true, 'the parent is the run that dispatched this one; it cannot block its own child');
});

test('a chained slot inherits its attempt number rather than counting the API', async () => {
  // One every second attempt would be lost if the number came from the list:
  // the parent still reads in_progress while the child decides.
  const parent = run(1, ANCHOR + 5 * 60_000, { status: 'in_progress' });
  const { fetchImpl } = fakeApi([parent]);
  const decision = await decide({
    ...base,
    eventName: 'repository_dispatch',
    payload: { attempt: 4, due_at: new Date(ANCHOR).toISOString(), parent_run_id: '1' },
    nowMs: ANCHOR + 5 * 60 * 60_000,
    fetchImpl
  });
  assert.equal(decision.attempt, 4);
});

test('the wait a chained slot is asked to sit through is capped', async () => {
  const parent = run(1, ANCHOR, { status: 'in_progress' });
  const { fetchImpl } = fakeApi([parent]);
  const decision = await decide({
    ...base,
    eventName: 'repository_dispatch',
    payload: { attempt: 5, due_at: new Date(ANCHOR + 16 * 60 * 60_000).toISOString(), parent_run_id: '1' },
    nowMs: ANCHOR + 60 * 60_000,
    fetchImpl
  });
  assert.equal(decision.run, true);
  assert.equal(decision.waitMinutes, MAX_WAIT_MINUTES);
});

test('a published run ends the campaign, whatever the clock says', async () => {
  const first = run(1, ANCHOR + 35 * 60_000);
  const { fetchImpl } = fakeApi([first], { 1: PUBLISHED_STEPS });
  const decision = await decide({ ...base, nowMs: ANCHOR + 5 * 60 * 60_000, fetchImpl });
  assert.equal(decision.run, false);
  assert.match(decision.reason, /published/);
});

test('ten attempts in one campaign is the ceiling', async () => {
  const runs = [];
  const jobs = {};
  for (let index = 1; index <= MAX_ATTEMPTS; index += 1) {
    runs.push(run(index, ANCHOR + index * 60 * 60_000, { updatedAt: ANCHOR + index * 60 * 60_000 + 20 * 60_000 }));
    jobs[index] = HELD_STEPS;
  }
  const { fetchImpl } = fakeApi(runs, jobs);
  const decision = await decide({ ...base, nowMs: ANCHOR + 23 * 60 * 60_000, fetchImpl });
  assert.equal(decision.run, false);
  assert.match(decision.reason, /ceiling of 10/);
});

test('a chained attempt past the ceiling does not run', async () => {
  const parent = run(1, ANCHOR, { status: 'in_progress' });
  const { fetchImpl } = fakeApi([parent]);
  const decision = await decide({
    ...base,
    eventName: 'repository_dispatch',
    payload: { attempt: 11, parent_run_id: '1' },
    nowMs: ANCHOR + 60 * 60_000,
    fetchImpl
  });
  assert.equal(decision.run, false);
  assert.match(decision.reason, /ceiling of 10/);
});

test('a run still going holds every later slot', async () => {
  const running = run(1, ANCHOR + 5 * 60_000, { status: 'in_progress', updatedAt: ANCHOR + 5 * 60_000 });
  const { fetchImpl } = fakeApi([running]);
  const decision = await decide({ ...base, nowMs: ANCHOR + 35 * 60_000, fetchImpl });
  assert.equal(decision.run, false);
  assert.match(decision.reason, /still in_progress/);
});

test('a manual dispatch ignores the gate and does not chain', async () => {
  const first = run(1, ANCHOR + 5 * 60_000);
  const { fetchImpl } = fakeApi([first], { 1: PUBLISHED_STEPS });
  const decision = await decide({ ...base, nowMs: ANCHOR + 60 * 60_000, fetchImpl, eventName: 'workflow_dispatch' });
  assert.equal(decision.run, true);
  assert.equal(decision.chain, false);
});

test('a manual run is not one of the campaign attempts', async () => {
  const manual = run(1, ANCHOR + 5 * 60_000, { event: 'workflow_dispatch' });
  const { fetchImpl } = fakeApi([manual], { 1: HELD_STEPS });
  const decision = await decide({ ...base, nowMs: ANCHOR + 90 * 60_000, fetchImpl });
  // A manual run at 20:20 must not consume the night's first chance or impose
  // its pause on the first scheduled attempt.
  assert.equal(decision.run, true);
  assert.equal(decision.attempt, 1);
});

test('a run outside the current campaign is not counted', async () => {
  const runs = [];
  const jobs = {};
  for (let index = 1; index <= MAX_ATTEMPTS; index += 1) {
    runs.push(run(index, ANCHOR - 20 * 60 * 60_000 + index * 60_000, { updatedAt: ANCHOR - 20 * 60 * 60_000 + index * 60_000 + 5 * 60_000 }));
    jobs[index] = HELD_STEPS;
  }
  const { fetchImpl } = fakeApi(runs, jobs);
  const decision = await decide({ ...base, nowMs: ANCHOR + 5 * 60_000, fetchImpl });
  assert.equal(decision.run, true);
  assert.equal(decision.attempt, 1);
});

test('an unreadable history fails closed', async () => {
  const fetchImpl = async () => ({ ok: false, status: 502, json: async () => ({}) });
  await assert.rejects(() => decide({ ...base, nowMs: ANCHOR, fetchImpl }), /answered 502/);
});

test('a run is classified by the step only the publish path reaches', () => {
  assert.equal(classifyRun(PUBLISHED_STEPS), 'published');
  assert.equal(classifyRun(HELD_STEPS), 'held');
  assert.equal(classifyRun([{ name: 'Measure', conclusion: 'failure' }]), 'failed');
  assert.equal(classifyRun([]), 'unknown');
});

test('the next slot is due one backoff after this attempt', () => {
  const payload = nextSlotPayload({ attempt: 2, nowMs: ANCHOR });
  assert.equal(payload.attempt, 3);
  assert.equal(Date.parse(payload.due_at) - ANCHOR, backoffAfter(2));
  assert.equal(payload.parent_run_id, String(process.env.GITHUB_RUN_ID ?? ''));
});

test('a manual run that publishes ends the campaign', async () => {
  // The operator stepping in and publishing is the night's work done. Later
  // slots must exit instead of crawling over a fresh subscription.
  const manual = run(1, ANCHOR + 5 * 60_000, { event: 'workflow_dispatch' });
  const { fetchImpl } = fakeApi([manual], { 1: PUBLISHED_STEPS });
  const decision = await decide({ ...base, nowMs: ANCHOR + 3 * 60 * 60_000, fetchImpl });
  assert.equal(decision.run, false);
  assert.match(decision.reason, /published/);
});

test('a manual crawl in progress holds the next slot', async () => {
  const manual = run(1, ANCHOR + 5 * 60_000, { event: 'workflow_dispatch', status: 'in_progress' });
  const { fetchImpl } = fakeApi([manual]);
  const decision = await decide({ ...base, nowMs: ANCHOR + 10 * 60_000, fetchImpl });
  assert.equal(decision.run, false);
  assert.match(decision.reason, /still in_progress/);
});

test('the wait cap leaves room for a real crawl inside the job timeout', () => {
  // A chained slot sleeps before it crawls. If the cap plus the crawl budget
  // ever exceeded the job's wall clock, the platform would cancel the run
  // mid-crawl: the attempt is lost and nothing is left to dispatch the next
  // slot, so the ladder would end on the night it was needed most.
  assert.ok(
    MAX_WAIT_MINUTES + CRAWL_BUDGET_MINUTES + JOB_OVERHEAD_MINUTES <= JOB_TIMEOUT_MINUTES,
    `wait ${MAX_WAIT_MINUTES} + crawl ${CRAWL_BUDGET_MINUTES} + overhead ${JOB_OVERHEAD_MINUTES} exceeds the ${JOB_TIMEOUT_MINUTES} min job timeout`
  );
  assert.equal(MAX_WAIT_MINUTES, 200, 'the derived cap is 200 minutes');
});

test('the workflow declares the same job timeout the gate budgets for', async () => {
  const { readFileSync } = await import('node:fs');
  const workflow = readFileSync(new URL('../.github/workflows/scheduled-subscription.yml', import.meta.url), 'utf8');
  const declared = Number(/^\s{4}timeout-minutes:\s*(\d+)\s*$/m.exec(workflow)?.[1] ?? 0);
  assert.equal(declared, JOB_TIMEOUT_MINUTES, 'the workflow timeout and the gate budget disagree');
});

test('a chained slot whose parent published does not run', async () => {
  // The parent is exempt from the in-flight guard (its row can still read
  // in_progress while the child decides) but not from the publish scan: a
  // published parent means the campaign is over. Found by running the merged
  // gate against live history, where it answered "run" here.
  const parent = run(1, ANCHOR + 5 * 60_000);
  const { fetchImpl } = fakeApi([parent], { 1: PUBLISHED_STEPS });
  const decision = await decide({
    ...base,
    eventName: 'repository_dispatch',
    payload: { attempt: 2, parent_run_id: '1' },
    nowMs: ANCHOR + 100 * 60_000,
    fetchImpl
  });
  assert.equal(decision.run, false);
  assert.equal(decision.chain, false);
  assert.match(decision.reason, /published/);
});

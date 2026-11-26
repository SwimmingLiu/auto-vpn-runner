import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BASE_BACKOFF_MS,
  CRAWL_BUDGET_MINUTES,
  JOB_OVERHEAD_MINUTES,
  JOB_TIMEOUT_MINUTES,
  MAX_ATTEMPTS,
  MAX_WAIT_MINUTES,
  MAX_WAITER_MINUTES,
  WAITER_OVERHEAD_MINUTES,
  backoffAfter,
  campaignWindow,
  classifyRun,
  decide,
  handoffPayload,
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
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

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
    updated_at: new Date(updatedAt ?? createdAt + 76 * MINUTE).toISOString()
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
/** A slot the gate turned down: nothing ran. */
const SKIPPED_STEPS = [
  { name: 'Measure', conclusion: 'skipped' },
  { name: 'Report a held night', conclusion: 'skipped' },
  { name: 'Publish', conclusion: 'skipped' },
  { name: 'Verify what is actually served', conclusion: 'skipped' }
];
/** A run cancelled while queued: the API reports no steps at all. */
const NO_STEPS = [];

const base = {
  repository: REPO,
  workflow: WORKFLOW,
  token: 't',
  currentRunId: '999',
  eventName: 'schedule',
  sleep: async () => {}
};

test('the campaign window is anchored at 20:15 UTC and lasts a day', () => {
  const inside = campaignWindow(ANCHOR + HOUR);
  assert.equal(inside.startMs, ANCHOR);
  assert.equal(inside.endMs, ANCHOR + 24 * HOUR);
  const before = campaignWindow(ANCHOR - HOUR);
  assert.equal(before.startMs, ANCHOR - 24 * HOUR);
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
  const decision = await decide({ ...base, nowMs: ANCHOR + 5 * MINUTE, fetchImpl });
  assert.equal(decision.run, true);
  assert.equal(decision.chain, true);
  assert.equal(decision.waiter, false);
  assert.equal(decision.attempt, 1);
  assert.equal(decision.waitMinutes, 0);
});

test('a cron slot inside the first pause waits it out instead of crawling early', async () => {
  // A cron that starts proves no chained slot is running, so this is the only
  // chance the night gets: it must sleep out the rest of the pause rather than
  // either crawling inside it or skipping to the next cron.
  const first = run(1, ANCHOR + 5 * MINUTE, { updatedAt: ANCHOR + 80 * MINUTE });
  const { fetchImpl } = fakeApi([first], { 1: HELD_STEPS });
  const decision = await decide({ ...base, nowMs: ANCHOR + 95 * MINUTE, fetchImpl });
  assert.equal(decision.run, true, 'fifteen minutes after the attempt is inside the thirty-minute pause');
  assert.equal(decision.attempt, 2);
  assert.equal(decision.waitMinutes, 15);
});

test('a cron slot after the first pause runs without waiting', async () => {
  const first = run(1, ANCHOR + 5 * MINUTE, { updatedAt: ANCHOR + 80 * MINUTE });
  const { fetchImpl } = fakeApi([first], { 1: HELD_STEPS });
  const decision = await decide({ ...base, nowMs: ANCHOR + 115 * MINUTE, fetchImpl });
  assert.equal(decision.run, true);
  assert.equal(decision.attempt, 2);
  assert.equal(decision.waitMinutes, 0);
});

test('a chained slot waits until its due time instead of skipping', async () => {
  // The parent dispatches immediately; the child sleeps out the pause. This is
  // what keeps the ladder inside one night even when no cron fires again.
  const parent = run(1, ANCHOR + 5 * MINUTE, { updatedAt: ANCHOR + 80 * MINUTE });
  const { fetchImpl } = fakeApi([parent], { 1: HELD_STEPS });
  const dueAt = ANCHOR + 110 * MINUTE;
  const decision = await decide({
    ...base,
    eventName: 'repository_dispatch',
    payload: { attempt: 2, due_at: new Date(dueAt).toISOString(), parent_run_id: '1' },
    nowMs: ANCHOR + 80 * MINUTE,
    fetchImpl
  });
  assert.equal(decision.run, true);
  assert.equal(decision.attempt, 2);
  assert.equal(decision.waitMinutes, 30);
});

test('a chained slot is not blocked by its own parent still reading in_progress', async () => {
  const parent = run(1, ANCHOR + 5 * MINUTE, { status: 'in_progress', updatedAt: ANCHOR + 80 * MINUTE });
  const { fetchImpl } = fakeApi([parent]);
  const decision = await decide({
    ...base,
    eventName: 'repository_dispatch',
    payload: { attempt: 2, due_at: new Date(ANCHOR + 110 * MINUTE).toISOString(), parent_run_id: '1' },
    nowMs: ANCHOR + 80 * MINUTE,
    fetchImpl
  });
  assert.equal(decision.run, true, 'the parent is the run that dispatched this one; it cannot block its own child');
});

test('a chained slot inherits its attempt number rather than counting the API', async () => {
  // Numbering from the list alone would lose an attempt while the parent's row
  // still reads in_progress.
  const parent = run(1, ANCHOR + 5 * MINUTE, { status: 'in_progress' });
  const { fetchImpl } = fakeApi([parent]);
  const decision = await decide({
    ...base,
    eventName: 'repository_dispatch',
    payload: { attempt: 4, due_at: new Date(ANCHOR).toISOString(), parent_run_id: '1' },
    nowMs: ANCHOR + 5 * HOUR,
    fetchImpl
  });
  assert.equal(decision.attempt, 4);
});

test('a stale payload cannot lower the attempt below the history', async () => {
  // A cron slot crawled while this chained slot sat queued. Its own number is
  // now two, but the next free one is three; letting the payload win would
  // spend a chance twice.
  const parent = run(1, ANCHOR + 5 * MINUTE, { updatedAt: ANCHOR + 80 * MINUTE });
  const cron = run(2, ANCHOR + 90 * MINUTE, { updatedAt: ANCHOR + 170 * MINUTE });
  const { fetchImpl } = fakeApi([parent, cron], { 1: HELD_STEPS, 2: HELD_STEPS });
  const decision = await decide({
    ...base,
    eventName: 'repository_dispatch',
    payload: { attempt: 2, due_at: new Date(ANCHOR + 110 * MINUTE).toISOString(), parent_run_id: '1' },
    nowMs: ANCHOR + 200 * MINUTE,
    fetchImpl
  });
  assert.equal(decision.attempt, 3);
  assert.equal(decision.attempts, 2);
});

test('a stale due time cannot run two crawls back to back', async () => {
  // The payload said 22:00; a cron slot crawled 22:10-23:20 in the meantime.
  // Honouring the payload would start the next crawl the moment this one
  // begins, inside the pause the cron's attempt earned.
  const first = run(1, ANCHOR + 5 * MINUTE, { updatedAt: ANCHOR + 80 * MINUTE });
  const cron = run(2, ANCHOR + 115 * MINUTE, { updatedAt: ANCHOR + 200 * MINUTE });
  const { fetchImpl } = fakeApi([first, cron], { 1: HELD_STEPS, 2: HELD_STEPS });
  const decision = await decide({
    ...base,
    eventName: 'repository_dispatch',
    payload: { attempt: 2, due_at: new Date(ANCHOR + 110 * MINUTE).toISOString(), parent_run_id: '1' },
    nowMs: ANCHOR + 200 * MINUTE,
    fetchImpl
  });
  assert.equal(decision.run, true);
  assert.equal(decision.attempt, 3);
  assert.equal(decision.waitMinutes, 60, 'the pause belongs to the crawl that actually finished last');
});

/** `count` held attempts, the last one finishing at `lastFinished`. */
function heldRuns(count, lastFinished) {
  const runs = [];
  const jobs = {};
  for (let index = 1; index <= count; index += 1) {
    const updatedAt = lastFinished - (count - index) * 60 * MINUTE;
    const event = index === 1 ? 'schedule' : 'repository_dispatch';
    runs.push(run(index, updatedAt - 75 * MINUTE, { event, updatedAt }));
    jobs[index] = HELD_STEPS;
  }
  return { runs, jobs };
}

test('a chained eight-hour pause becomes a waiter that hands the slot on', async () => {
  // A GitHub-hosted job dies at 360 minutes. Sleeping eight hours in one job is
  // impossible, but the pause is the operator's policy, so the slot itself is
  // handed to a successor that finishes the wait.
  const { runs, jobs } = heldRuns(5, ANCHOR + 9 * HOUR);
  const { fetchImpl } = fakeApi(runs, jobs);
  const now = ANCHOR + 10 * HOUR;
  const decision = await decide({
    ...base,
    eventName: 'repository_dispatch',
    payload: { attempt: 6, due_at: new Date(now + 8 * HOUR).toISOString(), parent_run_id: '5' },
    nowMs: now,
    fetchImpl
  });
  assert.equal(decision.run, false, 'the job cannot both sleep eight hours and crawl');
  assert.equal(decision.waiter, true);
  assert.equal(decision.chain, true);
  assert.equal(decision.waitMinutes, MAX_WAITER_MINUTES);
  assert.equal(Date.parse(decision.dueAt) - now, 8 * HOUR, 'the due time survives the handoff untouched');
  assert.equal(decision.attempt, 6);
});

test('a waiter hands on the same slot rather than the next one', () => {
  const payload = handoffPayload({ attempt: 7, dueAt: '2026-11-26T12:00:00.000Z' });
  assert.equal(payload.attempt, 7, 'a waiter spends no attempt');
  assert.equal(payload.due_at, '2026-11-26T12:00:00.000Z');
  assert.equal(payload.parent_run_id, String(process.env.GITHUB_RUN_ID ?? ''));
});

test('the last waiter of a long pause leaves a slot that can crawl', async () => {
  const { runs, jobs } = heldRuns(5, ANCHOR + 9 * HOUR);
  const { fetchImpl } = fakeApi(runs, jobs);
  const now = ANCHOR + 14 * HOUR + 45 * MINUTE;
  const decision = await decide({
    ...base,
    eventName: 'repository_dispatch',
    payload: { attempt: 6, due_at: new Date(ANCHOR + 17 * HOUR).toISOString(), parent_run_id: '5' },
    nowMs: now,
    fetchImpl
  });
  assert.equal(decision.run, true);
  assert.equal(decision.waiter, false);
  assert.equal(decision.waitMinutes, 135);
});

test('a pause that would run past the campaign ends the ladder', async () => {
  // The window rotates at the next 20:15 anchor. A slot due after it belongs to
  // a night that is already over; the next campaign starts with its own first
  // attempt rather than inheriting a crawl from this one.
  const { runs, jobs } = heldRuns(6, ANCHOR + 9 * HOUR);
  const { fetchImpl } = fakeApi(runs, jobs);
  const decision = await decide({
    ...base,
    eventName: 'repository_dispatch',
    payload: { attempt: 7, due_at: new Date(ANCHOR + 25 * HOUR).toISOString(), parent_run_id: '6' },
    nowMs: ANCHOR + 10 * HOUR,
    fetchImpl
  });
  assert.equal(decision.run, false);
  assert.equal(decision.waiter, false);
  assert.equal(decision.chain, false);
  assert.match(decision.reason, /past the end of the campaign/);
});

test('a pause too long to crawl behind is slept as far as the job allows', async () => {
  const parent = run(1, ANCHOR, { status: 'in_progress' });
  const { fetchImpl } = fakeApi([parent]);
  const decision = await decide({
    ...base,
    eventName: 'repository_dispatch',
    payload: { attempt: 5, due_at: new Date(ANCHOR + 5 * HOUR).toISOString(), parent_run_id: '1' },
    nowMs: ANCHOR + 60 * MINUTE,
    fetchImpl
  });
  // Four hours of pause: too long to sleep and still leave the crawl its
  // budget, so this job sleeps it out and hands the same slot on.
  assert.equal(decision.run, false);
  assert.equal(decision.waiter, true);
  assert.equal(decision.waitMinutes, 240);
});

test('a published run ends the campaign, whatever the clock says', async () => {
  const first = run(1, ANCHOR + 35 * MINUTE);
  const { fetchImpl } = fakeApi([first], { 1: PUBLISHED_STEPS });
  const decision = await decide({ ...base, nowMs: ANCHOR + 5 * HOUR, fetchImpl });
  assert.equal(decision.run, false);
  assert.match(decision.reason, /published/);
});

test('a run created before the anchor that publishes after it still ends the campaign', async () => {
  // A chained slot dispatched at 18:30 sleeps through the anchor, crawls at
  // 21:50 and publishes at 23:05. Keyed on creation alone it is invisible to
  // the campaign it lands in, and the 20:15 slot crawls over that fresh
  // subscription. Found by simulating a full night against the real functions.
  const straddler = run(1, ANCHOR - 105 * MINUTE, {
    event: 'repository_dispatch',
    updatedAt: ANCHOR + 170 * MINUTE
  });
  const { fetchImpl } = fakeApi([straddler], { 1: PUBLISHED_STEPS });
  const decision = await decide({ ...base, nowMs: ANCHOR + 3 * HOUR, fetchImpl });
  assert.equal(decision.run, false);
  assert.match(decision.reason, /published/);
});

test('a queued sibling does not hold the slot that is due to run', async () => {
  // Only a run that is executing shares the concurrency group with this one; a
  // queued run starts after it ends. Treating it as in-flight lost the chained
  // slot that was already due.
  const queued = run(1, ANCHOR + 5 * MINUTE, { status: 'queued', updatedAt: ANCHOR + 5 * MINUTE });
  const { fetchImpl } = fakeApi([queued]);
  const decision = await decide({ ...base, nowMs: ANCHOR + 10 * MINUTE, fetchImpl });
  assert.equal(decision.run, true);
});

test('a run still executing holds every later slot', async () => {
  const running = run(1, ANCHOR + 5 * MINUTE, { status: 'in_progress', updatedAt: ANCHOR + 5 * MINUTE });
  const { fetchImpl } = fakeApi([running]);
  const decision = await decide({ ...base, nowMs: ANCHOR + 35 * MINUTE, fetchImpl });
  assert.equal(decision.run, false);
  assert.match(decision.reason, /still in_progress/);
});

test('a slot is not blocked by its own row reading in_progress', async () => {
  // The gate reads the run history at the head of a job that has already
  // started, so the current run is in it and in_progress. Exempting it is half
  // of what makes the gate able to decide at all.
  const { fetchImpl } = fakeApi([run(999, ANCHOR, { status: 'in_progress' })]);
  const decision = await decide({ ...base, nowMs: ANCHOR + MINUTE, fetchImpl });
  assert.equal(decision.run, true, 'a slot refused to run because it could see itself');
});

test('a straddling parent still crawling in the API keeps its pause', async () => {
  // The parent's row flips to `completed` a second or two after its chain
  // step. During that window it is exempt from the in-flight guard and absent
  // from the completed-run scan, so a parent created before the anchor lost
  // both its number and its pause: the child crawled one minute after a
  // ninety-minute crawl.
  const parent = run(1, ANCHOR - 90 * MINUTE, {
    event: 'schedule',
    status: 'in_progress',
    updatedAt: ANCHOR + 5 * MINUTE
  });
  const { fetchImpl } = fakeApi([parent], { 1: HELD_STEPS });
  const decision = await decide({
    ...base,
    eventName: 'repository_dispatch',
    payload: { attempt: 3, due_at: new Date(ANCHOR + 65 * MINUTE).toISOString(), parent_run_id: '1' },
    nowMs: ANCHOR + 5 * MINUTE,
    fetchImpl
  });
  assert.equal(decision.run, true);
  assert.equal(decision.attempt, 2, 'the parent is this campaign\'s first attempt even before its row flips');
  assert.equal(decision.waitMinutes, 30, 'the first rung belongs to the crawl that just finished');
});

test('a straddling parent that published calls the campaign done', async () => {
  const parent = run(1, ANCHOR - 30 * MINUTE, {
    event: 'repository_dispatch',
    status: 'in_progress',
    updatedAt: ANCHOR + MINUTE
  });
  const { fetchImpl } = fakeApi([parent], { 1: PUBLISHED_STEPS });
  const decision = await decide({
    ...base,
    eventName: 'repository_dispatch',
    payload: { attempt: 2, parent_run_id: '1' },
    nowMs: ANCHOR + 2 * MINUTE,
    fetchImpl
  });
  assert.equal(decision.run, false);
  assert.match(decision.reason, /published/);
});

test('a manual dispatch ignores the gate and does not chain', async () => {
  const first = run(1, ANCHOR + 5 * MINUTE);
  const { fetchImpl } = fakeApi([first], { 1: PUBLISHED_STEPS });
  const decision = await decide({ ...base, nowMs: ANCHOR + 60 * MINUTE, fetchImpl, eventName: 'workflow_dispatch' });
  assert.equal(decision.run, true);
  assert.equal(decision.chain, false);
});

test('a manual run is not one of the campaign attempts', async () => {
  const manual = run(1, ANCHOR + 5 * MINUTE, { event: 'workflow_dispatch' });
  const { fetchImpl } = fakeApi([manual], { 1: HELD_STEPS });
  const decision = await decide({ ...base, nowMs: ANCHOR + 90 * MINUTE, fetchImpl });
  // A manual run at 20:20 must not consume the night's first chance or impose
  // its pause on the first scheduled attempt.
  assert.equal(decision.run, true);
  assert.equal(decision.attempt, 1);
});

test('a slot the gate turned down is not an attempt', async () => {
  // Every cron that fires while a chained successor is sleeping is a no-op
  // row. Counting those spent chances the night never took and pushed the
  // pause clock forward on nothing.
  const expected = run(1, ANCHOR + 5 * MINUTE, { updatedAt: ANCHOR + 80 * MINUTE });
  const noop1 = run(2, ANCHOR + 95 * MINUTE, { updatedAt: ANCHOR + 96 * MINUTE });
  const noop2 = run(3, ANCHOR + 130 * MINUTE, { updatedAt: ANCHOR + 131 * MINUTE });
  const { fetchImpl } = fakeApi([expected, noop1, noop2], { 1: HELD_STEPS, 2: SKIPPED_STEPS, 3: SKIPPED_STEPS });
  const decision = await decide({ ...base, nowMs: ANCHOR + 131 * MINUTE, fetchImpl });
  assert.equal(decision.attempt, 2, 'two no-op rows must not turn the second attempt into a fourth');
  assert.equal(decision.waitMinutes, 0, 'the no-ops must not reset the clock on nothing');
});

test('a run cancelled before it started is not an attempt', async () => {
  const expected = run(1, ANCHOR + 5 * MINUTE, { updatedAt: ANCHOR + 80 * MINUTE });
  const cancelled = run(2, ANCHOR + 90 * MINUTE, { updatedAt: ANCHOR + 91 * MINUTE });
  const { fetchImpl } = fakeApi([expected, cancelled], { 1: HELD_STEPS, 2: NO_STEPS });
  const decision = await decide({ ...base, nowMs: ANCHOR + 120 * MINUTE, fetchImpl });
  assert.equal(decision.attempt, 2);
});

test('a crawl cancelled during Measure is still an attempt', async () => {
  // The operator's cancel, or the job ceiling on a slow night: the step ran and
  // was cut short. Classifying it as nothing let the next slot crawl ten
  // minutes after an eighty-minute crawl, and let a night of overruns never
  // reach the ceiling.
  const cancelled = run(1, ANCHOR + 5 * MINUTE, { updatedAt: ANCHOR + 85 * MINUTE });
  const { fetchImpl } = fakeApi([cancelled], {
    1: [
      { name: 'Measure', conclusion: 'cancelled' },
      { name: 'Report a held night', conclusion: 'skipped' },
      { name: 'Publish', conclusion: 'skipped' },
      { name: 'Verify what is actually served', conclusion: 'skipped' }
    ]
  });
  const decision = await decide({ ...base, nowMs: ANCHOR + 95 * MINUTE, fetchImpl });
  assert.equal(decision.attempt, 2);
  assert.equal(decision.waitMinutes, 20);
});

test('a stall streak never withholds the chain from a slot that might recover', async () => {
  // Spending nothing is right for a transient 5xx and a run storm for a
  // misconfiguration — but enforcing the cutoff here ended the night on the
  // third slot, which is the one that measured and proved the blip was over.
  // The cutoff belongs to the handoff, the only place that knows the slot died.
  const { fetchImpl } = fakeApi([]);
  const decision = await decide({
    ...base,
    eventName: 'repository_dispatch',
    payload: { attempt: 1, stalled: 5 },
    nowMs: ANCHOR + 10 * MINUTE,
    fetchImpl
  });
  assert.equal(decision.run, true, 'the slot still gets its chance');
  assert.equal(decision.chain, true, 'a slot that recovers must be allowed to hand on');
});

test('the handoff refuses to extend a stall streak past the limit', async () => {
  const { execFileSync, spawnSync } = await import('node:child_process');
  const script = new URL('../scripts/publish-retry-gate.mjs', import.meta.url);
  const allowed = JSON.parse(
    execFileSync(process.execPath, [fileURLToPath(script), '--handoff', '--attempt', '5', '--stalled', '2'], { encoding: 'utf8' })
  );
  assert.equal(allowed.attempt, 5, 'a handoff inside the limit keeps the slot');
  assert.equal(allowed.stalled, 2);

  const refused = spawnSync(process.execPath, [fileURLToPath(script), '--handoff', '--attempt', '5', '--stalled', '3'], { encoding: 'utf8' });
  assert.equal(refused.status, 3, 'a fourth slot in a row must not be dispatched');
  assert.equal(refused.stdout.trim(), '', 'a refused handoff still printed a payload');
  assert.match(refused.stderr, /died before measuring/);
});

test('a measured run resets the streak', () => {
  // `--next` carries no streak, so a slot that measured and failed cannot
  // inherit a previous stall and stop the ladder one hop later.
  assert.equal(Object.prototype.hasOwnProperty.call(nextSlotPayload({ attempt: 3, nowMs: ANCHOR }), 'stalled'), false);
});

test('a crawl that failed is an attempt', async () => {
  const failed = run(1, ANCHOR + 5 * MINUTE, {
    updatedAt: ANCHOR + 40 * MINUTE
  });
  const { fetchImpl } = fakeApi([failed], { 1: [{ name: 'Measure', conclusion: 'failure' }] });
  const decision = await decide({ ...base, nowMs: ANCHOR + 45 * MINUTE, fetchImpl });
  assert.equal(decision.attempt, 2);
  assert.equal(decision.waitMinutes, 25, 'the pause runs from the failed crawl, not from nothing');
});

test('a run that measured and then failed at Publish still spends its chance', async () => {
  // Seventy-five minutes were measured and the floor was cleared; the run died
  // on the way out. Classifying that as "nothing happened" let a later slot
  // crawl minutes after it, inside the pause it had earned, and let ten such
  // runs pass the ceiling uncounted.
  const publishFailed = [
    { name: 'Measure', conclusion: 'success' },
    { name: 'Report a held night', conclusion: 'skipped' },
    { name: 'Publish', conclusion: 'failure' },
    { name: 'Verify what is actually served', conclusion: 'skipped' }
  ];
  const failed = run(1, ANCHOR + 5 * MINUTE, { updatedAt: ANCHOR + 80 * MINUTE });
  const { fetchImpl } = fakeApi([failed], { 1: publishFailed });
  const decision = await decide({ ...base, nowMs: ANCHOR + 90 * MINUTE, fetchImpl });
  assert.equal(decision.attempt, 2);
  assert.equal(decision.waitMinutes, 20, 'the pause runs from when that run finished');
});

test('a handoff with no due time paces itself from the history alone', async () => {
  // What a slot that died before it measured hands on: the same number, no due
  // time. The successor must not invent a pause from a failure that measured
  // nothing — it reads the last real crawl and finds the wait already served.
  const { runs, jobs } = heldRuns(5, ANCHOR + 9 * HOUR);
  const { fetchImpl } = fakeApi(runs, jobs);
  const decision = await decide({
    ...base,
    eventName: 'repository_dispatch',
    payload: { attempt: 6, due_at: '', parent_run_id: '5' },
    nowMs: ANCHOR + 18 * HOUR,
    fetchImpl
  });
  assert.equal(decision.attempt, 6);
  assert.equal(decision.run, true);
  assert.equal(decision.waitMinutes, 0, 'the eight-hour pause after attempt 5 has long expired');
});

test('a payload from the previous campaign does not number this one', async () => {
  // A waiter's sleep can cross the 20:15 anchor — a pause due at 20:14 wakes
  // and hands off at 20:15. The number and due time it carries belong to the
  // night that just ended; inheriting them starts the new campaign halfway up
  // the ladder, with two crawls left before its ceiling.
  const { fetchImpl } = fakeApi([]);
  const decision = await decide({
    ...base,
    eventName: 'repository_dispatch',
    payload: { attempt: 6, due_at: new Date(ANCHOR - 60_000).toISOString(), parent_run_id: '42' },
    nowMs: ANCHOR + 20_000,
    fetchImpl
  });
  assert.equal(decision.attempt, 1, 'the new campaign starts counting from one');
  assert.equal(decision.run, true);
  assert.equal(decision.waitMinutes, 0);
});

test('a parent that straddles the anchor speaks for the campaign it finishes in', async () => {
  // Created before the anchor, finished after it: the run is in this window,
  // but its number was the previous campaign's. The history counts it as this
  // campaign's first attempt, so the next one is two.
  const straddler = run(1, ANCHOR - 2 * HOUR, {
    event: 'repository_dispatch',
    updatedAt: ANCHOR + 10 * MINUTE
  });
  const { fetchImpl } = fakeApi([straddler], { 1: HELD_STEPS });
  const decision = await decide({
    ...base,
    eventName: 'repository_dispatch',
    payload: { attempt: 7, due_at: new Date(ANCHOR + 5 * MINUTE).toISOString(), parent_run_id: '1' },
    nowMs: ANCHOR + 15 * MINUTE,
    fetchImpl
  });
  assert.equal(decision.attempt, 2);
});

test('ten attempts in one campaign is the ceiling', async () => {
  const runs = [];
  const jobs = {};
  for (let index = 1; index <= MAX_ATTEMPTS; index += 1) {
    runs.push(run(index, ANCHOR + index * HOUR, { updatedAt: ANCHOR + index * HOUR + 20 * MINUTE }));
    jobs[index] = HELD_STEPS;
  }
  const { fetchImpl } = fakeApi(runs, jobs);
  const decision = await decide({ ...base, nowMs: ANCHOR + 23 * HOUR, fetchImpl });
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
    nowMs: ANCHOR + 60 * MINUTE,
    fetchImpl
  });
  assert.equal(decision.run, false);
  assert.match(decision.reason, /ceiling of 10/);
});

test('a run outside the current campaign is not counted', async () => {
  const runs = [];
  const jobs = {};
  for (let index = 1; index <= MAX_ATTEMPTS; index += 1) {
    const created = ANCHOR - 20 * HOUR + index * MINUTE;
    runs.push(run(index, created, { updatedAt: created + 5 * MINUTE }));
    jobs[index] = HELD_STEPS;
  }
  const { fetchImpl } = fakeApi(runs, jobs);
  const decision = await decide({ ...base, nowMs: ANCHOR + 5 * MINUTE, fetchImpl });
  assert.equal(decision.run, true);
  assert.equal(decision.attempt, 1);
});

test('a transient API error is retried, not fatal', async () => {
  let failures = 2;
  let calls = 0;
  const { fetchImpl: healthy } = fakeApi([]);
  const fetchImpl = async (url, init) => {
    calls += 1;
    // Match the path, not the whole URL: the request carries a query string,
    // and a fake that never fires makes this test pass with the retry removed.
    if (failures > 0 && new URL(url).pathname.endsWith('/runs')) {
      failures -= 1;
      return { ok: false, status: 502, json: async () => ({}) };
    }
    return healthy(url, init);
  };
  const decision = await decide({ ...base, nowMs: ANCHOR + MINUTE, fetchImpl });
  assert.equal(decision.run, true);
  assert.equal(failures, 0, 'the injected failures were never consumed; the retry was not exercised');
  assert.ok(calls > 2, 'one 5xx ended the ladder');
});

test('a rate-limited 403 is retried, a permission 403 is not', async () => {
  // GitHub answers a secondary rate limit with 403 and `retry-after`; the same
  // status with no such header is a permission error that will never heal.
  const limited = (headers) => async (url) => {
    const response = { ok: false, status: 403, json: async () => ({}), headers: { get: (name) => headers[name] ?? null } };
    return response;
  };
  let calls = 0;
  const healthy = fakeApi([]).fetchImpl;
  const rateLimited = async (url, init) => {
    calls += 1;
    if (calls === 1) return limited({ 'retry-after': '1' })(url);
    return healthy(url, init);
  };
  const decision = await decide({ ...base, nowMs: ANCHOR + MINUTE, fetchImpl: rateLimited });
  assert.equal(decision.run, true, 'a rate-limited 403 ended the ladder');
  assert.equal(calls, 2, 'the rate-limited call was not retried');

  // The primary limit answers 403 with the remaining count at zero instead of
  // a retry-after header.
  let primaryCalls = 0;
  const primary = async (url, init) => {
    primaryCalls += 1;
    if (primaryCalls === 1) return limited({ 'x-ratelimit-remaining': '0' })(url);
    return healthy(url, init);
  };
  const primaryDecision = await decide({ ...base, nowMs: ANCHOR + MINUTE, fetchImpl: primary });
  assert.equal(primaryDecision.run, true, 'a primary rate limit ended the ladder');
  assert.equal(primaryCalls, 2, 'the primary-limited call was not retried');

  let permissionCalls = 0;
  const permission = async (url) => {
    permissionCalls += 1;
    return limited({})(url);
  };
  await assert.rejects(() => decide({ ...base, nowMs: ANCHOR, fetchImpl: permission }), /answered 403/);
  assert.equal(permissionCalls, 1, 'a permission 403 was retried');
});

test('a persistent API failure still fails closed', async () => {
  const fetchImpl = async () => ({ ok: false, status: 502, json: async () => ({}) });
  await assert.rejects(() => decide({ ...base, nowMs: ANCHOR, fetchImpl }), /answered 502/);
});

test('a 403 is not retried', async () => {
  // A permission error will not heal by asking again; the ladder should say so
  // instead of spending four calls and a minute to reach the same answer.
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: false, status: 403, json: async () => ({}) };
  };
  await assert.rejects(() => decide({ ...base, nowMs: ANCHOR, fetchImpl }), /answered 403/);
  assert.equal(calls, 1);
});

test('a run is classified by the step only the publish path reaches', () => {
  assert.equal(classifyRun(PUBLISHED_STEPS), 'published');
  assert.equal(classifyRun(HELD_STEPS), 'held');
  assert.equal(classifyRun(SKIPPED_STEPS), 'unknown');
  assert.equal(classifyRun(NO_STEPS), 'unknown');
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
  const manual = run(1, ANCHOR + 5 * MINUTE, { event: 'workflow_dispatch' });
  const { fetchImpl } = fakeApi([manual], { 1: PUBLISHED_STEPS });
  const decision = await decide({ ...base, nowMs: ANCHOR + 3 * HOUR, fetchImpl });
  assert.equal(decision.run, false);
  assert.match(decision.reason, /published/);
});

test('a manual crawl in progress holds the next slot', async () => {
  const manual = run(1, ANCHOR + 5 * MINUTE, { event: 'workflow_dispatch', status: 'in_progress' });
  const { fetchImpl } = fakeApi([manual]);
  const decision = await decide({ ...base, nowMs: ANCHOR + 10 * MINUTE, fetchImpl });
  assert.equal(decision.run, false);
  assert.match(decision.reason, /still in_progress/);
});

test('the wait cap leaves room for a real crawl inside the job timeout', () => {
  // A slot that sleeps before it crawls must still fit in the job's wall clock.
  // If the cap plus the crawl budget ever exceeded it, the platform would
  // cancel the run mid-crawl: the attempt is lost and nothing is left to
  // dispatch the next slot, so the ladder would end on the night it mattered.
  assert.ok(
    MAX_WAIT_MINUTES + CRAWL_BUDGET_MINUTES + JOB_OVERHEAD_MINUTES <= JOB_TIMEOUT_MINUTES,
    `wait ${MAX_WAIT_MINUTES} + crawl ${CRAWL_BUDGET_MINUTES} + overhead ${JOB_OVERHEAD_MINUTES} exceeds the ${JOB_TIMEOUT_MINUTES} min job timeout`
  );
  assert.equal(MAX_WAIT_MINUTES, 200, 'the derived cap is 200 minutes');
});

test('a waiter fits in the job it has to sleep through, and hands off in time', () => {
  // The waiter crawls nothing, but it must still check out, run the gate and
  // post one dispatch after the sleep.
  assert.equal(MAX_WAITER_MINUTES, JOB_TIMEOUT_MINUTES - WAITER_OVERHEAD_MINUTES);
  assert.ok(MAX_WAITER_MINUTES > MAX_WAIT_MINUTES, 'a waiter that could not outlast a crawl slot would loop forever');
  assert.ok(
    MAX_WAITER_MINUTES + WAITER_OVERHEAD_MINUTES <= JOB_TIMEOUT_MINUTES,
    'a waiter would be killed mid-dispatch, losing the ladder'
  );
  // Eight hours is the longest rung the ladder reaches before the window ends.
  assert.ok(Math.ceil((8 * HOUR) / MINUTE / MAX_WAITER_MINUTES) <= 3, 'an eight-hour pause should cross at most three jobs');
});

test('the workflow declares the same job timeout the gate budgets for', async () => {
  const { readFileSync } = await import('node:fs');
  const workflow = readFileSync(new URL('../.github/workflows/scheduled-subscription.yml', import.meta.url), 'utf8');
  const declared = Number(/^\s{4}timeout-minutes:\s*(\d+)\s*$/m.exec(workflow)?.[1] ?? 0);
  assert.equal(declared, JOB_TIMEOUT_MINUTES, 'the workflow timeout and the gate budget disagree');
});

test('the gate runs when node is given a symlinked path to it', async () => {
  // `import.meta.url` is resolved through symlinks; `process.argv[1]` is as it
  // was spelled. Comparing them directly is empty on any path with a symlink
  // in it — `/tmp` on macOS is one — so `--next` printed nothing and the chain
  // step posted an empty payload.
  const { mkdtempSync, symlinkSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gate-link-'));
  const link = path.join(dir, 'gate.mjs');
  symlinkSync(fileURLToPath(new URL('../scripts/publish-retry-gate.mjs', import.meta.url)), link);
  const out = execFileSync(process.execPath, [link, '--next', '--attempt', '2'], { encoding: 'utf8' });
  assert.equal(JSON.parse(out).attempt, 3);
});

test('a chained slot whose parent published does not run', async () => {
  // The parent is exempt from the in-flight guard (its row can still read
  // in_progress while the child decides) but not from the publish scan: a
  // published parent means the campaign is over. Found by running the merged
  // gate against live history, where it answered "run" here.
  const parent = run(1, ANCHOR + 5 * MINUTE);
  const { fetchImpl } = fakeApi([parent], { 1: PUBLISHED_STEPS });
  const decision = await decide({
    ...base,
    eventName: 'repository_dispatch',
    payload: { attempt: 2, parent_run_id: '1' },
    nowMs: ANCHOR + 100 * MINUTE,
    fetchImpl
  });
  assert.equal(decision.run, false);
  assert.equal(decision.chain, false);
  assert.match(decision.reason, /published/);
});

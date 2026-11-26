#!/usr/bin/env node
/**
 * Decide whether this slot should attempt a publish, and how long to wait first.
 *
 * The nightly run used to be one shot: a thin sweep was held and the
 * subscription stayed a day older until the next night. The ladder gives one
 * campaign several attempts, each a full crawl of about seventy-five minutes,
 * so the slots have to be told apart from each other and spaced out.
 *
 * A campaign is anchored at 20:15 UTC — the slot the source server publishes
 * on — and lasts 24 hours. Inside it:
 *
 *   - A manual dispatch always runs. The operator asked for it, and a manual
 *     run is not one of the campaign's attempts.
 *   - If any run in the campaign published, every later slot exits in seconds
 *     instead of crawling again.
 *   - At most ten attempts start in one campaign.
 *   - After the nth attempt the next one waits 30 min × 2^(n-1): 30 min, 1 h,
 *     2 h, 4 h, 8 h. The wait is measured from when the attempt *finished*, so
 *     a long crawl does not eat into the pause that follows it.
 *
 * What counts as an attempt is a run that actually measured: a slot the gate
 * turned down, a run cancelled while queued, and a run that died before the
 * crawl all leave the count and the pause clock alone. Counting those punished
 * the night twice — once for a chance it never used, and again for the pause it
 * imposed on the next one.
 *
 * A pause longer than one job can hold is still honoured. A GitHub-hosted job
 * is killed at 360 minutes, so a slot asked to wait longer than it can wait and
 * still crawl does not crawl at all: it sleeps as much as the job allows, hands
 * its number and its due time to a successor, and exits. Two or three such
 * waiters carry an eight-hour pause across jobs without the ladder ever running
 * early — which is the thing the pause exists to prevent.
 *
 * Campaign membership is decided by when a run was *active*, not only by when
 * it was created. A chained slot created at 18:30 and publishing at 23:05
 * straddles the 20:15 anchor; keyed on creation alone it is invisible to the
 * campaign it lands in, and the next slot crawls over the subscription it just
 * published.
 *
 * The run history is the only state, so a lost slot, a cancelled run or a
 * re-run cannot desynchronise a counter: the gate reads what actually happened
 * from the API every time. The chain carries its own bookkeeping in the
 * dispatch payload (`attempt`, `due_at`) precisely so the child does not have
 * to race its parent's row flipping to `completed`. The payload is a hint, not
 * the truth: the attempt number is never allowed to fall below the history's,
 * and a pause the history has since enlarged wins over a stale `due_at`.
 *
 * Exit codes: 0 the decision was made; 2 the gate could not read the history.
 * A slot that cannot decide must not crawl — an unguarded retry is how ten
 * crawls stack on one night — so 2 means "skip" and the caller says why.
 */
import { realpathSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/** 20:15 UTC — the campaign anchor, matching the source server's publish slot. */
export const CAMPAIGN_HOUR_UTC = 20;
export const CAMPAIGN_MINUTE_UTC = 15;
/** One campaign. The window rotates at the next anchor, not at midnight. */
export const CAMPAIGN_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Pause after the first completed attempt; doubles per completed attempt. */
export const BASE_BACKOFF_MS = 30 * 60 * 1000;
/** Hard ceiling the operator named: ten chances in one night. */
export const MAX_ATTEMPTS = 10;
/**
 * The job's own wall clock, as the workflow declares it.
 *
 * 360 is what a GitHub-hosted runner enforces; `timeout-minutes` above that is
 * clamped, so this is the real budget rather than a preference.
 */
export const JOB_TIMEOUT_MINUTES = 360;
/**
 * What the crawl is allowed to take inside that budget.
 *
 * The last several crawls ran 60 to 80 minutes; 150 is roughly twice the
 * observed worst case, which is the margin a slow night needs.
 */
export const CRAWL_BUDGET_MINUTES = 150;
/** Checkout, setup, upload and the log redaction. */
export const JOB_OVERHEAD_MINUTES = 10;
/**
 * Longest pause a run will sit through *and then crawl*.
 *
 * A pause beyond this cannot be honoured inside the run that is asked to wait:
 * the job would be cancelled mid-crawl, which loses the attempt *and* the next
 * slot's dispatch. Such a slot becomes a waiter instead — see below.
 */
export const MAX_WAIT_MINUTES = JOB_TIMEOUT_MINUTES - CRAWL_BUDGET_MINUTES - JOB_OVERHEAD_MINUTES;
/** A waiter only sleeps, hands off and exits; it needs no crawl budget. */
export const WAITER_OVERHEAD_MINUTES = 15;
/**
 * Longest pause a waiter will sit through.
 *
 * Withdrawal leaves the successor enough of the job to check out, run the gate
 * and post one dispatch. Eight hours is three hops at this cap.
 */
export const MAX_WAITER_MINUTES = JOB_TIMEOUT_MINUTES - WAITER_OVERHEAD_MINUTES;
/**
 * How far back the campaign scan looks for runs that straddle the anchor.
 *
 * A run is never longer than one job (360 minutes); twelve hours is a wide
 * margin around that, and costs one API page.
 */
export const CAMPAIGN_LOOKBACK_MS = 12 * 60 * 60 * 1000;

/** Events that count as one of the campaign's attempts. */
export const ATTEMPT_EVENTS = Object.freeze(['schedule', 'repository_dispatch']);
/**
 * How many slots in a row may die before measuring and still hand on.
 *
 * Such a slot spends no chance, which is right for a transient 5xx — but a
 * permanent one (a renamed secret, a broken lockfile, a dead pin) would then
 * hand on forever at full speed: the one failure mode where "spends nothing"
 * turns into a run storm. Three is enough to ride out a blip and few enough
 * that a misconfiguration ends as three red runs.
 */
export const MAX_STALLED_PRE_MEASURE = 2;

/** The campaign window containing `now`. */
export function campaignWindow(nowMs) {
  const now = new Date(nowMs);
  const anchor = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    CAMPAIGN_HOUR_UTC,
    CAMPAIGN_MINUTE_UTC,
    0,
    0
  ));
  if (anchor.getTime() > nowMs) {
    anchor.setUTCDate(anchor.getUTCDate() - 1);
  }
  return { startMs: anchor.getTime(), endMs: anchor.getTime() + CAMPAIGN_WINDOW_MS };
}

/** Pause before the next attempt, given how many attempts have finished. */
export function backoffAfter(completedAttempts) {
  if (completedAttempts <= 0) return 0;
  return BASE_BACKOFF_MS * 2 ** (completedAttempts - 1);
}

/**
 * What a finished run did, read from its step conclusions.
 *
 * The workflow publishes no state for this: "Publish" and "Verify what is
 * actually served" only run when the floor was cleared, and "Report a held
 * night" only runs when it was not. Skipped steps are reported as such, which
 * is exactly the signal needed. A step set that says nothing — a run cancelled
 * while queued, a gate that could not read the history — classifies as
 * `unknown` and is not counted as an attempt.
 */
export function classifyRun(jobSteps) {
  const steps = Array.isArray(jobSteps) ? jobSteps : [];
  const conclusionOf = (name) => steps.find((step) => String(step?.name ?? '') === name)?.conclusion ?? null;
  if (conclusionOf('Verify what is actually served') === 'success') return 'published';
  if (conclusionOf('Report a held night') === 'success') return 'held';
  // A run that measured and then died at Publish or Verify spent the chance
  // just the same: seventy-five minutes were measured, and a Verify failure may
  // even have replaced the deployment. A Measure step that was *cancelled* —
  // the operator, or the job's own ceiling on a slow night — also ran and was
  // cut short. Only a step set that never reached Measure failed without
  // spending one; that one has its own path in the workflow.
  const measured = conclusionOf('Measure');
  if (measured === 'success' || measured === 'failure' || measured === 'cancelled') return 'failed';
  return 'unknown';
}

/** Did this outcome cost the campaign one of its chances? */
function isAttempt(outcome) {
  return outcome === 'held' || outcome === 'failed';
}

function isoSeconds(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Pauses between GET attempts; a transient 5xx must not end the night. */
export const API_RETRY_DELAYS_MS = Object.freeze([0, 2000, 5000, 10000]);

async function apiGet(fetchImpl, url, token, sleep) {
  let lastError = null;
  for (const delay of API_RETRY_DELAYS_MS) {
    if (delay > 0) await sleep(delay);
    try {
      // eslint-disable-next-line no-await-in-loop
      const response = await fetchImpl(url, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28'
        }
      });
      if (response.ok) {
        // eslint-disable-next-line no-await-in-loop
        return await response.json();
      }
      const error = new Error(`GET ${url} answered ${response.status}`);
      // A 403 is fatal unless it is a rate limit wearing the same status:
      // GitHub's secondary limits answer 403 with `retry-after`, and the
      // primary limit answers 403 with `x-ratelimit-remaining: 0`. Those heal
      // in seconds; a permission 403 never does.
      const headers = response.headers;
      const retryAfter = headers?.get?.('retry-after');
      const remaining = headers?.get?.('x-ratelimit-remaining');
      const rateLimited = response.status === 403 && Boolean(retryAfter || remaining === '0');
      if (response.status < 500 && response.status !== 429 && !rateLimited) {
        throw Object.assign(error, { fatal: true });
      }
      lastError = error;
    } catch (error) {
      if (error?.fatal) throw error;
      lastError = error;
    }
  }
  throw lastError ?? new Error(`GET ${url} failed`);
}

/**
 * Every run that was active inside the window, as the API lists it.
 *
 * Selected by creation *or* by last update: a run created before the anchor
 * whose crawl and publish finish after it belongs to the campaign it finished
 * in, and keying on creation alone would let the next slot crawl over the
 * subscription it just published.
 */
export async function readCampaign(fetchImpl, options) {
  const { token, repository, workflow, startMs, endMs, sleep = async () => {} } = options;
  const lookbackMs = options.lookbackMs ?? CAMPAIGN_LOOKBACK_MS;
  const base = `https://api.github.com/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/runs`;
  const runs = [];
  let page = 1;
  for (;;) {
    const url = `${base}?created=${encodeURIComponent(`>=${isoSeconds(startMs - lookbackMs)}`)}&per_page=100&page=${page}`;
    // eslint-disable-next-line no-await-in-loop
    const payload = await apiGet(fetchImpl, url, token, sleep);
    const batch = Array.isArray(payload?.workflow_runs) ? payload.workflow_runs : [];
    for (const run of batch) {
      const created = Date.parse(String(run?.created_at ?? ''));
      if (!Number.isFinite(created) || created >= endMs) continue;
      const updated = Date.parse(String(run?.updated_at ?? ''));
      if (created < startMs && !(Number.isFinite(updated) && updated >= startMs)) continue;
      runs.push(run);
    }
    if (batch.length < 100) break;
    page += 1;
    if (page > 10) break;
  }
  return runs.map((run) => ({
    id: run.id,
    event: run.event,
    status: run.status,
    conclusion: run.conclusion,
    createdAt: run.created_at,
    updatedAt: run.updated_at
  }));
}

async function outcomeOf(fetchImpl, token, repository, runId, sleep) {
  const url = `https://api.github.com/repos/${repository}/actions/runs/${runId}/jobs?per_page=100`;
  const payload = await apiGet(fetchImpl, url, token, sleep);
  const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
  const steps = jobs.flatMap((job) => (Array.isArray(job?.steps) ? job.steps : []));
  return classifyRun(steps);
}

function minutesBetween(fromMs, toMs) {
  return Math.max(0, Math.ceil((toMs - fromMs) / 60_000));
}

/**
 * The decision for one slot.
 *
 * `run: true` means crawl. `waiter: true` means sleep `waitMinutes`, hand the
 * slot to a successor unchanged, and exit without crawling. `chain` says
 * whether this run dispatches anything at all. `dueAt` is the absolute time the
 * slot is due, carried to a waiter's successor.
 */
export async function decide(options) {
  const {
    nowMs,
    fetchImpl = globalThis.fetch,
    token,
    repository,
    workflow,
    currentRunId = '',
    eventName = '',
    payload = {},
    maxAttempts = MAX_ATTEMPTS,
    maxWaitMinutes = MAX_WAIT_MINUTES,
    maxWaiterMinutes = MAX_WAITER_MINUTES,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  } = options;

  const skip = (reason, extra = {}) => ({
    run: false,
    waiter: false,
    chain: false,
    attempt: 0,
    attempts: 0,
    waitMinutes: 0,
    dueAt: null,
    reason,
    ...extra
  });

  if (eventName === 'workflow_dispatch') {
    return { run: true, waiter: false, chain: false, attempt: 0, attempts: 0, waitMinutes: 0, dueAt: null, reason: 'manual dispatch' };
  }

  const { startMs, endMs } = campaignWindow(nowMs);
  const chained = eventName === 'repository_dispatch';

  if (!token) return skip('no GITHUB_TOKEN; refusing to retry blindly');
  if (!repository) return skip('no GITHUB_REPOSITORY; refusing to retry blindly');

  const runs = await readCampaign(fetchImpl, { token, repository, workflow, startMs, endMs, sleep });

  // A run that is *executing* holds every other slot: it shares this
  // concurrency group, so it is mid-crawl and a second one would race it for
  // the same Pages deployment. A *queued* run does not hold anything — it
  // starts only after this one ends — and treating it as in-flight lost the
  // chained slot that was already due. This run and the run that dispatched it
  // are exempt: both are finished or finishing, and waiting for their rows to
  // flip is a race the gate must not lose.
  const exempt = new Set([String(currentRunId ?? ''), String(payload?.parent_run_id ?? '')].filter(Boolean));
  const active = runs.filter((run) =>
    run.status !== 'completed' && (run.status === 'in_progress' || run.status === 'waiting') && !exempt.has(String(run.id))
  );
  if (active.length > 0) {
    return skip(`run ${active[0].id} is still ${active[0].status}`);
  }

  // Every finished run in the window, whatever its event: a manual run that
  // published has done the night's work, and a later slot that crawled anyway
  // would replace a fresh subscription with another hour of work. A run still
  // unfinished was handled above; its outcome is unreadable, not published.
  const outcomes = [];
  for (const run of runs) {
    if (run.status !== 'completed') continue;
    // eslint-disable-next-line no-await-in-loop
    const outcome = await outcomeOf(fetchImpl, token, repository, run.id, sleep);
    outcomes.push({ run, outcome });
  }

  // The run that dispatched this slot can still read `in_progress` for a
  // second or two after its chain step — the row flip is exactly the race the
  // payload exists to survive, and it is why the parent is exempt from the
  // in-flight guard above. Reading only completed rows then hides the parent
  // from the history at the one moment its child needs it: a parent created
  // before the anchor loses its attempt number to the campaign rule *and* its
  // pause, so its child crawls one minute after a ninety-minute crawl. Its
  // step conclusions are already final, so read them directly.
  const parentRun = chained && String(payload?.parent_run_id ?? '')
    ? runs.find((run) => String(run.id) === String(payload.parent_run_id))
    : null;
  let parentFinishedMs = null;
  if (parentRun && parentRun.status !== 'completed') {
    const parentOutcome = await outcomeOf(fetchImpl, token, repository, parentRun.id, sleep);
    if (parentOutcome === 'published') {
      return skip(`run ${parentRun.id} published; the campaign is done`);
    }
    if (isAttempt(parentOutcome)) {
      // It finished when this slot was created: the chain step runs last.
      parentFinishedMs = nowMs;
      outcomes.push({ run: parentRun, outcome: parentOutcome, finishedMs: parentFinishedMs });
    }
  }

  const published = outcomes.find((entry) => entry.outcome === 'published');
  if (published) {
    return skip(`run ${published.run.id} published; the campaign is done`);
  }

  // Only scheduled and chained slots spend the campaign's chances; a manual
  // crawl is the operator's, and a run that never reached a crawl (skipped,
  // cancelled early, gate failure) spent nothing.
  const attempts = outcomes.filter((entry) => ATTEMPT_EVENTS.includes(String(entry.run?.event ?? '')) && isAttempt(entry.outcome));

  // A payload is the previous slot's bookkeeping for *its* campaign. A chained
  // handoff can cross the 20:15 anchor — a pause due at 20:14 turns into a
  // waiter that wakes at 20:15 — and the number and due time it carries belong
  // to the night that just ended. Inheriting them starts the new campaign
  // halfway up the ladder: its first pause is the old attempt's, and it can be
  // two crawls from the ceiling before it does any work. Only a parent created
  // inside this window can speak for this window.
  const payloadInCampaign = Boolean(parentRun) && Date.parse(String(parentRun.createdAt ?? '')) >= startMs;

  // Consecutive slots that died before reaching Measure. A transient failure
  // hands on without spending a chance; a permanent one must not do that
  // forever.
  const stalled = Math.max(0, Number(payload?.stalled ?? 0) || 0);

  const chainedAttempt = payloadInCampaign ? Number(payload?.attempt ?? 0) : 0;
  // The payload is a hint, the history is the record: a cron slot that crawled
  // while this one sat queued must not let the number go backwards.
  const attempt = Math.max(chainedAttempt > 0 ? chainedAttempt : 0, attempts.length + 1);

  if (attempt > maxAttempts) {
    return skip(`attempt ${attempt} exceeds the campaign ceiling of ${maxAttempts}`, { attempt, attempts: attempts.length });
  }

  const lastFinishedMs = attempts.reduce((latest, entry) => {
    const ended = entry.finishedMs ?? Date.parse(String(entry.run.updatedAt ?? ''));
    return Number.isFinite(ended) && ended > latest ? ended : latest;
  }, startMs);
  const fromHistoryMs = attempts.length > 0
    ? Math.max(0, lastFinishedMs + backoffAfter(attempts.length) - nowMs)
    : 0;

  const dueAtMs = payloadInCampaign ? Date.parse(String(payload?.due_at ?? '')) : NaN;
  const fromPayloadMs = Number.isFinite(dueAtMs) ? Math.max(0, dueAtMs - nowMs) : 0;

  // Whichever pause is longer wins. A `due_at` older than the last crawl's
  // finish is stale — a cron slot crawled in between — and honouring it would
  // run two crawls back to back.
  const remainingMs = Math.max(fromHistoryMs, fromPayloadMs);
  const dueAt = new Date(nowMs + remainingMs).toISOString();
  const waitMinutes = minutesBetween(nowMs, nowMs + remainingMs);

  if (remainingMs > 0 && nowMs + remainingMs >= endMs) {
    return skip('the next pause runs past the end of the campaign; the next anchor starts a fresh one', {
      attempt,
      attempts: attempts.length
    });
  }

  if (waitMinutes <= maxWaitMinutes) {
    // The successor is due one pause after this crawl finishes, which is at
    // least one pause after now. If even that lands past the anchor there is
    // nothing to chain: the next slot would only read the window, say so, and
    // exit. A dispatch that is known to be a no-op is one more row on the run
    // list for no chance at all.
    const inWindow = nowMs + backoffAfter(attempt) < endMs;
    const stalledOut = stalled >= MAX_STALLED_PRE_MEASURE;
    const chain = inWindow && !stalledOut;
    const base = attempt === 1
      ? 'first attempt of the campaign'
      : `attempt ${attempt} of ${maxAttempts}` + (waitMinutes > 0 ? `, after a ${waitMinutes} min pause` : '');
    let reason = base;
    if (!inWindow) reason = `${base}; the next pause would land past the campaign's end, so this is the last slot`;
    else if (stalledOut) reason = `${base}; ${stalled} slots in a row have died before measuring, so the ladder stops here`;
    return {
      run: true,
      waiter: false,
      chain,
      attempt,
      attempts: attempts.length,
      waitMinutes,
      dueAt,
      reason
    };
  }

  // The pause is longer than one job can hold and still crawl — the four- and
  // eight-hour rungs of the ladder. Sleep what this job can afford, hand the
  // number and the due time to a successor, and let it finish the pause. The
  // successor may itself be a waiter; eight hours is three hops.
  const waiterMinutes = Math.min(waitMinutes, maxWaiterMinutes);
  return {
    run: false,
    waiter: true,
    chain: true,
    attempt,
    attempts: attempts.length,
    waitMinutes: waiterMinutes,
    dueAt,
    reason: `attempt ${attempt} is due in ${waitMinutes} min; waiting ${waiterMinutes} min here and handing the slot on`
  };
}

/** The payload the chain hands to its successor after this attempt finished. */
export function nextSlotPayload({ attempt, nowMs }) {
  return {
    attempt: attempt + 1,
    due_at: new Date(nowMs + backoffAfter(attempt)).toISOString(),
    parent_run_id: String(process.env.GITHUB_RUN_ID ?? '')
  };
}

/** The payload a waiter hands on: same slot, same due time, new parent. */
export function handoffPayload({ attempt, dueAt, stalled = 0 }) {
  return {
    attempt,
    due_at: String(dueAt ?? ''),
    stalled: Number(stalled) || 0,
    parent_run_id: String(process.env.GITHUB_RUN_ID ?? '')
  };
}

function parseArgs(argv) {
  const args = { json: false, payload: {}, next: false, handoff: false, attempt: 0, dueAt: null, stalled: 0 };
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--json') args.json = true;
    else if (token === '--next') args.next = true;
    else if (token === '--handoff') args.handoff = true;
    else if (token === '--workflow') args.workflow = argv[++index];
    else if (token === '--max-attempts') args.maxAttempts = Number(argv[++index]);
    else if (token === '--attempt') args.attempt = Number(argv[++index]);
    else if (token === '--due-at') args.dueAt = argv[++index];
    else if (token === '--stalled') args.stalled = Number(argv[++index]);
    else if (token === '--payload') args.payload = JSON.parse(argv[++index] ?? '{}');
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.next) {
    // The chain's bookkeeping, printed for the dispatching step. The number is
    // this attempt's, so the successor's is one more; the due time is one
    // backoff after *this* moment, which is when this attempt finished.
    process.stdout.write(`${JSON.stringify(nextSlotPayload({ attempt: args.attempt, nowMs: Date.now() }))}\n`);
    return;
  }
  if (args.handoff) {
    // A waiter hands on the slot it was given, untouched. A slot that died
    // before measuring also carries how many in a row have.
    process.stdout.write(`${JSON.stringify(handoffPayload({ attempt: args.attempt, dueAt: args.dueAt, stalled: args.stalled }))}\n`);
    return;
  }
  const decision = await decide({
    nowMs: Date.now(),
    token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '',
    repository: process.env.GITHUB_REPOSITORY || '',
    workflow: args.workflow || 'scheduled-subscription.yml',
    currentRunId: process.env.GITHUB_RUN_ID || '',
    eventName: process.env.GITHUB_EVENT_NAME || '',
    payload: args.payload,
    maxAttempts: Number.isFinite(args.maxAttempts) ? args.maxAttempts : MAX_ATTEMPTS
  });
  if (args.json) {
    process.stdout.write(`${JSON.stringify(decision)}\n`);
  } else {
    process.stdout.write(`${decision.run ? 'run' : decision.waiter ? 'wait' : 'skip'}: ${decision.reason}\n`);
  }
  if (process.env.GITHUB_OUTPUT) {
    const fs = await import('node:fs');
    const reason = String(decision.reason).replace(/\r?\n/g, ' ');
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `run=${decision.run}`,
        `waiter=${decision.waiter}`,
        `chain=${decision.chain}`,
        `attempt=${decision.attempt}`,
        `wait_minutes=${decision.waitMinutes}`,
        `due_at=${decision.dueAt ?? ''}`,
        `reason=${reason}`
      ].join('\n') + '\n'
    );
  }
}

/**
 * Is this file the program node was asked to run?
 *
 * Node resolves `import.meta.url` through symlinks, `process.argv[1]` as it was
 * spelled. Comparing them directly is empty on any path with a symlink in it —
 * `/tmp` on macOS is one — so `--next` would print nothing and the chain step
 * would post an empty payload.
 */
function isEntrypoint() {
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main().catch((error) => {
    // A gate that cannot read the history must not crawl: an unguarded slot is
    // how ten crawls stack on one night. Say why and exit non-zero; the
    // workflow turns this into a skip and does not chain further.
    process.stderr.write(`retry gate: ${error?.message ?? error}\n`);
    try {
      const fs = process.getBuiltinModule ? process.getBuiltinModule('node:fs') : null;
      fs?.appendFileSync(process.env.GITHUB_OUTPUT, 'run=false\nwaiter=false\nchain=false\nwait_minutes=0\nreason=the run history could not be read\n');
    } catch {
      // the output file is best-effort; the non-zero exit is the signal
    }
    process.exit(2);
  });
}

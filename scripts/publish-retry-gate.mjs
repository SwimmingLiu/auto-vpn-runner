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
 *   - If any attempt in the window published, every later slot exits in
 *     seconds instead of crawling again.
 *   - At most ten attempts start in one campaign.
 *   - After the nth attempt the next one waits 30 min × 2^(n-1): 30 min, 1 h,
 *     2 h, 4 h, 8 h. The wait is measured from when the attempt *finished*, so
 *     a long crawl does not eat into the pause that follows it.
 *
 * The run history is the only state, so a lost slot, a cancelled run or a
 * re-run cannot desynchronise a counter: the gate reads what actually happened
 * from the API every time. The chain carries its own bookkeeping in the
 * dispatch payload (`attempt`, `due_at`) precisely so the child does not have
 * to race its parent's row flipping to `completed`.
 *
 * Exit codes: 0 the decision was made; 2 the gate could not read the history.
 * A slot that cannot decide must not crawl — an unguarded retry is how ten
 * crawls stack on one night — so 2 means "skip" and the caller says why.
 */
import process from 'node:process';

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
 * Longest pause a run will sit through.
 *
 * A GitHub-hosted job may live six hours and the crawl takes about one and a
 * quarter, so a pause beyond this cannot be honoured inside the run that is
 * asked to wait. The ladder's useful part (30 min, 1 h, 2 h) is well inside;
 * by the fourth pause the night is nearly over and running the moment the cap
 * expires is the same decision the full pause would have reached.
 */
export const MAX_WAIT_MINUTES = 200;

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
 * is exactly the signal needed.
 */
export function classifyRun(jobSteps) {
  const steps = Array.isArray(jobSteps) ? jobSteps : [];
  const conclusionOf = (name) => steps.find((step) => String(step?.name ?? '') === name)?.conclusion ?? null;
  if (conclusionOf('Verify what is actually served') === 'success') return 'published';
  if (conclusionOf('Report a held night') === 'success') return 'held';
  if (conclusionOf('Measure') === 'failure') return 'failed';
  return 'unknown';
}

/** Events that count as one of the campaign's attempts. */
export const ATTEMPT_EVENTS = Object.freeze(['schedule', 'repository_dispatch']);

function isoSeconds(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

async function apiGet(fetchImpl, url, token) {
  const response = await fetchImpl(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28'
    }
  });
  if (!response.ok) {
    throw new Error(`GET ${url} answered ${response.status}`);
  }
  return response.json();
}

/** Every run of the workflow created inside the window, as the API lists it. */
export async function readCampaign(fetchImpl, options) {
  const { token, repository, workflow, startMs, endMs, currentRunId } = options;
  const base = `https://api.github.com/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/runs`;
  const runs = [];
  let page = 1;
  for (;;) {
    const url = `${base}?created=${encodeURIComponent(`>=${isoSeconds(startMs)}`)}&per_page=100&page=${page}`;
    const payload = await apiGet(fetchImpl, url, token);
    const batch = Array.isArray(payload?.workflow_runs) ? payload.workflow_runs : [];
    for (const run of batch) {
      const created = Date.parse(String(run?.created_at ?? ''));
      if (!Number.isFinite(created) || created < startMs || created >= endMs) continue;
      runs.push(run);
    }
    if (batch.length < 100) break;
    page += 1;
    if (page > 10) break;
  }
  return runs
    .filter((run) => String(run?.id) !== String(currentRunId ?? ''))
    .map((run) => ({
      id: run.id,
      event: run.event,
      status: run.status,
      conclusion: run.conclusion,
      createdAt: run.created_at,
      updatedAt: run.updated_at
    }));
}

async function outcomeOf(fetchImpl, token, repository, runId) {
  const url = `https://api.github.com/repos/${repository}/actions/runs/${runId}/jobs?per_page=100`;
  const payload = await apiGet(fetchImpl, url, token);
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
 * `run: false` is the normal answer for most slots; the caller exits without
 * crawling. `waitMinutes` is how long the run should sleep before its first
 * step touches the network, and `chain` says whether the run should dispatch
 * a successor when it finishes.
 */
export async function decide(options) {
  const {
    nowMs,
    fetchImpl = globalThis.fetch,
    token,
    repository,
    workflow,
    currentRunId,
    eventName = '',
    payload = {},
    maxAttempts = MAX_ATTEMPTS,
    maxWaitMinutes = MAX_WAIT_MINUTES
  } = options;

  if (eventName === 'workflow_dispatch') {
    return { run: true, chain: false, attempt: 0, attempts: 0, waitMinutes: 0, reason: 'manual dispatch' };
  }

  const { startMs, endMs } = campaignWindow(nowMs);
  const chained = eventName === 'repository_dispatch';
  const chainedAttempt = Number(payload?.attempt ?? 0);
  const dueAtMs = Date.parse(String(payload?.due_at ?? ''));
  const parentRunId = String(payload?.parent_run_id ?? '');

  if (!token) {
    return { run: false, chain: false, attempt: 0, attempts: 0, waitMinutes: 0, reason: 'no GITHUB_TOKEN; refusing to retry blindly' };
  }
  if (!repository) {
    return { run: false, chain: false, attempt: 0, attempts: 0, waitMinutes: 0, reason: 'no GITHUB_REPOSITORY; refusing to retry blindly' };
  }

  const runs = await readCampaign(fetchImpl, { token, repository, workflow, startMs, endMs, currentRunId });
  const attempted = runs.filter((run) => ATTEMPT_EVENTS.includes(String(run?.event ?? '')));

  // A run that is mid-crawl holds every other slot. The parent is exempt: it is
  // the run that dispatched this one, so it is finished or finishing, and its
  // row flipping to `completed` is a race this gate must not lose.
  const inFlight = runs.filter((run) => run.status !== 'completed' && String(run.id) !== parentRunId);
  if (inFlight.length > 0) {
    return {
      run: false,
      chain: false,
      attempt: 0,
      attempts: 0,
      waitMinutes: 0,
      reason: `run ${inFlight[0].id} is still ${inFlight[0].status}`
    };
  }

  // Every run in the window, not just the counted attempts: a manual run that
  // publishes has done the night's work, and a later slot that crawled anyway
  // would replace a fresh subscription with another hour of work. A manual run
  // still does not *consume* an attempt — it is not one of the ten chances.
  for (const run of runs) {
    if (String(run.id) === parentRunId) continue;
    // eslint-disable-next-line no-await-in-loop
    const outcome = await outcomeOf(fetchImpl, token, repository, run.id);
    if (outcome === 'published') {
      return {
        run: false,
        chain: false,
        attempt: 0,
        attempts: attempted.length,
        waitMinutes: 0,
        reason: `run ${run.id} published; the campaign is done`
      };
    }
  }

  // A chained slot inherits its number from the parent's payload: counting from
  // the API would be off by one for as long as the parent's row reads
  // `in_progress`, and the campaign's ceiling must not depend on that timing.
  const attempt = chained && chainedAttempt > 0 ? chainedAttempt : attempted.length + 1;

  if (attempt > maxAttempts) {
    return {
      run: false,
      chain: false,
      attempt,
      attempts: attempted.length,
      waitMinutes: 0,
      reason: `attempt ${attempt} exceeds the campaign ceiling of ${maxAttempts}`
    };
  }

  let waitMinutes = 0;
  if (chained && Number.isFinite(dueAtMs) && dueAtMs > nowMs) {
    waitMinutes = Math.min(minutesBetween(nowMs, dueAtMs), maxWaitMinutes);
  } else if (!chained) {
    // A cron slot has no payload, so the pause is derived from when the last
    // attempt finished. Without a previous attempt there is nothing to wait for.
    const finishedMs = attempted.reduce((latest, run) => {
      const ended = Date.parse(String(run.updatedAt ?? ''));
      return Number.isFinite(ended) && ended > latest ? ended : latest;
    }, startMs);
    const pause = backoffAfter(attempted.length);
    if (attempted.length > 0 && nowMs < finishedMs + pause) {
      return {
        run: false,
        chain: false,
        attempt,
        attempts: attempted.length,
        waitMinutes: 0,
        reason: `attempt ${attempted.length} finished ${minutesBetween(finishedMs, nowMs)} min ago; ` +
          `the next pause is ${Math.round(pause / 60_000)} min`
      };
    }
  }

  return {
    run: true,
    chain: true,
    attempt,
    attempts: attempted.length,
    waitMinutes,
    reason: attempt === 1
      ? 'first attempt of the campaign'
      : `attempt ${attempt} of ${maxAttempts}` + (waitMinutes > 0 ? `, after a ${waitMinutes} min pause` : '')
  };
}

/** The payload the chain hands to its successor. */
export function nextSlotPayload({ attempt, nowMs }) {
  return {
    attempt: attempt + 1,
    due_at: new Date(nowMs + backoffAfter(attempt)).toISOString(),
    parent_run_id: String(process.env.GITHUB_RUN_ID ?? '')
  };
}

function parseArgs(argv) {
  const args = { json: false, payload: {}, next: false, attempt: 0 };
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--json') args.json = true;
    else if (token === '--next') args.next = true;
    else if (token === '--workflow') args.workflow = argv[++index];
    else if (token === '--max-attempts') args.maxAttempts = Number(argv[++index]);
    else if (token === '--attempt') args.attempt = Number(argv[++index]);
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
    process.stdout.write(`${decision.run ? 'run' : 'skip'}: ${decision.reason}\n`);
  }
  if (process.env.GITHUB_OUTPUT) {
    const fs = await import('node:fs');
    const reason = String(decision.reason).replace(/\r?\n/g, ' ');
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      [`run=${decision.run}`, `chain=${decision.chain}`, `attempt=${decision.attempt}`, `wait_minutes=${decision.waitMinutes}`, `reason=${reason}`].join('\n') + '\n'
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    // A gate that cannot read the history must not crawl: an unguarded slot is
    // how ten crawls stack on one night. Say why and exit non-zero; the
    // workflow turns this into a skip and does not chain further.
    process.stderr.write(`retry gate: ${error?.message ?? error}\n`);
    try {
      const fs = process.getBuiltinModule ? process.getBuiltinModule('node:fs') : null;
      fs?.appendFileSync(process.env.GITHUB_OUTPUT, 'run=false\nchain=false\nwait_minutes=0\nreason=the run history could not be read\n');
    } catch {
      // the output file is best-effort; the non-zero exit is the signal
    }
    process.exit(2);
  });
}

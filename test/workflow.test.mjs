import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * The nightly workflow is one job of shell steps that share state only through
 * the filesystem and the environment. That sharing is where it failed: the
 * import step and the measure step each resolve `<runtime-root>/accounts.db`,
 * and only one of them set `VPN_AUTOMATION_RUNTIME_ROOT`.
 *
 * The failure is invisible from either step alone. The import reported 631
 * rows and 631 active; the run then failed every source in about 20 ms with
 * "account pool has no active <brand> account", because it was reading a
 * different — and newly created, empty — database.
 *
 * `--project-root` does not redirect the pool: `AccountStore` resolves the
 * path from the environment alone. So the assertion is that every step which
 * touches the pool names the same runtime root — and, since the pool moved to
 * a shared Postgres table, the same database.
 */

const WORKFLOW_PATH = new URL('../.github/workflows/scheduled-subscription.yml', import.meta.url);
const raw = readFileSync(WORKFLOW_PATH, 'utf8');

/** Split into `- name:` blocks, keeping each step's body. */
function steps(text) {
  const parts = text.split(/^\s{6}- name:/m);
  const head = parts.shift();
  return parts.map((body) => {
    const [nameLine, ...rest] = body.split('\n');
    return { name: nameLine.trim(), body: rest.join('\n'), head };
  });
}

const RUNNER_ROOT = '${{ runner.temp }}/autovpn';

test('the sync step writes the pool where the measure step reads it', () => {
  const poolSteps = steps(raw).filter((step) =>
    /\bautovpn accounts sync\b|\bautovpn run\b|\bretry-stage\b/.test(step.body)
  );
  assert.ok(poolSteps.length >= 2, `expected at least two pool-touching steps, found ${poolSteps.length}`);

  for (const step of poolSteps) {
    assert.match(
      step.body,
      /VPN_AUTOMATION_RUNTIME_ROOT:\s*\$\{\{\s*runner\.temp\s*\}\}\/autovpn/,
      `"${step.name}" does not set VPN_AUTOMATION_RUNTIME_ROOT to ${RUNNER_ROOT}, ` +
        'so it resolves a different accounts.db than the other steps'
    );
  }
});

test('the sync is required to leave active rows, not merely to connect', () => {
  const syncStep = steps(raw).find((step) => /\bautovpn accounts sync\b/.test(step.body));
  assert.ok(syncStep, 'no step runs `autovpn accounts sync`');
  assert.match(
    syncStep.body,
    /stats\??\.active\s*>\s*0/,
    'the sync step does not fail when the pool has no active rows; ' +
      'that state reaches the crawl as "no accounts" instead'
  );
});

/**
 * The pool used to be assembled from base64 halves of a 57 KB file in
 * repository secrets. That mechanism is gone: the rows live in the operator's
 * Postgres database, and a host reaches it with one URL. A step that still
 * reads `ACCOUNTS_PART_*` would be a second source of truth, and a test that
 * still accepted it would let that split come back.
 */
test('the pool comes from the shared database, not from split secrets', () => {
  const sync = steps(raw).find((step) => /\bautovpn accounts sync\b/.test(step.body));
  assert.ok(sync, 'no step syncs the account pool');
  assert.match(sync.body, /AUTOVPN_ACCOUNTS_DB_URL:\s*\$\{\{\s*secrets\.AUTOVPN_ACCOUNTS_DB_URL\s*\}\}/);
  assert.doesNotMatch(raw, /ACCOUNTS_PART_\d|assemble-account-pool/);

  const measure = steps(raw).find((step) => /\bautovpn run\b/.test(step.body));
  assert.ok(measure, 'no step runs the pipeline');
  assert.match(
    measure.body,
    /AUTOVPN_ACCOUNTS_DB_URL:\s*\$\{\{\s*secrets\.AUTOVPN_ACCOUNTS_DB_URL\s*\}\}/,
    'the measure step cannot push its retirements back to the shared pool'
  );
});

test('the CLI is built from the pinned checkout, not installed by version number', () => {
  // A published version cannot contain a fix that is still a branch commit, so
  // installing by number silently runs code the workflow was never tested
  // against. The first runner night did exactly that and failed on a bug the
  // branch had already fixed.
  const install = steps(raw).find((step) => /npm\/autovpn-cli run build/.test(step.body));
  assert.ok(install, 'no step builds the CLI from this checkout');
  assert.doesNotMatch(
    install.body,
    /npm install -g[^\n]*@swimmingliu\/autovpn@/,
    'the CLI is installed from npm by version; build it from the checkout instead'
  );
  assert.match(install.body, /npm install -g[^\n]*\.\/npm\/autovpn-cli/, 'the built CLI is not installed');
});

test('the uploaded log is the redacted one, and nothing uploads the raw log', () => {
  // A public repository's artifacts are downloadable without authentication.
  // The raw log carries one event per link with the full vmess payload, so
  // uploading it as-is publishes the subscription.
  const upload = steps(raw).find((step) => /upload-artifact/.test(step.body));
  assert.ok(upload, 'no upload-artifact step');
  assert.match(upload.body, /run\.redacted\.jsonl/, 'the raw run log is what gets uploaded');
  assert.doesNotMatch(
    upload.body,
    /\$\{\{ runner\.temp \}\}\/run\.jsonl/,
    'the upload path still names the unredacted log'
  );
  const redact = steps(raw).find((step) => /redact-run-log\.mjs/.test(step.body));
  assert.ok(redact, 'nothing redacts the log before upload');
  assert.match(redact.body, /grep -qE/, 'the redaction step does not verify its own output');
});

test('every step that can reach the obfuscate stage has the subscription key', () => {
  // The obfuscate stage resolves the key from the environment, and it runs
  // inside `autovpn run` (Measure), not only at publish. A run that cleared the
  // floor at 54 links then died in obfuscate because only the Publish step had
  // the variable.
  const steps = raw.split(/^\s{6}- name:/m).slice(1).map((body) => {
    const [nameLine, ...rest] = body.split('\n');
    return { name: nameLine.trim(), body: rest.join('\n') };
  });
  const reachable = steps.filter((step) => /\bautovpn run\b/.test(step.body) || /retry-stage/.test(step.body));
  assert.ok(reachable.length >= 2, `expected Measure and Publish, found ${reachable.length}`);
  for (const step of reachable) {
    assert.match(
      step.body,
      /VPN_AUTOMATION_SUBSCRIPTION_KEY:/,
      `"${step.name}" can reach the obfuscate stage but does not set VPN_AUTOMATION_SUBSCRIPTION_KEY`
    );
  }
});

/**
 * The retry ladder is only as good as the workflow that runs it: a gate whose
 * verdict nothing reads (or a chain step that needs a token it does not have)
 * fails silently, and the night would go back to one attempt with nobody the
 * wiser. These tests pin the wiring, not the decision logic — that lives in
 * `retry-gate.test.mjs`.
 */

test('every crawl step is gated on the slot decision', () => {
  const gated = steps(raw).filter((step) => /steps\.slot\.outputs\.run/.test(step.body));
  const crawls = steps(raw).filter((step) => /\bautovpn run\b|retry-stage|egress-on-runner/.test(step.body));
  assert.ok(crawls.length >= 3, `expected the crawl steps, found ${crawls.length}`);
  for (const step of crawls) {
    assert.ok(
      gated.some((candidate) => candidate.name === step.name),
      `"${step.name}" crawls without checking whether this slot should run`
    );
  }
});

test('the gate runs before anything is fetched from the network', () => {
  const all = steps(raw);
  const gateIndex = all.findIndex((step) => /publish-retry-gate\.mjs/.test(step.body));
  assert.ok(gateIndex >= 0, 'no step runs the retry gate');
  for (const step of all) {
    if (step.name === 'Checkout this repository' || step.name === 'Setup Node.js') continue;
    if (step.name === all[gateIndex].name) continue;
    const index = all.indexOf(step);
    if (index > gateIndex) continue;
    assert.ok(
      /actions\/checkout|setup-node/.test(step.body),
      `"${step.name}" runs before the gate without being a checkout/setup step`
    );
  }
});

test('the chain has the permission its dispatch needs', () => {
  // `POST /repos/{owner}/{repo}/dispatches` is a Contents: write endpoint.
  // With `actions: write` it answers 403, the chain step fails, and the ladder
  // silently stops at the first attempt. The gate's own reads still need
  // Actions read, and naming any permission sets the rest to none.
  const permissions = /^permissions:\n((?:  .*\n)+)/m.exec(raw)?.[1] ?? '';
  assert.match(permissions, /^  contents: write$/m, 'the job cannot dispatch its next slot');
  assert.match(permissions, /^  actions: read$/m, 'the gate cannot read the run history without Actions read');
  assert.doesNotMatch(permissions, /^  actions: write$/m, 'actions: write is not what repository_dispatch checks');
});

test('a crawl that finishes without publishing dispatches the next slot', () => {
  const chain = steps(raw).find((step) => /dispatches/.test(step.body) && /client_payload/.test(step.body));
  assert.ok(chain, 'nothing dispatches the next slot');
  assert.match(chain.body, /--next/, 'the chain step does not derive the next attempt number');
  assert.match(chain.body, /steps\.verify\.outcome/, 'the chain cannot tell a published attempt from a held one');
});

test('a cancelled run does not chain, a failed one does', () => {
  // The ladder exists for thin sweeps and failed crawls, so the chain step must
  // run on failure. A cancelled run is the operator stopping the night, and it
  // must not spawn a successor that nobody can see.
  const chain = steps(raw).find((step) => /dispatches/.test(step.body) && /client_payload/.test(step.body));
  assert.ok(chain, 'nothing dispatches the next slot');
  assert.match(chain.body, /!cancelled\(\)/, 'the chain step must run after a failure but not after a cancel');
  assert.doesNotMatch(chain.body, /^\s+if: \$\{\{ always\(\)/m, 'always() would also chain a cancelled run');
});

test('the chain retries its dispatch instead of ending the night on one 5xx', () => {
  const chain = steps(raw).find((step) => /dispatches/.test(step.body) && /client_payload/.test(step.body));
  assert.ok(chain, 'nothing dispatches the next slot');
  const tries = Number(/for attempt in 1 2 3 4 5 6/.test(chain.body) ? 6 : /for attempt in 1 2 3/.test(chain.body) ? 3 : 0);
  assert.ok(tries >= 6, 'a dispatch outage of a few minutes ends the ladder');
});

test('the chain runs from the runner checkout, not the pipeline directory', () => {
  // The job default is `source`; a waiter never checks that out, and the gate
  // script lives in the runner checkout. Without this the chain step cannot
  // even start, so no attempt ever dispatches a successor. Found by audit.
  const chain = steps(raw).find((step) => /dispatches/.test(step.body) && /client_payload/.test(step.body));
  assert.ok(chain, 'nothing dispatches the next slot');
  assert.match(chain.body, /working-directory: \./, 'the chain step inherits working-directory: source');
  assert.match(chain.body, /runner\/scripts\/publish-retry-gate\.mjs/, 'the chain step cannot find the gate');
});

test('a waiter hands its slot on without crawling', () => {
  // The eight-hour rung of the ladder does not fit in one job. The slot that
  // cannot wait and still crawl must still chain, or the pause is truncated
  // back to what one job holds.
  const chain = steps(raw).find((step) => /dispatches/.test(step.body) && /client_payload/.test(step.body));
  assert.ok(chain, 'nothing dispatches the next slot');
  assert.match(chain.body, /--handoff/, 'a waiter has no way to hand its slot on');
  assert.doesNotMatch(
    chain.body,
    /steps\.slot\.outputs\.run == 'true'/,
    'the chain is gated on the crawl, so a waiter can never dispatch'
  );
  const wait = steps(raw).find((step) => /^\s*sleep /m.test(step.body) && /wait_minutes/.test(step.body));
  assert.ok(wait, 'no step sleeps out the pause');
  assert.match(wait.body, /steps\.slot\.outputs\.waiter/, 'a waiter does not sleep');
});

test('steps that run before the pipeline checkout do not inherit its directory', () => {
  // `defaults.run.working-directory: source` is right for every crawl step and
  // fatal for the ones ahead of it: the directory is created by the pipeline
  // checkout, so bash refuses to start and the gate never runs. A live dispatch
  // found this the first time it fired.
  const all = steps(raw);
  const pipelineCheckout = all.findIndex((step) => /repository: swimmingliu\/auto-vpn/.test(step.body));
  assert.ok(pipelineCheckout > 0, 'no pipeline checkout step');
  for (const step of all.slice(0, pipelineCheckout)) {
    if (!/\brun:/.test(step.body)) continue;
    assert.match(
      step.body,
      /working-directory: \./,
      `"${step.name}" runs before the pipeline checkout but inherits working-directory: source`
    );
  }
});

test('a redaction failure leaves nothing for the upload to publish', () => {
  // The upload runs on `always()` and uploads whatever is at the path. A guard
  // that only exits non-zero still publishes the file it just refused — and a
  // guard that removes one file at a time publishes the sibling it had not
  // examined yet.
  const redact = steps(raw).find((candidate) => /redact-run-log\.mjs/.test(candidate.body));
  assert.ok(redact, 'nothing redacts the log');
  assert.match(redact.body, /leaked=1/, 'the guard exits on the first match instead of checking every file');
  assert.match(
    redact.body,
    /for f in "\$RUNNER_TEMP"\/run\.redacted\.jsonl "\$RUNNER_TEMP"\/deploy\.redacted\.jsonl; do/,
    'the deploy log is never examined for leaks'
  );
  assert.match(
    redact.body,
    /rm -f "\$RUNNER_TEMP"\/run\.redacted\.jsonl "\$RUNNER_TEMP"\/deploy\.redacted\.jsonl/,
    'only the file that matched is removed; the unexamined sibling is still uploaded'
  );
  assert.doesNotMatch(redact.body, /rm -f "\$f"/, 'removing one file at a time leaves the sibling');
});

test('a slot that died before measuring hands on the same slot', () => {
  // A registry 5xx in the build spends no chance and earns no pause. Chaining
  // `--next` from it charges the night an attempt it never took and starts the
  // next pause from a failure that measured nothing.
  const chain = steps(raw).find((step) => /dispatches/.test(step.body) && /client_payload/.test(step.body));
  assert.ok(chain, 'nothing dispatches the next slot');
  assert.match(chain.body, /MEASURED: \$\{\{ steps\.measure\.outcome \}\}/, 'the chain cannot tell a measured run from a dead one');
  assert.match(chain.body, /"\$MEASURED" != "success"/, 'the chain treats a dead run as a spent attempt');
});

test('a gate that cannot read the history fails the run visibly', () => {
  const gate = steps(raw).find((candidate) => /publish-retry-gate\.mjs/.test(candidate.body) && /--payload/.test(candidate.body));
  assert.ok(gate, 'no step runs the retry gate');
  assert.match(gate.body, /::error::/, 'a fail-closed slot leaves a red run with no explanation');
  assert.match(
    gate.body,
    /if \[ "\$status" -ne 0 \]; then[\s\S]*?exit "\$status"/,
    'the annotation is not on the branch that fails the step'
  );
  // Without the capture, `|| true` in place of `|| status=$?` leaves the step
  // green with run=false and the night silently skips.
  assert.match(
    gate.body,
    /publish-retry-gate\.mjs[\s\S]*?\|\|\s*status=\$\?/,
    'the gate\'s exit status is discarded; a fail-closed slot reads as a green skip'
  );
});

test('the configuration check names the secrets the crawl needs', () => {
  // Both are read inside Measure and Publish, so a missing one surfaces after
  // the crawl — or inside obfuscate, where the message names a sentinel rather
  // than the secret.
  const check = steps(raw).find((step) => /^Check required configuration$/.test(step.name));
  assert.ok(check, 'no configuration check step');
  for (const key of ['AUTOVPN_SUBSCRIPTION_KEY', 'AUTOVPN_PAGES_ADMIN']) {
    assert.match(check.body, new RegExp(`check "secret ${key}"`), `${key} is not checked before the crawl`);
  }
});

test('a dead slot carries its streak so a misconfiguration cannot storm', () => {
  const chain = steps(raw).find((step) => /dispatches/.test(step.body) && /client_payload/.test(step.body));
  assert.ok(chain, 'nothing dispatches the next slot');
  assert.match(chain.body, /--stalled/, 'a slot that dies before measuring never counts how many have');
  assert.match(chain.body, /STALLED: \$\{\{ github\.event\.client_payload\.stalled \|\| 0 \}\}/, 'the streak is not read from the payload');
  // The refusal is a non-zero exit from the handoff; without the capture the
  // step would go green having dispatched nothing.
  assert.match(
    chain.body,
    /--handoff[\s\S]*?\|\|\s*status=\$\?/,
    'the handoff\'s refusal is discarded; a permanent failure would end as a green skip'
  );
  assert.match(
    chain.body,
    /if \[ "\$status" -ne 0 \][\s\S]*?exit 1/,
    'the streak refusal does not fail the run'
  );
});

test('a skipped slot does not try to redact logs it never produced', () => {
  // The redaction step runs on `always()` so a failed attempt still leaves a
  // log; on a skipped slot there is no log and `source` is not checked out, so
  // it would fail the run for nothing.
  const step = steps(raw).find((candidate) => /redact-run-log\.mjs/.test(candidate.body));
  assert.ok(step, 'nothing redacts the log');
  assert.match(step.body, /steps\.slot\.outputs\.run == 'true'/, 'redaction runs even when the slot was skipped');
});

test('no step reads its own outputs', () => {
  // `${{ steps.<self>.outputs.* }}` inside the step that sets them is always
  // empty — GitHub resolves outputs after the step finishes. A live chained run
  // logged a bare `slot: ` because of it.
  for (const step of steps(raw)) {
    const id = /^\s{8}id: (\S+)$/m.exec(step.body)?.[1];
    if (!id) continue;
    // The gate's own comment names the expression it warns about, so judge the
    // executable lines only.
    const executable = step.body
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    assert.doesNotMatch(
      executable,
      new RegExp(`steps\\.${id}\\.outputs`),
      `"${step.name}" reads steps.${id}.outputs from inside itself; that is always empty`
    );
  }
});

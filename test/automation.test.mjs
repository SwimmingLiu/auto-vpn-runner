import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = (name) =>
  readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');

const bump = workflow('bump-pipeline-ref.yml');
const keepalive = workflow('keepalive.yml');

test('a release opens a pin PR instead of moving the pin in place', () => {
  assert.match(bump, /repository_dispatch:/);
  assert.match(bump, /types: \[autovpn-release\]/);
  assert.match(bump, /workflow_dispatch:/);
  assert.match(bump, /contents: read/);
  assert.doesNotMatch(bump, /contents: write/, 'the GITHUB_TOKEN does not push the workflow change');
  assert.doesNotMatch(bump, /pull-requests: write/, 'the GITHUB_TOKEN does not create the PR');
  assert.match(bump, /ref: main/);
  assert.match(bump, /token: \$\{\{ secrets\.AUTOVPN_RUNNER_TOKEN \}\}/, 'the checkout must push with the PAT');
  assert.match(bump, /gh pr create/);
  assert.match(bump, /git push --force origin "\$\{BRANCH\}"/);
  assert.doesNotMatch(bump, /git push(?: --force)? origin main/);
  assert.doesNotMatch(bump, /gh pr merge/);
  assert.match(bump, /PIPELINE_REF/);
  assert.match(bump, /AUTOVPN_RUNNER_TOKEN/);
});

test('the pin workflow validates the tag and refuses a downgrade', () => {
  assert.ok(bump.includes("'^v[0-9]+\\.[0-9]+(\\.[0-9]+)?$'"), 'release tags are not validated');
  assert.ok(bump.includes("'^[0-9a-f]{40}$'"), 'release commits are not validated');
  assert.match(bump, /commits\/\$\{RELEASE_TAG\}/, 'the tag is not resolved to its commit');
  assert.match(bump, /compare\/main\.\.\.\$\{RELEASE_SHA\}/, 'the release commit is not required to be on main');
  assert.match(bump, /behind\|identical/, 'a commit outside main is not rejected');
  assert.match(bump, /compare\/\$\{CURRENT\}\.\.\.\$\{RELEASE_SHA\}/);
  assert.match(bump, /Could not compare \$\{RELEASE_SHA\} with the current pin/);
  assert.doesNotMatch(bump, /STATUS=unknown/, 'an API failure must not look like a downgrade');
  assert.match(bump, /ahead\)/);
  assert.match(bump, /behind\|identical/);
  assert.match(bump, /Already pinned/);
});

test('the keepalive commits inside every 60-day activity window', () => {
  assert.match(keepalive, /schedule:/);
  const cron = keepalive.match(/cron:\s*'([^']+)'/)?.[1];
  assert.ok(cron, 'keepalive has no cron expression');
  const [minute, hour, dayOfMonth, month] = cron.trim().split(/\s+/);
  assert.equal(month, '*', 'keepalive must run every month');
  assert.equal(dayOfMonth, '1,15', 'keepalive must run twice a month');
  assert.ok(Number(minute) >= 0 && Number(minute) <= 59, 'keepalive minute is invalid');
  assert.ok(Number(hour) >= 0 && Number(hour) <= 23, 'keepalive hour is invalid');
  assert.match(keepalive, /ref: main/);
  assert.match(keepalive, /\.github\/keepalive/);
  assert.match(keepalive, /git push/);
  assert.match(keepalive, /contents: write/);
});

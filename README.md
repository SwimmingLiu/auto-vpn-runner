# auto-vpn-runner

The nightly publish for the AutoVPN subscription, scheduled on GitHub Actions.

This repository owns the schedule and nothing else. Each night the workflow
checks out [`swimmingliu/auto-vpn`](https://github.com/swimmingliu/auto-vpn) at a pinned
commit, builds its CLI, syncs the account pool from its database, measures
through the nodes in the currently published subscription, and uploads the
measured artifact to Cloudflare Pages. The pipeline code, the account pool and
the subscription remain owned by the other repository and its database.

## Configuration

Credentials are repository secrets, configured under Settings → Secrets and
variables → Actions. They are deliberately not described here; the workflow
names the ones it reads.

## Schedule

20:15 UTC daily. A night that does not clear the profile's `min_final_links`
floor is held: nothing is published and the previous subscription stays in
service. A held night is a successful run, not a failure.

GitHub disables a scheduled workflow in a public repository after 60 days
without repository activity; a scheduled workflow's own runs do not reset that
clock. The monthly `Keepalive` workflow commits a dated heartbeat file, which is
ordinary repository activity and keeps the nightly schedule eligible. If the
repository is ever frozen for more than 60 days anyway, re-enable the schedule
from the Actions tab.

## Running it by hand

Actions → Scheduled Subscription Publish → Run workflow. `dry_run` measures and
stops before publishing.

## Moving the pin

`PIPELINE_REF` names the `auto-vpn` commit whose CLI is measured. A release in
`auto-vpn` dispatches `Bump pipeline pin`, which opens a pull request against
this repository moving `PIPELINE_REF` to the release commit. It refuses a commit
that is not ahead of the current pin, never pushes to `main`, and never merges.
Review and merge the PR, then run the scheduled workflow once by hand before
letting the schedule take over.

The dispatch and the pin PR need `AUTOVPN_RUNNER_TOKEN`, a fine-grained token
scoped to this repository with `Contents: read/write` and `Pull requests:
read/write`. It is set in `auto-vpn` for the dispatch and here for the PR
(scheduled-workflow runs use the checkout's `GITHUB_TOKEN` to push the branch,
then this token to open the PR so pull-request CI runs).

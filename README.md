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
variables → Actions. Secret values are deliberately not described here; the
workflows name the secrets they read. The permission shape for the
cross-repository `AUTOVPN_RUNNER_TOKEN` is documented under
[Moving the pin](#moving-the-pin).

## Schedule

20:15 UTC daily. A night that does not clear the profile's `min_final_links`
floor is held: nothing is published and the previous subscription stays in
service. A held night is a successful run, not a failure.

GitHub disables a scheduled workflow in a public repository after 60 days
without repository activity; a scheduled workflow's own runs do not reset that
clock. The twice-monthly `Keepalive` workflow commits a dated heartbeat file,
which is ordinary repository activity and keeps the nightly schedule eligible.
Two runs a month leave room for one missed run. If the repository is ever
frozen for more than 60 days anyway, re-enable the schedule from the Actions
tab.

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
scoped to this repository with `Contents: read/write`, `Pull requests:
read/write` and `Workflows: read/write`. The last one is required because the
pin lives in a workflow file, and the job's own `GITHUB_TOKEN` cannot push a
workflow change. Set the same token in both repositories: `auto-vpn` uses it
for the dispatch, this repository uses it to push the branch and open the PR.
The PAT push and a PAT-created PR also mean pull-request CI runs.

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

GitHub disables a scheduled workflow after 60 days without repository activity;
if that happens, re-enable it from the Actions tab.

## Running it by hand

Actions → Scheduled Subscription Publish → Run workflow. `dry_run` measures and
stops before publishing.

## Moving the pin

`PIPELINE_REF` names the `auto-vpn` commit whose CLI is measured. Move it to a
commit on `auto-vpn`'s `main`, then run the workflow once by hand before letting
the schedule take over.

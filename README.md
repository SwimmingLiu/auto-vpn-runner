# auto-vpn-runner

The scheduled runner for the AutoVPN Cloudflare subscription.

The pipeline itself lives in [`swimmingliu/auto-vpn`](https://github.com/swimmingliu/auto-vpn). This repository owns only the schedule, the credentials and the run history: the workflow checks out `auto-vpn` at a pinned commit, builds the CLI from it, measures through the nodes in the already-published subscription, and publishes the artifact that run measured to Cloudflare Pages.

Keeping the schedule here means a run cannot be changed by an in-flight branch in the source repository, and the secrets that can publish live in exactly one place.

## Required configuration

Secrets — Settings → Secrets and variables → Actions → Secrets:

| Secret | What it is |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Pages deploy token for the account |
| `AUTOVPN_SUBSCRIPTION_URL` | The published subscription the crawl egresses through and that the run keeps in service |
| `AUTOVPN_SUBSCRIPTION_KEY` | The key the published subscription answers to; the profile defers to it and never stores it |
| `AUTOVPN_PAGES_ADMIN` | The share worker's admin token, read at publish |
| `AUTOVPN_ACCOUNTS_DB_URL` | The shared Postgres pool (`autovpn.accounts`); the run syncs it instead of importing a split secret |

Variables — same screen, Variables tab:

| Variable | What it is |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | The account the Pages project belongs to |

Secret values cannot be read back from another repository; they have to be added here from wherever they are kept. Add them at repository level — the workflow deliberately declares no `environment`, so an environment-scoped secret would be invisible to it.

## Schedule

20:15 UTC daily. A night that does not clear `min_final_links` is reported as a held night and publishes nothing — the previous subscription stays in service. A held night is a successful run, not a red one.

GitHub disables a scheduled workflow after 60 days without repository activity and emails the owner; re-enable it from the Actions tab if that email arrives.

## Running it by hand

Actions → Cloudflare Subscription → Run workflow. `dry_run` measures and stops before publishing, which is the way to check a new pin without touching what is being served.

## Moving the pin

`PIPELINE_REF` in the workflow names the `auto-vpn` commit whose CLI is measured. Move it to a commit on `auto-vpn`'s `main`, then run the workflow once with `workflow_dispatch` before letting the schedule take over.

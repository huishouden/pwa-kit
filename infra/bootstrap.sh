#!/usr/bin/env bash
# Creates (or tops up) a Firebase project for a family of PWAs and wires each app repo for keyless
# CI deploys. Safe to re-run: every step checks before it creates.
#
#   infra/bootstrap.sh path/to/apps.conf
#   infra/bootstrap.sh --staging path/to/apps.conf
#   infra/bootstrap.sh [--staging] --prune-domains path/to/apps.conf
#
# Sign-in lists (docs/one-site.md "Sign-in origins"): the OAuth client's Authorized JavaScript
# origins need only the suite's site (SUITE_SITE in src/site.ts) and <project>.firebaseapp.com;
# Firebase Auth's authorized domains get those two, plus each app's staging site and localhost in
# staging only. Other authorized domains are listed; --prune-domains removes them.
#
# --staging provisions the separate staging project, huishouden-staging, instead (STANDARD.md
# "Staging"): the same apps with sites named <STAGING_PROJECT>-<app> (the production default site becomes the staging default
# site), STAGING_-prefixed repo variables, a `staging` environment any branch may use, and a WIF
# provider that accepts any branch of the owner's repos (pull requests deploy there). Its deploy
# account may also deploy rules, write Firestore, manage Auth users and sign custom tokens for the
# test users. Nothing it creates can reach the production project.
#
# apps.conf is a bash file defining:
#   PROJECT=<firebase project id>
#   GITHUB_OWNER=<github user or org>
#   APPS=( "<repo>:<hosting site>:<web app display name or empty>" ... )
# Optional: POOL, PROVIDER, SA_NAME (defaults: github, github, github-deploy);
#   ALSO_TRUSTED_OWNERS="<user or org> ..." — other owners whose repos may also deploy (each repo is
#   still allowed separately), e.g. while repos move between a user and an org.
#   VAPID_PUBLIC_KEY=<key> — the push sender's public key (huishouden/notify `bun run vapid`); set on
#   every app as VITE_VAPID_PUBLIC_KEY for @huishouden/pwa-kit/push. Public, like the web config.
#   DEPLOY_REPOS="<repo> ..." — repos that deploy to the project without a site (the rules repo):
#   they get the WIF binding, the deploy variables and the environment.
#   STAGING_PROJECT (only huishouden-staging, the default), STAGING_DISPLAY_NAME,
#   STAGING_FIRESTORE_LOCATION (default us-east1; the staging Firestore database is created if missing).
#   ALERT_EMAIL=<address> (environment) — production only: an email when Firestore reads in 24 hours
#   pass 60% of the free plan's 50,000 (infra/read-alert.sh, docs/one-site.md "Budgets").
#
# Production environment (STANDARD.md "Pull requests"): every repo gets a `production` environment
# deployable from main only; the secrets it holds are placed by `hh ops secret push` (cloudflare, newrelic-user).
#
# Prerequisites (once per machine), all as the same Google account:
#   npx firebase-tools login ; gcloud auth login ; gh auth login
set -euo pipefail

STAGING=false
PRUNE_DOMAINS=false
while [[ "${1:-}" == --* ]]; do
  case "$1" in
    --staging) STAGING=true ;;
    --prune-domains) PRUNE_DOMAINS=true ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
CONFIG=${1:?usage: bootstrap.sh [--staging] [--prune-domains] path/to/apps.conf}
# shellcheck source=/dev/null
source "$CONFIG"
: "${PROJECT:?PROJECT missing in $CONFIG}" "${GITHUB_OWNER:?GITHUB_OWNER missing in $CONFIG}"
POOL=${POOL:-github}
PROVIDER=${PROVIDER:-github}
SA_NAME=${SA_NAME:-github-deploy}
DISPLAY_NAME=${DISPLAY_NAME:-$PROJECT}
read -r -a DEPLOY_REPOS <<<"${DEPLOY_REPOS:-}"
VAR=""                # repo variable prefix

if $STAGING; then
  # The kit's staging code (seed, test sign-in, the staging CI job) refuses every other project.
  STAGING_PROJECT=${STAGING_PROJECT:-huishouden-staging}
  if [[ "$STAGING_PROJECT" != huishouden-staging ]]; then
    echo "STAGING_PROJECT must be huishouden-staging: the kit's staging code accepts no other project" >&2
    exit 1
  fi
  # Every site moves to the staging project: the production default site (named after the
  # project) becomes the staging default site, and <family>-<app> becomes <staging project>-<app>.
  STAGED=()
  for entry in "${APPS[@]}"; do
    IFS=: read -r repo site app_name <<<"$entry"
    if [[ "$site" == "$PROJECT" ]]; then site=$STAGING_PROJECT; else site="$STAGING_PROJECT-${site#*-}"; fi
    STAGED+=("$repo:$site:$app_name")
  done
  APPS=("${STAGED[@]}")
  PROJECT=$STAGING_PROJECT
  DISPLAY_NAME=${STAGING_DISPLAY_NAME:-"$DISPLAY_NAME staging"}
  VAR=STAGING_
  # The notification sender only reads the production project.
  unset VAPID_PUBLIC_KEY
fi

# The site that serves the suite: production's is SUITE_SITE in the kit's src/site.ts (the one place
# the address is set), staging's the staging project's default site.
SUITE_SITE=$(sed -n "s/^export const SUITE_SITE = '\([a-z0-9-]*\)';$/\1/p" "$(dirname "${BASH_SOURCE[0]}")/../src/site.ts")
: "${SUITE_SITE:?SUITE_SITE not found in src/site.ts of the kit}"
$STAGING && SUITE_SITE=$PROJECT
firebase() { npx --yes firebase-tools@14 "$@"; }
step() { printf '\n== %s\n' "$*"; }

step "Firebase project $PROJECT"
if ! gcloud projects describe "$PROJECT" >/dev/null 2>&1; then
  firebase projects:create "$PROJECT" --display-name "$DISPLAY_NAME" || true
fi
if ! firebase projects:list --json | jq -e --arg p "$PROJECT" '.result[] | select(.projectId == $p)' >/dev/null; then
  gcloud services enable firebase.googleapis.com --project "$PROJECT"
  # 403 here on a project you own means this Google account has not accepted the Firebase terms:
  # open https://console.firebase.google.com, choose "Add project" > this project, accept, re-run.
  firebase projects:addfirebase "$PROJECT"
fi
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')

step "APIs"
gcloud services enable --project "$PROJECT" \
  firebasehosting.googleapis.com iamcredentials.googleapis.com sts.googleapis.com \
  identitytoolkit.googleapis.com sheets.googleapis.com drive.googleapis.com \
  calendar-json.googleapis.com gmail.googleapis.com
if $STAGING; then
  gcloud services enable --project "$PROJECT" firestore.googleapis.com firebaserules.googleapis.com
  step "Firestore (staging)"
  gcloud firestore databases describe --database='(default)' --project "$PROJECT" >/dev/null 2>&1 \
    || gcloud firestore databases create --location "${STAGING_FIRESTORE_LOCATION:-us-east1}" --project "$PROJECT"
fi

step "Deploy service account"
SA="$SA_NAME@$PROJECT.iam.gserviceaccount.com"
gcloud iam service-accounts describe "$SA" --project "$PROJECT" >/dev/null 2>&1 \
  || gcloud iam service-accounts create "$SA_NAME" --project "$PROJECT" --display-name "GitHub Actions deploy"
# A new service account takes a few seconds to become visible to IAM; granting roles before then
# fails with "does not exist". Wait for it (up to a minute) rather than failing the run.
for _ in $(seq 1 12); do
  gcloud iam service-accounts describe "$SA" --project "$PROJECT" >/dev/null 2>&1 && break
  sleep 5
done
ROLES=(roles/firebasehosting.admin roles/serviceusage.serviceUsageConsumer roles/serviceusage.apiKeysViewer roles/run.viewer)
# Staging only: the rules repo deploys there from PRs, and CI seeds the test household (Firestore,
# Auth users) and signs the test users' custom tokens. Never granted in production.
$STAGING && ROLES+=(roles/firebaserules.admin roles/datastore.indexAdmin roles/datastore.user roles/firebaseauth.admin)
for role in "${ROLES[@]}"; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$SA" --role "$role" --condition None >/dev/null
done
if $STAGING; then
  # Custom tokens are JWTs the account signs as itself (IAM signJwt), so no key ever exists.
  gcloud iam service-accounts add-iam-policy-binding "$SA" --project "$PROJECT" \
    --member "serviceAccount:$SA" --role roles/iam.serviceAccountTokenCreator >/dev/null
fi
echo "$SA"

if $STAGING; then
  step "Workload Identity Federation (GitHub OIDC: owner $GITHUB_OWNER, any branch)"
else
  step "Workload Identity Federation (GitHub OIDC: owner $GITHUB_OWNER, main branch only)"
fi
# Numeric owner id, not the name: a renamed account's old name could be claimed by someone else.
OWNER_IDS=""
for owner in "$GITHUB_OWNER" ${ALSO_TRUSTED_OWNERS:-}; do
  OWNER_IDS+="${OWNER_IDS:+, }'$(gh api "users/$owner" --jq .id)'"
done
WIF_CONDITION="assertion.repository_owner_id in [$OWNER_IDS] && assertion.ref == 'refs/heads/main'"
if $STAGING; then
  # Staging takes pull requests from any branch (GitHub gives forks' PR runs no OIDC token at all),
  # so the workflow is pinned instead: the kit's released pwa.yml (a tag, which a branch can't
  # rewrite), or the workflows of the DEPLOY_REPOS (the rules repo).
  WORKFLOWS="assertion.job_workflow_ref.startsWith('$GITHUB_OWNER/pwa-kit/.github/workflows/pwa.yml@refs/tags/')"
  for repo in "${DEPLOY_REPOS[@]}"; do
    WORKFLOWS+=" || assertion.job_workflow_ref.startsWith('$GITHUB_OWNER/$repo/.github/workflows/')"
  done
  WIF_CONDITION="assertion.repository_owner_id in [$OWNER_IDS] && ($WORKFLOWS)"
fi
gcloud iam workload-identity-pools describe "$POOL" --project "$PROJECT" --location global >/dev/null 2>&1 \
  || gcloud iam workload-identity-pools create "$POOL" --project "$PROJECT" --location global --display-name "GitHub Actions"
gcloud iam workload-identity-pools providers describe "$PROVIDER" --project "$PROJECT" --location global --workload-identity-pool "$POOL" >/dev/null 2>&1 \
  || gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" --project "$PROJECT" --location global \
       --workload-identity-pool "$POOL" --display-name "GitHub" \
       --issuer-uri "https://token.actions.githubusercontent.com" \
       --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
       --attribute-condition "$WIF_CONDITION"
# Re-applied every run so older providers pick up the stricter condition.
gcloud iam workload-identity-pools providers update-oidc "$PROVIDER" --project "$PROJECT" --location global \
  --workload-identity-pool "$POOL" --attribute-condition "$WIF_CONDITION" >/dev/null
WIF_PROVIDER="projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/providers/$PROVIDER"

if [[ "$SUITE_SITE" != "$PROJECT" ]]; then
  step "Suite site $SUITE_SITE.web.app"
  firebase hosting:sites:get "$SUITE_SITE" --project "$PROJECT" >/dev/null 2>&1 \
    || firebase hosting:sites:create "$SUITE_SITE" --project "$PROJECT"
fi

for repo in "${DEPLOY_REPOS[@]}"; do APPS+=("$repo::"); done
for entry in "${APPS[@]}"; do
  IFS=: read -r repo site app_name <<<"$entry"
  step "$repo${site:+ → $site.web.app}"

  if [[ -n "$site" && "$site" != "$PROJECT" ]]; then
    firebase hosting:sites:get "$site" --project "$PROJECT" >/dev/null 2>&1 \
      || firebase hosting:sites:create "$site" --project "$PROJECT"
  fi

  # Each repo is allowed separately; the provider condition limits tokens to main-branch runs.
  gcloud iam service-accounts add-iam-policy-binding "$SA" --project "$PROJECT" \
    --role roles/iam.workloadIdentityUser \
    --member "principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/attribute.repository/$GITHUB_OWNER/$repo" >/dev/null

  if ! gh repo view "$GITHUB_OWNER/$repo" >/dev/null 2>&1; then
    echo "repo $GITHUB_OWNER/$repo not found; skipping variables"
    continue
  fi
  # Free on public repos; re-applied because transferring a repo turns both off.
  gh api -X PATCH "repos/$GITHUB_OWNER/$repo" --input - >/dev/null <<'JSON'
{"security_and_analysis": {"secret_scanning": {"status": "enabled"}, "secret_scanning_push_protection": {"status": "enabled"}}}
JSON
  gh variable set "${VAR}GCP_WIF_PROVIDER" --repo "$GITHUB_OWNER/$repo" --body "$WIF_PROVIDER"
  gh variable set "${VAR}GCP_DEPLOY_SA" --repo "$GITHUB_OWNER/$repo" --body "$SA"
  if $STAGING; then
    [[ -n "$site" ]] && gh variable set STAGING_SITE --repo "$GITHUB_OWNER/$repo" --body "$site"
    # Pull requests deploy to staging, so any branch may use its environment.
    gh api -X PUT "repos/$GITHUB_OWNER/$repo/environments/staging" --input - >/dev/null <<'JSON'
{"deployment_branch_policy": null}
JSON
  else
    # Deploys run in the production environment; only main may deploy to it.
    gh api -X PUT "repos/$GITHUB_OWNER/$repo/environments/production" --input - >/dev/null <<'JSON'
{"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
JSON
    gh api -X POST "repos/$GITHUB_OWNER/$repo/environments/production/deployment-branch-policies" -f name=main -f type=branch >/dev/null 2>&1 || true
    # Secrets the repo is expected to hold, placed from the keychain by hh's registry (never from this
    # script's environment): the Cloudflare token and account id in the `production` environment of the
    # portal and the Workers, and the portal's repo secret NEW_RELIC_API_KEY (what monitoring.yml
    # reads; docs/observability.md). --expected skips every other repo; --soft skips a secret the
    # keychain does not hold yet (`hh ops secret store <name>`). Nothing is printed.
    if command -v hh >/dev/null 2>&1 && [[ "$GITHUB_OWNER" == huishouden ]]; then
      for secret in cloudflare newrelic-user; do
        hh ops secret push "$secret" --repos "$repo" --expected --soft || echo "  hh ops secret push $secret failed for $repo; run it by hand" >&2
      done
    fi
  fi
  # release-please opens release PRs with GITHUB_TOKEN; the default token stays read-only.
  # An organization must allow this first (org admin): Settings > Actions > Workflow permissions.
  if ! gh api -X PUT "repos/$GITHUB_OWNER/$repo/actions/permissions/workflow" \
    -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true >/dev/null 2>/tmp/bootstrap-gh.err; then
    if grep -q "organization does not allow" /tmp/bootstrap-gh.err; then
      echo "The $GITHUB_OWNER organization blocks Actions from opening pull requests (release-please needs it)." >&2
      echo "Allow it at https://github.com/organizations/$GITHUB_OWNER/settings/actions" >&2
      echo "(Workflow permissions > Allow GitHub Actions to create and approve pull requests), then re-run." >&2
    else
      cat /tmp/bootstrap-gh.err >&2
    fi
    exit 1
  fi

  if [[ -n "$app_name" ]]; then
    app_id=$(firebase apps:list WEB --project "$PROJECT" --json | jq -r --arg n "$app_name" '.result[] | select(.displayName == $n) | .appId' | head -1)
    if [[ -z "$app_id" ]]; then
      app_id=$(firebase apps:create WEB "$app_name" --project "$PROJECT" --json | jq -r '.result.appId')
    fi
    # Web SDK config is public by design (it ships in the bundle); access is enforced by Auth and rules.
    config=$(firebase apps:sdkconfig WEB "$app_id" --project "$PROJECT" --json | jq '.result.sdkConfig')
    gh variable set "${VAR}VITE_FIREBASE_API_KEY" --repo "$GITHUB_OWNER/$repo" --body "$(jq -r .apiKey <<<"$config")"
    # The project's default auth domain is the only redirect URI the auto-created OAuth client allows;
    # using the app's own domain needs its /__/auth/handler added to that client in the console.
    gh variable set "${VAR}VITE_FIREBASE_AUTH_DOMAIN" --repo "$GITHUB_OWNER/$repo" --body "$PROJECT.firebaseapp.com"
    gh variable set "${VAR}VITE_FIREBASE_PROJECT_ID" --repo "$GITHUB_OWNER/$repo" --body "$PROJECT"
    gh variable set "${VAR}VITE_FIREBASE_APP_ID" --repo "$GITHUB_OWNER/$repo" --body "$app_id"
    gh variable set "${VAR}VITE_FIREBASE_MESSAGING_SENDER_ID" --repo "$GITHUB_OWNER/$repo" --body "$(jq -r .messagingSenderId <<<"$config")"
    # For silent One Tap sign-in (@huishouden/pwa-kit/auth): the OAuth client Firebase created for
    # Google sign-in. Public, like the rest of the web config. Empty until Google sign-in is enabled.
    client_id=$(curl -s -H "Authorization: Bearer $(gcloud auth print-access-token)" -H "x-goog-user-project: $PROJECT" \
      "https://identitytoolkit.googleapis.com/admin/v2/projects/$PROJECT/defaultSupportedIdpConfigs/google.com" | jq -r '.clientId // empty')
    [[ -n "$client_id" ]] && gh variable set "${VAR}VITE_GOOGLE_CLIENT_ID" --repo "$GITHUB_OWNER/$repo" --body "$client_id"
  fi
  if [[ -n "${VAPID_PUBLIC_KEY:-}" ]]; then
    gh variable set VITE_VAPID_PUBLIC_KEY --repo "$GITHUB_OWNER/$repo" --body "$VAPID_PUBLIC_KEY"
  fi
done

if [[ -n "${client_id:-}" ]]; then
  # Only the suite's site and the auth handler: Google allows an unverified app 10 authorized
  # domains, each *.web.app counting separately, and the per-app sites never show Google's prompt.
  step "Sign-in origins on the OAuth web client"
  bun "$(dirname "${BASH_SOURCE[0]}")/../scripts/oauth-origins.ts" "$client_id" --project="$PROJECT" --site="$SUITE_SITE" || true
fi

step "Auth authorized domains"
# Firebase Auth only accepts sign-ins from listed domains. Needs Auth initialised (console step 1).
# Production: the suite's site and the auth handler only (the old per-app sites just redirect).
# Staging adds each app's own staging site (its PR runs sign in there) and localhost.
AUTH_API="https://identitytoolkit.googleapis.com/admin/v2/projects/$PROJECT/config"
auth_headers=(-H "Authorization: Bearer $(gcloud auth print-access-token)" -H "x-goog-user-project: $PROJECT")
current=$(curl -s "${auth_headers[@]}" "$AUTH_API")
if jq -e '.authorizedDomains' >/dev/null <<<"$current"; then
  wanted=$(
    echo "$SUITE_SITE.web.app"
    echo "$PROJECT.firebaseapp.com"
    if $STAGING; then
      for entry in "${APPS[@]}"; do IFS=: read -r _ site _ <<<"$entry"; [[ -z "$site" ]] || echo "$site.web.app"; done
      echo localhost
    fi
  )
  wanted_json=$(jq -Rnc '[inputs | select(. != "")] | unique' <<<"$wanted")
  extra=$(jq -r --argjson w "$wanted_json" '.authorizedDomains - $w | .[]' <<<"$current")
  if $PRUNE_DOMAINS; then
    domains=$wanted_json
  else
    domains=$(jq -c --argjson w "$wanted_json" '(.authorizedDomains + $w) | unique' <<<"$current")
  fi
  if [[ "$(jq -c 'sort' <<<"$domains")" != "$(jq -c '.authorizedDomains | sort' <<<"$current")" ]]; then
    curl -s -X PATCH "${auth_headers[@]}" -H "Content-Type: application/json" \
      "$AUTH_API?updateMask=authorizedDomains" -d "{\"authorizedDomains\": $domains}" | jq -c '.authorizedDomains'
  else
    jq -c '.authorizedDomains' <<<"$current"
  fi
  if [[ -n "$extra" ]] && ! $PRUNE_DOMAINS; then
    echo "Not needed (re-run with --prune-domains to remove): $(tr '\n' ' ' <<<"$extra")"
  fi
else
  echo "Auth not initialised yet; do console step 1, then re-run."
fi

if ! $STAGING; then
  step "Firestore read alert"
  if [[ -n "${ALERT_EMAIL:-}" ]]; then
    "$(dirname "${BASH_SOURCE[0]}")/read-alert.sh" "$PROJECT" || { echo "The read alert failed; re-run infra/read-alert.sh $PROJECT" >&2; exit 1; }
  else
    echo "  ALERT_EMAIL not set: no email when reads near the free plan's daily limit (infra/read-alert.sh)"
  fi
fi

step "Done"
cat <<EOF
Manual steps the APIs don't cover (project $PROJECT):
  1. Firebase console > Authentication > Get started > Sign-in method > Google > Enable
     (initialises Auth on the free plan and creates the OAuth web client; no supported API does either)
  2. Google Cloud console > Google Auth Platform > Clients > the "Web client (auto created by Google
     Service)" > Authorized JavaScript origins: add https://$SUITE_SITE.web.app (the suite's site) and
     https://$PROJECT.firebaseapp.com, nothing per app (Google allows an unverified app 10 authorized
     domains); the origins step above lists any still missing. Then re-run this script so apps get
     ${VAR}VITE_GOOGLE_CLIENT_ID.
EOF

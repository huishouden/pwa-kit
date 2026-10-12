#!/usr/bin/env bash
# Emails when the project's Firestore reads run high (STANDARD.md "Read budgets"; docs/one-site.md
# "Budgets"): over HOURLY billed reads in the last hour (default 5,000: a runaway job at the rate of
# the 2026-10-12 incident gets there in about three minutes, while the suite's busiest normal hour is
# under 4,000), and over DAILY in the last 24 hours (default 30,000, 60% of the free plan's 50,000).
# Cloud Monitoring, free. Safe to re-run: the channel and the policies are found by name and updated.
#
#   ALERT_EMAIL=you@example.com infra/read-alert.sh <project> [daily] [hourly]
#   infra/read-alert.sh --print <project> [daily] [hourly]   # the policies as JSON, nothing changed
#
# Without ALERT_EMAIL an existing channel of that name is used as it is. Reads are counted as
# Firestore bills them against the quota: documents returned (`document/read_count`) plus one for
# every query and aggregation request, which Firestore bills at least one read even when it returns
# nothing and which `read_count` leaves out. The windows are rolling, not the quota's Pacific day,
# so the email comes early rather than late.
set -euo pipefail
PRINT=false
if [[ "${1:-}" == "--print" ]]; then PRINT=true; shift; fi
PROJECT=${1:?usage: [ALERT_EMAIL=…] read-alert.sh [--print] <project> [daily] [hourly]}
DAILY=${2:-30000}
HOURLY=${3:-5000}
API=https://monitoring.googleapis.com/v3/projects/$PROJECT
CHANNEL_NAME="Huishouden budget alerts"
DAILY_NAME="Firestore reads over 60% of the free quota"
HOURLY_NAME="Firestore reads over ${HOURLY} in an hour"
HOURLY_PREFIX="Firestore reads over "

# Billed reads over a window ([1h], [1d]) above a threshold, in PromQL.
reads_query() {
  echo "(sum(increase(firestore_googleapis_com:document_read_count{monitored_resource=\"firestore_instance\"}[$1])) or vector(0)) + (sum(increase(firestore_googleapis_com:api_request_count{monitored_resource=\"datastore_request\",api_method=~\"RunQuery|RunAggregationQuery\"}[$1])) or vector(0)) > $2"
}

# policy <name> <window> <threshold> <evaluation seconds> <auto-close seconds> <what> <channel>
policy() {
  jq -n --arg n "$1" --arg q "$(reads_query "$2" "$3")" --arg c "$7" --arg t "$3" --arg w "$6" --arg every "${4}s" --arg close "${5}s" '{
    displayName: $n,
    combiner: "OR",
    documentation: {mimeType: "text/markdown", content: ("Firestore has billed more than " + $t + " reads in " + $w + ". The free (Spark) plan stops every read at 50,000 a day until midnight Pacific, for every app and Worker. Find the source: the Workers log each run'"'"'s reads (calendar `work`/`round`, notify `NotifyRun.reads`, the connector'"'"'s tool calls); Cloud Monitoring `firestore.googleapis.com/api/request_count` by method shows what kind of read. pwa-kit STANDARD.md \"Read budgets\".")},
    conditions: [{displayName: ("Reads in " + $w + " over " + $t), conditionPrometheusQueryLanguage: {query: $q, duration: "0s", evaluationInterval: $every}}],
    alertStrategy: {autoClose: $close},
    notificationChannels: (if $c == "" then [] else [$c] end)
  }'
}

if $PRINT; then
  jq -n --argjson d "$(policy "$DAILY_NAME" 1d "$DAILY" 300 86400 "the last 24 hours" "")" --argjson h "$(policy "$HOURLY_NAME" 1h "$HOURLY" 60 3600 "the last hour" "")" '[$d, $h]'
  exit 0
fi

auth=(-H "Authorization: Bearer $(gcloud auth print-access-token)" -H "x-goog-user-project: $PROJECT" -H "Content-Type: application/json")
gcloud services enable monitoring.googleapis.com --project "$PROJECT" >/dev/null

channel=$(curl -sf "${auth[@]}" -G "$API/notificationChannels" --data-urlencode "filter=type=\"email\" AND display_name=\"$CHANNEL_NAME\"" | jq -r '.notificationChannels[0].name // empty')
if [[ -n "${ALERT_EMAIL:-}" ]]; then
  channel_body=$(jq -n --arg n "$CHANNEL_NAME" --arg e "$ALERT_EMAIL" '{type: "email", displayName: $n, labels: {email_address: $e}}')
  if [[ -z "$channel" ]]; then
    channel=$(curl -sf "${auth[@]}" -X POST "$API/notificationChannels" -d "$channel_body" | jq -r .name)
    echo "  created the email channel"
  else
    curl -sf "${auth[@]}" -X PATCH "https://monitoring.googleapis.com/v3/$channel?updateMask=labels" -d "$channel_body" >/dev/null
    echo "  email channel up to date"
  fi
elif [[ -z "$channel" ]]; then
  echo "No \"$CHANNEL_NAME\" channel yet: set ALERT_EMAIL to create it." >&2
  exit 1
else
  echo "  using the existing email channel"
fi

# apply <current name filter> <body> <label>
apply() {
  local existing
  existing=$(curl -sf "${auth[@]}" -G "$API/alertPolicies" --data-urlencode "filter=$1" | jq -r '.alertPolicies[0].name // empty')
  if [[ -z "$existing" ]]; then
    curl -sf "${auth[@]}" -X POST "$API/alertPolicies" -d "$2" >/dev/null
    echo "  created the alert: $3"
  else
    curl -sf "${auth[@]}" -X PATCH "https://monitoring.googleapis.com/v3/$existing" -d "$2" >/dev/null
    echo "  alert up to date: $3"
  fi
}

apply "display_name=\"$DAILY_NAME\"" "$(policy "$DAILY_NAME" 1d "$DAILY" 300 86400 "the last 24 hours" "$channel")" "$DAILY_NAME ($DAILY reads in 24 hours)"
# Found by its prefix and window, so a new threshold updates the same policy.
apply "display_name=starts_with(\"$HOURLY_PREFIX\") AND display_name=ends_with(\" in an hour\")" "$(policy "$HOURLY_NAME" 1h "$HOURLY" 60 3600 "the last hour" "$channel")" "$HOURLY_NAME"

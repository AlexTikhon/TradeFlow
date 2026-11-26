#!/bin/bash
# Usage: check-database-url < url   (exit 0 accepts, 1 rejects; the URL is never an argument)
# Accepts only the application database URL contract (docs/aws-infrastructure.md, Database TLS):
#   postgresql://<user>:<secret>@<host>[:<port>]/<database>?sslmode=verify-full&sslrootcert=/etc/tradeflow/rds-ca.pem
# with the two parameters in either order and nothing else in the query. node-postgres
# (pg-connection-string) URL-decodes parameter names and values and lets the last repeat win, so
# the query must be literal: percent-encoding, '+', a fragment, an empty, unknown or repeated
# parameter is refused rather than interpreted. Messages never repeat the URL or any part of it.
# Embedded in user data by Terraform; tested by infra/aws/tests/database-url.test.js.
set -euo pipefail
export LC_ALL=C

fail() {
  echo "DATABASE_URL rejected: $1" >&2
  exit 1
}

(($# == 0)) || fail "the URL is read from standard input, never from arguments"
url=''
if IFS= read -r -d '' url; then
  fail "it contains a NUL byte"
fi
[[ -n "$url" ]] || fail "it is empty"
printable='^[!-~]+$'
[[ "$url" =~ $printable ]] || fail "only printable ASCII without spaces or control characters is allowed"

base=${url%%\?*}
[[ "$base" != "$url" ]] || fail "it has no query (sslmode and sslrootcert are required)"
query=${url#*\?}

# User, secret (unreserved characters or %XX), DNS host, optional port, database name.
authority='^postgresql://[A-Za-z0-9_]+:([A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})+@[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:([0-9]{1,5}))?/[A-Za-z0-9_]+$'
[[ "$base" =~ $authority ]] || fail "expected postgresql://<user>:<secret>@<host>[:<port>]/<database>"
port=${BASH_REMATCH[4]}
if [[ -n "$port" ]] && ((10#$port < 1 || 10#$port > 65535)); then
  fail "the port is out of range"
fi

literal_query='^[a-z]+=[A-Za-z0-9_./-]+(&[a-z]+=[A-Za-z0-9_./-]+)*$'
[[ "$query" =~ $literal_query ]] ||
  fail "the query must be literal name=value pairs joined by '&' (no encoding, '+', ';', '#' or empty parts)"

sslmode=0
sslrootcert=0
IFS='&' read -r -a params <<< "$query"
for param in "${params[@]}"; do
  name=${param%%=*}
  value=${param#*=}
  case "$name" in
    sslmode)
      [[ "$value" == verify-full ]] || fail "sslmode must be verify-full"
      sslmode=$((sslmode + 1))
      ;;
    sslrootcert)
      [[ "$value" == /etc/tradeflow/rds-ca.pem ]] || fail "sslrootcert must be /etc/tradeflow/rds-ca.pem"
      sslrootcert=$((sslrootcert + 1))
      ;;
    *) fail "only the sslmode and sslrootcert parameters are allowed" ;;
  esac
done
((sslmode == 1)) || fail "sslmode must appear exactly once"
((sslrootcert == 1)) || fail "sslrootcert must appear exactly once"

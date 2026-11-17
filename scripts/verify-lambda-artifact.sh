#!/usr/bin/env bash
# Verifies the Lambda artifact of a Python service WITHOUT touching the live
# dev environment: the service is copied to the same directory depth (so the
# relative plugin path ../../packages/pycommon/... still resolves), the
# ${cf:...} references are stubbed (the deployed infra stack predates the
# table outputs the services now reference), and the artifact is inspected.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE="$1"
DEST="$ROOT/backend/.tmp-verify-$SERVICE"

rm -rf "$DEST"
mkdir -p "$DEST"
# The scratch copy must not outlive the run — it is a full duplicate of the
# service tree and would otherwise linger in the repo.
trap 'rm -rf "$DEST"' EXIT
# Copy the service without its build output.
(cd "$ROOT/backend/$SERVICE" && tar --exclude='.serverless' --exclude='.requirements' --exclude='__pycache__' -cf - .) | (cd "$DEST" && tar -xf -)

# Stub the CloudFormation outputs (they only feed env vars / IAM resources).
python - "$DEST/serverless.yml" <<'PY'
import re, sys

path = sys.argv[1]
with open(path, encoding="utf-8") as fh:
    text = fh.read()

stubbed = re.sub(r"\$\{cf:[^}]*\}[^}]*\}?", "stubbed-value", text)
# Nested form: ${cf:${self:custom.infra}.TableName}
stubbed = re.sub(r"\$\{cf:\$\{self:custom\.[A-Za-z]+\}\.[A-Za-z]+\}", "stubbed-value", stubbed)
with open(path, "w", encoding="utf-8", newline="\n") as fh:
    fh.write(stubbed)
PY

echo "=== packaging $SERVICE ==="
cd "$DEST"
npx serverless package --stage dev > "/tmp/pkg-$SERVICE.log" 2>&1 || {
  echo "PACKAGE FAILED ($SERVICE)"
  tail -30 "/tmp/pkg-$SERVICE.log"
  exit 1
}
echo "package exit=0"

echo "=== artifact contents (top level) ==="
for zip in .serverless/*.zip; do
  echo "--- $zip ($(du -h "$zip" | cut -f1)) ---"
  python - "$zip" <<'PY'
import sys, zipfile

with zipfile.ZipFile(sys.argv[1]) as zf:
    names = zf.namelist()
    roots = sorted({n.split("/")[0] for n in names})
    print("top-level entries:", roots)
    pycommon = [n for n in names if n.startswith("pycommon/")]
    print("pycommon files:", len(pycommon))
    for n in sorted(pycommon)[:12]:
        print("   ", n)
    print("has pycommon/__init__.py:", "pycommon/__init__.py" in names)
    print("has pycommon/security.py:", "pycommon/security.py" in names)
    print("has pycommon/py.typed:", "pycommon/py.typed" in names)
    print("has app/main.py:", "app/main.py" in names)
    print("site-packages present:", any(n.startswith("site-packages/") for n in names))
PY
done

echo "=== working tree left clean? ==="
ls -d "$DEST/pycommon" 2>/dev/null && echo "LEFTOVER pycommon copy in the service tree!" || echo "no leftover pycommon copy"
ls -a "$DEST" | tr '\n' ' '
echo

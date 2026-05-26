#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

npm run start:backend
exec npm run start:frontend

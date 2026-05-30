#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONDA_ENV="${CONDA_ENV:-dc}"

echo "[backend] Python pipeline — 별도 HTTP 서버 없음 (STEP 업로드 시 server.js가 conda로 실행)"

if ! command -v conda >/dev/null 2>&1; then
	echo "[backend] ERROR: conda not found. README 설치 절차를 참고하세요."
	exit 1
fi

if ! conda env list | awk '{print $1}' | grep -qx "$CONDA_ENV"; then
	echo "[backend] ERROR: conda env '$CONDA_ENV' 없음. README: conda create -n dc python=3.10 -y"
	exit 1
fi

if ! conda run -n "$CONDA_ENV" node -v >/dev/null 2>&1; then
	echo "[backend] ERROR: conda env '$CONDA_ENV'에 nodejs/npm 없음. README: conda install -c conda-forge nodejs"
	exit 1
fi

CONDA_ENV="$CONDA_ENV" bash "$ROOT/scripts/patch-occwl.sh"

if conda run -n "$CONDA_ENV" python -c \
	"import numpy, trimesh, open3d; from occwl.compound import Compound; import msgpack, tqdm; \
from pathlib import Path; import occwl; \
assert 'facing.Nodes()' not in (Path(occwl.__file__).parent / 'face.py').read_text(), \
'occwl face.py patch missing — bash scripts/patch-occwl.sh'" \
	2>/dev/null
then
	echo "[backend] conda env '$CONDA_ENV' OK — Python pipeline + node/npm ready"
	exit 0
fi

echo "[backend] ERROR: conda env '$CONDA_ENV' 미설정 또는 Python 패키지 누락."
echo "[backend] README 설치 절차:"
echo "  conda activate $CONDA_ENV"
echo "  conda install -c conda-forge numpy trimesh pythonocc-core nodejs -y"
echo "  pip install -r requirements.txt"
echo "  bash scripts/patch-occwl.sh"
exit 1

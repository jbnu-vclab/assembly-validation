#!/usr/bin/env bash
set -euo pipefail

echo "[backend] Python pipeline — 별도 HTTP 서버 없음 (STEP 업로드 시 server.js가 conda로 실행)"

if ! command -v conda >/dev/null 2>&1; then
	echo "[backend] ERROR: conda not found. README 설치 절차를 참고하세요."
	exit 1
fi

if ! conda run -n dc node -v >/dev/null 2>&1; then
	echo "[backend] ERROR: conda env 'dc'에 nodejs/npm 없음. README: conda install -c conda-forge nodejs"
	exit 1
fi

if conda run -n dc python -c \
	"import numpy, trimesh, open3d; from occwl.compound import Compound; import msgpack, tqdm" \
	2>/dev/null
then
	echo "[backend] conda env 'dc' OK — Python pipeline + node/npm ready"
	exit 0
fi

echo "[backend] ERROR: conda env 'dc' 미설정 또는 Python 패키지 누락. README 설치 절차를 참고하세요."
exit 1

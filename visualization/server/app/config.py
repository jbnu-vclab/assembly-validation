"""서버 설정값. 경로와 상수를 한 곳에 모아 두고 다른 모듈은 여기서 가져다 쓴다."""

from pathlib import Path

# assembly-validation/ (visualization/server/app/config.py 에서 세 단계 위)
PROJECT_ROOT = Path(__file__).resolve().parents[3]

# 팀 파이프라인 CLI 와 같은 설정 파일. 조립 계산 파라미터를 여기서 읽는다.
PIPELINE_CONFIG_PATH = PROJECT_ROOT / "config" / "config.yaml"

ALLOWED_STEP_SUFFIXES = {".step", ".stp"}

# /load-step 미리보기용 STEPLoader 설정
PREVIEW_FACE_TOLERANCE = 0.1
PREVIEW_ANGLE_TOLERANCE = 0.1
PREVIEW_MAX_WORKERS = 4

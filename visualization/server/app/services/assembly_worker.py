"""
조립 계산 프로세스. job_service 가 `python -m server.app.services.assembly_worker <step> <output>` 로 띄운다.

팀 함수의 출력은 그대로 stdout 으로 흘려보내고(job_service 가 읽어 단계를 판단), 실패하면
오류 문구를 stderr 에 남기고 1 로 끝난다.
"""

import sys
from pathlib import Path

from server.app.config import PROJECT_ROOT

# 팀 모듈(data/, core/, 루트 main.py)을 import 할 수 있게 프로젝트 루트를 맨 앞에 둔다.
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from server.app.services.assembly_service import run_pipeline  # noqa: E402


def main() -> int:
    step_path, output_path = Path(sys.argv[1]), Path(sys.argv[2])
    try:
        run_pipeline(step_path, output_path)
    except Exception as error:  # 팀 함수의 어떤 오류든 문구로 남긴다
        print(f"{type(error).__name__}: {error}", file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

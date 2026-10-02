"""STEP 파일 → 조립(분해) 경로 결과 msgpack. 팀 파이프라인(data/ · core/)을 호출한다.

계산은 job_service 가 띄운 별도 프로세스(assembly_worker)에서 run_pipeline 으로 돌린다.
별도 프로세스라야 새 STEP 이 올라왔을 때 진행 중인 계산을 중간에 끊을 수 있다.
"""

from pathlib import Path

from omegaconf import OmegaConf

from server.app.config import PIPELINE_CONFIG_PATH

# 팀 함수는 단계마다 "── <구획 이름>" 제목을 출력한다. 팀 코드를 고치지 않고 이 제목으로
# 진행 단계를 짐작한다. 제목이 바뀌면 단계 표시만 멈출 뿐 계산 결과에는 영향이 없다.
STAGE_MESH = "mesh"            # STEP → Mesh 변환 · 복구 · CAD 매칭
STAGE_ASSEMBLY = "assembly"    # 충돌 판정 준비 · 분해 경로 탐색 · 실패 진단
_STAGE_MARKERS = (
    ("── 충돌 판정", STAGE_ASSEMBLY),
)


def detect_stage(output_line: str) -> str | None:
    """팀 함수의 출력 한 줄에서 진행 단계가 바뀌었는지 읽는다."""
    for marker, stage in _STAGE_MARKERS:
        if marker in output_line:
            return stage
    return None


def run_pipeline(step_path: Path, output_path: Path) -> None:
    """
    팀 파이프라인(RRT* 분해 경로 탐색)을 실행해 결과 msgpack 을 output_path 에 저장한다.

    탐색 파라미터는 CLI 와 같은 config/config.yaml 에서 읽어 인자로 넘긴다. 서버와 CLI 가
    같은 함수 · 같은 설정을 쓰므로 Debug 모드로 확인한 CLI 결과와 같은 조건에서 나온다.
    결과는 팀 exporter 형식 그대로다(분해 실패 진단 failures 포함). 정규화는 프론트
    result_loader.js 가 맡는다.
    """
    # 루트 main.py(팀 파이프라인 CLI)의 탐색 함수. 계산 프로세스 안에서만 불러온다.
    from main import execute_disassembly_search

    pipeline_config = OmegaConf.load(PIPELINE_CONFIG_PATH)
    execute_disassembly_search(
        step_path=str(step_path),
        output_path=str(output_path),
        worker_count=pipeline_config.search.worker_count,
        iteration_count=pipeline_config.search.iteration_count,
        does_sample_rotation=pipeline_config.search.does_sample_rotation,
        random_seed=pipeline_config.search.random_seed,
        time_budget_seconds=pipeline_config.search.time_budget_seconds,
        max_interference_growth=pipeline_config.max_interference_growth,
    )

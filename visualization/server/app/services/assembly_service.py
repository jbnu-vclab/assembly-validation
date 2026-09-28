"""STEP 파일 → 조립(분해) 경로 결과 msgpack. 팀 파이프라인(data/ · core/)을 호출한다."""

import tempfile
from pathlib import Path

from omegaconf import OmegaConf

# 루트 main.py(팀 파이프라인 CLI)의 탐색 함수. 서버 main.py 가 프로젝트 루트를 sys.path
# 맨 앞에 넣으므로 여기서 'main' 은 루트 main.py 를 가리킨다.
from main import execute_disassembly_search
from server.app.config import PIPELINE_CONFIG_PATH
from server.app.services.errors import StepProcessException


def assemble_step(step_path: Path, display_name: str) -> bytes:
    """
    팀 파이프라인(RRT* 분해 경로 탐색)을 실행하고 결과 msgpack 바이트를 돌려준다.

    탐색 파라미터는 CLI 와 같은 config/config.yaml 에서 읽는다. 서버와 CLI 가 같은 설정을
    쓰므로, Debug 모드로 확인한 CLI 결과와 Service 모드 결과가 같은 조건에서 나온다.
    부품마다 search.time_budget_seconds 까지 탐색하므로 수 분이 걸릴 수 있다.

    결과는 팀 exporter 형식 그대로다. 정규화는 프론트 result_loader.js 가 맡는다.

    [failures 미연동] 분해에 실패한 부품의 정보(failures: closest_path · last_valid_pose ·
    first_blocked_pose)는 아직 팀 main 브랜치의 exporter 가 내보내지 않는다. 팀원이 해당
    작업을 main 에 합치면 결과 msgpack 에 그대로 실려 오고, 프론트가 이미 해석하므로 이
    함수는 바꿀 필요가 없다. 그 전까지 실패 부품은 화면에서 '분해 경로 없음' 으로 보인다.

    Args:
        step_path: 서버에 저장된 STEP 파일 경로.
        display_name: 사용자가 올린 파일 이름. 오류 메시지에 쓴다.
    """
    # 팀 함수는 결과를 파일로만 저장하므로 임시 파일에 받은 뒤 읽는다.
    with tempfile.TemporaryDirectory(prefix="assembly-result-") as output_directory:
        output_path = Path(output_directory) / "assembly_result.msgpack"
        try:
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
            return output_path.read_bytes()
        except Exception as error:
            raise StepProcessException(
                f"failed to assemble STEP file {display_name!r}: {error}"
            ) from error

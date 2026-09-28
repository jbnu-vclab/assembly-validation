"""
Service 모드 API 엔드포인트. HTTP 와 서비스 계층 사이의 통역만 맡는다.

    요청에서 값 꺼내기 → 서비스 호출 → 서비스 예외를 HTTP 상태 코드로 → 응답 만들기

실제 처리는 services/ 에 있다. Debug 모드는 이 API 를 쓰지 않는다(브라우저가
output/*.msgpack 을 직접 읽는다).

엔드포인트는 CPU 를 오래 쓰므로 async 가 아닌 일반 def 로 둔다. FastAPI 가 스레드 풀에서
실행하므로 계산 중에도 다른 요청(/health 등)이 막히지 않는다.
"""

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import Response

from server.app.api.http_utils import msgpack_response, stored_step_upload
from server.app.services import assembly_service, step_service
from server.app.services.errors import StepProcessException

router = APIRouter()


@router.get("/health")
def get_health() -> dict[str, str]:
    return {"status": "ok"}


@router.post("/load-step")
def load_step(step_file: UploadFile = File(...)) -> Response:
    """STEP 파일을 받아 메시 미리보기 msgpack 을 반환한다(trajectories 는 빈 배열)."""
    with stored_step_upload(step_file) as step_path:
        try:
            payload_bytes = step_service.load_step_preview(step_path, step_file.filename)
        except StepProcessException as error:
            raise HTTPException(status_code=500, detail=str(error)) from error

    return msgpack_response(payload_bytes, "loaded_step.msgpack", "pending")


@router.post("/assemble")
def assemble(step_file: UploadFile = File(...)) -> Response:
    """
    STEP 파일을 받아 분해 경로 탐색 결과 msgpack 을 반환한다.

    /load-step 은 업로드를 보관하지 않으므로 계산할 STEP 파일을 여기서 다시 받는다.
    응답에 수 분이 걸릴 수 있다. 진행 상황 표시가 필요해지면 작업 ID 기반(POST 후 상태
    조회)으로 바꾼다. failures 연동 상태는 assembly_service.assemble_step 을 참고.
    """
    with stored_step_upload(step_file) as step_path:
        try:
            payload_bytes = assembly_service.assemble_step(step_path, step_file.filename)
        except StepProcessException as error:
            raise HTTPException(status_code=500, detail=str(error)) from error

    return msgpack_response(payload_bytes, "assembly_result.msgpack", "done")

"""
Service 모드 API 엔드포인트. HTTP 와 서비스 계층 사이의 통역만 맡는다.

    요청에서 값 꺼내기 → 서비스 호출 → 서비스 예외를 HTTP 상태 코드로 → 응답 만들기

실제 처리는 services/ 에 있다. Debug 모드는 이 API 를 쓰지 않는다(브라우저가
output/*.msgpack 을 직접 읽는다).

조립 계산은 수 분이 걸려 작업 방식으로 둔다. 시작하면 job_id 를 바로 돌려주고, 브라우저가
진행 단계를 조회하다가 끝나면 결과를 받아 간다.

    POST /api/assemble                  STEP 업로드 → 계산 시작 → {"job_id"}
    GET  /api/assemble/{job_id}         진행 단계 → {"stage", "error", "elapsed_seconds"}
    GET  /api/assemble/{job_id}/result  결과 msgpack (끝난 뒤 한 번)
"""

import time

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import Response

from server.app.api.http_utils import msgpack_response, save_step_upload
from server.app.services import job_service

router = APIRouter()


@router.get("/health")
def get_health() -> dict[str, str]:
    return {"status": "ok"}


@router.post("/assemble", status_code=202)
def start_assembly(step_file: UploadFile = File(...)) -> dict[str, str]:
    """STEP 파일을 받아 조립 계산을 백그라운드에서 시작한다. 진행 중이던 계산은 멈추고 새로 시작한다."""
    job = job_service.create_job(step_file.filename or "upload.step")

    try:
        step_path = save_step_upload(step_file, job.directory)
    except HTTPException:
        job_service.discard_job(job.job_id)
        raise

    job_service.start_job(job, step_path)
    return {"job_id": job.job_id}


@router.get("/assemble/{job_id}")
def get_assembly_status(job_id: str) -> dict[str, object]:
    """진행 단계: queued · mesh · assembly · done · failed."""
    job = job_service.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"unknown assembly job {job_id!r}")
    return {
        "stage": job.stage,
        "error": job.error,
        "elapsed_seconds": round(time.monotonic() - job.started_at, 1),
    }


@router.get("/assemble/{job_id}/result")
def get_assembly_result(job_id: str) -> Response:
    """끝난 작업의 결과 msgpack. 가져가면 서버에서 지운다."""
    job = job_service.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"unknown assembly job {job_id!r}")
    payload_bytes = job_service.take_result(job_id)
    if payload_bytes is None:
        raise HTTPException(status_code=409, detail=f"assembly job is not finished (stage: {job.stage})")
    return msgpack_response(payload_bytes, "assembly_result.msgpack")

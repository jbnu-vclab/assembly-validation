"""엔드포인트들이 같이 쓰는 HTTP 도구. 업로드 파일 저장과 msgpack 응답 만들기."""

import shutil
from pathlib import Path

from fastapi import HTTPException, UploadFile
from fastapi.responses import Response

from server.app.config import ALLOWED_STEP_SUFFIXES


def save_step_upload(step_file: UploadFile, directory: Path) -> Path:
    """
    업로드된 STEP 파일을 directory 에 저장하고 그 경로를 돌려준다.

    잘못된 업로드(이름 없음 · 확장자 오류 · 빈 파일)는 400, 저장 실패는 500 으로 거절한다.
    """
    if step_file.filename is None or step_file.filename == "":
        raise HTTPException(status_code=400, detail="uploaded STEP file name is missing")

    suffix = Path(step_file.filename).suffix.lower()
    if suffix not in ALLOWED_STEP_SUFFIXES:
        raise HTTPException(
            status_code=400,
            detail=f"uploaded file must be a STEP file (.step/.stp), received {step_file.filename!r}",
        )

    step_path = directory / Path(step_file.filename).name
    try:
        with step_path.open("wb") as step_output:
            shutil.copyfileobj(step_file.file, step_output)
    except OSError as error:
        raise HTTPException(
            status_code=500,
            detail=f"failed to store uploaded STEP file: {error}",
        ) from error

    if step_path.stat().st_size == 0:
        raise HTTPException(status_code=400, detail="uploaded STEP file is empty")
    return step_path


def msgpack_response(payload_bytes: bytes, filename: str) -> Response:
    """msgpack 바이트를 파일 응답으로."""
    return Response(
        content=payload_bytes,
        media_type="application/msgpack",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )

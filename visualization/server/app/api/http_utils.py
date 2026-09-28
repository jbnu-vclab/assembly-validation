"""엔드포인트들이 같이 쓰는 HTTP 도구. 업로드 파일 저장과 msgpack 응답 만들기."""

import shutil
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from fastapi import HTTPException, UploadFile
from fastapi.responses import Response

from server.app.config import ALLOWED_STEP_SUFFIXES


@contextmanager
def stored_step_upload(step_file: UploadFile) -> Iterator[Path]:
    """
    업로드된 STEP 파일을 임시 폴더에 저장하고 그 경로를 빌려준다. with 블록이 끝나면 지운다.

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

    with tempfile.TemporaryDirectory(prefix="assembly-step-") as working_directory:
        step_path = Path(working_directory) / Path(step_file.filename).name
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

        yield step_path


def msgpack_response(payload_bytes: bytes, filename: str, path_planning_status: str) -> Response:
    """msgpack 바이트를 응답으로. X-Pipeline-* 헤더에 단계별 상태를 담는다."""
    return Response(
        content=payload_bytes,
        media_type="application/msgpack",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Pipeline-Parse": "step-loader",
            "X-Pipeline-Path-Planning": path_planning_status,
            "X-Pipeline-Collision": path_planning_status,
        },
    )

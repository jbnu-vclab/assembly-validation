"""STEP 업로드를 파싱해 mesh msgpack을 반환하는 API."""

import tempfile
from pathlib import Path

import msgpack
import numpy as np
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from trimesh import Trimesh

from data.loader import STEPLoader

router = APIRouter()

_ALLOWED_STEP_SUFFIXES = {".step", ".stp"}
_FACE_TOLERANCE = 0.1
_ANGLE_TOLERANCE = 0.1
_MAX_WORKERS = 4


class StepProcessException(Exception):
    """STEP 처리 파이프라인이 실패했을 때 발생."""


def _check_is_step_filename(filename: str) -> None:
    suffix = Path(filename).suffix.lower()
    if suffix not in _ALLOWED_STEP_SUFFIXES:
        raise StepProcessException(
            f"uploaded file must be a STEP file (.step/.stp), received {filename!r}"
        )


def _get_mesh_global_bbox(meshes: list[Trimesh]) -> list[float]:
    minimum_corner = np.min([mesh.bounds[0] for mesh in meshes], axis=0)
    maximum_corner = np.max([mesh.bounds[1] for mesh in meshes], axis=0)
    return [
        float(minimum_corner[0]),
        float(minimum_corner[1]),
        float(minimum_corner[2]),
        float(maximum_corner[0]),
        float(maximum_corner[1]),
        float(maximum_corner[2]),
    ]


def _serialize_mesh_entry(mesh: Trimesh, part_index: int) -> dict[str, object]:
    return {
        "mesh": {
            "vertices": mesh.vertices.tolist(),
            "faces": mesh.faces.tolist(),
        },
        "state": {
            "position": [0.0, 0.0, 0.0],
            "rotation": [0.0, 0.0, 0.0],
        },
        "part_index": part_index,
    }


def _load_step_file(step_path: Path, step_display_path: str) -> bytes:
    """
    STEP → mesh msgpack 파싱 경로.

    - STEPLoader 로 solids 메시 추출
    - trajectories 는 비워 두고, 조립 계산 단계에서 채울 예정
    """
    try:
        step_loader = STEPLoader(
            filename=str(step_path),
            face_tolerance=_FACE_TOLERANCE,
            angle_tolerance=_ANGLE_TOLERANCE,
            max_workers=_MAX_WORKERS,
        )
        meshes = step_loader.load_all()
    except Exception as error:
        raise StepProcessException(
            f"failed to load STEP file at {step_display_path!r}: {error}"
        ) from error

    if len(meshes) == 0:
        raise StepProcessException(
            f"no solids found in step file {step_display_path!r}"
        )

    payload = {
        "metadata": {
            "step_path": step_display_path,
            "global_bbox": _get_mesh_global_bbox(meshes),
        },
        "solids": [
            _serialize_mesh_entry(mesh, part_index)
            for part_index, mesh in enumerate(meshes)
        ],
        "trajectories": [],
    }
    return msgpack.packb(payload, use_bin_type=True)


async def _store_uploaded_step_file(step_file: UploadFile) -> tuple[Path, tempfile.TemporaryDirectory]:
    if step_file.filename is None or step_file.filename == "":
        raise HTTPException(status_code=400, detail="uploaded STEP file name is missing")

    try:
        _check_is_step_filename(step_file.filename)
    except StepProcessException as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

    step_bytes = await step_file.read()
    if len(step_bytes) == 0:
        raise HTTPException(status_code=400, detail="uploaded STEP file is empty")

    temporary_directory = tempfile.TemporaryDirectory(prefix="assembly-step-")
    try:
        step_path = Path(temporary_directory.name) / Path(step_file.filename).name
        step_path.write_bytes(step_bytes)
    except OSError as error:
        temporary_directory.cleanup()
        raise HTTPException(
            status_code=500,
            detail=f"failed to store uploaded STEP file: {error}",
        ) from error

    return step_path, temporary_directory


@router.get("/health")
def get_health() -> dict[str, str]:
    return {"status": "ok"}


@router.post("/load-step")
async def load_step(step_file: UploadFile = File(...)) -> Response:
    """
    STEP 파일을 받아 mesh로 파싱한 msgpack을 반환한다.

    - 경로 계산 / 충돌: 미구현 (trajectories 빈 배열)
    """
    step_path, temporary_directory = await _store_uploaded_step_file(step_file)
    try:
        payload_bytes = _load_step_file(step_path, step_file.filename)
    except StepProcessException as error:
        raise HTTPException(status_code=500, detail=str(error)) from error
    finally:
        temporary_directory.cleanup()

    return Response(
        content=payload_bytes,
        media_type="application/msgpack",
        headers={
            "Content-Disposition": 'attachment; filename="loaded_step.msgpack"',
            "X-Pipeline-Parse": "step-loader",
            "X-Pipeline-Path-Planning": "pending",
            "X-Pipeline-Collision": "pending",
        },
    )


# =============================================================================
# [임시] 아래 구간은 조립 계산 더미 경로다.
# 원래는 core/planner · core/collision · data/exporter 로 조립 결과를 생성해야 한다.
# 해당 모듈 구현이 끝나면 import / _assemble_with_dummy_output /
# create_demo_exporter 호출 / /assemble 더미 본문을 삭제하고 실제 조립 API로 교체한다.
# =============================================================================
from data.dummy_data_exporter import (  # noqa: E402
    DummyExportException,
    create_demo_exporter,
)


def _assemble_with_dummy_output(step_filename: str) -> bytes:
    """
    [임시][삭제 예정] STEP 파일명에 대응하는 output/*.msgpack 더미 조립 결과를 반환한다.

    예: Cleaner.STEP → output/cleaner.msgpack
    실제 조립 함수(core + data/exporter)가 준비되면 이 함수 전체를 삭제한다.
    """
    exporter = create_demo_exporter(step_filename)
    try:
        return exporter.export_to_bytes()
    except DummyExportException as error:
        raise StepProcessException(str(error)) from error


@router.post("/assemble")
async def assemble(step_filename: str = Form(...)) -> Response:
    """
    조립 계산 요청을 받아 조립 결과 msgpack을 반환한다.

    [임시] 현재는 output/{step}.msgpack 더미를 반환한다.
    planner / collision / exporter 구현 후 더미 호출부를 삭제한다.
    """
    if step_filename.strip() == "":
        raise HTTPException(status_code=400, detail="step_filename is missing")

    try:
        _check_is_step_filename(step_filename)
    except StepProcessException as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

    try:
        # [임시][삭제 예정] 실제 조립 파이프라인으로 교체할 위치
        payload_bytes = _assemble_with_dummy_output(step_filename)
    except StepProcessException as error:
        raise HTTPException(status_code=500, detail=str(error)) from error

    return Response(
        content=payload_bytes,
        media_type="application/msgpack",
        headers={
            "Content-Disposition": 'attachment; filename="assembly_result.msgpack"',
            # [임시][삭제 예정] 더미 헤더. 실제 조립 연결 시 갱신/삭제
            "X-Pipeline-Parse": "step-loader",
            "X-Pipeline-Path-Planning": "dummy-output",
            "X-Pipeline-Collision": "pending",
        },
    )
# =============================================================================
# [임시] 더미 조립 경로 끝
# =============================================================================

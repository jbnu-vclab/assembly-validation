"""STEP 파일 → 메시 미리보기 msgpack. 경로(trajectories)는 비워 두고 조립 계산에서 채운다."""

from pathlib import Path

import msgpack
import numpy as np
from trimesh import Trimesh

from data.loader import STEPLoader
from server.app.config import (
    PREVIEW_ANGLE_TOLERANCE,
    PREVIEW_FACE_TOLERANCE,
    PREVIEW_MAX_WORKERS,
)
from server.app.services.errors import StepProcessException


def load_step_preview(step_path: Path, display_name: str) -> bytes:
    """
    STEP 파일을 메시로 변환해 미리보기 msgpack 을 만든다.

    Args:
        step_path: 서버에 저장된 STEP 파일 경로.
        display_name: 사용자가 올린 파일 이름. 메타데이터와 오류 메시지에 쓴다.

    Returns:
        {metadata, solids, trajectories: []} 를 담은 msgpack 바이트.
    """
    try:
        step_loader = STEPLoader(
            filename=str(step_path),
            face_tolerance=PREVIEW_FACE_TOLERANCE,
            angle_tolerance=PREVIEW_ANGLE_TOLERANCE,
            max_workers=PREVIEW_MAX_WORKERS,
        )
        meshes = step_loader.load_all()
    except Exception as error:
        raise StepProcessException(
            f"failed to load STEP file at {display_name!r}: {error}"
        ) from error

    if len(meshes) == 0:
        raise StepProcessException(f"no solids found in step file {display_name!r}")

    payload = {
        "metadata": {
            "step_path": display_name,
            "global_bbox": _get_mesh_global_bbox(meshes),
        },
        "solids": [
            _serialize_mesh_entry(mesh, part_index)
            for part_index, mesh in enumerate(meshes)
        ],
        "trajectories": [],
    }
    return msgpack.packb(payload, use_bin_type=True)


def _get_mesh_global_bbox(meshes: list[Trimesh]) -> list[float]:
    """모든 부품을 감싸는 상자 [xmin, ymin, zmin, xmax, ymax, zmax]. 카메라 맞춤에 쓴다."""
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
    """메시 하나를 msgpack 으로 보낼 수 있는 dict 로. 자세는 조립 상태(전부 0)다."""
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

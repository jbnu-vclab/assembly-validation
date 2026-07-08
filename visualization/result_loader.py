"""msgpack 조립 결과 파일을 읽는 모듈."""

from dataclasses import dataclass

import msgpack
import numpy as np
from trimesh import Trimesh

from core.action import Action, ActionType
from core.state import State


@dataclass(frozen=True)
class AssemblyMetadata:
    """조립 결과 파일의 메타데이터."""

    step_path: str
    global_bbox: tuple[float, float, float, float, float, float]


@dataclass(frozen=True)
class SolidData:
    """하나의 solid mesh와 해당 상태."""

    mesh: Trimesh
    state: State


@dataclass(frozen=True)
class TrajectoryFrame:
    """trajectory의 한 프레임."""

    solid_index: int
    state: State
    action: Action


class ResultLoadException(Exception):
    """조립 결과 파일을 읽지 못했을 때 발생."""


class _ResultFormatException(Exception):
    """msgpack 조립 결과 포맷이 규약을 벗어날 때 발생."""


class MsgpackResultLoader:
    """msgpack 조립 결과 파일을 AssemblyMetadata, SolidData, TrajectoryFrame으로 역직렬화한다."""

    def load(
        self,
        input_path: str,
    ) -> tuple[AssemblyMetadata, list[SolidData], list[TrajectoryFrame]]:
        try:
            with open(input_path, "rb") as input_file:
                payload_bytes = input_file.read()
        except OSError as error:
            raise ResultLoadException(
                f"failed to read result file at {input_path!r}"
            ) from error

        try:
            return _deserialize_from_bytes(payload_bytes)
        except _ResultFormatException as error:
            raise ResultLoadException(
                f"result file at {input_path!r} does not match the expected format"
            ) from error
        except KeyError as error:
            raise ResultLoadException(
                f"result file at {input_path!r} is missing required field {error!s}"
            ) from error


def _deserialize_from_bytes(
    payload_bytes: bytes,
) -> tuple[AssemblyMetadata, list[SolidData], list[TrajectoryFrame]]:
    try:
        payload = msgpack.unpackb(payload_bytes, raw=False)
    except msgpack.UnpackException as error:
        raise _ResultFormatException("payload is not valid msgpack data") from error

    if not isinstance(payload, dict):
        raise _ResultFormatException(f"payload root must be a dict, received {type(payload)}")

    return (
        _deserialize_metadata(payload["metadata"]),
        _deserialize_solids(payload["solids"]),
        _deserialize_trajectory_frames(payload["trajectories"]),
    )


def _deserialize_metadata(metadata_entry: object) -> AssemblyMetadata:
    if not isinstance(metadata_entry, dict):
        raise _ResultFormatException(
            f"metadata must be a dict, received {type(metadata_entry)}"
        )

    step_path = metadata_entry["step_path"]
    global_bbox = metadata_entry["global_bbox"]
    if not isinstance(step_path, str):
        raise _ResultFormatException(f"step_path must be a string, received {type(step_path)}")
    if not isinstance(global_bbox, list) or len(global_bbox) != 6:
        raise _ResultFormatException(
            f"global_bbox must contain exactly 6 values, received {global_bbox!r}"
        )

    try:
        normalized_global_bbox = tuple(float(value) for value in global_bbox)
    except (TypeError, ValueError) as error:
        raise _ResultFormatException(
            f"global_bbox must contain numeric values, received {global_bbox!r}"
        ) from error

    return AssemblyMetadata(step_path=step_path, global_bbox=normalized_global_bbox)


def _deserialize_solids(solids_entry: object) -> list[SolidData]:
    if not isinstance(solids_entry, list):
        raise _ResultFormatException(f"solids must be a list, received {type(solids_entry)}")

    return [_deserialize_solid(solid_entry) for solid_entry in solids_entry]


def _deserialize_solid(solid_entry: object) -> SolidData:
    if not isinstance(solid_entry, dict):
        raise _ResultFormatException(f"solid entry must be a dict, received {type(solid_entry)}")

    mesh_entry = solid_entry["mesh"]
    state_entry = solid_entry["state"]
    if not isinstance(mesh_entry, dict):
        raise _ResultFormatException(f"mesh must be a dict, received {type(mesh_entry)}")

    vertices = mesh_entry["vertices"]
    faces = mesh_entry["faces"]
    if not isinstance(vertices, list) or not isinstance(faces, list):
        raise _ResultFormatException("mesh vertices and faces must be lists")

    return SolidData(
        mesh=Trimesh(
            vertices=np.array(vertices, dtype=float),
            faces=np.array(faces, dtype=int),
        ),
        state=_deserialize_state(state_entry),
    )


def _deserialize_trajectory_frames(trajectory_frames_entry: object) -> list[TrajectoryFrame]:
    if not isinstance(trajectory_frames_entry, list):
        raise _ResultFormatException(
            f"trajectories must be a list, received {type(trajectory_frames_entry)}"
        )

    return [
        _deserialize_trajectory_frame(trajectory_frame_entry)
        for trajectory_frame_entry in trajectory_frames_entry
    ]


def _deserialize_trajectory_frame(trajectory_frame_entry: object) -> TrajectoryFrame:
    if not isinstance(trajectory_frame_entry, dict):
        raise _ResultFormatException(
            f"trajectory frame must be a dict, received {type(trajectory_frame_entry)}"
        )

    solid_index = trajectory_frame_entry["solid"]
    if not isinstance(solid_index, int):
        raise _ResultFormatException(
            f"trajectory solid index must be an int, received {type(solid_index)}"
        )

    return TrajectoryFrame(
        solid_index=solid_index,
        state=_deserialize_state(trajectory_frame_entry["state"]),
        action=_deserialize_action(trajectory_frame_entry["action"]),
    )


def _deserialize_state(state_entry: object) -> State:
    if not isinstance(state_entry, dict):
        raise _ResultFormatException(f"state must be a dict, received {type(state_entry)}")

    position = state_entry["position"]
    rotation = state_entry["rotation"]
    if not isinstance(position, list) or len(position) != 3:
        raise _ResultFormatException(
            f"state position must contain 3 values, received {position!r}"
        )
    if not isinstance(rotation, list) or len(rotation) != 3:
        raise _ResultFormatException(
            f"state rotation must contain 3 values, received {rotation!r}"
        )

    return State(position=tuple(position), rotation=tuple(rotation))


def _deserialize_action(action_entry: object) -> Action:
    if not isinstance(action_entry, dict):
        raise _ResultFormatException(f"action must be a dict, received {type(action_entry)}")

    action_type_value = action_entry["type"]
    action_value = action_entry["value"]
    if action_type_value not in {action_type.value for action_type in ActionType}:
        raise _ResultFormatException(
            f"action type must be one of translation or rotation, received {action_type_value!r}"
        )
    if not isinstance(action_value, list) or len(action_value) != 3:
        raise _ResultFormatException(
            f"action value must contain 3 values, received {action_value!r}"
        )

    action_type = ActionType(action_type_value)
    if action_type is ActionType.TRANSLATION:
        return Action(action_type=action_type, value=tuple(action_value))
    return Action(action_type=action_type, value=tuple(int(component) for component in action_value))

"""웹 시각화 개발용 임시 조립 결과 msgpack을 제공하는 모듈.

[임시] core/planner · core/collision · data/exporter 구현 전까지
output/{step_stem}.msgpack 을 읽어 프론트엔드 스키마로 정규화한다.
예: Cleaner.STEP → output/cleaner.msgpack
실제 조립 파이프라인이 연결되면 이 모듈 전체를 삭제한다.
"""

from pathlib import Path

import msgpack

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_OUTPUT_DIRECTORY = _PROJECT_ROOT / "output"


class DummyExportException(Exception):
    """임시 msgpack 결과 파일을 생성하지 못했을 때 발생."""


class DummyDataExporter:
    """사전 생성된 조립 시퀀스 msgpack을 프론트 포맷으로 변환해 직렬화한다."""

    def __init__(self, sequence_path: str, step_path: str) -> None:
        self._sequence_path = sequence_path
        self._step_path = step_path

    def export(self, output_path: str) -> None:
        payload_bytes = self.export_to_bytes()

        output_file = Path(output_path)
        try:
            output_file.parent.mkdir(parents=True, exist_ok=True)
            output_file.write_bytes(payload_bytes)
        except OSError as error:
            raise DummyExportException(
                f"failed to write dummy result file at {output_path!r}"
            ) from error

    def export_to_bytes(self) -> bytes:
        payload = self._build_payload_from_sequence()
        return msgpack.packb(payload, use_bin_type=True)

    def _build_payload_from_sequence(self) -> dict[str, object]:
        raw_payload = _load_sequence_payload(self._sequence_path)
        solid_entries_with_keys = _get_indexed_entries_with_keys(
            raw_payload.get("solids"),
            "solids",
        )
        trajectory_entries_with_keys = _get_indexed_entries_with_keys(
            raw_payload.get("trajectories"),
            "trajectories",
        )
        trajectories = [entry for _, entry in trajectory_entries_with_keys]
        trajectories = _merge_colinear_trajectory_frames(trajectories)
        metadata_entry = raw_payload.get("metadata")
        if not isinstance(metadata_entry, dict):
            raise DummyExportException("sequence metadata must be an object")

        global_bbox = _get_flat_global_bbox(metadata_entry.get("global_bbox"))
        solids = _get_solids_with_derived_initial_states(
            solid_entries_with_keys,
            trajectories,
        )
        global_bbox = _expand_bbox_with_solid_states(global_bbox, solids)
        part_index_to_dense_index = {
            solid_entry["part_index"]: dense_index
            for dense_index, solid_entry in enumerate(solids)
            if isinstance(solid_entry.get("part_index"), int)
        }
        remapped_trajectories = _remap_trajectory_solid_indexes(
            trajectories,
            part_index_to_dense_index,
        )

        return {
            "metadata": {
                "step_path": self._step_path,
                "global_bbox": global_bbox,
            },
            "solids": solids,
            "trajectories": remapped_trajectories,
        }


def get_dummy_sequence_path(step_path: str) -> Path:
    """
    STEP 파일명에서 output/ 더미 시퀀스 경로를 결정한다.

    Cleaner.STEP → output/cleaner.msgpack
    Hair Dryer.STEP → output/hair_dryer.msgpack
    """
    step_stem = Path(step_path).stem.strip()
    if step_stem == "":
        raise DummyExportException(
            f"cannot derive dummy sequence name from step path {step_path!r}"
        )

    normalized_stem = "_".join(step_stem.lower().split())
    sequence_path = _OUTPUT_DIRECTORY / f"{normalized_stem}.msgpack"
    if not sequence_path.is_file():
        raise DummyExportException(
            f"dummy assembly sequence does not exist at {sequence_path!s} "
            f"for step {step_path!r}"
        )
    return sequence_path


def _load_sequence_payload(sequence_path: str) -> dict[object, object]:
    sequence_file = Path(sequence_path)
    if not sequence_file.is_file():
        raise DummyExportException(
            f"assembly sequence file does not exist at {sequence_path!r}"
        )

    try:
        sequence_bytes = sequence_file.read_bytes()
    except OSError as error:
        raise DummyExportException(
            f"failed to read assembly sequence file at {sequence_path!r}"
        ) from error

    try:
        payload = msgpack.unpackb(sequence_bytes, raw=False, strict_map_key=False)
    except Exception as error:
        raise DummyExportException(
            f"failed to decode assembly sequence msgpack at {sequence_path!r}"
        ) from error

    if not isinstance(payload, dict):
        raise DummyExportException(
            f"assembly sequence root must be an object, received {type(payload).__name__}"
        )
    return payload


def _get_indexed_entries_with_keys(
    indexed_entries: object,
    field_name: str,
) -> list[tuple[int, object]]:
    """list 또는 int-key map을 (part_index, entry) 목록으로 변환한다. 키를 보존한다."""
    if isinstance(indexed_entries, list):
        return [(index, entry) for index, entry in enumerate(indexed_entries)]

    if not isinstance(indexed_entries, dict):
        raise DummyExportException(
            f"{field_name} must be a list or int-keyed object, "
            f"received {type(indexed_entries).__name__}"
        )

    if len(indexed_entries) == 0:
        return []

    try:
        sorted_keys = sorted(indexed_entries.keys(), key=int)
    except (TypeError, ValueError) as error:
        raise DummyExportException(
            f"{field_name} keys must be integers"
        ) from error

    indexed_entries_with_keys: list[tuple[int, object]] = []
    for key in sorted_keys:
        part_index = int(key)
        if part_index < 0:
            raise DummyExportException(
                f"{field_name} keys must be non-negative integers, received {key!r}"
            )
        indexed_entries_with_keys.append((part_index, indexed_entries[key]))
    return indexed_entries_with_keys


def _get_action_direction_key(action_entry: object, field_name: str) -> str:
    if not isinstance(action_entry, dict):
        raise DummyExportException(f"{field_name} must be an object")

    action_type = action_entry.get("type")
    action_value = action_entry.get("value")
    if action_type not in {"translation", "rotation"}:
        raise DummyExportException(
            f"{field_name}.type must be translation or rotation, received {action_type!r}"
        )
    if not isinstance(action_value, list) or len(action_value) != 3:
        raise DummyExportException(f"{field_name}.value must contain 3 values")

    numeric_value = [float(component) for component in action_value]
    magnitude = (
        numeric_value[0] ** 2 + numeric_value[1] ** 2 + numeric_value[2] ** 2
    ) ** 0.5
    if magnitude < 1e-9:
        return f"{action_type}:0,0,0"

    direction_components = [
        round(component / magnitude, 6) for component in numeric_value
    ]
    return (
        f"{action_type}:{direction_components[0]},"
        f"{direction_components[1]},{direction_components[2]}"
    )


def _merge_colinear_trajectory_frames(trajectories: list[object]) -> list[object]:
    """
    같은 solid + 같은 방향의 연속 trajectory를 한 프레임으로 합친다.
    예: 오른쪽×3 + 뒷쪽×2 → 오른쪽 1프레임 + 뒷쪽 1프레임.
    """
    if len(trajectories) == 0:
        return []

    merged_trajectories: list[object] = []
    run_start_index = 0

    for frame_index in range(1, len(trajectories) + 1):
        run_start_frame = trajectories[run_start_index]
        if not isinstance(run_start_frame, dict):
            raise DummyExportException(
                f"trajectories[{run_start_index}] must be an object"
            )

        can_extend_run = False
        if frame_index < len(trajectories):
            next_frame = trajectories[frame_index]
            if not isinstance(next_frame, dict):
                raise DummyExportException(
                    f"trajectories[{frame_index}] must be an object"
                )
            can_extend_run = (
                next_frame.get("solid") == run_start_frame.get("solid")
                and _get_action_direction_key(
                    next_frame.get("action"),
                    f"trajectories[{frame_index}].action",
                )
                == _get_action_direction_key(
                    run_start_frame.get("action"),
                    f"trajectories[{run_start_index}].action",
                )
            )

        if can_extend_run:
            continue

        run_frames = trajectories[run_start_index:frame_index]
        last_frame = run_frames[-1]
        if not isinstance(last_frame, dict):
            raise DummyExportException(
                f"trajectories[{frame_index - 1}] must be an object"
            )

        merged_action_value = [0.0, 0.0, 0.0]
        for run_frame in run_frames:
            if not isinstance(run_frame, dict):
                raise DummyExportException("trajectory frame must be an object")
            action_entry = run_frame.get("action")
            if not isinstance(action_entry, dict):
                raise DummyExportException("trajectory action must be an object")
            action_value = action_entry.get("value")
            if not isinstance(action_value, list) or len(action_value) != 3:
                raise DummyExportException("trajectory action.value must contain 3 values")
            for axis_index in range(3):
                merged_action_value[axis_index] += float(action_value[axis_index])

        end_state = _get_validated_state(
            last_frame.get("state"),
            f"trajectories[{frame_index - 1}].state",
        )
        run_start_action = run_start_frame.get("action")
        if not isinstance(run_start_action, dict):
            raise DummyExportException(
                f"trajectories[{run_start_index}].action must be an object"
            )

        merged_trajectories.append(
            {
                "solid": run_start_frame.get("solid"),
                "state": end_state,
                "action": {
                    "type": run_start_action.get("type"),
                    "value": merged_action_value,
                },
            }
        )
        run_start_index = frame_index

    return merged_trajectories


def _remap_trajectory_solid_indexes(
    trajectories: list[object],
    part_index_to_dense_index: dict[int, int],
) -> list[object]:
    remapped_trajectories: list[object] = []
    for frame_index, trajectory_frame in enumerate(trajectories):
        if not isinstance(trajectory_frame, dict):
            raise DummyExportException(
                f"trajectories[{frame_index}] must be an object"
            )
        part_index = trajectory_frame.get("solid")
        if not isinstance(part_index, int):
            raise DummyExportException(
                f"trajectories[{frame_index}].solid must be an integer"
            )
        if part_index not in part_index_to_dense_index:
            raise DummyExportException(
                f"trajectories[{frame_index}].solid={part_index} is missing from solids"
            )
        remapped_frame = dict(trajectory_frame)
        remapped_frame["solid"] = part_index_to_dense_index[part_index]
        remapped_trajectories.append(remapped_frame)
    return remapped_trajectories


def _get_solids_with_derived_initial_states(
    solid_entries_with_keys: list[tuple[int, object]],
    trajectories: list[object],
) -> list[dict[str, object]]:
    """
    시퀀스 파일의 solids.state 는 조립 완료 자세(원점)인 경우가 많다.
    프론트는 solids.state → trajectories[].state 로 보간하므로,
    각 solid의 첫 trajectory action 을 역산해 분해 시작 자세를 넣는다.
    part_index(파서/캐시 인덱스)를 각 solid에 보존한다.
    """
    first_trajectory_by_part_index: dict[int, dict[str, object]] = {}
    for trajectory_frame in trajectories:
        if not isinstance(trajectory_frame, dict):
            raise DummyExportException("trajectory frame must be an object")
        part_index = trajectory_frame.get("solid")
        if not isinstance(part_index, int):
            raise DummyExportException("trajectory solid must be an integer")
        if part_index not in first_trajectory_by_part_index:
            first_trajectory_by_part_index[part_index] = trajectory_frame

    normalized_solids: list[dict[str, object]] = []
    for part_index, solid_entry in solid_entries_with_keys:
        if not isinstance(solid_entry, dict):
            raise DummyExportException(f"solids[{part_index}] must be an object")

        mesh_entry = solid_entry.get("mesh")
        state_entry = solid_entry.get("state")
        if not isinstance(mesh_entry, dict) or not isinstance(state_entry, dict):
            raise DummyExportException(
                f"solids[{part_index}] must contain mesh and state objects"
            )

        initial_state = _get_validated_state(state_entry, f"solids[{part_index}].state")
        first_trajectory = first_trajectory_by_part_index.get(part_index)
        if first_trajectory is not None:
            initial_state = _get_state_before_action(
                end_state=_get_validated_state(
                    first_trajectory.get("state"),
                    f"trajectories[solid={part_index}].state",
                ),
                action_entry=first_trajectory.get("action"),
                field_name=f"trajectories[solid={part_index}].action",
            )

        normalized_solid: dict[str, object] = {
            "mesh": mesh_entry,
            "state": initial_state,
            "part_index": part_index,
        }
        solid_name = solid_entry.get("name")
        if isinstance(solid_name, str) and solid_name.strip() != "":
            normalized_solid["name"] = solid_name
        elif solid_name is not None:
            raise DummyExportException(
                f"solids[{part_index}].name must be a non-empty string"
            )
        solid_conversion = solid_entry.get("conversion")
        if isinstance(solid_conversion, str) and solid_conversion.strip() != "":
            normalized_solid["conversion"] = solid_conversion
        elif solid_conversion is not None:
            raise DummyExportException(
                f"solids[{part_index}].conversion must be a non-empty string"
            )
        normalized_solids.append(normalized_solid)

    return normalized_solids


def _get_flat_global_bbox(global_bbox_entry: object) -> list[float]:
    if isinstance(global_bbox_entry, list):
        if len(global_bbox_entry) != 6:
            raise DummyExportException(
                f"global_bbox list must contain exactly 6 values, "
                f"received length {len(global_bbox_entry)}"
            )
        return [float(value) for value in global_bbox_entry]

    if not isinstance(global_bbox_entry, dict):
        raise DummyExportException(
            f"global_bbox must be a list or {{min, max}} object, "
            f"received {type(global_bbox_entry).__name__}"
        )

    minimum_corner = global_bbox_entry.get("min")
    maximum_corner = global_bbox_entry.get("max")
    if not isinstance(minimum_corner, list) or not isinstance(maximum_corner, list):
        raise DummyExportException("global_bbox.min and global_bbox.max must be lists")
    if len(minimum_corner) != 3 or len(maximum_corner) != 3:
        raise DummyExportException(
            "global_bbox.min and global_bbox.max must each contain 3 values"
        )

    return [
        float(minimum_corner[0]),
        float(minimum_corner[1]),
        float(minimum_corner[2]),
        float(maximum_corner[0]),
        float(maximum_corner[1]),
        float(maximum_corner[2]),
    ]


def _get_validated_state(
    state_entry: object,
    field_name: str,
) -> dict[str, list[float]]:
    if not isinstance(state_entry, dict):
        raise DummyExportException(f"{field_name} must be an object")

    position = state_entry.get("position")
    rotation = state_entry.get("rotation")
    if not isinstance(position, list) or not isinstance(rotation, list):
        raise DummyExportException(
            f"{field_name}.position and {field_name}.rotation must be lists"
        )
    if len(position) != 3 or len(rotation) != 3:
        raise DummyExportException(
            f"{field_name}.position and {field_name}.rotation must each contain 3 values"
        )

    return {
        "position": [float(value) for value in position],
        "rotation": [float(value) for value in rotation],
    }


def _get_state_before_action(
    end_state: dict[str, list[float]],
    action_entry: object,
    field_name: str,
) -> dict[str, list[float]]:
    if not isinstance(action_entry, dict):
        raise DummyExportException(f"{field_name} must be an object")

    action_type = action_entry.get("type")
    action_value = action_entry.get("value")
    if action_type not in {"translation", "rotation"}:
        raise DummyExportException(
            f"{field_name}.type must be translation or rotation, received {action_type!r}"
        )
    if not isinstance(action_value, list) or len(action_value) != 3:
        raise DummyExportException(f"{field_name}.value must contain 3 values")

    delta = [float(value) for value in action_value]
    if action_type == "translation":
        return {
            "position": [
                end_state["position"][0] - delta[0],
                end_state["position"][1] - delta[1],
                end_state["position"][2] - delta[2],
            ],
            "rotation": list(end_state["rotation"]),
        }

    return {
        "position": list(end_state["position"]),
        "rotation": [
            end_state["rotation"][0] - delta[0],
            end_state["rotation"][1] - delta[1],
            end_state["rotation"][2] - delta[2],
        ],
    }


def _expand_bbox_with_solid_states(
    global_bbox: list[float],
    solids: list[dict[str, object]],
) -> list[float]:
    expanded_bbox = list(global_bbox)
    for solid_entry in solids:
        state_entry = solid_entry["state"]
        if not isinstance(state_entry, dict):
            continue
        position = state_entry.get("position")
        if not isinstance(position, list) or len(position) != 3:
            continue

        for axis_index in range(3):
            offset = float(position[axis_index])
            expanded_bbox[axis_index] = min(
                expanded_bbox[axis_index],
                global_bbox[axis_index] + offset,
            )
            expanded_bbox[axis_index + 3] = max(
                expanded_bbox[axis_index + 3],
                global_bbox[axis_index + 3] + offset,
            )

    return expanded_bbox


def create_demo_exporter(step_path: str) -> DummyDataExporter:
    """STEP 파일명에 대응하는 output/ 더미 시퀀스로 DummyDataExporter를 생성한다."""
    return DummyDataExporter(
        sequence_path=str(get_dummy_sequence_path(step_path)),
        step_path=step_path,
    )

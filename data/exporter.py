# 탐색 결과를 msgpack 파일로 저장하고 읽는다. 저장 구조는 README.md의 Output Structure와 같다.
from dataclasses import dataclass
from typing import Dict, List, Sequence, Tuple, Optional

import msgpack
import numpy as np
import trimesh

from core.action import Action
from core.interference import OverlapRegion
from core.state import State


# 저장할 데이터가 맞지 않을 때 발생시키는 예외
class TrajectorySerializationException(Exception):
    pass


# 궤적 한 스텝: (부품 번호, 동작 후 상태, 동작)
TrajectoryStep = Tuple[int, State, Action]


# 진단 자세: 상태와 그 자세에서의 겹침 영역들
@dataclass(frozen=True)
class DiagnosedPose:
    state: State
    overlap_regions: Tuple[OverlapRegion, ...]


# 분해하지 못한 부품의 진단 정보
@dataclass(frozen=True)
class SolidFailureDiagnosis:
    # 실패 이유 문장
    reason: str
    # 도달한 분리량과 필요한 분리량(목표 여유)
    separation: float
    required_separation: float
    # 진단 때 장애물로 둔 부품 번호들
    obstacle_solid_ids: Tuple[int, ...]
    # 가장 가까이 간 경로(저장용 궤적 스텝)
    closest_path_steps: Tuple[TrajectoryStep, ...]
    # 간섭 없는 마지막 자세(없으면 None)
    last_valid_pose: Optional[DiagnosedPose]
    # 더 밀었을 때 처음 막힌 자세와 겹침(없으면 None)
    first_blocked_pose: Optional[DiagnosedPose]


# 부품 메쉬, 조립 상태, 분해 궤적, 실패 진단을 사전 하나로 묶어 msgpack으로 직렬화한다.
class MsgpackTrajectorySerializer:
    # 입력을 검사·복사하고, 조립 상태의 전체 경계 상자를 미리 계산한다.
    def __init__(
        self,
        step_path: str,
        solid_meshes: Dict[int, trimesh.Trimesh],
        assembled_states: Dict[int, State],
        extra_metadata: Optional[Dict[str, object]] = None,
        solid_names: Optional[Dict[int, str]] = None,
        conversion_results: Optional[Dict[int, str]] = None,
        solid_failures: Optional[Dict[int, SolidFailureDiagnosis]] = None,
    ) -> None:
        if set(solid_meshes.keys()) != set(assembled_states.keys()):
            raise TrajectorySerializationException(
                "solid_meshes and assembled_states must share the same solid identifiers"
            )
        self.step_path = step_path
        self.extra_metadata = dict(extra_metadata) if extra_metadata else dict()
        self.solid_names = dict(solid_names) if solid_names else dict()
        self.conversion_results = (
            dict(conversion_results) if conversion_results else dict()
        )
        self.solid_failures = dict(solid_failures) if solid_failures else dict()
        unknown_failure_ids = sorted(set(self.solid_failures) - set(solid_meshes))
        if unknown_failure_ids:
            raise TrajectorySerializationException(
                f"solid_failures references unknown solids {unknown_failure_ids}"
            )
        self.solid_meshes = solid_meshes
        self.assembled_states = assembled_states
        self.global_bounding_box = self.compute_global_bounding_box(
            solid_meshes, assembled_states
        )

    # 모든 부품을 각 상태로 놓았을 때의 전체 경계 상자 {'min': [...], 'max': [...]}
    @staticmethod
    def compute_global_bounding_box(
        solid_meshes: Dict[int, trimesh.Trimesh],
        states: Dict[int, State],
    ) -> Dict[str, List[float]]:
        if not solid_meshes:
            raise TrajectorySerializationException(
                "solid_meshes must contain at least one solid to compute a bounding box"
            )
        lower_bounds: List[np.ndarray] = list()
        upper_bounds: List[np.ndarray] = list()
        for solid_id, mesh in solid_meshes.items():
            transformation_matrix = states[solid_id].to_transformation_matrix()
            local_vertices = np.asarray(mesh.vertices, dtype=float)
            homogeneous_vertices = np.hstack(
                [local_vertices, np.ones((len(local_vertices), 1))]
            )
            world_vertices = (transformation_matrix @ homogeneous_vertices.T).T[:, :3]
            lower_bounds.append(world_vertices.min(axis=0))
            upper_bounds.append(world_vertices.max(axis=0))
        global_lower = np.min(lower_bounds, axis=0)
        global_upper = np.max(upper_bounds, axis=0)
        return {
            "min": [float(value) for value in global_lower],
            "max": [float(value) for value in global_upper],
        }

    # State → {'position': [...], 'rotation': [...]}
    @staticmethod
    def _to_state_dictionary(state: State) -> Dict[str, List]:
        return {
            "position": [float(coordinate) for coordinate in state.position],
            "rotation": [int(angle) for angle in state.rotation],
        }

    # Action → {'type': 'translation' 또는 'rotation', 'value': [...]}
    @staticmethod
    def _to_action_dictionary(action: Action) -> Dict[str, object]:
        if action.is_translation():
            value = [float(component) for component in action.value]
        else:
            value = [int(component) for component in action.value]
        return {"type": action.action_type.value, "value": value}

    # 메쉬 → {'vertices': [[x, y, z], ...], 'faces': [[a, b, c], ...]}
    @staticmethod
    def _to_mesh_dictionary(mesh: trimesh.Trimesh) -> Dict[str, List]:
        return {
            "vertices": np.asarray(mesh.vertices, dtype=float).tolist(),
            "faces": np.asarray(mesh.faces, dtype=int).tolist(),
        }

    # 겹침 영역 → {'obstacle', 'is_over_limit', 'mesh'}
    def _to_overlap_dictionary(self, overlap_region: OverlapRegion) -> Dict[str, object]:
        return {
            "obstacle": int(overlap_region.obstacle_solid_id),
            "is_over_limit": bool(overlap_region.is_over_limit),
            "mesh": {
                "vertices": np.asarray(overlap_region.overlap_vertices, dtype=float).tolist(),
                "faces": np.asarray(overlap_region.overlap_faces, dtype=int).tolist(),
            },
        }

    # 진단 자세 → {'state'}. does_include_overlaps이면 'overlaps'도 넣는다.
    def _to_pose_dictionary(
        self, diagnosed_pose: DiagnosedPose, does_include_overlaps: bool
    ) -> Dict[str, object]:
        pose_dictionary: Dict[str, object] = {
            "state": self._to_state_dictionary(diagnosed_pose.state)
        }
        if does_include_overlaps:
            pose_dictionary["overlaps"] = {
                overlap_index: self._to_overlap_dictionary(overlap_region)
                for overlap_index, overlap_region in enumerate(diagnosed_pose.overlap_regions)
            }
        return pose_dictionary

    # 실패 진단 → {'closest_path', 'last_valid_pose', 'first_blocked_pose'}.
    # 마지막 유효 자세는 상태만, 처음 막힌 자세는 겹침까지 담는다.
    def _to_failure_dictionary(
        self, diagnosis: SolidFailureDiagnosis
    ) -> Dict[str, object]:
        entry: Dict[str, object] = dict()
        entry["closest_path"] = {
            step_index: {
                "solid": int(step_solid_id),
                "state": self._to_state_dictionary(state),
                "action": self._to_action_dictionary(action),
            }
            for step_index, (step_solid_id, state, action) in enumerate(
                diagnosis.closest_path_steps
            )
        }
        entry["last_valid_pose"] = (
            None
            if diagnosis.last_valid_pose is None
            else self._to_pose_dictionary(
                diagnosis.last_valid_pose, does_include_overlaps=False
            )
        )
        entry["first_blocked_pose"] = (
            None
            if diagnosis.first_blocked_pose is None
            else self._to_pose_dictionary(
                diagnosis.first_blocked_pose, does_include_overlaps=True
            )
        )
        return entry

    # 저장할 전체 사전 {'metadata', 'solids', 'trajectories', 'failures'}를 만든다.
    def to_output_dictionary(
        self, trajectory_steps: Sequence[TrajectoryStep]
    ) -> Dict[str, object]:
        # 부품마다 이름, 메쉬 변환 결과, 메쉬, 조립 상태
        solids_output: Dict[int, object] = dict()
        for solid_id, mesh in self.solid_meshes.items():
            entry: Dict[str, object] = dict()
            if solid_id in self.solid_names:
                entry["name"] = str(self.solid_names[solid_id])
            if solid_id in self.conversion_results:
                entry["conversion"] = str(self.conversion_results[solid_id])
            entry["mesh"] = self._to_mesh_dictionary(mesh)
            entry["state"] = self._to_state_dictionary(self.assembled_states[solid_id])
            solids_output[solid_id] = entry

        # 분해 궤적 스텝(번호 순서 = 분해 순서)
        trajectories_output: Dict[int, object] = dict()
        for step_index, (solid_id, state, action) in enumerate(trajectory_steps):
            if solid_id not in self.solid_meshes:
                raise TrajectorySerializationException(
                    f"trajectory step {step_index} references unknown solid {solid_id}"
                )
            trajectories_output[step_index] = {
                "solid": int(solid_id),
                "state": self._to_state_dictionary(state),
                "action": self._to_action_dictionary(action),
            }

        metadata_output = {
            "step_path": self.step_path,
            "global_bbox": self.global_bounding_box,
        }
        # 추가 metadata는 기본 키(step_path, global_bbox)를 덮어쓰지 않는다.
        for key, value in self.extra_metadata.items():
            if key not in metadata_output:
                metadata_output[key] = value

        # 분해하지 못한 부품의 진단
        failures_output: Dict[int, object] = {
            int(solid_id): self._to_failure_dictionary(diagnosis)
            for solid_id, diagnosis in self.solid_failures.items()
        }

        return {
            "metadata": metadata_output,
            "solids": solids_output,
            "trajectories": trajectories_output,
            "failures": failures_output,
        }

    # 전체 사전을 msgpack 바이트로 바꾼다.
    def serialize_to_binary(
        self, trajectory_steps: Sequence[TrajectoryStep]
    ) -> bytes:
        output_dictionary = self.to_output_dictionary(trajectory_steps)
        return msgpack.packb(output_dictionary, use_bin_type=True)

    # msgpack 바이트를 파일로 쓴다.
    def write_to_file(
        self, trajectory_steps: Sequence[TrajectoryStep], output_path: str
    ) -> None:
        binary_data = self.serialize_to_binary(trajectory_steps)
        with open(output_path, "wb") as output_file:
            output_file.write(binary_data)

    # msgpack 바이트를 사전으로 읽는다(정수 키 허용).
    @staticmethod
    def deserialize_from_binary(binary_data: bytes) -> Dict[str, object]:
        return msgpack.unpackb(binary_data, raw=False, strict_map_key=False)

    # msgpack 파일을 읽어 사전으로 돌려준다.
    @staticmethod
    def read_from_file(input_path: str) -> Dict[str, object]:
        with open(input_path, "rb") as input_file:
            binary_data = input_file.read()
        return MsgpackTrajectorySerializer.deserialize_from_binary(binary_data)

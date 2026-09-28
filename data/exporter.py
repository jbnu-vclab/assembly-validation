from dataclasses import dataclass
from typing import Dict, List, Sequence, Tuple, Optional

import msgpack
import numpy as np
import trimesh

from core.action import Action
from core.interference import OverlapRegion
from core.state import State


class TrajectorySerializationException(Exception):
    pass


TrajectoryStep = Tuple[int, State, Action]


@dataclass(frozen=True)
class DiagnosedPose:
    state: State
    overlap_regions: Tuple[OverlapRegion, ...]


@dataclass(frozen=True)
class SolidFailureDiagnosis:
    reason: str
    separation: float
    required_separation: float
    obstacle_solid_ids: Tuple[int, ...]
    closest_path_steps: Tuple[TrajectoryStep, ...]
    last_valid_pose: Optional[DiagnosedPose]
    first_blocked_pose: Optional[DiagnosedPose]


class MsgpackTrajectorySerializer:
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

    @staticmethod
    def _to_state_dictionary(state: State) -> Dict[str, List]:
        return {
            "position": [float(coordinate) for coordinate in state.position],
            "rotation": [int(angle) for angle in state.rotation],
        }

    @staticmethod
    def _to_action_dictionary(action: Action) -> Dict[str, object]:
        if action.is_translation():
            value = [float(component) for component in action.value]
        else:
            value = [int(component) for component in action.value]
        return {"type": action.action_type.value, "value": value}

    @staticmethod
    def _to_mesh_dictionary(mesh: trimesh.Trimesh) -> Dict[str, List]:
        return {
            "vertices": np.asarray(mesh.vertices, dtype=float).tolist(),
            "faces": np.asarray(mesh.faces, dtype=int).tolist(),
        }

    def _to_overlap_dictionary(self, overlap_region: OverlapRegion) -> Dict[str, object]:
        return {
            "obstacle": int(overlap_region.obstacle_solid_id),
            "is_over_limit": bool(overlap_region.is_over_limit),
            "mesh": {
                "vertices": np.asarray(overlap_region.overlap_vertices, dtype=float).tolist(),
                "faces": np.asarray(overlap_region.overlap_faces, dtype=int).tolist(),
            },
        }

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

    def to_output_dictionary(
        self, trajectory_steps: Sequence[TrajectoryStep]
    ) -> Dict[str, object]:
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
        for key, value in self.extra_metadata.items():
            if key not in metadata_output:
                metadata_output[key] = value

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

    def serialize_to_binary(
        self, trajectory_steps: Sequence[TrajectoryStep]
    ) -> bytes:
        output_dictionary = self.to_output_dictionary(trajectory_steps)
        return msgpack.packb(output_dictionary, use_bin_type=True)

    def write_to_file(
        self, trajectory_steps: Sequence[TrajectoryStep], output_path: str
    ) -> None:
        binary_data = self.serialize_to_binary(trajectory_steps)
        with open(output_path, "wb") as output_file:
            output_file.write(binary_data)

    @staticmethod
    def deserialize_from_binary(binary_data: bytes) -> Dict[str, object]:
        return msgpack.unpackb(binary_data, raw=False, strict_map_key=False)

    @staticmethod
    def read_from_file(input_path: str) -> Dict[str, object]:
        with open(input_path, "rb") as input_file:
            binary_data = input_file.read()
        return MsgpackTrajectorySerializer.deserialize_from_binary(binary_data)

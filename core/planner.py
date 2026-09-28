import itertools
from dataclasses import dataclass, replace
from typing import Dict, List, Optional, Tuple

import numpy as np
from scipy.spatial.transform import Rotation, Slerp

from core.action import Action, ActionType
from core.interference import InterferenceException, InterferenceSession
from core.state import State


class PlanningException(Exception):
    pass


_ROTATION_GRID_ANGLES = (0, 90, 180, 270)


def _to_grid_rotation_matrix(euler_angles: Tuple[int, int, int]) -> np.ndarray:
    rotation_matrix = np.rint(
        Rotation.from_euler("XYZ", euler_angles, degrees=True).as_matrix()
    )
    rotation_matrix[rotation_matrix == 0.0] = 0.0
    return rotation_matrix


def _to_matrix_key(rotation_matrix: np.ndarray) -> Tuple[int, ...]:
    return tuple(np.rint(rotation_matrix).astype(int).flatten())


def _build_canonical_rotation_lookup() -> Tuple[Dict[Tuple[int, ...], Tuple[int, int, int]], List[Tuple[int, int, int]]]:
    matrix_key_to_euler: Dict[Tuple[int, ...], Tuple[int, int, int]] = dict()
    canonical_eulers: List[Tuple[int, int, int]] = list()
    for euler_angles in itertools.product(_ROTATION_GRID_ANGLES, repeat=3):
        matrix_key = _to_matrix_key(_to_grid_rotation_matrix(euler_angles))
        if matrix_key not in matrix_key_to_euler:
            matrix_key_to_euler[matrix_key] = euler_angles
            canonical_eulers.append(euler_angles)
    return matrix_key_to_euler, canonical_eulers


_MATRIX_KEY_TO_EULER, _CANONICAL_ROTATION_EULERS = _build_canonical_rotation_lookup()

_EULER_TO_CANONICAL: Dict[Tuple[int, int, int], Tuple[int, int, int]] = {
    euler_angles: _MATRIX_KEY_TO_EULER[_to_matrix_key(_to_grid_rotation_matrix(euler_angles))]
    for euler_angles in itertools.product(_ROTATION_GRID_ANGLES, repeat=3)
}


def _to_canonical_rotation(rotation: Tuple[int, int, int]) -> Tuple[int, int, int]:
    rotation_key = tuple(int(component) % 360 for component in rotation)
    canonical = _EULER_TO_CANONICAL.get(rotation_key)
    if canonical is not None:
        return canonical
    return _MATRIX_KEY_TO_EULER[_to_matrix_key(_to_grid_rotation_matrix(rotation_key))]


def _to_canonical_rotation_euler(rotation_matrix: np.ndarray) -> Tuple[int, int, int]:
    matrix_key = _to_matrix_key(rotation_matrix)
    if matrix_key not in _MATRIX_KEY_TO_EULER:
        raise PlanningException(
            f"rotation matrix {matrix_key} is not a 90-degree grid orientation"
        )
    return _MATRIX_KEY_TO_EULER[matrix_key]


def get_axis_aligned_separation(
    moving_world_vertices: np.ndarray, obstacle_bounding_box: np.ndarray
) -> Tuple[int, int, float]:
    separations = get_axis_separations(moving_world_vertices, obstacle_bounding_box)
    flat_index = int(np.argmax(separations))
    axis_index, sign_column = divmod(flat_index, 2)
    return axis_index, _to_sign(sign_column), float(separations[axis_index, sign_column])


def get_axis_separations(
    moving_world_vertices: np.ndarray, obstacle_bounding_box: np.ndarray
) -> np.ndarray:
    moving_lower_bound = moving_world_vertices.min(axis=0)
    moving_upper_bound = moving_world_vertices.max(axis=0)
    return np.stack(
        [
            obstacle_bounding_box[0] - moving_upper_bound,
            moving_lower_bound - obstacle_bounding_box[1],
        ],
        axis=1,
    )


def _to_sign(sign_column: int) -> int:
    return -1 if sign_column == 0 else 1


def _to_sign_column(sign: int) -> int:
    return 0 if sign < 0 else 1


OPENNESS_COLUMN_COUNT = 16384

_PLANE_AXIS_INDICES = {0: (1, 2), 1: (0, 2), 2: (0, 1)}

_CANDIDATE_CHUNK_SIZE = 2_000_000

_EXTRACTION_BOUNDARY_MARGIN = 1e-6


def _to_column_crossings(
    triangles: np.ndarray,
    axis_index: int,
    grid_origin: Tuple[float, float],
    grid_spacing: float,
    grid_shape: Tuple[int, int],
) -> Tuple[np.ndarray, np.ndarray]:
    first_plane_axis, second_plane_axis = _PLANE_AXIS_INDICES[axis_index]
    first = triangles[:, :, first_plane_axis]
    second = triangles[:, :, second_plane_axis]
    depth = triangles[:, :, axis_index]

    first_lower = np.maximum(np.ceil((first.min(axis=1) - grid_origin[0]) / grid_spacing), 0)
    first_upper = np.minimum(
        np.floor((first.max(axis=1) - grid_origin[0]) / grid_spacing), grid_shape[0] - 1
    )
    second_lower = np.maximum(np.ceil((second.min(axis=1) - grid_origin[1]) / grid_spacing), 0)
    second_upper = np.minimum(
        np.floor((second.max(axis=1) - grid_origin[1]) / grid_spacing), grid_shape[1] - 1
    )
    first_counts = (first_upper - first_lower + 1).astype(np.int64)
    second_counts = (second_upper - second_lower + 1).astype(np.int64)

    edge_first_u = first[:, 1] - first[:, 0]
    edge_first_v = second[:, 1] - second[:, 0]
    edge_second_u = first[:, 2] - first[:, 0]
    edge_second_v = second[:, 2] - second[:, 0]
    determinant = edge_first_u * edge_second_v - edge_second_u * edge_first_v

    candidate_counts = np.where(
        (first_counts > 0) & (second_counts > 0) & (np.abs(determinant) > 1e-14),
        first_counts * second_counts,
        0,
    )
    triangle_indices = np.nonzero(candidate_counts)[0]
    if len(triangle_indices) == 0:
        return np.zeros(0, dtype=np.int64), np.zeros(0, dtype=float)

    column_blocks: List[np.ndarray] = list()
    depth_blocks: List[np.ndarray] = list()
    cumulative_counts = np.cumsum(candidate_counts[triangle_indices])
    chunk_start = 0
    while chunk_start < len(triangle_indices):
        consumed = cumulative_counts[chunk_start - 1] if chunk_start > 0 else 0
        chunk_stop = int(
            np.searchsorted(cumulative_counts, consumed + _CANDIDATE_CHUNK_SIZE, side="right")
        )
        chunk_stop = max(chunk_stop, chunk_start + 1)
        chunk = triangle_indices[chunk_start:chunk_stop]
        counts = candidate_counts[chunk]
        triangle = np.repeat(chunk, counts)
        offset = np.arange(int(counts.sum())) - np.repeat(np.cumsum(counts) - counts, counts)
        row_length = np.repeat(second_counts[chunk], counts)
        first_index = np.repeat(first_lower[chunk], counts).astype(np.int64) + offset // row_length
        second_index = np.repeat(second_lower[chunk], counts).astype(np.int64) + offset % row_length

        relative_u = grid_origin[0] + first_index * grid_spacing - first[triangle, 0]
        relative_v = grid_origin[1] + second_index * grid_spacing - second[triangle, 0]
        chunk_determinant = determinant[triangle]
        weight_first = (
            relative_u * edge_second_v[triangle] - edge_second_u[triangle] * relative_v
        ) / chunk_determinant
        weight_second = (
            edge_first_u[triangle] * relative_v - relative_u * edge_first_v[triangle]
        ) / chunk_determinant
        weight_origin = 1.0 - weight_first - weight_second
        is_inside = (weight_origin >= 0.0) & (weight_first >= 0.0) & (weight_second >= 0.0)

        crossing_depth = (
            weight_origin * depth[triangle, 0]
            + weight_first * depth[triangle, 1]
            + weight_second * depth[triangle, 2]
        )
        column_blocks.append((first_index * grid_shape[1] + second_index)[is_inside])
        depth_blocks.append(crossing_depth[is_inside])
        chunk_start = chunk_stop
    return np.concatenate(column_blocks), np.concatenate(depth_blocks)


def _to_material_intervals(
    column_indices: np.ndarray, depths: np.ndarray
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    if len(column_indices) == 0:
        empty = np.zeros(0, dtype=float)
        return np.zeros(0, dtype=np.int64), empty, empty
    order = np.lexsort((depths, column_indices))
    column_indices = column_indices[order]
    depths = depths[order]
    _, first_positions, counts = np.unique(
        column_indices, return_index=True, return_counts=True
    )
    rank = np.arange(len(column_indices)) - np.repeat(first_positions, counts)
    is_kept = np.repeat(counts % 2 == 0, counts)
    column_indices, depths, rank = column_indices[is_kept], depths[is_kept], rank[is_kept]
    is_entry = rank % 2 == 0
    return column_indices[is_entry], depths[is_entry], depths[~is_entry]


def get_axis_openness(
    moving_world_vertices: np.ndarray,
    moving_faces: np.ndarray,
    obstacle_world_meshes: List[Tuple[np.ndarray, np.ndarray]],
    column_count: int,
) -> np.ndarray:
    openness = np.zeros((3, 2), dtype=float)
    lower_bound = moving_world_vertices.min(axis=0)
    upper_bound = moving_world_vertices.max(axis=0)
    moving_triangles = moving_world_vertices[moving_faces]
    obstacle_triangle_sets = list()
    for obstacle_vertices, obstacle_faces in obstacle_world_meshes:
        triangles = obstacle_vertices[obstacle_faces]
        obstacle_triangle_sets.append(
            (triangles, triangles.min(axis=1), triangles.max(axis=1))
        )
    for axis_index in range(3):
        first_plane_axis, second_plane_axis = _PLANE_AXIS_INDICES[axis_index]
        projected_area = (upper_bound[first_plane_axis] - lower_bound[first_plane_axis]) * (
            upper_bound[second_plane_axis] - lower_bound[second_plane_axis]
        )
        grid_spacing = float(np.sqrt(max(projected_area, 1e-12) / column_count))
        grid_origin = (
            float(lower_bound[first_plane_axis]) + grid_spacing * 0.3183098861837907,
            float(lower_bound[second_plane_axis]) + grid_spacing * 0.2718281828459045,
        )
        grid_shape = (
            int(np.floor((upper_bound[first_plane_axis] - grid_origin[0]) / grid_spacing)) + 1,
            int(np.floor((upper_bound[second_plane_axis] - grid_origin[1]) / grid_spacing)) + 1,
        )
        moving_columns, moving_entries, moving_exits = _to_material_intervals(
            *_to_column_crossings(moving_triangles, axis_index, grid_origin, grid_spacing, grid_shape)
        )
        if len(moving_columns) == 0:
            continue

        obstacle_intervals = list()
        for triangles, triangle_lower, triangle_upper in obstacle_triangle_sets:
            is_touching = (
                (triangle_upper[:, first_plane_axis] >= lower_bound[first_plane_axis])
                & (triangle_lower[:, first_plane_axis] <= upper_bound[first_plane_axis])
                & (triangle_upper[:, second_plane_axis] >= lower_bound[second_plane_axis])
                & (triangle_lower[:, second_plane_axis] <= upper_bound[second_plane_axis])
            )
            if not np.any(is_touching):
                continue
            obstacle_intervals.append(
                _to_material_intervals(
                    *_to_column_crossings(
                        triangles[is_touching], axis_index, grid_origin, grid_spacing, grid_shape
                    )
                )
            )

        for sign_column in range(2):
            if sign_column == 1:
                entries, exits = moving_entries, moving_exits
            else:
                entries, exits = -moving_exits, -moving_entries
            order = np.lexsort((entries, moving_columns))
            sorted_columns, sorted_entries, sorted_exits = (
                moving_columns[order], entries[order], exits[order]
            )
            columns, first_positions, interval_counts = np.unique(
                sorted_columns, return_index=True, return_counts=True
            )
            rear_depths = np.minimum.reduceat(sorted_entries, first_positions)
            front_depths = np.maximum.reduceat(sorted_exits, first_positions)
            is_blocked = np.zeros(len(columns), dtype=bool)
            is_inside_obstacle = np.zeros(len(columns), dtype=bool)

            for obstacle_columns, obstacle_entries, obstacle_exits in obstacle_intervals:
                if len(obstacle_columns) == 0:
                    continue
                if sign_column == 1:
                    starts, ends = obstacle_entries, obstacle_exits
                else:
                    starts, ends = -obstacle_exits, -obstacle_entries
                positions = np.clip(np.searchsorted(columns, obstacle_columns), 0, len(columns) - 1)
                is_shared = columns[positions] == obstacle_columns
                positions, starts, ends = positions[is_shared], starts[is_shared], ends[is_shared]
                if len(positions) == 0:
                    continue
                rear = rear_depths[positions]
                front = front_depths[positions]

                is_ahead = starts > rear + grid_spacing
                is_enclosing = (starts <= rear + grid_spacing) & (ends >= front - grid_spacing)
                is_inside_obstacle[positions[is_enclosing]] = True

                is_embedded = np.zeros(len(positions), dtype=bool)
                block_start = first_positions[positions]
                block_stop = block_start + interval_counts[positions]
                for interval_rank in range(int(interval_counts.max())):
                    candidate = block_start + interval_rank
                    is_valid = candidate < block_stop
                    candidate = np.where(is_valid, candidate, block_start)
                    is_embedded |= (
                        is_valid
                        & (sorted_entries[candidate] - grid_spacing <= starts)
                        & (sorted_exits[candidate] + grid_spacing >= ends)
                    )
                is_blocked[positions[is_ahead & ~is_embedded]] = True

            is_counted = ~is_inside_obstacle | is_blocked
            counted_count = int(np.count_nonzero(is_counted))
            if counted_count > 0:
                openness[axis_index, sign_column] = 1.0 - (
                    np.count_nonzero(is_blocked) / counted_count
                )
    return openness


@dataclass(frozen=True)
class RRTStarConfig:
    max_iteration_count: int
    translation_step_size: float
    neighbor_radius: float
    goal_sample_rate: float
    rotation_distance_weight: float
    translation_interpolation_count: int
    rotation_interpolation_count: int
    removal_clearance: float
    sampling_margin_ratio: float
    does_sample_rotation: bool
    maximum_extension_step_count: int
    stops_at_first_feasible_path: bool
    random_seed: int

    def __post_init__(self) -> None:
        if self.max_iteration_count < 1:
            raise PlanningException(
                f"max_iteration_count must be at least 1, received {self.max_iteration_count}"
            )
        if self.translation_step_size <= 0.0:
            raise PlanningException(
                f"translation_step_size must be positive, received {self.translation_step_size}"
            )
        if self.neighbor_radius <= 0.0:
            raise PlanningException(
                f"neighbor_radius must be positive, received {self.neighbor_radius}"
            )
        if not 0.0 <= self.goal_sample_rate <= 1.0:
            raise PlanningException(
                f"goal_sample_rate must be within [0, 1], received {self.goal_sample_rate}"
            )
        if self.rotation_distance_weight < 0.0:
            raise PlanningException(
                f"rotation_distance_weight must be non-negative, received {self.rotation_distance_weight}"
            )
        if self.translation_interpolation_count < 2:
            raise PlanningException(
                f"translation_interpolation_count must be at least 2, received {self.translation_interpolation_count}"
            )
        if self.rotation_interpolation_count < 2:
            raise PlanningException(
                f"rotation_interpolation_count must be at least 2, received {self.rotation_interpolation_count}"
            )
        if self.removal_clearance <= 0.0:
            raise PlanningException(
                f"removal_clearance must be positive, received {self.removal_clearance}"
            )
        if self.sampling_margin_ratio <= 0.0:
            raise PlanningException(
                f"sampling_margin_ratio must be positive, received {self.sampling_margin_ratio}"
            )
        if self.maximum_extension_step_count < 1:
            raise PlanningException(
                f"maximum_extension_step_count must be at least 1, received {self.maximum_extension_step_count}"
            )


@dataclass
class _TreeNode:
    state: State
    parent_index: Optional[int]
    cost_from_start: float


@dataclass(frozen=True)
class PlanningResult:
    is_success: bool
    states: Tuple[State, ...]
    actions: Tuple[Action, ...]
    cost: float
    iteration_count: int
    farthest_paths: Tuple[Tuple[Tuple[State, ...], Tuple[Action, ...], float], ...]
    translation_iteration_count: int = 0
    rotation_iteration_count: int = 0


class InterferenceSessionAdapter:
    def __init__(
        self,
        interference_session: InterferenceSession,
        moving_centroid_local: np.ndarray,
    ):
        self.interference_session = interference_session
        self.moving_centroid_local = np.asarray(moving_centroid_local, dtype=float)

    @property
    def query_count(self) -> int:
        return self.interference_session.query_count

    @property
    def boolean_count(self) -> int:
        return self.interference_session.boolean_count

    def is_valid_state(self, moving_state: State) -> bool:
        return self.interference_session.is_transformation_valid(
            moving_state.to_transformation_matrix()
        )

    def is_path_segment_valid(
        self, start_state: State, goal_state: State, interpolation_count: int
    ) -> bool:
        if interpolation_count < 2:
            raise InterferenceException(
                f"interpolation_count must be at least 2, received {interpolation_count}"
            )
        if start_state.rotation != goal_state.rotation:
            raise InterferenceException(
                "is_path_segment_valid assumes a pure translation segment; "
                f"rotations differ: {start_state.rotation} vs {goal_state.rotation}"
            )

        start_position = np.asarray(start_state.position, dtype=float)
        goal_position = np.asarray(goal_state.position, dtype=float)
        rotation_matrix = start_state.to_rotation_matrix()
        for interpolation_index in range(interpolation_count):
            interpolation_ratio = interpolation_index / (interpolation_count - 1)
            interpolated_position = (
                start_position + (goal_position - start_position) * interpolation_ratio
            )
            transformation_matrix = np.eye(4)
            transformation_matrix[:3, :3] = rotation_matrix
            transformation_matrix[:3, 3] = interpolated_position
            if not self.interference_session.is_transformation_valid(transformation_matrix):
                return False
        return True

    def is_rotation_segment_valid(
        self, start_state: State, goal_state: State, interpolation_count: int
    ) -> bool:
        if interpolation_count < 2:
            raise InterferenceException(
                f"interpolation_count must be at least 2, received {interpolation_count}"
            )
        start_rotation_matrix = start_state.to_rotation_matrix()
        goal_rotation_matrix = goal_state.to_rotation_matrix()
        if np.allclose(start_rotation_matrix, goal_rotation_matrix):
            return self.is_valid_state(start_state)

        start_position = np.asarray(start_state.position, dtype=float)
        goal_position = np.asarray(goal_state.position, dtype=float)
        start_world_centroid = start_rotation_matrix @ self.moving_centroid_local + start_position
        goal_world_centroid = goal_rotation_matrix @ self.moving_centroid_local + goal_position
        if not np.allclose(start_world_centroid, goal_world_centroid, atol=1e-6):
            raise InterferenceException(
                "is_rotation_segment_valid assumes a pure rotation about the moving "
                "centroid; the start and goal states do not share a world centroid "
                f"({start_world_centroid} vs {goal_world_centroid})"
            )
        world_centroid = start_world_centroid

        key_rotations = Rotation.from_matrix(
            np.stack([start_rotation_matrix, goal_rotation_matrix])
        )
        slerp = Slerp([0.0, 1.0], key_rotations)
        for interpolation_index in range(interpolation_count):
            interpolation_ratio = interpolation_index / (interpolation_count - 1)
            interpolated_rotation_matrix = slerp([interpolation_ratio])[0].as_matrix()
            interpolated_position = (
                world_centroid - interpolated_rotation_matrix @ self.moving_centroid_local
            )
            transformation_matrix = np.eye(4)
            transformation_matrix[:3, :3] = interpolated_rotation_matrix
            transformation_matrix[:3, 3] = interpolated_position
            if not self.interference_session.is_transformation_valid(transformation_matrix):
                return False
        return True


class RRTStarPlanner:
    def __init__(
        self,
        moving_solid_id: int,
        solid_meshes: Dict[int, "object"],
        assembled_states: Dict[int, State],
        config: RRTStarConfig,
        interference_session: "object",
    ):
        if moving_solid_id not in solid_meshes:
            raise PlanningException(
                f"moving solid {moving_solid_id} is not present in solid_meshes"
            )
        if moving_solid_id not in assembled_states:
            raise PlanningException(
                f"moving solid {moving_solid_id} is not present in assembled_states"
            )
        if set(solid_meshes.keys()) != set(assembled_states.keys()):
            raise PlanningException(
                "solid_meshes and assembled_states must share the same solid identifiers"
            )

        self.moving_solid_id = moving_solid_id
        self.solid_meshes = solid_meshes
        self.assembled_states = assembled_states
        self.config = config

        self.collision_session = InterferenceSessionAdapter(
            interference_session,
            np.asarray(solid_meshes[moving_solid_id].centroid, dtype=float),
        )

        self.start_state = assembled_states[moving_solid_id]
        if not self.collision_session.is_valid_state(self.start_state):
            raise PlanningException(
                "start (assembled) state is already in collision; the interference "
                "baseline must be calibrated from the assembled configuration"
            )

        moving_mesh = solid_meshes[moving_solid_id]
        self.moving_centroid_local = np.asarray(moving_mesh.centroid, dtype=float)
        self.moving_vertices_local = np.asarray(moving_mesh.vertices, dtype=float)
        self.moving_faces = np.asarray(moving_mesh.faces, dtype=np.int64)
        self._most_open_axis_direction: Optional[Tuple[int, int, float]] = None

        self.obstacle_bounding_box = self._to_obstacle_bounding_box()
        self.sampling_lower_bound, self.sampling_upper_bound = self._to_sampling_bounds()
        self.random_generator = np.random.default_rng(config.random_seed)

        moving_start_world_vertices = self._to_world_vertices(
            self.moving_vertices_local, self.start_state.to_transformation_matrix()
        )
        self.moving_start_lower_bound = moving_start_world_vertices.min(axis=0)
        self.moving_start_upper_bound = moving_start_world_vertices.max(axis=0)

        self.free_escape_axis_directions = self._to_free_escape_axis_directions()

    def _to_free_escape_axis_directions(self) -> List[Tuple[int, int]]:
        free_axis_directions: List[Tuple[int, int]] = list()
        for axis_index in range(3):
            for sign in (1, -1):
                displacement = np.zeros(3, dtype=float)
                displacement[axis_index] = sign * self.config.translation_step_size
                probe_state = State(
                    position=tuple(np.asarray(self.start_state.position) + displacement),
                    rotation=self.start_state.rotation,
                )
                if self.collision_session.is_valid_state(
                    probe_state
                ) and self._segment_valid(
                    self.start_state,
                    probe_state,
                    self._interpolation_count_for(self.start_state, probe_state),
                ):
                    free_axis_directions.append((axis_index, sign))
        return free_axis_directions

    def _to_obstacle_bounding_box(self) -> np.ndarray:
        minimum_corners = list()
        maximum_corners = list()
        for solid_id, mesh in self.solid_meshes.items():
            if solid_id == self.moving_solid_id:
                continue
            transformation_matrix = self.assembled_states[solid_id].to_transformation_matrix()
            world_vertices = self._to_world_vertices(
                np.asarray(mesh.vertices, dtype=float), transformation_matrix
            )
            minimum_corners.append(world_vertices.min(axis=0))
            maximum_corners.append(world_vertices.max(axis=0))
        if len(minimum_corners) == 0:
            raise PlanningException(
                "assembly must contain at least one obstacle solid besides the moving solid"
            )
        return np.vstack(
            [np.min(minimum_corners, axis=0), np.max(maximum_corners, axis=0)]
        )

    def _to_sampling_bounds(self) -> Tuple[np.ndarray, np.ndarray]:
        minimum_corners = list()
        maximum_corners = list()
        for solid_id, mesh in self.solid_meshes.items():
            transformation_matrix = self.assembled_states[solid_id].to_transformation_matrix()
            world_vertices = self._to_world_vertices(
                np.asarray(mesh.vertices, dtype=float), transformation_matrix
            )
            minimum_corners.append(world_vertices.min(axis=0))
            maximum_corners.append(world_vertices.max(axis=0))
        assembly_lower_bound = np.min(minimum_corners, axis=0)
        assembly_upper_bound = np.max(maximum_corners, axis=0)
        assembly_extent = assembly_upper_bound - assembly_lower_bound
        margin = assembly_extent * self.config.sampling_margin_ratio
        return assembly_lower_bound - margin, assembly_upper_bound + margin

    def _to_world_vertices(
        self, local_vertices: np.ndarray, transformation_matrix: np.ndarray
    ) -> np.ndarray:
        rotation_part = transformation_matrix[:3, :3]
        translation_part = transformation_matrix[:3, 3]
        return local_vertices @ rotation_part.T + translation_part

    def get_next_state(self, state: State, action: Action) -> State:
        current_rotation_matrix = state.to_rotation_matrix()
        current_position = np.asarray(state.position, dtype=float)

        if action.is_translation():
            next_position = current_position + np.asarray(action.value, dtype=float)
            return State(position=tuple(next_position), rotation=state.rotation)

        action_rotation_matrix = _to_grid_rotation_matrix(action.value)
        world_centroid = current_rotation_matrix @ self.moving_centroid_local + current_position
        next_rotation_matrix = action_rotation_matrix @ current_rotation_matrix
        next_position = (
            action_rotation_matrix @ (current_position - world_centroid) + world_centroid
        )
        return State(
            position=tuple(next_position),
            rotation=_to_canonical_rotation_euler(next_rotation_matrix),
        )

    def get_edge_actions(
        self, from_state: State, to_state: State
    ) -> List[Tuple[Action, State]]:
        edge_actions: List[Tuple[Action, State]] = list()
        intermediate_state = from_state

        from_rotation_matrix = from_state.to_rotation_matrix()
        to_rotation_matrix = to_state.to_rotation_matrix()
        if not np.allclose(from_rotation_matrix, to_rotation_matrix):
            rotation_delta_matrix = to_rotation_matrix @ from_rotation_matrix.T
            rotation_action = Action(
                action_type=ActionType.ROTATION,
                value=_to_canonical_rotation_euler(rotation_delta_matrix),
            )
            intermediate_state = self.get_next_state(from_state, rotation_action)
            edge_actions.append((rotation_action, intermediate_state))

        intermediate_position = np.asarray(intermediate_state.position, dtype=float)
        target_position = np.asarray(to_state.position, dtype=float)
        if not np.allclose(intermediate_position, target_position, atol=1e-9):
            translation_action = Action(
                action_type=ActionType.TRANSLATION,
                value=tuple(target_position - intermediate_position),
            )
            intermediate_state = self.get_next_state(intermediate_state, translation_action)
            edge_actions.append((translation_action, intermediate_state))

        return edge_actions
    def _segment_valid(self, start_state, goal_state, interpolation_count) -> bool:
        return self.collision_session.is_path_segment_valid(
            start_state, goal_state, interpolation_count
        )

    def _interpolation_count_for(self, first_state: State, second_state: State) -> int:
        distance = float(
            np.linalg.norm(
                np.asarray(second_state.position, dtype=float)
                - np.asarray(first_state.position, dtype=float)
            )
        )
        base_count = self.config.translation_interpolation_count
        if distance <= 0.0:
            return base_count
        required = int(np.ceil(distance / max(self.config.translation_step_size, 1e-9))) + 1
        return max(base_count, required)

    def _straight_interpolation_count_for(self, first_state: State, second_state: State) -> int:
        distance = float(
            np.linalg.norm(
                np.asarray(second_state.position, dtype=float)
                - np.asarray(first_state.position, dtype=float)
            )
        )
        base_count = self.config.translation_interpolation_count
        if distance <= 0.0:
            return base_count
        required = int(
            np.ceil(distance / self.config.translation_step_size * (base_count - 1))
        ) + 1
        return max(base_count, required)

    def is_edge_valid(self, from_state: State, to_state: State) -> bool:
        previous_state = from_state
        for action, resulting_state in self.get_edge_actions(from_state, to_state):
            if action.is_rotation():
                if not self.collision_session.is_rotation_segment_valid(
                    previous_state,
                    resulting_state,
                    self.config.rotation_interpolation_count,
                ):
                    return False
            else:
                if not self._segment_valid(
                    previous_state,
                    resulting_state,
                    self._interpolation_count_for(previous_state, resulting_state),
                ):
                    return False
            previous_state = resulting_state
        return True

    def get_state_distance(self, first_state: State, second_state: State) -> float:
        translation_distance = float(
            np.linalg.norm(
                np.asarray(second_state.position) - np.asarray(first_state.position)
            )
        )
        is_same_rotation = _to_canonical_rotation(
            tuple(first_state.rotation)
        ) == _to_canonical_rotation(tuple(second_state.rotation))
        if is_same_rotation:
            return translation_distance
        return translation_distance + self.config.rotation_distance_weight

    def get_nearest_node(self, tree_nodes: List[_TreeNode], query_state: State) -> int:
        nearest_index = 0
        nearest_distance = float("inf")
        for node_index, node in enumerate(tree_nodes):
            distance = self.get_state_distance(node.state, query_state)
            if distance < nearest_distance:
                nearest_distance = distance
                nearest_index = node_index
        return nearest_index

    def get_neighbor_indices(
        self, tree_nodes: List[_TreeNode], query_state: State
    ) -> List[int]:
        neighbor_indices: List[int] = list()
        for node_index, node in enumerate(tree_nodes):
            if self.get_state_distance(node.state, query_state) <= self.config.neighbor_radius:
                neighbor_indices.append(node_index)
        return neighbor_indices

    def sample_random_state(self, does_sample_rotation: bool) -> State:
        if self.random_generator.random() < self.config.goal_sample_rate:
            return self.get_goal_biased_state()

        translation_lower_bound = self.sampling_lower_bound - self.moving_start_lower_bound
        translation_upper_bound = self.sampling_upper_bound - self.moving_start_upper_bound
        sampled_position = self.random_generator.uniform(
            translation_lower_bound, translation_upper_bound
        )
        return State(
            position=tuple(sampled_position),
            rotation=self.sample_rotation(does_sample_rotation),
        )

    def sample_rotation(self, does_sample_rotation: bool) -> Tuple[int, int, int]:
        if not does_sample_rotation:
            return self.start_state.rotation
        rotation_index = int(self.random_generator.integers(len(_CANONICAL_ROTATION_EULERS)))
        return _CANONICAL_ROTATION_EULERS[rotation_index]

    def get_goal_biased_state(self) -> State:
        if len(self.free_escape_axis_directions) > 0:
            choice_index = int(
                self.random_generator.integers(len(self.free_escape_axis_directions))
            )
            axis_index, sign = self.free_escape_axis_directions[choice_index]
        else:
            axis_index = int(self.random_generator.integers(3))
            sign = 1 if bool(self.random_generator.integers(2)) else -1

        assembly_span = (
            self.obstacle_bounding_box[1, axis_index]
            - self.obstacle_bounding_box[0, axis_index]
        )
        moving_span = (
            self.moving_start_upper_bound[axis_index]
            - self.moving_start_lower_bound[axis_index]
        )
        overshoot = self.random_generator.uniform(0.0, assembly_span + moving_span)

        sampled_position = np.asarray(self.start_state.position, dtype=float).copy()
        if sign > 0:
            clearing_translation = (
                self.obstacle_bounding_box[1, axis_index]
                + self.config.removal_clearance
                - self.moving_start_lower_bound[axis_index]
            )
            sampled_position[axis_index] = (
                self.start_state.position[axis_index] + clearing_translation + overshoot
            )
        else:
            clearing_translation = (
                self.obstacle_bounding_box[0, axis_index]
                - self.config.removal_clearance
                - self.moving_start_upper_bound[axis_index]
            )
            sampled_position[axis_index] = (
                self.start_state.position[axis_index] + clearing_translation - overshoot
            )
        return State(
            position=tuple(sampled_position),
            rotation=self.start_state.rotation,
        )

    def steer_toward(self, from_state: State, to_state: State) -> State:
        from_position = np.asarray(from_state.position, dtype=float)
        to_position = np.asarray(to_state.position, dtype=float)
        difference = to_position - from_position
        distance = float(np.linalg.norm(difference))

        if distance <= self.config.translation_step_size:
            steered_position = to_position
        else:
            steered_position = (
                from_position
                + difference / distance * self.config.translation_step_size
            )
        return State(position=tuple(steered_position), rotation=to_state.rotation)

    def get_best_escape_axis_direction(self, state: State) -> Tuple[int, int, float]:
        world_vertices = self._to_world_vertices(
            self.moving_vertices_local, state.to_transformation_matrix()
        )
        return get_axis_aligned_separation(world_vertices, self.obstacle_bounding_box)

    def get_axis_separations_at(self, state: State) -> np.ndarray:
        world_vertices = self._to_world_vertices(
            self.moving_vertices_local, state.to_transformation_matrix()
        )
        return get_axis_separations(world_vertices, self.obstacle_bounding_box)

    def get_most_open_axis_direction(self) -> Tuple[int, int, float]:
        if self._most_open_axis_direction is not None:
            return self._most_open_axis_direction

        moving_world_vertices = self._to_world_vertices(
            self.moving_vertices_local, self.start_state.to_transformation_matrix()
        )
        obstacle_world_meshes = [
            (
                self._to_world_vertices(
                    np.asarray(mesh.vertices, dtype=float),
                    self.assembled_states[solid_id].to_transformation_matrix(),
                ),
                np.asarray(mesh.faces, dtype=np.int64),
            )
            for solid_id, mesh in self.solid_meshes.items()
            if solid_id != self.moving_solid_id
        ]
        openness = get_axis_openness(
            moving_world_vertices, self.moving_faces, obstacle_world_meshes, OPENNESS_COLUMN_COUNT
        )
        separations = get_axis_separations(moving_world_vertices, self.obstacle_bounding_box)

        best_key: Optional[Tuple[float, float]] = None
        best_direction = (0, -1)
        for axis_index in range(3):
            for sign_column in range(2):
                key = (
                    float(openness[axis_index, sign_column]),
                    float(separations[axis_index, sign_column]),
                )
                if best_key is None or key > best_key:
                    best_key = key
                    best_direction = (axis_index, _to_sign(sign_column))
        self._most_open_axis_direction = (
            best_direction[0],
            best_direction[1],
            float(openness[best_direction[0], _to_sign_column(best_direction[1])]),
        )
        return self._most_open_axis_direction

    def get_closest_path(
        self, result: PlanningResult
    ) -> Tuple[Tuple[State, ...], Tuple[Action, ...], float]:
        if result.is_success:
            return (
                result.states,
                result.actions,
                self.get_separation_from_obstacles(result.states[-1]),
            )
        axis_index, sign, _ = self.get_most_open_axis_direction()
        return result.farthest_paths[axis_index * 2 + _to_sign_column(sign)]

    def get_separation_from_obstacles(self, state: State) -> float:
        return self.get_best_escape_axis_direction(state)[2]

    def is_goal_reached(self, state: State) -> bool:
        return self.get_separation_from_obstacles(state) >= self.config.removal_clearance

    def get_first_blocked_state(self, from_state: State) -> Optional[State]:
        if self.is_goal_reached(from_state):
            return None
        axis_index, sign, _ = self.get_most_open_axis_direction()
        separation = float(
            self.get_axis_separations_at(from_state)[axis_index, _to_sign_column(sign)]
        )
        remaining_distance = self.config.removal_clearance - separation
        if remaining_distance <= 0.0:
            return None

        start_position = np.asarray(from_state.position, dtype=float)
        goal_position = start_position.copy()
        goal_position[axis_index] += sign * remaining_distance
        goal_state = State(position=tuple(goal_position), rotation=from_state.rotation)

        interpolation_count = self._straight_interpolation_count_for(from_state, goal_state)
        for interpolation_index in range(1, interpolation_count):
            interpolation_ratio = interpolation_index / (interpolation_count - 1)
            interpolated_position = (
                start_position + (goal_position - start_position) * interpolation_ratio
            )
            candidate_state = State(
                position=tuple(interpolated_position), rotation=from_state.rotation
            )
            if not self.collision_session.is_valid_state(candidate_state):
                return candidate_state
        return None

    def has_any_feasible_first_move(self) -> bool:
        if len(self.free_escape_axis_directions) > 0:
            return True
        current_rotation_matrix = self.start_state.to_rotation_matrix()
        current_position = np.asarray(self.start_state.position, dtype=float)
        world_centroid = (
            current_rotation_matrix @ self.moving_centroid_local + current_position
        )
        for euler in _CANONICAL_ROTATION_EULERS:
            if tuple(euler) == tuple(self.start_state.rotation):
                continue
            target_rotation_matrix = _to_grid_rotation_matrix(tuple(euler))
            next_position = world_centroid - target_rotation_matrix @ self.moving_centroid_local
            rotated_state = State(position=tuple(next_position), rotation=tuple(euler))
            try:
                if self.collision_session.is_rotation_segment_valid(
                    self.start_state, rotated_state, self.config.rotation_interpolation_count
                ):
                    return True
            except Exception:
                continue
        return False

    def _get_clearing_translation(self, axis_index: int, sign: int) -> float:
        if sign > 0:
            return float(
                self.obstacle_bounding_box[1, axis_index]
                + self.config.removal_clearance
                + _EXTRACTION_BOUNDARY_MARGIN
                - self.moving_start_lower_bound[axis_index]
            )
        return float(
            self.obstacle_bounding_box[0, axis_index]
            - self.config.removal_clearance
            - _EXTRACTION_BOUNDARY_MARGIN
            - self.moving_start_upper_bound[axis_index]
        )

    def _try_straight_pull(
        self, lateral_offset: np.ndarray, axis_index: int, sign: int
    ) -> Optional[PlanningResult]:
        lateral_position = np.asarray(self.start_state.position, dtype=float) + lateral_offset
        lateral_state = State(position=tuple(lateral_position), rotation=self.start_state.rotation)
        goal_position = lateral_position.copy()
        goal_position[axis_index] += self._get_clearing_translation(axis_index, sign)
        goal_state = State(position=tuple(goal_position), rotation=self.start_state.rotation)
        if not self.is_goal_reached(goal_state):
            return None

        path_states = [self.start_state]
        if np.any(lateral_offset != 0.0):
            if not self.collision_session.is_valid_state(lateral_state):
                return None
            if not self._segment_valid(
                self.start_state,
                lateral_state,
                self._straight_interpolation_count_for(self.start_state, lateral_state),
            ):
                return None
            path_states.append(lateral_state)
        if not self.collision_session.is_valid_state(goal_state):
            return None
        if not self._segment_valid(
            lateral_state,
            goal_state,
            self._straight_interpolation_count_for(lateral_state, goal_state),
        ):
            return None
        path_states.append(goal_state)

        translation_actions = tuple(
            Action(
                action_type=ActionType.TRANSLATION,
                value=tuple(
                    np.asarray(next_state.position, dtype=float)
                    - np.asarray(previous_state.position, dtype=float)
                ),
            )
            for previous_state, next_state in zip(path_states[:-1], path_states[1:])
        )
        cost = sum(
            self.get_state_distance(previous_state, next_state)
            for previous_state, next_state in zip(path_states[:-1], path_states[1:])
        )
        return PlanningResult(
            is_success=True,
            states=tuple(path_states),
            actions=translation_actions,
            cost=float(cost),
            iteration_count=0,
            farthest_paths=tuple(),
        )

    def try_straight_extraction(self) -> Optional[PlanningResult]:
        for axis_index, sign in self.free_escape_axis_directions:
            result = self._try_straight_pull(np.zeros(3, dtype=float), axis_index, sign)
            if result is not None:
                return result

        open_axis_index, open_sign, _ = self.get_most_open_axis_direction()
        for perpendicular_axis_index in _PLANE_AXIS_INDICES[open_axis_index]:
            for side in (1, -1):
                lateral_offset = np.zeros(3, dtype=float)
                lateral_offset[perpendicular_axis_index] = side * self.config.translation_step_size
                result = self._try_straight_pull(lateral_offset, open_axis_index, open_sign)
                if result is not None:
                    return result
        return None

    def _to_immobile_result(self) -> PlanningResult:
        start_separations = self.get_axis_separations_at(self.start_state)
        return PlanningResult(
            is_success=False,
            states=tuple(),
            actions=tuple(),
            cost=float("inf"),
            iteration_count=0,
            farthest_paths=tuple(
                ((self.start_state,), tuple(), float(start_separations[axis_index, sign_column]))
                for axis_index in range(3)
                for sign_column in range(2)
            ),
        )

    def execute_search(self) -> PlanningResult:
        if not self.has_any_feasible_first_move():
            return self._to_immobile_result()
        straight_result = self.try_straight_extraction()
        if straight_result is not None:
            return straight_result
        return self._execute_staged_tree_search()

    def execute_tree_search(self) -> PlanningResult:
        if not self.has_any_feasible_first_move():
            return self._to_immobile_result()
        return self._execute_staged_tree_search()

    def _execute_staged_tree_search(self) -> PlanningResult:
        translation_result = self._execute_tree_search(does_sample_rotation=False)
        translation_iteration_count = translation_result.iteration_count
        if translation_result.is_success or not self.config.does_sample_rotation:
            return replace(
                translation_result, translation_iteration_count=translation_iteration_count
            )

        rotation_result = self._execute_tree_search(does_sample_rotation=True)
        if rotation_result.is_success:
            farthest_paths = rotation_result.farthest_paths
        else:
            farthest_paths = tuple(
                max(translation_path, rotation_path, key=lambda path: path[2])
                for translation_path, rotation_path in zip(
                    translation_result.farthest_paths, rotation_result.farthest_paths
                )
            )
        return replace(
            rotation_result,
            iteration_count=translation_iteration_count + rotation_result.iteration_count,
            farthest_paths=farthest_paths,
            translation_iteration_count=translation_iteration_count,
            rotation_iteration_count=rotation_result.iteration_count,
        )

    def _execute_tree_search(self, does_sample_rotation: bool) -> PlanningResult:
        self.random_generator = np.random.default_rng(self.config.random_seed)
        tree_nodes: List[_TreeNode] = [
            _TreeNode(state=self.start_state, parent_index=None, cost_from_start=0.0)
        ]
        best_goal_index: Optional[int] = None
        best_goal_cost = float("inf")
        farthest_separations = self.get_axis_separations_at(self.start_state)
        farthest_node_indices = np.zeros((3, 2), dtype=np.int64)

        performed_iteration_count = 0
        for iteration_index in range(self.config.max_iteration_count):
            performed_iteration_count = iteration_index + 1

            sampled_state = self.sample_random_state(does_sample_rotation)
            source_index = self.get_nearest_node(tree_nodes, sampled_state)

            for _ in range(self.config.maximum_extension_step_count):
                source_state = tree_nodes[source_index].state
                new_state = self.steer_toward(source_state, sampled_state)
                if new_state == source_state:
                    break
                if not self.collision_session.is_valid_state(new_state):
                    break
                if not self.is_edge_valid(source_state, new_state):
                    break

                new_node_index = self._insert_node(tree_nodes, source_index, new_state)

                new_separations = self.get_axis_separations_at(new_state)
                is_farther = new_separations > farthest_separations
                farthest_separations[is_farther] = new_separations[is_farther]
                farthest_node_indices[is_farther] = new_node_index
                new_separation = float(new_separations.max())
                if new_separation >= self.config.removal_clearance:
                    if tree_nodes[new_node_index].cost_from_start < best_goal_cost:
                        best_goal_cost = tree_nodes[new_node_index].cost_from_start
                        best_goal_index = new_node_index

                if new_state == sampled_state:
                    break
                source_index = new_node_index

            if self.config.stops_at_first_feasible_path and best_goal_index is not None:
                break

        if best_goal_index is None:
            farthest_paths = list()
            for axis_index in range(3):
                for sign_column in range(2):
                    path_states, path_actions = self.build_path(
                        tree_nodes, int(farthest_node_indices[axis_index, sign_column])
                    )
                    farthest_paths.append((
                        tuple(path_states),
                        tuple(path_actions),
                        float(farthest_separations[axis_index, sign_column]),
                    ))
            return PlanningResult(
                is_success=False,
                states=tuple(),
                actions=tuple(),
                cost=float("inf"),
                iteration_count=performed_iteration_count,
                farthest_paths=tuple(farthest_paths),
            )

        states, actions = self.build_path(tree_nodes, best_goal_index)
        return PlanningResult(
            is_success=True,
            states=tuple(states),
            actions=tuple(actions),
            cost=best_goal_cost,
            iteration_count=performed_iteration_count,
            farthest_paths=tuple(),
        )

    def _insert_node(
        self, tree_nodes: List[_TreeNode], source_index: int, new_state: State
    ) -> int:
        neighbor_indices = self.get_neighbor_indices(tree_nodes, new_state)
        parent_index, parent_cost = self._choose_parent(
            tree_nodes, neighbor_indices, source_index, new_state
        )
        new_node_index = len(tree_nodes)
        tree_nodes.append(
            _TreeNode(
                state=new_state,
                parent_index=parent_index,
                cost_from_start=parent_cost,
            )
        )
        self._rewire_neighbors(tree_nodes, neighbor_indices, new_node_index)
        return new_node_index

    def _choose_parent(
        self,
        tree_nodes: List[_TreeNode],
        neighbor_indices: List[int],
        nearest_index: int,
        new_state: State,
    ) -> Tuple[int, float]:
        best_parent_index = nearest_index
        best_cost = tree_nodes[nearest_index].cost_from_start + self.get_state_distance(
            tree_nodes[nearest_index].state, new_state
        )
        for neighbor_index in neighbor_indices:
            candidate_cost = tree_nodes[neighbor_index].cost_from_start + self.get_state_distance(
                tree_nodes[neighbor_index].state, new_state
            )
            if candidate_cost < best_cost and self.is_edge_valid(
                tree_nodes[neighbor_index].state, new_state
            ):
                best_cost = candidate_cost
                best_parent_index = neighbor_index
        return best_parent_index, best_cost

    def _rewire_neighbors(
        self,
        tree_nodes: List[_TreeNode],
        neighbor_indices: List[int],
        new_node_index: int,
    ) -> None:
        new_node = tree_nodes[new_node_index]
        for neighbor_index in neighbor_indices:
            if neighbor_index == new_node.parent_index:
                continue
            candidate_cost = new_node.cost_from_start + self.get_state_distance(
                new_node.state, tree_nodes[neighbor_index].state
            )
            if candidate_cost < tree_nodes[neighbor_index].cost_from_start and self.is_edge_valid(
                new_node.state, tree_nodes[neighbor_index].state
            ):
                tree_nodes[neighbor_index].parent_index = new_node_index
                tree_nodes[neighbor_index].cost_from_start = candidate_cost

    def build_path(
        self, tree_nodes: List[_TreeNode], goal_index: int
    ) -> Tuple[List[State], List[Action]]:
        node_states: List[State] = list()
        node_index: Optional[int] = goal_index
        while node_index is not None:
            node_states.append(tree_nodes[node_index].state)
            node_index = tree_nodes[node_index].parent_index
        node_states.reverse()

        state_path: List[State] = [node_states[0]]
        action_path: List[Action] = list()
        for segment_index in range(len(node_states) - 1):
            for action, resulting_state in self.get_edge_actions(
                node_states[segment_index], node_states[segment_index + 1]
            ):
                action_path.append(action)
                state_path.append(resulting_state)
        return state_path, action_path

    def to_assembly_path(
        self, disassembly_result: PlanningResult
    ) -> Tuple[List[State], List[Action]]:
        if not disassembly_result.is_success:
            raise PlanningException("cannot build an assembly path from a failed disassembly result")

        assembly_state_path = list(reversed(disassembly_result.states))
        assembly_action_path: List[Action] = list()
        for segment_index in range(len(assembly_state_path) - 1):
            for action, _ in self.get_edge_actions(
                assembly_state_path[segment_index], assembly_state_path[segment_index + 1]
            ):
                assembly_action_path.append(action)
        return assembly_state_path, assembly_action_path

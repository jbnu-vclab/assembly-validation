# RRT* 기반 분해 경로 탐색.
# 움직이는 부품 하나를 조립 상태에서 출발시켜, 위치는 연속 공간에서, 회전은 24개 이산 자세 중에서
# 샘플링하며 트리를 키운다. 나머지 부품 전체의 경계 상자에서 목표 여유 이상 떨어진 상태에 닿으면
# 분해된 것으로 본다.
import itertools
from dataclasses import dataclass, replace
from typing import Dict, List, Optional, Tuple

import numpy as np
from scipy.spatial.transform import Rotation, Slerp

from core.action import Action, ActionType
from core.interference import InterferenceException, InterferenceSession
from core.state import State


# 탐색 입력이나 설정이 잘못되었을 때 발생시키는 예외
class PlanningException(Exception):
    pass


# 축마다 쓰는 회전 각도(도). 4^3 = 64개 조합이 서로 다른 회전 행렬 24개로 모인다.
_ROTATION_GRID_ANGLES = (0, 90, 180, 270)


# 90도 단위 XYZ intrinsic 오일러 각을 성분이 -1/0/1인 회전 행렬로 바꾼다.
def _to_grid_rotation_matrix(euler_angles: Tuple[int, int, int]) -> np.ndarray:
    rotation_matrix = np.rint(
        Rotation.from_euler("XYZ", euler_angles, degrees=True).as_matrix()
    )
    rotation_matrix[rotation_matrix == 0.0] = 0.0
    return rotation_matrix


# 회전 행렬을 정수 튜플로 바꿔 사전 키로 쓴다.
def _to_matrix_key(rotation_matrix: np.ndarray) -> Tuple[int, ...]:
    return tuple(np.rint(rotation_matrix).astype(int).flatten())


# 64개 오일러 조합을 돌며 회전 행렬마다 처음 나온 오일러 각을 대표값으로 정한다.
# 반환: (행렬 키 → 대표 오일러 각, 대표 오일러 각 24개 목록)
def _build_canonical_rotation_lookup() -> Tuple[Dict[Tuple[int, ...], Tuple[int, int, int]], List[Tuple[int, int, int]]]:
    matrix_key_to_euler: Dict[Tuple[int, ...], Tuple[int, int, int]] = dict()
    canonical_eulers: List[Tuple[int, int, int]] = list()
    for euler_angles in itertools.product(_ROTATION_GRID_ANGLES, repeat=3):
        matrix_key = _to_matrix_key(_to_grid_rotation_matrix(euler_angles))
        if matrix_key not in matrix_key_to_euler:
            matrix_key_to_euler[matrix_key] = euler_angles
            canonical_eulers.append(euler_angles)
    return matrix_key_to_euler, canonical_eulers


# 모듈을 불러올 때 한 번 만드는 조회표
_MATRIX_KEY_TO_EULER, _CANONICAL_ROTATION_EULERS = _build_canonical_rotation_lookup()

# 64개 오일러 조합 → 같은 회전의 대표 오일러 각
_EULER_TO_CANONICAL: Dict[Tuple[int, int, int], Tuple[int, int, int]] = {
    euler_angles: _MATRIX_KEY_TO_EULER[_to_matrix_key(_to_grid_rotation_matrix(euler_angles))]
    for euler_angles in itertools.product(_ROTATION_GRID_ANGLES, repeat=3)
}


# 90도 단위 오일러 각(360으로 나눈 나머지로 정규화)을 대표 오일러 각으로 바꾼다.
def _to_canonical_rotation(rotation: Tuple[int, int, int]) -> Tuple[int, int, int]:
    rotation_key = tuple(int(component) % 360 for component in rotation)
    canonical = _EULER_TO_CANONICAL.get(rotation_key)
    if canonical is not None:
        return canonical
    return _MATRIX_KEY_TO_EULER[_to_matrix_key(_to_grid_rotation_matrix(rotation_key))]


# 회전 행렬을 대표 오일러 각으로 바꾼다. 90도 격자 자세가 아니면 예외.
def _to_canonical_rotation_euler(rotation_matrix: np.ndarray) -> Tuple[int, int, int]:
    matrix_key = _to_matrix_key(rotation_matrix)
    if matrix_key not in _MATRIX_KEY_TO_EULER:
        raise PlanningException(
            f"rotation matrix {matrix_key} is not a 90-degree grid orientation"
        )
    return _MATRIX_KEY_TO_EULER[matrix_key]


# 여섯 방향(±x, ±y, ±z) 중 움직이는 부품이 장애물 경계 상자에서 가장 멀리 떨어진 방향.
# 반환: (축 번호, 부호 -1/+1, 분리량)
def get_axis_aligned_separation(
    moving_world_vertices: np.ndarray, obstacle_bounding_box: np.ndarray
) -> Tuple[int, int, float]:
    separations = get_axis_separations(moving_world_vertices, obstacle_bounding_box)
    flat_index = int(np.argmax(separations))
    axis_index, sign_column = divmod(flat_index, 2)
    return axis_index, _to_sign(sign_column), float(separations[axis_index, sign_column])


# 축·방향별 분리량 3x2 배열.
# 열 0은 - 방향(장애물 최소 - 부품 최대), 열 1은 + 방향(부품 최소 - 장애물 최대)이다.
# 양수면 그 방향으로 이미 떨어져 있다.
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


# 열 번호(0/1) → 부호(-1/+1)
def _to_sign(sign_column: int) -> int:
    return -1 if sign_column == 0 else 1


# 부호(-1/+1) → 열 번호(0/1)
def _to_sign_column(sign: int) -> int:
    return 0 if sign < 0 else 1


# 열린 정도를 잴 때 축마다 쓰는 광선 수(격자 칸 수)
OPENNESS_COLUMN_COUNT = 16384

# 축 번호 → 그 축에 수직인 평면의 두 축 번호
_PLANE_AXIS_INDICES = {0: (1, 2), 1: (0, 2), 2: (0, 1)}

# 광선-삼각형 교차 후보를 한 번에 처리할 최대 개수(메모리 제한)
_CANDIDATE_CHUNK_SIZE = 2_000_000

# 직선 분해 목표 이동량에 더하는 아주 작은 여유(경계값 비교 오차 방지)
_EXTRACTION_BOUNDARY_MARGIN = 1e-6


# axis 방향 광선들과 삼각형들의 교차를 구한다. 광선은 axis에 수직인 평면 위에
# grid_spacing 간격 격자로 놓인다. 반환: (교차한 칸 번호, 교차 지점의 axis 좌표)
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

    # 삼각형 투영의 경계 상자 안에 드는 격자 칸 범위
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

    # 투영된 삼각형의 두 모서리 벡터와 행렬식(0에 가까우면 광선과 나란한 삼각형이라 뺀다)
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

    # 후보 (삼각형, 칸) 쌍을 _CANDIDATE_CHUNK_SIZE개씩 나눠 처리한다.
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
        # 후보마다 삼각형 번호와 칸의 두 격자 번호를 펼친다.
        triangle = np.repeat(chunk, counts)
        offset = np.arange(int(counts.sum())) - np.repeat(np.cumsum(counts) - counts, counts)
        row_length = np.repeat(second_counts[chunk], counts)
        first_index = np.repeat(first_lower[chunk], counts).astype(np.int64) + offset // row_length
        second_index = np.repeat(second_lower[chunk], counts).astype(np.int64) + offset % row_length

        # barycentric 좌표로 칸 중심이 삼각형 안인지 보고, 안이면 교차 깊이를 보간한다.
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


# 칸마다 교차 깊이를 정렬해 (들어감, 나옴) 쌍으로 묶어 물체 내부 구간을 만든다.
# 교차 수가 홀수인 칸(접선이나 틈 때문에 짝이 맞지 않는 칸)은 버린다.
# 반환: (칸 번호, 구간 시작 깊이, 구간 끝 깊이)
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


# 여섯 방향(±x, ±y, ±z)으로 부품이 얼마나 열려 있는지(열린 정도 0~1) 구한다.
# 축마다 부품 투영을 덮는 광선 격자를 만들고, 진행 방향에서 장애물에 부딪히는 칸을
# 막힌 칸으로 센다. 열린 정도 = 1 - 막힌 칸 수 / 센 칸 수.
# 반환: 3x2 배열(행 = 축, 열 0 = - 방향, 열 1 = + 방향)
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
        # 부품 투영 넓이를 column_count개 칸으로 나누는 격자 간격
        grid_spacing = float(np.sqrt(max(projected_area, 1e-12) / column_count))
        # 격자 시작점을 간격의 1/π, e/10배만큼 밀어 칸 중심이 메쉬 모서리나 정점에 정확히
        # 걸리는 경우를 피한다.
        grid_origin = (
            float(lower_bound[first_plane_axis]) + grid_spacing * 0.3183098861837907,
            float(lower_bound[second_plane_axis]) + grid_spacing * 0.2718281828459045,
        )
        grid_shape = (
            int(np.floor((upper_bound[first_plane_axis] - grid_origin[0]) / grid_spacing)) + 1,
            int(np.floor((upper_bound[second_plane_axis] - grid_origin[1]) / grid_spacing)) + 1,
        )
        # 움직이는 부품의 칸별 내부 구간
        moving_columns, moving_entries, moving_exits = _to_material_intervals(
            *_to_column_crossings(moving_triangles, axis_index, grid_origin, grid_spacing, grid_shape)
        )
        if len(moving_columns) == 0:
            continue

        # 부품 투영 범위에 걸치는 장애물 삼각형만 골라 칸별 내부 구간을 구한다.
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

        # 열 1(+ 방향)은 깊이를 그대로, 열 0(- 방향)은 깊이 부호를 뒤집어 같은 방식으로 처리한다.
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
            # 칸마다 부품의 뒤끝(가장 작은 시작 깊이)과 앞끝(가장 큰 끝 깊이)
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

                # 장애물 구간이 부품 뒤끝보다 앞에서 시작하면 그 방향으로 밀 때 부딪친다.
                is_ahead = starts > rear + grid_spacing
                # 장애물 구간이 부품 구간 전체를 덮으면 부품이 장애물과 겹쳐 있는 칸이다.
                is_enclosing = (starts <= rear + grid_spacing) & (ends >= front - grid_spacing)
                is_inside_obstacle[positions[is_enclosing]] = True

                # 장애물 구간이 부품 자신의 내부 구간 하나 안에 들어 있으면(조립 상태 겹침)
                # 막힘에서 뺀다.
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

            # 장애물과 겹쳐 있는 칸은 막혔을 때만 센다.
            is_counted = ~is_inside_obstacle | is_blocked
            counted_count = int(np.count_nonzero(is_counted))
            if counted_count > 0:
                openness[axis_index, sign_column] = 1.0 - (
                    np.count_nonzero(is_blocked) / counted_count
                )
    return openness


# RRT* 탐색 설정. 길이 단위는 STEP 좌표 단위이며, main.py가 델타(최소 부품 두께 / 2)를
# 기준으로 값을 정한다.
@dataclass(frozen=True)
class RRTStarConfig:
    # 최대 반복 횟수(탐색 단계마다)
    max_iteration_count: int
    # 델타: 한 번 확장할 때의 최대 평행이동 거리
    translation_step_size: float
    # 이웃 반경: 부모 선택과 재연결 대상이 되는 상태 거리
    neighbor_radius: float
    # 목표 편향 비율: 이 확률로 무작위 샘플 대신 목표 쪽 샘플을 쓴다.
    goal_sample_rate: float
    # 자세가 다를 때 상태 거리에 더하는 회전 비용
    rotation_distance_weight: float
    # 평행이동 구간 간섭 검사의 최소 보간 점 수
    translation_interpolation_count: int
    # 회전 구간 간섭 검사의 보간 점 수
    rotation_interpolation_count: int
    # 목표 여유: 장애물 경계 상자에서 이만큼 떨어지면 분해된 것으로 본다.
    removal_clearance: float
    # 샘플링 범위를 조립체 크기의 이 비율만큼 사방으로 넓힌다.
    sampling_margin_ratio: float
    # 평행이동만으로 실패하면 회전까지 샘플링해 다시 탐색할지 여부
    does_sample_rotation: bool
    # 연속 확장 한계: 샘플 하나를 향해 델타씩 연속으로 뻗는 최대 횟수
    maximum_extension_step_count: int
    # 첫 분해 경로를 찾으면 반복을 멈출지 여부
    stops_at_first_feasible_path: bool
    # 난수 시드
    random_seed: int

    # 설정값 범위를 검사한다.
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


# 트리 노드: 상태, 부모 노드 번호(루트는 None), 시작점부터의 누적 비용
@dataclass
class _TreeNode:
    state: State
    parent_index: Optional[int]
    cost_from_start: float


# 탐색 결과. 성공하면 states/actions가 분해 경로(조립 상태 → 분해된 상태)이다.
@dataclass(frozen=True)
class PlanningResult:
    is_success: bool
    states: Tuple[State, ...]
    actions: Tuple[Action, ...]
    # 경로 비용(상태 거리의 합). 실패면 inf
    cost: float
    # 수행한 반복 수(탐색 단계 합계)
    iteration_count: int
    # 실패 진단용: 6방향마다 가장 멀리 간 노드까지의 (상태들, 동작들, 분리량).
    # 순서는 축 번호 × 2 + 열 번호(0 = - 방향, 1 = + 방향)
    farthest_paths: Tuple[Tuple[Tuple[State, ...], Tuple[Action, ...], float], ...]
    # 평행이동 단계와 회전 단계 각각의 반복 수
    translation_iteration_count: int = 0
    rotation_iteration_count: int = 0


# InterferenceSession을 State 단위로 쓰도록 감싼다.
# 상태 하나와 구간(평행이동, 회전)이 허용 상한 이내인지 판정한다.
class InterferenceSessionAdapter:
    def __init__(
        self,
        interference_session: InterferenceSession,
        moving_centroid_local: np.ndarray,
    ):
        self.interference_session = interference_session
        self.moving_centroid_local = np.asarray(moving_centroid_local, dtype=float)

    # 세션의 판정 요청 수
    @property
    def query_count(self) -> int:
        return self.interference_session.query_count

    # 세션의 불린 연산 수
    @property
    def boolean_count(self) -> int:
        return self.interference_session.boolean_count

    # 상태 하나가 허용 상한 이내인지 판정한다.
    def is_valid_state(self, moving_state: State) -> bool:
        return self.interference_session.is_transformation_valid(
            moving_state.to_transformation_matrix()
        )

    # 자세가 같은 두 상태 사이의 평행이동 구간을 양 끝 포함 interpolation_count개 점으로
    # 나눠 판정한다.
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

    # 무게 중심을 고정한 채 start 자세에서 goal 자세로 도는 구간을 판정한다.
    def is_rotation_segment_valid(
        self, start_state: State, goal_state: State, interpolation_count: int
    ) -> bool:
        if interpolation_count < 2:
            raise InterferenceException(
                f"interpolation_count must be at least 2, received {interpolation_count}"
            )
        start_rotation_matrix = start_state.to_rotation_matrix()
        goal_rotation_matrix = goal_state.to_rotation_matrix()
        # 자세가 같으면 상태 하나만 판정한다.
        if np.allclose(start_rotation_matrix, goal_rotation_matrix):
            return self.is_valid_state(start_state)

        start_position = np.asarray(start_state.position, dtype=float)
        goal_position = np.asarray(goal_state.position, dtype=float)
        start_world_centroid = start_rotation_matrix @ self.moving_centroid_local + start_position
        goal_world_centroid = goal_rotation_matrix @ self.moving_centroid_local + goal_position
        # 두 상태의 월드 무게 중심이 다르면 순수 회전이 아니므로 예외
        if not np.allclose(start_world_centroid, goal_world_centroid, atol=1e-6):
            raise InterferenceException(
                "is_rotation_segment_valid assumes a pure rotation about the moving "
                "centroid; the start and goal states do not share a world centroid "
                f"({start_world_centroid} vs {goal_world_centroid})"
            )
        world_centroid = start_world_centroid

        # Slerp(구면 선형 보간)로 자세를 나누고, 무게 중심이 제자리에 있도록 위치를 맞춘다.
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


# 부품 하나의 분해 경로를 찾는 플래너. execute_search는 직선 분해(Tier1)를 먼저 시도하고,
# 안 되면 RRT*(Tier2)를 쓴다. RRT*는 평행이동만 샘플링해 보고, 실패하면 회전까지 샘플링한다.
class RRTStarPlanner:
    # 입력 검사, 시작 상태 간섭 검사, 장애물 경계 상자와 샘플링 범위 계산,
    # 바로 움직일 수 있는 방향 탐색을 한다.
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

        # 회전 중심은 움직이는 부품 메쉬의 무게 중심(로컬 좌표)이다.
        self.collision_session = InterferenceSessionAdapter(
            interference_session,
            np.asarray(solid_meshes[moving_solid_id].centroid, dtype=float),
        )

        # 시작 상태 = 조립 상태. 이미 허용 상한을 넘으면 탐색할 수 없다.
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
        # 가장 열린 방향 계산 결과 캐시
        self._most_open_axis_direction: Optional[Tuple[int, int, float]] = None

        self.obstacle_bounding_box = self._to_obstacle_bounding_box()
        self.sampling_lower_bound, self.sampling_upper_bound = self._to_sampling_bounds()
        self.random_generator = np.random.default_rng(config.random_seed)

        # 조립 상태에서 움직이는 부품의 월드 경계 상자
        moving_start_world_vertices = self._to_world_vertices(
            self.moving_vertices_local, self.start_state.to_transformation_matrix()
        )
        self.moving_start_lower_bound = moving_start_world_vertices.min(axis=0)
        self.moving_start_upper_bound = moving_start_world_vertices.max(axis=0)

        # 조립 상태에서 델타만큼 바로 움직일 수 있는 (축, 부호) 목록
        self.free_escape_axis_directions = self._to_free_escape_axis_directions()

    # 여섯 방향으로 델타만큼 평행이동해 보고, 간섭 없이 움직일 수 있는 (축, 부호)를 모은다.
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

    # 움직이는 부품을 뺀 나머지 부품 전체의 월드 경계 상자 [[최소], [최대]]
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

    # 조립체 전체 경계 상자를 sampling_margin_ratio만큼 사방으로 넓힌 샘플링 범위
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

    # 로컬 정점에 4x4 변환을 적용해 월드 좌표로 바꾼다.
    def _to_world_vertices(
        self, local_vertices: np.ndarray, transformation_matrix: np.ndarray
    ) -> np.ndarray:
        rotation_part = transformation_matrix[:3, :3]
        translation_part = transformation_matrix[:3, 3]
        return local_vertices @ rotation_part.T + translation_part

    # 상태에 동작 하나를 적용한 다음 상태. 평행이동은 위치에 더하고, 회전은 월드 무게 중심을
    # 기준으로 돌린다(자세는 대표 오일러 각으로 정규화).
    def get_next_state(self, state: State, action: Action) -> State:
        current_rotation_matrix = state.to_rotation_matrix()
        current_position = np.asarray(state.position, dtype=float)

        if action.is_translation():
            next_position = current_position + np.asarray(action.value, dtype=float)
            return State(position=tuple(next_position), rotation=state.rotation)

        # 월드 무게 중심 c를 고정한 회전: 새 자세 = R_action·R, 새 위치 = R_action·(p - c) + c
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

    # 두 상태를 잇는 동작 목록: 자세가 다르면 무게 중심 기준 회전 하나,
    # 이어서 남은 위치 차이만큼 평행이동 하나. 반환: [(동작, 동작 후 상태), ...]
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
    # 평행이동 구간의 간섭 판정
    def _segment_valid(self, start_state, goal_state, interpolation_count) -> bool:
        return self.collision_session.is_path_segment_valid(
            start_state, goal_state, interpolation_count
        )

    # 평행이동 구간의 보간 점 수: 델타마다 한 점 이상, 최소 translation_interpolation_count개
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

    # 직선 분해와 진단용 보간 점 수: 점 간격이 델타 / (translation_interpolation_count - 1)이
    # 되도록 촘촘하게 잡는다.
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

    # 두 상태를 잇는 동작(회전 → 평행이동)을 차례로 적용하며 각 구간이 간섭 없는지 확인한다.
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

    # 상태 거리 = 위치 거리 + (자세가 다르면 회전 비용). 최근접 노드와 경로 비용 계산에 쓴다.
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

    # 질의 상태와 가장 가까운 트리 노드 번호(모든 노드를 훑는다)
    def get_nearest_node(self, tree_nodes: List[_TreeNode], query_state: State) -> int:
        nearest_index = 0
        nearest_distance = float("inf")
        for node_index, node in enumerate(tree_nodes):
            distance = self.get_state_distance(node.state, query_state)
            if distance < nearest_distance:
                nearest_distance = distance
                nearest_index = node_index
        return nearest_index

    # 질의 상태에서 이웃 반경 안에 있는 트리 노드 번호들
    def get_neighbor_indices(
        self, tree_nodes: List[_TreeNode], query_state: State
    ) -> List[int]:
        neighbor_indices: List[int] = list()
        for node_index, node in enumerate(tree_nodes):
            if self.get_state_distance(node.state, query_state) <= self.config.neighbor_radius:
                neighbor_indices.append(node_index)
        return neighbor_indices

    # 무작위 상태 샘플. 목표 편향 비율의 확률로 목표 쪽 상태를 뽑고,
    # 아니면 샘플링 범위 안의 무작위 위치를 뽑는다.
    def sample_random_state(self, does_sample_rotation: bool) -> State:
        if self.random_generator.random() < self.config.goal_sample_rate:
            return self.get_goal_biased_state()

        # 부품의 조립 상태 경계 상자가 샘플링 범위 안에 머무는 평행이동 범위
        translation_lower_bound = self.sampling_lower_bound - self.moving_start_lower_bound
        translation_upper_bound = self.sampling_upper_bound - self.moving_start_upper_bound
        sampled_position = self.random_generator.uniform(
            translation_lower_bound, translation_upper_bound
        )
        return State(
            position=tuple(sampled_position),
            rotation=self.sample_rotation(does_sample_rotation),
        )

    # 회전을 샘플링하지 않으면 시작 자세, 샘플링하면 24개 대표 자세 중 하나
    def sample_rotation(self, does_sample_rotation: bool) -> Tuple[int, int, int]:
        if not does_sample_rotation:
            return self.start_state.rotation
        rotation_index = int(self.random_generator.integers(len(_CANONICAL_ROTATION_EULERS)))
        return _CANONICAL_ROTATION_EULERS[rotation_index]

    # 목표 쪽 샘플: 자유 방향(없으면 무작위 축·부호)으로 장애물 경계 상자를 목표 여유만큼
    # 벗어난 위치에서, 0 ~ (장애물 경계 상자 폭 + 부품 폭)의 무작위 거리를 더 간 상태.
    # 자세는 시작 자세 그대로다.
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

    # from에서 to 쪽으로 최대 델타만큼 간 상태(자세는 to의 자세)
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

    # 주어진 상태에서 장애물 경계 상자와 가장 멀리 떨어진 (축, 부호, 분리량)
    def get_best_escape_axis_direction(self, state: State) -> Tuple[int, int, float]:
        world_vertices = self._to_world_vertices(
            self.moving_vertices_local, state.to_transformation_matrix()
        )
        return get_axis_aligned_separation(world_vertices, self.obstacle_bounding_box)

    # 주어진 상태의 축·방향별 분리량(3x2)
    def get_axis_separations_at(self, state: State) -> np.ndarray:
        world_vertices = self._to_world_vertices(
            self.moving_vertices_local, state.to_transformation_matrix()
        )
        return get_axis_separations(world_vertices, self.obstacle_bounding_box)

    # 조립 상태에서 가장 열린 방향 (축, 부호, 열린 정도). 열린 정도가 같으면 분리량이 큰 쪽.
    # 실패 진단의 기준 방향으로 쓰며, 한 번 계산하면 캐시한다.
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

    # 진단용 가장 가까운 경로 (상태들, 동작들, 분리량). 성공이면 그 경로를,
    # 실패면 가장 열린 방향으로 가장 멀리 간 경로를 돌려준다.
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

    # 여섯 방향 분리량 중 최댓값
    def get_separation_from_obstacles(self, state: State) -> float:
        return self.get_best_escape_axis_direction(state)[2]

    # 최대 분리량이 목표 여유 이상이면 분해된 것으로 본다.
    def is_goal_reached(self, state: State) -> bool:
        return self.get_separation_from_obstacles(state) >= self.config.removal_clearance

    # from 상태에서 가장 열린 방향으로 목표 여유까지 직선으로 밀어 보며, 처음 허용 상한을
    # 넘는 상태를 찾는다. 이미 분해되었거나 끝까지 막히지 않으면 None.
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

    # 조립 상태에서 첫 동작이 하나라도 가능한지: 바로 움직일 수 있는 방향이 있거나,
    # 무게 중심 기준으로 다른 23개 자세 중 하나로 간섭 없이 돌 수 있으면 True.
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

    # 조립 상태에서 axis·sign 방향으로 장애물 경계 상자를 목표 여유만큼 벗어나는 데 필요한
    # 이동량(부호 포함)
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

    # 직선 분해 한 번: lateral_offset만큼 옆으로 비킨 뒤(0이면 생략) axis·sign 방향으로
    # 곧장 빼낸다. 모든 구간이 간섭 없으면 성공 결과, 아니면 None.
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

    # Tier1 직선 분해: 바로 움직일 수 있는 방향마다 곧장 빼 본다.
    def try_straight_extraction(self) -> Optional[PlanningResult]:
        for axis_index, sign in self.free_escape_axis_directions:
            result = self._try_straight_pull(np.zeros(3, dtype=float), axis_index, sign)
            if result is not None:
                return result

        # 안 되면 가장 열린 방향에 수직인 두 축으로 ±델타 비킨 뒤 빼 본다.
        open_axis_index, open_sign, _ = self.get_most_open_axis_direction()
        for perpendicular_axis_index in _PLANE_AXIS_INDICES[open_axis_index]:
            for side in (1, -1):
                lateral_offset = np.zeros(3, dtype=float)
                lateral_offset[perpendicular_axis_index] = side * self.config.translation_step_size
                result = self._try_straight_pull(lateral_offset, open_axis_index, open_sign)
                if result is not None:
                    return result
        return None

    # 첫 동작부터 불가능할 때의 실패 결과. 6방향 모두 조립 상태 하나만 담은 경로로 채운다.
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

    # 전체 탐색: 첫 동작 가능 여부 → 직선 분해 → 단계적 RRT*
    def execute_search(self) -> PlanningResult:
        if not self.has_any_feasible_first_move():
            return self._to_immobile_result()
        straight_result = self.try_straight_extraction()
        if straight_result is not None:
            return straight_result
        return self._execute_staged_tree_search()

    # 직선 분해 없이 단계적 RRT*만 실행한다.
    def execute_tree_search(self) -> PlanningResult:
        if not self.has_any_feasible_first_move():
            return self._to_immobile_result()
        return self._execute_staged_tree_search()

    # Tier2 RRT*: 평행이동만 샘플링해 먼저 탐색하고, 실패하면(회전 허용 시) 회전까지
    # 샘플링해 다시 탐색한다. 둘 다 실패하면 방향마다 더 멀리 간 경로를 진단용으로 남긴다.
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

    # RRT* 본체: 샘플 → 최근접 노드 → 델타씩 연속 확장 → 부모 선택과 재연결.
    # 새 노드가 목표 여유 이상 떨어지면 목표 후보로 기록한다.
    def _execute_tree_search(self, does_sample_rotation: bool) -> PlanningResult:
        # 단계마다 같은 시드로 난수를 다시 시작해 결과를 재현할 수 있게 한다.
        self.random_generator = np.random.default_rng(self.config.random_seed)
        tree_nodes: List[_TreeNode] = [
            _TreeNode(state=self.start_state, parent_index=None, cost_from_start=0.0)
        ]
        best_goal_index: Optional[int] = None
        best_goal_cost = float("inf")
        # 방향별 최대 분리량과 그 노드 번호(실패 진단용)
        farthest_separations = self.get_axis_separations_at(self.start_state)
        farthest_node_indices = np.zeros((3, 2), dtype=np.int64)

        performed_iteration_count = 0
        for iteration_index in range(self.config.max_iteration_count):
            performed_iteration_count = iteration_index + 1

            sampled_state = self.sample_random_state(does_sample_rotation)
            source_index = self.get_nearest_node(tree_nodes, sampled_state)

            # 샘플을 향해 델타씩 뻗는다. 간섭이 생기거나 샘플에 닿으면 멈춘다.
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

                # 방향별 최대 분리량을 갱신하고, 목표 여유 이상 떨어졌으면
                # 비용이 가장 낮은 목표 노드로 기록한다.
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

            # 첫 경로에서 멈추는 설정이면 여기서 끝낸다.
            if self.config.stops_at_first_feasible_path and best_goal_index is not None:
                break

        # 실패: 방향마다 가장 멀리 간 노드까지의 경로를 진단용으로 만든다.
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

    # 새 상태를 트리에 넣는다: 이웃 중 비용이 가장 낮은 부모를 고르고, 이웃을 재연결한다.
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

    # 최근접 노드를 기본 부모로 두고, 이웃 중 누적 비용이 더 낮고 간섭 없이 이어지는
    # 노드가 있으면 그 노드를 부모로 삼는다.
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

    # 새 노드를 거치는 편이 더 싸고 간섭 없이 이어지는 이웃은 부모를 새 노드로 바꾼다
    # (RRT* 재연결).
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

    # 목표 노드에서 부모를 따라 루트까지 올라간 뒤 순서를 뒤집는다.
    def build_path(
        self, tree_nodes: List[_TreeNode], goal_index: int
    ) -> Tuple[List[State], List[Action]]:
        node_states: List[State] = list()
        node_index: Optional[int] = goal_index
        while node_index is not None:
            node_states.append(tree_nodes[node_index].state)
            node_index = tree_nodes[node_index].parent_index
        node_states.reverse()

        # 노드 사이를 동작(회전 → 평행이동) 단위로 펼친다.
        state_path: List[State] = [node_states[0]]
        action_path: List[Action] = list()
        for segment_index in range(len(node_states) - 1):
            for action, resulting_state in self.get_edge_actions(
                node_states[segment_index], node_states[segment_index + 1]
            ):
                action_path.append(action)
                state_path.append(resulting_state)
        return state_path, action_path

    # 분해 경로를 뒤집어 조립 경로(분해된 상태 → 조립 상태)와 그 동작들을 만든다.
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

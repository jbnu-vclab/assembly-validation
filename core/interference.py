# 부품 사이의 간섭 판정.
# B-rep 솔리드를 삼각분할하고 닫힌 manifold로 복구한 뒤, manifold3d 불린 교집합 부피 V로
# 간섭 길이 L = V^(1/3)을 잰다. 부품 쌍마다 조립 상태의 간섭 길이(L0)를 기준값으로 두고,
# 허용 상한(= L0 + 간섭 증가 허용치)을 넘으면 간섭으로 판정한다.
from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np


# 간섭 판정 중 문제가 생겼을 때 발생시키는 예외
class InterferenceException(Exception):
    pass


# OCC로 솔리드를 삼각분할해 (정점, 면) 배열을 만든다.
# 면 경계에서 좌표가 같은(merge_digits 자리 반올림) 정점은 하나로 합쳐 면 사이 연결을 유지한다.
def triangulate_solid_preserving_topology(
    shape,
    linear_deflection: float = 0.02,
    angular_deflection: float = 0.5,
    merge_digits: int = 6,
) -> Tuple[np.ndarray, np.ndarray]:
    from OCC.Core.BRep import BRep_Tool
    from OCC.Core.BRepMesh import BRepMesh_IncrementalMesh
    from OCC.Core.BRepTools import breptools
    from OCC.Core.TopAbs import TopAbs_FACE, TopAbs_REVERSED
    from OCC.Core.TopExp import TopExp_Explorer
    from OCC.Core.TopLoc import TopLoc_Location
    from OCC.Core.TopoDS import topods

    # 기존 삼각분할을 지우고 선형·각도 허용 오차로 다시 삼각분할한다.
    breptools.Clean(shape)
    BRepMesh_IncrementalMesh(shape, linear_deflection, False, angular_deflection, True)

    vertices: List[List[float]] = list()
    faces: List[List[int]] = list()
    # 반올림한 좌표 → 정점 번호(같은 좌표의 정점을 하나로 합친다)
    index_of_coordinate: Dict[Tuple[float, float, float], int] = dict()

    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    while explorer.More():
        face = topods.Face(explorer.Current())
        location = TopLoc_Location()
        triangulation = BRep_Tool.Triangulation(face, location)
        if triangulation is not None:
            # 면 삼각분할의 노드는 location 변환을 적용해야 형상 좌표가 된다.
            transformation = location.Transformation()
            # 방향이 뒤집힌 면은 꼭짓점 순서를 바꿔 법선이 바깥을 향하게 한다.
            is_reversed = face.Orientation() == TopAbs_REVERSED
            local_indices: List[int] = list()
            for node_number in range(1, triangulation.NbNodes() + 1):
                point = triangulation.Node(node_number).Transformed(transformation)
                coordinate = (
                    round(point.X(), merge_digits),
                    round(point.Y(), merge_digits),
                    round(point.Z(), merge_digits),
                )
                global_index = index_of_coordinate.get(coordinate)
                if global_index is None:
                    global_index = len(vertices)
                    index_of_coordinate[coordinate] = global_index
                    vertices.append([point.X(), point.Y(), point.Z()])
                local_indices.append(global_index)
            # OCC 번호는 1부터 시작한다. 정점을 합쳐 퇴화한 삼각형은 버린다.
            for triangle_number in range(1, triangulation.NbTriangles() + 1):
                first, second, third = triangulation.Triangle(triangle_number).Get()
                a = local_indices[first - 1]
                b = local_indices[second - 1]
                c = local_indices[third - 1]
                if a == b or b == c or a == c:
                    continue
                faces.append([a, c, b] if is_reversed else [a, b, c])
        explorer.Next()

    return np.asarray(vertices, dtype=float), np.asarray(faces, dtype=np.int64)


# (정점, 면)으로 manifold3d.Manifold를 만든다. 생성에 실패하거나 부피가 minimum_volume
# 이하이면 None이다(닫히지 않은 메쉬는 빈 manifold가 되어 부피가 0이다).
def _build_manifold(vertices: np.ndarray, faces: np.ndarray, minimum_volume: float):
    import manifold3d

    try:
        mesh = manifold3d.Mesh(
            vert_properties=np.asarray(vertices, dtype=np.float32),
            tri_verts=np.asarray(faces, dtype=np.uint32),
        )
        manifold = manifold3d.Manifold(mesh)
    except Exception:
        return None
    if manifold.volume() <= minimum_volume:
        return None
    return manifold


# tolerance 간격 격자로 반올림해 가까운 정점을 하나로 합치고,
# 퇴화한 삼각형과 꼭짓점 집합이 같은 중복 삼각형을 지운다.
def _weld_vertices(vertices: np.ndarray, faces: np.ndarray, tolerance: float):
    keys = np.round(vertices / tolerance) * tolerance if tolerance > 0 else vertices
    _, first_index, inverse = np.unique(keys, axis=0, return_index=True, return_inverse=True)
    new_vertices = vertices[first_index]
    new_faces = inverse[faces]
    keep = (
        (new_faces[:, 0] != new_faces[:, 1])
        & (new_faces[:, 1] != new_faces[:, 2])
        & (new_faces[:, 2] != new_faces[:, 0])
    )
    new_faces = new_faces[keep]
    sorted_key = np.sort(new_faces, axis=1)
    _, unique_index = np.unique(sorted_key, axis=0, return_index=True)
    return new_vertices, new_faces[np.sort(unique_index)]


# 한 모서리를 셋 이상의 삼각형이 공유하면(비다양체) 넓이가 큰 두 개만 남긴다.
# 반환: (남은 면, 지운 면 수)
def _drop_nonmanifold_faces(vertices: np.ndarray, faces: np.ndarray):
    triangle = vertices[faces]
    areas = 0.5 * np.linalg.norm(
        np.cross(triangle[:, 1] - triangle[:, 0], triangle[:, 2] - triangle[:, 0]), axis=1
    )
    edge_faces: Dict[Tuple[int, int], List[int]] = dict()
    for index, (a, b, c) in enumerate(faces):
        for u, v in ((a, b), (b, c), (c, a)):
            edge_faces.setdefault((u, v) if u < v else (v, u), []).append(index)
    removed = set()
    for members in edge_faces.values():
        alive = [m for m in members if m not in removed]
        if len(alive) <= 2:
            continue
        alive.sort(key=lambda index: areas[index])
        removed.update(alive[: len(alive) - 2])
    if not removed:
        return faces, 0
    keep = np.array([index not in removed for index in range(len(faces))])
    return faces[keep], len(removed)


# 모서리로 이어진 삼각형을 차례로 따라가며 꼭짓점 순서(면 방향)를 하나로 맞춘다.
# 이웃이 공유 모서리를 같은 방향으로 쓰면 그 이웃을 뒤집는다. 반환: (맞춘 면, 뒤집은 수)
def _unify_orientation(faces: np.ndarray):
    edge_map: Dict[Tuple[int, int], List[int]] = dict()
    for index, (a, b, c) in enumerate(faces):
        for u, v in ((a, b), (b, c), (c, a)):
            edge_map.setdefault((u, v) if u < v else (v, u), []).append(index)
    visited = np.zeros(len(faces), dtype=bool)
    result = faces.copy()
    flip_count = 0
    for seed in range(len(faces)):
        if visited[seed]:
            continue
        visited[seed] = True
        queue = [seed]
        while queue:
            current = queue.pop()
            a, b, c = result[current]
            for u, v in ((a, b), (b, c), (c, a)):
                key = (u, v) if u < v else (v, u)
                for neighbour in edge_map.get(key, ()):
                    if neighbour == current or visited[neighbour]:
                        continue
                    x, y, z = result[neighbour]
                    if ((x, y) == (u, v)) or ((y, z) == (u, v)) or ((z, x) == (u, v)):
                        result[neighbour] = result[neighbour][::-1]
                        flip_count += 1
                    visited[neighbour] = True
                    queue.append(neighbour)
    return result, flip_count


# 반대 방향 짝이 없는 방향 모서리(열린 모서리)를 이어 구멍 경계 고리들을 찾는다.
def _boundary_loops(faces: np.ndarray) -> List[List[int]]:
    directed = set()
    for a, b, c in faces:
        directed.update(((a, b), (b, c), (c, a)))
    open_edges = [(u, v) for (u, v) in directed if (v, u) not in directed]
    successor: Dict[int, List[int]] = dict()
    for u, v in open_edges:
        successor.setdefault(u, []).append(v)
    loops = []
    used = set()
    for start in open_edges:
        if start in used:
            continue
        loop = [start[0], start[1]]
        used.add(start)
        current = start[1]
        while True:
            options = [v for v in successor.get(current, []) if (current, v) not in used]
            if not options:
                break
            following = options[0]
            used.add((current, following))
            if following == loop[0]:
                break
            loop.append(following)
            current = following
            # 비정상 입력에서 끝없이 도는 것을 막는 안전장치
            if len(loop) > 100000:
                break
        if len(loop) >= 3:
            loops.append(loop)
    return loops


# 경계 고리의 중심점과 크기(점들의 경계 상자 대각선 길이)
def _loop_frame(vertices: np.ndarray, loop: List[int]) -> Tuple[np.ndarray, float]:
    points = vertices[loop]
    centre = points.mean(axis=0)
    diameter = float(np.linalg.norm(points.max(axis=0) - points.min(axis=0)))
    return centre, diameter


# 서로 마주 보는 경계 고리 쌍을 고른다. 두 고리 점 사이 최근접 거리의 중앙값이
# 작은 고리 크기의 25% 미만인 쌍을 후보로 두고, 가까운 쌍부터 겹치지 않게 짝짓는다.
# 반환: (짝 목록, 짝 없는 고리 번호 목록)
def _pair_facing_loops(vertices: np.ndarray, loops: List[List[int]]):
    if len(loops) < 2:
        return [], list(range(len(loops)))

    frames = [_loop_frame(vertices, loop) for loop in loops]
    candidates = []
    for i in range(len(loops)):
        for j in range(i + 1, len(loops)):
            points_i = vertices[loops[i]]
            points_j = vertices[loops[j]]
            distances = np.linalg.norm(points_i[:, None, :] - points_j[None, :, :], axis=2)
            gap = float(np.median(distances.min(axis=1)))
            reference = min(frames[i][1], frames[j][1])
            if reference <= 0:
                continue
            if gap < 0.25 * reference:
                candidates.append((gap, i, j))

    candidates.sort()
    paired = set()
    pairs = []
    for _, i, j in candidates:
        if i in paired or j in paired:
            continue
        paired.update((i, j))
        pairs.append((i, j))
    unpaired = [index for index in range(len(loops)) if index not in paired]
    return pairs, unpaired


# 두 고리를 둘레 진행 비율이 맞도록 번갈아 전진하며 삼각형 strip으로 잇는다.
def _zip_loops(vertices: np.ndarray, first: List[int], second: List[int]):
    triangles = []
    i = j = 0
    total_first, total_second = len(first), len(second)
    while i < total_first or j < total_second:
        a_now = first[i % total_first]
        b_now = second[j % total_second]
        if i >= total_first:
            advance_first = False
        elif j >= total_second:
            advance_first = True
        else:
            advance_first = (i + 1) / total_first <= (j + 1) / total_second

        if advance_first:
            a_next = first[(i + 1) % total_first]
            triangles.append((a_next, a_now, b_now))
            i += 1
        else:
            b_next = second[(j + 1) % total_second]
            triangles.append((b_next, b_now, a_now))
            j += 1
    return triangles


# 두 고리를 삼각형 strip으로 잇는다(복구 라벨의 '띠'). 두 번째 고리를 정방향과 역방향으로
# 각각 시작점을 맞춰 이어 보고, 삼각형 최장 모서리 합이 작은 쪽을 고른다.
def _bridge_loops(vertices: np.ndarray, first_loop: List[int], second_loop: List[int]):
    first = list(first_loop)
    second = list(second_loop)
    if len(first) < 3 or len(second) < 3:
        return []

    def align(loop):
        start = int(np.argmin(np.linalg.norm(vertices[loop] - vertices[first[0]], axis=1)))
        return loop[start:] + loop[:start]

    forward = _zip_loops(vertices, first, align(second))
    backward = _zip_loops(vertices, first, align(second[::-1]))

    def strip_cost(triangles):
        if not triangles:
            return float("inf")
        points = vertices[np.asarray(triangles, dtype=np.int64)]
        edges = np.stack([
            np.linalg.norm(points[:, 1] - points[:, 0], axis=1),
            np.linalg.norm(points[:, 2] - points[:, 1], axis=1),
            np.linalg.norm(points[:, 0] - points[:, 2], axis=1),
        ], axis=1)
        return float(edges.max(axis=1).sum())

    return forward if strip_cost(forward) <= strip_cost(backward) else backward


# 고리 중심 정점(centre_index)과 고리 모서리로 부채꼴 삼각형을 만들어 구멍을 막는다
# (복구 라벨의 '덮개').
def _star_cap(vertices: np.ndarray, loop: List[int], centre_index: int):
    return [(loop[position], loop[(position + 1) % len(loop)], centre_index)
            for position in range(len(loop))]


# 짝지은 고리는 strip으로 잇고, 짝 없는 고리는 중심 정점을 추가해 cap으로 막는다.
# 반환: (정점, 면, 추가한 면 수)
def _apply_closure(vertices: np.ndarray, faces: np.ndarray, loops, pairs, unpaired):
    added = []
    for i, j in pairs:
        added.extend(_bridge_loops(vertices, loops[i], loops[j]))

    extra_vertices = []
    next_index = len(vertices)
    for index in unpaired:
        loop = loops[index]
        extra_vertices.append(vertices[loop].mean(axis=0).reshape(1, 3))
        added.extend(_star_cap(vertices, loop, next_index))
        next_index += 1

    if not added:
        return vertices, faces, 0
    new_vertices = np.vstack([vertices] + extra_vertices) if extra_vertices else vertices
    new_faces = np.vstack([faces, np.asarray(added, dtype=faces.dtype)])
    return new_vertices, new_faces, len(added)


# 구멍을 막은 후보 메쉬 목록. 짝이 있으면 마주 보는 고리를 strip으로 잇고 나머지를 cap으로
# 막은 후보를 먼저, 모든 고리를 cap으로 막은 후보를 그다음에 둔다.
# 후보마다 (정점, 면, 추가한 면 수, strip 쌍 수, cap 수)
def _close_boundaries(vertices: np.ndarray, faces: np.ndarray):
    loops = _boundary_loops(faces)
    if not loops:
        return []

    pairs, unpaired = _pair_facing_loops(vertices, loops)

    candidates = []
    if pairs:
        bridged_vertices, bridged_faces, added = _apply_closure(
            vertices, faces, loops, pairs, unpaired
        )
        candidates.append((bridged_vertices, bridged_faces, added, len(pairs), len(unpaired)))

    capped_vertices, capped_faces, added = _apply_closure(
        vertices, faces, loops, [], list(range(len(loops)))
    )
    candidates.append((capped_vertices, capped_faces, added, 0, len(loops)))
    return candidates


# 삼각형과 원점이 이루는 사면체의 부호 있는 부피 합. 음수면 면 방향이 안쪽을 향한다.
def _signed_volume(vertices: np.ndarray, faces: np.ndarray) -> float:
    triangle = vertices[faces]
    return float(
        np.sum(np.einsum("ij,ij->i", triangle[:, 0], np.cross(triangle[:, 1], triangle[:, 2]))) / 6.0
    )


# 메쉬를 닫힌 manifold로 만들 때까지 단계적으로 복구한다.
#   1) 그대로 → 라벨 '직접'
#   2) 정점 용접 + 비다양체 면 제거 + 방향 통일 → '용접+비다양체N+방향M'
#   3) 구멍을 strip/cap으로 막은 후보 → '...+구멍(띠N쌍+덮개M개, K면)'
# 반환: (정점, 면, manifold 또는 None, 복구 라벨). 모두 실패하면 라벨 끝에 ' 실패'가 붙는다.
def repair_mesh_geometry(vertices: np.ndarray, faces: np.ndarray, minimum_volume: float):
    vertices = np.asarray(vertices, dtype=float)
    faces = np.asarray(faces, dtype=np.int64)

    direct = _build_manifold(vertices, faces, minimum_volume)
    if direct is not None:
        return vertices, faces, direct, "직접"

    # 용접 허용 오차 = 메쉬 경계 상자 대각선 길이의 1e-6배
    extent = vertices.max(axis=0) - vertices.min(axis=0)
    scale = float(np.linalg.norm(extent))
    tolerance = 1e-6 * scale if scale > 0 else 0.0

    work_vertices, work_faces = _weld_vertices(vertices, faces, tolerance)
    work_faces, dropped = _drop_nonmanifold_faces(work_vertices, work_faces)
    work_faces, flips = _unify_orientation(work_faces)
    # 부피가 음수면 모든 면을 뒤집어 바깥 방향으로 맞춘다.
    if _signed_volume(work_vertices, work_faces) < 0:
        work_faces = work_faces[:, ::-1]
    label = f"용접+비다양체{dropped}+방향{flips}"
    candidate = _build_manifold(work_vertices, work_faces, minimum_volume)
    if candidate is not None:
        return work_vertices, work_faces, candidate, label

    # 그래도 닫히지 않으면 구멍을 막은 후보를 차례로 시도한다.
    closures = _close_boundaries(work_vertices, work_faces)

    attempts = []
    for filled_vertices, filled_faces, added, bridged, capped in closures:
        detail = []
        if bridged:
            detail.append(f"띠{bridged}쌍")
        if capped:
            detail.append(f"덮개{capped}개")
        attempt_label = f"{label}+구멍({'+'.join(detail)}, {added}면)"
        # 막은 그대로와 방향을 다시 통일한 것 두 가지를 시도한다.
        unified_faces, _ = _unify_orientation(filled_faces)
        for candidate_faces in (filled_faces, unified_faces):
            oriented = candidate_faces
            if _signed_volume(filled_vertices, oriented) < 0:
                oriented = oriented[:, ::-1]
            candidate = _build_manifold(filled_vertices, oriented, minimum_volume)
            if candidate is not None:
                return filled_vertices, oriented, candidate, attempt_label
        attempts.append(attempt_label)
    return work_vertices, work_faces, None, (attempts[0] if attempts else label) + " 실패"


# repair_mesh_geometry 결과를 (manifold, 복구된 정점, 라벨) 순서로 돌려주는 래퍼
def repair_to_manifold(vertices: np.ndarray, faces: np.ndarray, minimum_volume: float):
    repaired_vertices, _, manifold, label = repair_mesh_geometry(vertices, faces, minimum_volume)
    return manifold, repaired_vertices, label


# 겹침 부피 V를 길이로 바꾼다: L = V^(1/3) (V ≤ 0이면 0)
def interference_length(volume: float) -> float:
    if volume <= 0.0:
        return 0.0
    return float(volume) ** (1.0 / 3.0)


# 움직이는 솔리드와 장애물 솔리드의 모든 쌍에 대해 교집합 부피를 더한다.
# 경계 상자가 떨어진 쌍은 건너뛴다. manifold3d에서 ^ 는 교집합이다.
def _sum_pairwise_intersection_volume(moving_solids: List[object], obstacle_solids: List[object]) -> float:
    total = 0.0
    obstacle_boxes = [solid.bounding_box() for solid in obstacle_solids]
    for moving in moving_solids:
        moving_box = moving.bounding_box()
        for obstacle, obstacle_box in zip(obstacle_solids, obstacle_boxes):
            if (
                moving_box[3] < obstacle_box[0]
                or obstacle_box[3] < moving_box[0]
                or moving_box[4] < obstacle_box[1]
                or obstacle_box[4] < moving_box[1]
                or moving_box[5] < obstacle_box[2]
                or obstacle_box[5] < moving_box[2]
            ):
                continue
            total += float((moving ^ obstacle).volume())
    return total


# 4x4 변환 행렬의 위쪽 3x4 부분으로 manifold를 옮긴다.
def _transform_manifold(manifold, transformation_matrix: np.ndarray):
    matrix = np.asarray(transformation_matrix, dtype=float)
    return manifold.transform(matrix[:3, :4])


# 자식 프로세스 작업: 맡은 부품 쌍의 조립 상태 간섭 길이를 계산해 큐에 넣는다.
# 실패한 쌍은 길이 대신 오류 문자열을 담는다.
def _baseline_pair_worker(checker, pairs, transformations, queue) -> None:
    results = list()
    for first, second in pairs:
        try:
            depth = checker.interference_length_between(
                first, transformations[first], second, transformations[second]
            )
        except Exception as failure:
            results.append(((first, second), None, f"{type(failure).__name__}: {failure}"))
            continue
        results.append(((first, second), float(depth), None))
    queue.put(results)


# 부품 쌍들을 worker_count개 프로세스로 나눠 조립 상태 간섭 길이를 병렬 계산한다.
# 하나라도 실패하면 예외. 반환: {(부품 a, 부품 b): 간섭 길이}
def _run_baseline_pairs_parallel(checker, pairs, transformations, worker_count: int):
    import multiprocessing

    # fork로 띄워 manifold를 가진 checker를 피클링 없이 자식에게 넘긴다.
    context = multiprocessing.get_context("fork")
    count = max(1, min(worker_count, len(pairs)))
    # 쌍을 번갈아 나눠 프로세스마다 부하를 고르게 한다.
    chunks = [pairs[index::count] for index in range(count)]
    queue = context.Queue()
    processes = list()
    for chunk in chunks:
        if not chunk:
            continue
        process = context.Process(
            target=_baseline_pair_worker, args=(checker, chunk, transformations, queue)
        )
        process.start()
        processes.append(process)
    collected = dict()
    failures = list()
    # 프로세스 수만큼 결과를 먼저 받은 뒤 join한다(큐를 비우기 전에 join하면 멈출 수 있다).
    for _ in processes:
        for key, value, reason in queue.get():
            if reason is not None:
                failures.append((key, reason))
                continue
            collected[key] = value
    for process in processes:
        process.join()
    if failures:
        detail = "; ".join(f"{pair}: {reason}" for pair, reason in failures[:5])
        raise InterferenceException(
            f"baseline calibration failed for {len(failures)} pair(s): {detail}"
        )
    return collected


# 부품 쌍별 허용 상한. baseline_lengths[a][b]는 조립 상태에서 a와 b의 간섭 길이(L0),
# margin은 간섭 증가 허용치이며, 허용 상한 = L0 + margin이다.
@dataclass(frozen=True)
class InterferenceBudget:
    baseline_lengths: Dict[int, Dict[int, float]]
    margin: float

    # 부품 쌍의 허용 상한. 기준값이 없으면 L0 = 0으로 본다.
    def limit_for(self, moving_solid_id: int, obstacle_solid_id: int) -> float:
        baseline = self.baseline_lengths.get(moving_solid_id, dict()).get(obstacle_solid_id, 0.0)
        return baseline + self.margin


# 부품마다 manifold를 미리 만들어 두고, 주어진 변환에서 두 부품의 간섭 부피와 길이를 계산한다.
# 메쉬를 만들지 못하거나 닫지 못한 부품은 excluded_solid_ids로 빼고 이유를 exclusion_reasons에
# 남긴다.
class InterferenceVolumeChecker:
    def __init__(
        self,
        solid_shapes: Dict[int, object],
        linear_deflection: float = 0.02,
        angular_deflection: float = 0.5,
        merge_digits: int = 6,
        minimum_manifold_volume: float = 1.0,
    ):
        if not solid_shapes:
            raise InterferenceException("at least one solid is required")

        self.solid_shapes = dict(solid_shapes)
        self.manifolds: Dict[int, object] = dict()
        self.local_bounds: Dict[int, np.ndarray] = dict()
        self.recovery_settings_used: Dict[int, str] = dict()
        self.excluded_solid_ids: List[int] = list()
        self.exclusion_reasons: Dict[int, str] = dict()

        # 부품마다 삼각분할 → manifold 복구를 하고 로컬 경계 상자를 저장한다.
        for solid_id, shape in self.solid_shapes.items():
            try:
                vertices, faces = triangulate_solid_preserving_topology(
                    shape, linear_deflection, angular_deflection, merge_digits
                )
            except Exception as error:
                self.excluded_solid_ids.append(solid_id)
                self.exclusion_reasons[solid_id] = f"메쉬 생성 실패: {error}"
                continue
            if len(vertices) == 0 or len(faces) == 0:
                self.excluded_solid_ids.append(solid_id)
                self.exclusion_reasons[solid_id] = "삼각분할 결과가 비었다"
                continue
            self.local_bounds[solid_id] = np.vstack([vertices.min(axis=0), vertices.max(axis=0)])
            manifold, repaired_vertices, label = repair_to_manifold(
                vertices, faces, minimum_manifold_volume
            )
            if manifold is None:
                self.excluded_solid_ids.append(solid_id)
                self.exclusion_reasons[solid_id] = f"복구 후에도 닫히지 않음: {label}"
                continue
            self.manifolds[solid_id] = manifold
            self.local_bounds[solid_id] = np.vstack(
                [repaired_vertices.min(axis=0), repaired_vertices.max(axis=0)]
            )
            # 복구를 거친 부품만 적용한 복구 라벨을 기록한다.
            if label != "직접":
                self.recovery_settings_used[solid_id] = label

        # 제외된 부품은 표에서 지우고, manifold가 하나도 없으면 예외를 발생시킨다.
        if self.excluded_solid_ids:
            for excluded_id in self.excluded_solid_ids:
                self.solid_shapes.pop(excluded_id, None)
                self.local_bounds.pop(excluded_id, None)

            if not self.manifolds:
                raise InterferenceException(
                    "모든 부품이 제외되어 판정할 것이 없다: "
                    + "; ".join(
                        f"{solid_id}: {reason}"
                        for solid_id, reason in self.exclusion_reasons.items()
                    )
                )

    # 부품 manifold를 변환해 리스트로 돌려준다(manifold가 없으면 None).
    def _transformed_solids(self, solid_id: int, transformation_matrix: np.ndarray):
        if solid_id in self.manifolds:
            return [_transform_manifold(self.manifolds[solid_id], transformation_matrix)]
        return None

    # 로컬 경계 상자의 꼭짓점 8개를 변환해 월드 좌표 경계 상자 [[최소], [최대]]를 구한다.
    def world_bounds(self, solid_id: int, transformation_matrix: np.ndarray) -> np.ndarray:
        low, high = self.local_bounds[solid_id]
        corners = np.array(
            [[x, y, z] for x in (low[0], high[0]) for y in (low[1], high[1]) for z in (low[2], high[2])],
            dtype=float,
        )
        matrix = np.asarray(transformation_matrix, dtype=float)
        moved = corners @ matrix[:3, :3].T + matrix[:3, 3]
        return np.vstack([moved.min(axis=0), moved.max(axis=0)])

    # 두 부품을 각 변환에 놓았을 때의 겹침 부피. 경계 상자가 떨어져 있으면 불린 연산 없이 0.
    def interference_volume(
        self,
        moving_solid_id: int,
        moving_transformation: np.ndarray,
        obstacle_solid_id: int,
        obstacle_transformation: np.ndarray,
    ) -> float:
        moving_bounds = self.world_bounds(moving_solid_id, moving_transformation)
        obstacle_bounds = self.world_bounds(obstacle_solid_id, obstacle_transformation)
        if np.any(moving_bounds[1] < obstacle_bounds[0]) or np.any(
            obstacle_bounds[1] < moving_bounds[0]
        ):
            return 0.0

        moving_solids = self._transformed_solids(moving_solid_id, moving_transformation)
        obstacle_solids = self._transformed_solids(obstacle_solid_id, obstacle_transformation)
        if moving_solids is None or obstacle_solids is None:
            missing = moving_solid_id if moving_solids is None else obstacle_solid_id
            raise InterferenceException(
                f"solid {missing} has no mesh backend; the general repair is expected to "
                "close every part, so this should have been caught at construction"
            )
        return _sum_pairwise_intersection_volume(moving_solids, obstacle_solids)

    # 두 부품을 각 변환에 놓았을 때의 간섭 길이 L = V^(1/3)
    def interference_length_between(
        self,
        moving_solid_id: int,
        moving_transformation: np.ndarray,
        obstacle_solid_id: int,
        obstacle_transformation: np.ndarray,
    ) -> float:
        moving_bounds = self.world_bounds(moving_solid_id, moving_transformation)
        obstacle_bounds = self.world_bounds(obstacle_solid_id, obstacle_transformation)
        if np.any(moving_bounds[1] < obstacle_bounds[0]) or np.any(
            obstacle_bounds[1] < moving_bounds[0]
        ):
            return 0.0

        moving_solids = self._transformed_solids(moving_solid_id, moving_transformation)
        obstacle_solids = self._transformed_solids(obstacle_solid_id, obstacle_transformation)
        if moving_solids is None or obstacle_solids is None:
            missing = moving_solid_id if moving_solids is None else obstacle_solid_id
            raise InterferenceException(
                f"solid {missing} has no mesh backend; the general repair is expected to "
                "close every part, so this should have been caught at construction"
            )
        volume = _sum_pairwise_intersection_volume(moving_solids, obstacle_solids)
        return interference_length(volume)

    # 조립 상태에서 모든 부품 쌍의 간섭 길이(L0)를 재서 허용 상한표를 만든다.
    # 조립 상태에 이미 있는 겹침(접촉, 끼워맞춤)은 허용하고, 그보다 margin을 넘게 커질 때만
    # 간섭으로 본다.
    def calibrate_baselines(
        self,
        assembled_transformations: Dict[int, np.ndarray],
        margin: float,
        worker_count: int,
    ) -> InterferenceBudget:
        solid_ids = sorted(self.solid_shapes)
        baselines: Dict[int, Dict[int, float]] = {solid_id: dict() for solid_id in solid_ids}
        pairs = [
            (first, second)
            for a_index, first in enumerate(solid_ids)
            for second in solid_ids[a_index + 1 :]
        ]

        # worker_count가 2 이상이면 병렬로, 아니면 차례로 계산한다.
        if worker_count > 1 and len(pairs) > 1:
            computed = _run_baseline_pairs_parallel(self, pairs, assembled_transformations, worker_count)
        else:
            computed = {
                (first, second): self.interference_length_between(
                    first,
                    assembled_transformations[first],
                    second,
                    assembled_transformations[second],
                )
                for first, second in pairs
            }
        for (first, second), depth in computed.items():
            baselines[first][second] = depth
            baselines[second][first] = depth
        return InterferenceBudget(baseline_lengths=baselines, margin=float(margin))

    # 허용 상한을 넘는 장애물을 (장애물 번호, 간섭 길이, 허용 상한) 목록으로 돌려준다.
    def find_interfering_obstacles(
        self,
        moving_solid_id: int,
        moving_transformation: np.ndarray,
        obstacle_transformations: Dict[int, np.ndarray],
        budget: InterferenceBudget,
    ) -> List[Tuple[int, float, float]]:
        offenders: List[Tuple[int, float, float]] = list()
        for obstacle_solid_id, obstacle_transformation in obstacle_transformations.items():
            if obstacle_solid_id == moving_solid_id:
                continue
            limit = budget.limit_for(moving_solid_id, obstacle_solid_id)
            depth = self.interference_length_between(
                moving_solid_id, moving_transformation, obstacle_solid_id, obstacle_transformation
            )
            if depth > limit:
                offenders.append((obstacle_solid_id, depth, limit))
        return offenders

    # 움직이는 부품이 모든 장애물에 대해 허용 상한 이내이면 True
    def is_transformation_valid(
        self,
        moving_solid_id: int,
        moving_transformation: np.ndarray,
        obstacle_transformations: Dict[int, np.ndarray],
        budget: InterferenceBudget,
    ) -> bool:
        for obstacle_solid_id, obstacle_transformation in obstacle_transformations.items():
            if obstacle_solid_id == moving_solid_id:
                continue
            limit = budget.limit_for(moving_solid_id, obstacle_solid_id)
            depth = self.interference_length_between(
                moving_solid_id, moving_transformation, obstacle_solid_id, obstacle_transformation
            )
            if depth > limit:
                return False
        return True


# 실패 진단용 겹침 정보: 장애물 번호, 간섭 길이와 허용 상한, 상한 초과 여부,
# 겹침 부피, 겹침 메쉬(정점, 면)
@dataclass(frozen=True)
class OverlapRegion:
    obstacle_solid_id: int
    interference_length: float
    interference_limit: float
    is_over_limit: bool
    overlap_volume: float
    overlap_vertices: np.ndarray
    overlap_faces: np.ndarray


# 움직이는 부품 하나와 조립 위치에 고정된 장애물들 사이의 간섭 판정 세션.
# 장애물 manifold를 미리 변환해 두고, 판정 결과를 변환 행렬 키로 캐시한다.
class InterferenceSession:
    def __init__(
        self,
        checker: InterferenceVolumeChecker,
        moving_solid_id: int,
        obstacle_transformations: Dict[int, np.ndarray],
        budget: InterferenceBudget,
    ):
        self.checker = checker
        self.moving_solid_id = moving_solid_id
        self.budget = budget
        # 움직이는 부품 자신은 장애물에서 뺀다.
        self.obstacle_transformations = {
            solid_id: np.asarray(matrix, dtype=float)
            for solid_id, matrix in obstacle_transformations.items()
            if solid_id != moving_solid_id
        }
        if not self.obstacle_transformations:
            raise InterferenceException(
                "at least one obstacle besides the moving solid is required"
            )
        # 장애물의 월드 경계 상자와 변환된 manifold를 미리 만들어 둔다.
        self.obstacle_world_bounds = {
            solid_id: checker.world_bounds(solid_id, matrix)
            for solid_id, matrix in self.obstacle_transformations.items()
        }
        self.transformed_obstacles: Dict[int, List[object]] = dict()
        for solid_id, matrix in self.obstacle_transformations.items():
            transformed = checker._transformed_solids(solid_id, matrix)
            if transformed is not None:
                self.transformed_obstacles[solid_id] = transformed
        # 판정 요청 수와 실제 불린 연산 수(통계용)
        self.query_count = 0
        self.boolean_count = 0

        # 변환 행렬 키 → 판정 결과 캐시
        self.decision_cache: Dict[Tuple, bool] = dict()
        self.cache_hit_count = 0

    # 캐시 키: 변환 행렬을 소수 둘째 자리로 반올림한 튜플(이 차이 안의 변환은 같은 판정을 쓴다)
    @staticmethod
    def _transformation_key(transformation_matrix: np.ndarray) -> Tuple:
        return tuple(np.round(np.asarray(transformation_matrix, dtype=float).ravel(), 2))

    # 움직이는 부품을 moving_transformation에 놓았을 때 장애물 하나와의 간섭 길이
    def interference_length_against(
        self, obstacle_solid_id: int, moving_transformation: np.ndarray
    ) -> float:
        self.query_count += 1
        moving_bounds = self.checker.world_bounds(self.moving_solid_id, moving_transformation)
        obstacle_bounds = self.obstacle_world_bounds[obstacle_solid_id]
        # 경계 상자가 떨어져 있으면 불린 연산 없이 0
        if np.any(moving_bounds[1] < obstacle_bounds[0]) or np.any(
            obstacle_bounds[1] < moving_bounds[0]
        ):
            return 0.0

        self.boolean_count += 1
        # 미리 변환해 둔 장애물 manifold로 계산하고, 없으면 checker로 계산한다.
        if obstacle_solid_id in self.transformed_obstacles:
            moving_solids = self.checker._transformed_solids(
                self.moving_solid_id, moving_transformation
            )
            if moving_solids is not None:
                volume = _sum_pairwise_intersection_volume(
                    moving_solids, self.transformed_obstacles[obstacle_solid_id]
                )
                return interference_length(volume)

        return self.checker.interference_length_between(
            self.moving_solid_id,
            moving_transformation,
            obstacle_solid_id,
            self.obstacle_transformations[obstacle_solid_id],
        )

    # 겹치는 장애물마다 교집합 메쉬를 모아 OverlapRegion 목록을 만든다(실패 진단 저장용).
    def get_overlap_regions(self, moving_transformation: np.ndarray) -> List[OverlapRegion]:
        moving_solids = self.checker._transformed_solids(
            self.moving_solid_id, moving_transformation
        )
        if moving_solids is None:
            raise InterferenceException(
                f"solid {self.moving_solid_id} has no mesh backend; the general repair is "
                "expected to close every part, so this should have been caught at construction"
            )
        moving_bounds = self.checker.world_bounds(self.moving_solid_id, moving_transformation)

        overlap_regions: List[OverlapRegion] = list()
        for obstacle_solid_id, obstacle_solids in self.transformed_obstacles.items():
            obstacle_bounds = self.obstacle_world_bounds[obstacle_solid_id]
            if np.any(moving_bounds[1] < obstacle_bounds[0]) or np.any(
                obstacle_bounds[1] < moving_bounds[0]
            ):
                continue

            overlap_volume = 0.0
            vertex_blocks: List[np.ndarray] = list()
            face_blocks: List[np.ndarray] = list()
            # 조각 여러 개를 한 메쉬로 합치도록 면의 정점 번호를 앞 조각들의 정점 수만큼 민다.
            vertex_offset = 0
            for moving_solid in moving_solids:
                for obstacle_solid in obstacle_solids:
                    intersection = moving_solid ^ obstacle_solid
                    piece_volume = float(intersection.volume())
                    if piece_volume <= 0.0:
                        continue
                    overlap_volume += piece_volume
                    intersection_mesh = intersection.to_mesh()
                    piece_vertices = np.asarray(
                        intersection_mesh.vert_properties, dtype=float
                    )[:, :3]
                    piece_faces = np.asarray(intersection_mesh.tri_verts, dtype=np.int64)
                    vertex_blocks.append(piece_vertices)
                    face_blocks.append(piece_faces + vertex_offset)
                    vertex_offset += len(piece_vertices)
            if overlap_volume <= 0.0:
                continue

            limit = self.budget.limit_for(self.moving_solid_id, obstacle_solid_id)
            length = interference_length(overlap_volume)
            overlap_regions.append(
                OverlapRegion(
                    obstacle_solid_id=int(obstacle_solid_id),
                    interference_length=float(length),
                    interference_limit=float(limit),
                    is_over_limit=bool(length > limit),
                    overlap_volume=float(overlap_volume),
                    overlap_vertices=np.vstack(vertex_blocks),
                    overlap_faces=np.vstack(face_blocks),
                )
            )
        return overlap_regions

    # 모든 장애물에 대해 간섭 길이가 허용 상한 이내인지 판정한다(캐시 사용).
    def is_transformation_valid(self, moving_transformation: np.ndarray) -> bool:
        cache_key = self._transformation_key(moving_transformation)
        cached = self.decision_cache.get(cache_key)
        if cached is not None:
            self.cache_hit_count += 1
            return cached

        result = True
        for obstacle_solid_id in self.obstacle_transformations:
            limit = self.budget.limit_for(self.moving_solid_id, obstacle_solid_id)
            depth = self.interference_length_against(obstacle_solid_id, moving_transformation)
            if depth > limit:
                result = False
                break

        self.decision_cache[cache_key] = result
        return result

    # 두 변환 사이를 interpolation_count 등분한 점마다 판정한다.
    # 위치는 선형 보간하고, 회전은 절반을 넘으면 끝 회전으로 바꾼다.
    def is_segment_valid(
        self,
        start_transformation: np.ndarray,
        end_transformation: np.ndarray,
        interpolation_count: int,
    ) -> bool:
        if interpolation_count < 2:
            raise InterferenceException("interpolation_count must be at least 2")
        start = np.asarray(start_transformation, dtype=float)
        end = np.asarray(end_transformation, dtype=float)
        for step in range(interpolation_count + 1):
            ratio = step / interpolation_count
            matrix = start.copy()
            matrix[:3, 3] = start[:3, 3] * (1.0 - ratio) + end[:3, 3] * ratio
            if ratio > 0.5:
                matrix[:3, :3] = end[:3, :3]
            if not self.is_transformation_valid(matrix):
                return False
        return True

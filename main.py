import os
import sys
import time
import unicodedata
from dataclasses import replace

import hydra
import numpy as np
import trimesh
from omegaconf import DictConfig

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from core.action import Action, ActionType
from core.interference import (
    InterferenceSession,
    InterferenceVolumeChecker,
    repair_mesh_geometry,
)
from core.planner import (
    PlanningException,
    PlanningResult,
    RRTStarConfig,
    RRTStarPlanner,
    get_axis_aligned_separation,
)
from core.state import State
from data.exporter import (
    DiagnosedPose,
    MsgpackTrajectorySerializer,
    SolidFailureDiagnosis,
)
from data.loader import STEPLoader, match_solids_to_step

def _display_width(text: str) -> int:
    return sum(2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1 for ch in text)


def _pad(text: str, width: int, does_align_right: bool = False) -> str:
    padding = " " * max(0, width - _display_width(text))
    return padding + text if does_align_right else text + padding


def print_table(headers, rows, alignments=None) -> None:
    if alignments is None:
        alignments = ["<"] * len(headers)
    widths = [max(_display_width(headers[i]),
                  *(_display_width(row[i]) for row in rows)) if rows
              else _display_width(headers[i])
              for i in range(len(headers))]
    align_right = [alignments[i] == ">" for i in range(len(headers))]
    def render(cells):
        return ("  " + "  ".join(_pad(cells[i], widths[i], align_right[i])
                                 for i in range(len(headers)))).rstrip()

    print(render(headers), flush=True)
    print(render(["─" * width for width in widths]), flush=True)
    for row in rows:
        print(render(row), flush=True)


def print_section(title: str) -> None:
    print(f"\n── {title} " + "─" * max(0, 74 - _display_width(title)), flush=True)


def print_msgpack_structure(document, output_path: str) -> None:
    metadata = document["metadata"]
    solids = document["solids"]
    trajectories = document["trajectories"]
    failures = document["failures"]

    print_section("산출물 구조")
    print(f"  {os.path.basename(output_path)}  "
          f"({os.path.getsize(output_path) / 1e6:.1f} MB)", flush=True)
    vertex_total = sum(len(solids[key]["mesh"]["vertices"]) for key in solids)
    face_total = sum(len(solids[key]["mesh"]["faces"]) for key in solids)
    sample_key = next(iter(sorted(solids)))
    sample_step = next(iter(sorted(trajectories))) if trajectories else None
    conversion_counts = dict()
    for key in solids:
        result = str(solids[key].get("conversion", "—"))
        conversion_counts[result] = conversion_counts.get(result, 0) + 1
    lines = [
        ("metadata", ""),
        ("  step_path", str(metadata["step_path"])),
        ("  global_bbox", f"min {[round(v, 1) for v in metadata['global_bbox']['min']]}  "
                          f"max {[round(v, 1) for v in metadata['global_bbox']['max']]}"),
        ("  excluded_bodies", f"{len(metadata.get('excluded_bodies', []))}개 "
                             "(형상조차 얻지 못해 판정에서 뺀 몸체)"),
        ("  unwatertight_bodies", f"{len(metadata.get('unwatertight_bodies', []))}개 "
                                 "(형상은 담고 판정에서만 뺀 몸체)"),
        ("solids", f"{len(solids)}개  ·  정점 {vertex_total:,}  ·  삼각형 {face_total:,}"),
        (f"  [{sample_key}].name", str(solids[sample_key].get("name", "—"))),
        (f"  [{sample_key}].conversion",
         str(solids[sample_key].get("conversion", "—"))
         + "  (전체: " + ", ".join(f"{key} {value}개" for key, value
                                   in sorted(conversion_counts.items())) + ")"),
        (f"  [{sample_key}].mesh", f"vertices {len(solids[sample_key]['mesh']['vertices']):,} x 3  ·  "
                                   f"faces {len(solids[sample_key]['mesh']['faces']):,} x 3"),
        (f"  [{sample_key}].state", f"position {solids[sample_key]['state']['position']}  ·  "
                                     f"rotation {solids[sample_key]['state']['rotation']}  "
                                     "(조립 상태)"),
        ("trajectories", f"{len(trajectories)} 스텝  (분해 순서 — 뒤집으면 조립 순서)"),
    ]
    if sample_step is not None:
        entry = trajectories[sample_step]
        lines.append((f"  [{sample_step}]", f"solid {entry['solid']}  ·  "
                                            f"action {entry['action']['type']}  ·  "
                                            "state = 도달 위치·자세"))
    lines.append(("failures", f"{len(failures)}개 부품  "
                              "(분해하지 못한 부품 — 어디까지 갔고 어디가 걸렸는가)"))
    if failures:
        sample_failure_key = next(iter(sorted(failures)))
        sample_failure = failures[sample_failure_key]
        blocked_pose = sample_failure["first_blocked_pose"]
        valid_pose = sample_failure["last_valid_pose"]
        lines.extend([
            (f"  [{sample_failure_key}] 항목 필드",
             f"{', '.join(sample_failure)}  "
             f"(부품 이름은 solids[{sample_failure_key}].name — 여기 담지 않는다)"),
            (f"  [{sample_failure_key}].closest_path",
             f"{len(sample_failure['closest_path'])} 스텝  "
             "(trajectories 와 같은 구조 — 같은 재생 코드를 쓴다)"),
            (f"  [{sample_failure_key}].last_valid_pose",
             "없음 (조립 상태부터 상한 초과 — 충돌 없는 자세가 없다)" if valid_pose is None
             else f"state 만  (충돌 없는 마지막 자세 — 겹침은 담지 않는다)"),
            (f"  [{sample_failure_key}].first_blocked_pose",
             "없음 (이 방향은 열려 있었다)" if blocked_pose is None
             else f"겹침 {len(blocked_pose['overlaps'])}개  (더 밀었을 때 처음 막힌 자세)"),
        ])
        if blocked_pose is not None and blocked_pose["overlaps"]:
            sample_overlap = blocked_pose["overlaps"][next(iter(sorted(blocked_pose["overlaps"])))]
            lines.append((f"    …first_blocked_pose.overlaps[0]",
                          f"obstacle {sample_overlap['obstacle']}  ·  "
                          f"is_over_limit {sample_overlap['is_over_limit']}  ·  "
                          f"mesh vertices {len(sample_overlap['mesh']['vertices']):,} x 3  ·  "
                          f"faces {len(sample_overlap['mesh']['faces']):,} x 3"))
    label_width = max(_display_width(label) for label, _ in lines)
    for label, value in lines:
        print(("  " + _pad(label, label_width)
               + ("  " + value if value else "")).rstrip(), flush=True)

    if failures:
        print_section("분해 실패 진단  (저장된 failures 재판독)")
        failure_rows = []
        for failure_key in sorted(failures):
            entry = failures[failure_key]
            blocked_pose = entry["first_blocked_pose"]
            failure_name = str(solids[failure_key].get("name", ""))[:14]
            path_step_count = f"{len(entry['closest_path'])}"
            if blocked_pose is None:
                failure_rows.append([str(failure_key), failure_name, path_step_count,
                                     "—", "—", "—",
                                     "개방 방향이 끝까지 열려 있어 막힘 자세가 없다"])
                continue
            overlaps = [blocked_pose["overlaps"][key]
                        for key in sorted(blocked_pose["overlaps"])]
            over_limit_overlaps = sorted(
                (overlap for overlap in overlaps if overlap["is_over_limit"]),
                key=lambda overlap: -len(overlap["mesh"]["faces"]),
            )
            failure_rows.append([
                str(failure_key),
                failure_name,
                path_step_count,
                "없음" if entry["last_valid_pose"] is None else "있음",
                f"{len(overlaps)}",
                f"{len(over_limit_overlaps)}",
                ", ".join(f"{overlap['obstacle']}:"
                          f"{solids[overlap['obstacle']].get('name', '')}"
                          f"({len(overlap['mesh']['faces']):,}삼각형)"
                          for overlap in over_limit_overlaps[:2]) or "—",
            ])
        print_table(
            ["번호", "이름", "경로", "유효자세", "막힘 겹침", "초과", "상한 초과 장애물(겹침 크기)"],
            failure_rows,
            [">", "<", ">", "<", ">", ">", "<"],
        )

    if not trajectories:
        return

    segments = []
    for key in sorted(trajectories):
        entry = trajectories[key]
        solid_id = entry["solid"]
        if segments and segments[-1]["solid"] == solid_id:
            segments[-1]["steps"].append(entry)
        else:
            segments.append(dict(solid=solid_id, steps=[entry]))

    names_by_id = {int(key): str(value.get("name", "")) for key, value in solids.items()}

    print_section("분해 경로  (역순이 조립 경로)")
    rows = []
    for order, segment in enumerate(segments, 1):
        solid_id = int(segment["solid"])
        steps = segment["steps"]
        start = np.asarray(solids[solid_id]["state"]["position"], dtype=float)
        finish = np.asarray(steps[-1]["state"]["position"], dtype=float)
        displacement = finish - start
        axis = int(np.argmax(np.abs(displacement)))
        rotation_count = sum(1 for step in steps if step["action"]["type"] != "translation")
        rows.append([
            str(order),
            str(solid_id),
            names_by_id.get(solid_id, "")[:16],
            f"{len(steps)}",
            f"{'XYZ'[axis]}{'+' if displacement[axis] >= 0 else '-'}",
            f"{float(np.linalg.norm(displacement)):.1f}",
            f"{rotation_count}" if rotation_count else "—",
            f"{steps[-1]['state']['rotation']}",
        ])
    print_table(
        ["순서", "번호", "이름", "스텝", "축", "이동거리", "회전", "최종 자세"],
        rows,
        [">", ">", "<", ">", "<", ">", ">", "<"],
    )
    print(f"\n  조립 경로는 위 {len(segments)}개 구간을 역순으로, 각 구간의 스텝도 역순으로,"
          f" 각 동작의 값을 반대로 적용해 얻는다.", flush=True)


def to_waypoint_steps(moving_solid_id, states, actions):
    if len(actions) != len(states) - 1:
        raise RuntimeError(
            f"부품 {moving_solid_id}: 상태 {len(states)}개에 동작 {len(actions)}개 — "
            "동작은 상태보다 정확히 하나 적어야 한다"
        )
    waypoint_steps = []
    for previous_state, state, action in zip(states[:-1], states[1:], actions):
        if action.action_type != ActionType.TRANSLATION:
            waypoint_steps.append((moving_solid_id, state, action))
            continue
        displacement = np.asarray(action.value, dtype=float)
        distance = float(np.linalg.norm(displacement))
        piece_count = max(1, int(np.ceil(distance / TRAJECTORY_WAYPOINT_STEP)))
        piece = displacement / piece_count
        position = np.asarray(previous_state.position, dtype=float)
        for piece_index in range(piece_count):
            position = position + piece
            if piece_index == piece_count - 1:
                position = np.asarray(state.position, dtype=float)
            waypoint_steps.append((
                moving_solid_id,
                State(position=tuple(position), rotation=state.rotation),
                Action(action_type=ActionType.TRANSLATION, value=tuple(piece)),
            ))
    return waypoint_steps


def to_resolution_tier(result):
    if result.rotation_iteration_count > 0:
        return f"Tier2 회전 RRT* {result.rotation_iteration_count}회"
    if result.iteration_count > 0:
        return f"Tier2 병진 RRT* {result.translation_iteration_count}회"
    first_translation = np.abs(np.asarray(result.actions[0].value, dtype=float))
    total_translation = np.abs(
        np.asarray(result.states[-1].position, dtype=float)
        - np.asarray(result.states[0].position, dtype=float)
    )
    if int(np.argmax(first_translation)) != int(np.argmax(total_translation)):
        return "Tier1 옆+직선"
    return "Tier1 직선"


ESCAPE_DISTANCE = 400.0

TRAJECTORY_WAYPOINT_STEP = 50.0


def execute_disassembly_search(
    step_path: str,
    output_path: str,
    worker_count: int,
    iteration_count: int,
    does_sample_rotation: bool,
    random_seed: int,
    time_budget_seconds: float,
    max_interference_growth: float,
):
    search_started = time.time()
    output_directory = os.path.dirname(os.path.abspath(output_path))
    if output_directory:
        os.makedirs(output_directory, exist_ok=True)

    def elapsed() -> str:
        return f"{time.time() - search_started:6.1f}s"

    print_section(f"입력  {os.path.basename(step_path)}")

    loader = STEPLoader(step_path, face_tolerance=0.02, angle_tolerance=0.5, max_workers=8)
    meshes, signatures, seen_signatures, repair_labels, names = {}, {}, set(), {}, {}
    name_sources, hash_named_ids = {}, []
    display_meshes, display_names, display_signatures, display_reasons = {}, {}, {}, {}
    excluded_bodies = []
    for mesh in loader.load_all():
        signature = STEPLoader.mesh_signature(mesh.vertices)
        if signature in seen_signatures:
            continue
        seen_signatures.add(signature)
        repaired_vertices, repaired_faces, manifold, repair_label = repair_mesh_geometry(
            np.asarray(mesh.vertices, dtype=float),
            np.asarray(mesh.faces, dtype=np.int64),
            1e-9,
        )
        if manifold is None:
            display_id = len(display_meshes)
            display_meshes[display_id] = trimesh.Trimesh(
                vertices=np.asarray(mesh.vertices, float),
                faces=np.asarray(mesh.faces, np.int64),
                process=False,
            )
            display_names[display_id] = str(mesh.metadata["name"])
            display_signatures[display_id] = signature
            display_reasons[display_id] = f"복구 후에도 닫히지 않음: {repair_label}"
            continue
        solid_id = len(meshes)
        meshes[solid_id] = trimesh.Trimesh(
            vertices=repaired_vertices, faces=repaired_faces, process=False
        )
        signatures[solid_id] = signature
        names[solid_id] = str(mesh.metadata["name"])
        name_sources[solid_id] = str(mesh.metadata.get("name_source", "occ"))
        if name_sources[solid_id] == "hash":
            hash_named_ids.append(solid_id)
        if repair_label != "직접":
            repair_labels[solid_id] = repair_label
    for skipped_name, skipped_reason in getattr(loader, "skipped_bodies", []):
        excluded_bodies.append(("", str(skipped_name), str(skipped_reason)))

    solid_ids = sorted(meshes)
    if not solid_ids:
        raise RuntimeError(
            "모든 몸체가 제외되어 판정할 것이 없다: "
            + "; ".join(f"{name}: {reason}" for _, name, reason in excluded_bodies)
        )
    step_named_ids = [i for i in solid_ids if i not in hash_named_ids]

    extents = {i: np.asarray(meshes[i].bounds[1]) - np.asarray(meshes[i].bounds[0])
               for i in solid_ids}
    vertex_arrays = {i: np.asarray(meshes[i].vertices, float) for i in solid_ids}
    shapes = match_solids_to_step(vertex_arrays, step_path, maximum_error=2.0)
    identity = np.eye(4)
    assembled_states = {i: State((0.0, 0.0, 0.0), (0, 0, 0)) for i in solid_ids}

    smallest_extent = min(float(np.min(extents[i])) for i in solid_ids)
    spacing = smallest_extent / 2.0
    global_low = np.min([np.asarray(meshes[i].bounds[0]) for i in solid_ids], axis=0)
    global_high = np.max([np.asarray(meshes[i].bounds[1]) for i in solid_ids], axis=0)
    assembly_span = float(np.max(global_high - global_low))

    print(f"  부품 {len(solid_ids)}개  ·  B-rep 대응 {len(shapes)}/{len(solid_ids)}"
          f"  ·  이름 {len(step_named_ids)}/{len(solid_ids)} STEP"
          + (f" + {len(hash_named_ids)} 해시" if hash_named_ids else "")
          + f"  ·  {elapsed()}", flush=True)
    print(f"  조립체 span {assembly_span:.1f}  ·  최소 부품 두께 {smallest_extent:.2f}"
          f"  ·  탐색 스텝 {spacing:.2f}", flush=True)
    if repair_labels:
        print(f"  메쉬 복구 {len(repair_labels)}/{len(solid_ids)}: "
              + ", ".join(f"{signatures[i]}({repair_labels[i]})"
                          for i in sorted(repair_labels)), flush=True)
    if excluded_bodies:
        print(f"  제외 {len(excluded_bodies)}개: "
              + ", ".join(f"{name}({reason[:36]})" for _, name, reason in excluded_bodies),
              flush=True)

    print_section("부품")
    print_table(
        ["서명", "이름", "부피", "AABB (x·y·z)"],
        [[signatures[i], str(names.get(i, "")),
          f"{float(meshes[i].volume):,.0f}" if meshes[i].is_volume else "—",
          " · ".join(f"{value:.1f}" for value in extents[i])]
         for i in sorted(solid_ids, key=lambda k: -float(np.prod(extents[k])))],
        ["<", "<", ">", "<"],
    )

    preparation_started = time.time()
    checker = InterferenceVolumeChecker(shapes)
    for excluded_id in getattr(checker, "excluded_solid_ids", []):
        reason = checker.exclusion_reasons.get(excluded_id, "판정기 구성 중 제외")
        excluded_bodies.append((signatures.get(excluded_id, ""),
                                names.get(excluded_id, str(excluded_id)),
                                f"판정기: {reason}"))
        for table in (meshes, shapes, extents, vertex_arrays, assembled_states,
                      signatures, names):
            table.pop(excluded_id, None)
    solid_ids = sorted(meshes)
    if not solid_ids:
        raise RuntimeError(
            "판정기 구성 후 남은 부품이 없다: "
            + "; ".join(f"{name}: {reason}" for _, name, reason in excluded_bodies)
        )
    if getattr(checker, "excluded_solid_ids", []):
        print(f"  판정기 추가 제외 {len(checker.excluded_solid_ids)}개 "
              f"-> 남은 부품 {len(solid_ids)}개", flush=True)

    budget = checker.calibrate_baselines({i: identity for i in solid_ids},
                                         margin=float(max_interference_growth),
                                         worker_count=worker_count)
    CONTACT_REPORT_THRESHOLD = 1e-3
    contact_pairs = {
        frozenset((first, second)): length
        for first, obstacles in budget.baseline_lengths.items()
        for second, length in obstacles.items()
        if length > CONTACT_REPORT_THRESHOLD and first != second
    }
    contact_lengths = sorted(contact_pairs.values())
    print_section("충돌 판정")
    print(f"  방식      삼각형 메쉬 불린(manifold3d), 간섭 길이 L = V^(1/3)", flush=True)
    print(f"  허용 증가 {max_interference_growth:g}  "
          f"(쌍별 상한 = 조립 상태 간섭 길이 + 이 값)", flush=True)
    if contact_lengths:
        print(f"  조립 간섭 쌍 {len(contact_lengths)}개  ·  길이 최대 "
              f"{contact_lengths[-1]:.3f} / 중앙 "
              f"{contact_lengths[len(contact_lengths) // 2]:.3f}"
              f"  (길이 {CONTACT_REPORT_THRESHOLD:g} 이하는 세지 않음)", flush=True)
    else:
        print(f"  조립 간섭 없음 (모든 쌍 길이 {CONTACT_REPORT_THRESHOLD:g} 이하)",
              flush=True)
    print(f"  manifold {len(checker.manifolds)}/{len(solid_ids)}  ·  준비 "
          f"{time.time() - preparation_started:.1f}s  ·  {elapsed()}", flush=True)

    config = RRTStarConfig(
        max_iteration_count=iteration_count,
        translation_step_size=spacing,
        neighbor_radius=spacing * 3.0,
        goal_sample_rate=0.3,
        rotation_distance_weight=spacing,
        translation_interpolation_count=8,
        rotation_interpolation_count=8,
        removal_clearance=spacing,
        sampling_margin_ratio=1.0,
        does_sample_rotation=does_sample_rotation,
        maximum_extension_step_count=int(np.ceil(assembly_span * 2.0 / spacing)) + 2,
        stops_at_first_feasible_path=True,
        random_seed=random_seed,
    )
    print_section("RRT* 설정")
    print_table(
        ["항목", "값", "유도"],
        [["최대 반복", f"{iteration_count}", "config.search.iteration_count"],
         ["병진 스텝", f"{spacing:.2f}", "최소 부품 두께 / 2"],
         ["이웃 반경", f"{config.neighbor_radius:.2f}", "스텝 x 3"],
         ["회전 가중", f"{config.rotation_distance_weight:.2f}", "스텝 (전이 1회 = 1스텝)"],
         ["목표 여유", f"{config.removal_clearance:.2f}", "스텝"],
         ["확장 한계", f"{config.maximum_extension_step_count}", "조립체 span x 2 / 스텝"],
         ["회전 탐색", "병진 실패 시 24 자세" if does_sample_rotation else "병진만", "config"],
         ["시드", f"{random_seed}", "config"]],
        ["<", ">", "<"],
    )

    def extend_to_escape(planner, result):
        final_state = result.states[-1]
        start_position = np.asarray(planner.start_state.position, dtype=float)
        final_position = np.asarray(final_state.position, dtype=float)
        displacement = final_position - start_position

        axis = int(np.argmax(np.abs(displacement)))
        sign = 1.0 if displacement[axis] >= 0.0 else -1.0
        remaining = ESCAPE_DISTANCE - abs(displacement[axis])
        if remaining <= 0.0:
            return result

        escape_position = final_position.copy()
        escape_position[axis] += sign * remaining
        escape_state = State(position=tuple(escape_position), rotation=final_state.rotation)

        if not planner.collision_session.is_valid_state(escape_state):
            return result
        if not planner._segment_valid(
            final_state, escape_state,
            planner._straight_interpolation_count_for(final_state, escape_state),
        ):
            return result

        escape_action = Action(
            action_type=ActionType.TRANSLATION,
            value=tuple(escape_position - final_position),
        )
        return replace(
            result,
            states=result.states + (escape_state,),
            actions=result.actions + (escape_action,),
            cost=result.cost + float(remaining),
            farthest_paths=tuple(),
        )

    def build_interference_session(moving_solid_id, present_ids):
        obstacle_ids = [i for i in present_ids if i != moving_solid_id]
        if not obstacle_ids:
            raise RuntimeError(
                f"부품 {moving_solid_id}: 장애물이 없다 — 장애물 없는 부품은 그리디 "
                "루프가 '자명(마지막)' 으로 따로 처리해야 한다"
            )
        return InterferenceSession(
            checker, moving_solid_id, {i: identity for i in obstacle_ids}, budget
        )

    def build_planner(moving_solid_id, present_ids, session):
        return RRTStarPlanner(
            moving_solid_id=moving_solid_id,
            solid_meshes={i: meshes[i] for i in present_ids},
            assembled_states={i: assembled_states[i] for i in present_ids},
            config=config,
            interference_session=session,
        )

    def get_assembled_separation(moving_solid_id, present_ids):
        obstacle_ids = [i for i in present_ids if i != moving_solid_id]
        obstacle_bounding_box = np.vstack([
            np.min([np.asarray(meshes[i].bounds[0]) for i in obstacle_ids], axis=0),
            np.max([np.asarray(meshes[i].bounds[1]) for i in obstacle_ids], axis=0),
        ])
        transformation_matrix = assembled_states[moving_solid_id].to_transformation_matrix()
        world_vertices = (
            np.asarray(meshes[moving_solid_id].vertices, dtype=float)
            @ transformation_matrix[:3, :3].T
            + transformation_matrix[:3, 3]
        )
        return get_axis_aligned_separation(world_vertices, obstacle_bounding_box)[2]

    def plan_straight_removal(moving_solid_id, present_ids):
        session = build_interference_session(moving_solid_id, present_ids)
        planner = build_planner(moving_solid_id, present_ids, session)
        if not planner.has_any_feasible_first_move():
            return None
        result = planner.try_straight_extraction()
        if result is None:
            return None
        return extend_to_escape(planner, result)

    def plan_tree_removal(moving_solid_id, present_ids):
        session = build_interference_session(moving_solid_id, present_ids)
        planner = build_planner(moving_solid_id, present_ids, session)
        result = planner.execute_tree_search()
        if not result.is_success:
            return result
        return extend_to_escape(planner, result)

    print_section("분해 탐색")
    search_header = ["#", "부품", "이름", "계층", "스텝", "비용", "남은", "누적"]
    search_alignments = [">", "<", "<", "<", ">", ">", ">", ">"]
    search_widths = [3, 6, 16, 20, 4, 7, 4, 6]
    def print_search_row(cells) -> None:
        print(("  " + "  ".join(_pad(cells[i], search_widths[i],
                                     search_alignments[i] == ">")
                                for i in range(len(cells)))).rstrip(), flush=True)

    print_search_row(search_header)
    print_search_row(["─" * width for width in search_widths])

    search_loop_started = time.time()
    active_ids = list(solid_ids)
    removal_results = []
    resolved_tiers = {}
    failed_attempts = {}
    while active_ids:
        if len(active_ids) == 1:
            last_id = active_ids[0]
            escape_position = np.zeros(3)
            escape_position[0] = ESCAPE_DISTANCE
            escape_state = State(position=tuple(escape_position), rotation=(0, 0, 0))
            escape_action = Action(action_type=ActionType.TRANSLATION,
                                   value=tuple(escape_position))
            removal_results.append((last_id, PlanningResult(
                is_success=True,
                states=(assembled_states[last_id], escape_state),
                actions=(escape_action,),
                cost=float(ESCAPE_DISTANCE),
                iteration_count=0,
                farthest_paths=tuple(),
            )))
            resolved_tiers[last_id] = "자명(마지막)"
            print_search_row([str(len(removal_results)), signatures[last_id],
                               str(names.get(last_id, ""))[:16], "자명(마지막)",
                               "1", f"{ESCAPE_DISTANCE:.1f}", "0", elapsed()])
            active_ids = []
            break

        picked = None
        is_over_time_budget = False
        ordered_ids = sorted(active_ids, key=lambda i: float(np.prod(extents[i])))
        for moving_solid_id in ordered_ids:
            try:
                result = plan_straight_removal(moving_solid_id, active_ids)
            except PlanningException as error:
                print(f"    ! {signatures[moving_solid_id]}  예외: {error}", flush=True)
                continue
            if result is not None:
                picked = (moving_solid_id, result)
                break
            if time.time() - search_loop_started > time_budget_seconds * len(solid_ids):
                is_over_time_budget = True
                print("    ! 시간 상한 도달 — 이 라운드에서 중단", flush=True)
                break
        if picked is None and not is_over_time_budget:
            print(f"    · 직선으로 빠지는 부품 없음 — 남은 {len(ordered_ids)}개에 RRT* 탐색",
                  flush=True)
            for moving_solid_id in ordered_ids:
                try:
                    result = plan_tree_removal(moving_solid_id, active_ids)
                except PlanningException as error:
                    print(f"    ! {signatures[moving_solid_id]}  예외: {error}", flush=True)
                    continue
                if result.is_success:
                    picked = (moving_solid_id, result)
                    break
                failed_attempts[moving_solid_id] = (
                    tuple(i for i in active_ids if i != moving_solid_id),
                    result,
                )
                if time.time() - search_loop_started > time_budget_seconds * len(solid_ids):
                    print("    ! 시간 상한 도달 — 이 라운드에서 중단", flush=True)
                    break
        if picked is None:
            break

        moving_solid_id, result = picked
        removal_results.append((moving_solid_id, result))
        active_ids.remove(moving_solid_id)
        tier = to_resolution_tier(result)
        resolved_tiers[moving_solid_id] = tier
        print_search_row([str(len(removal_results)), signatures[moving_solid_id],
                          str(names.get(moving_solid_id, ""))[:16], tier,
                          str(len(result.actions)), f"{result.cost:.1f}",
                          str(len(active_ids)), elapsed()])

    search_failure_ids = list(active_ids)
    print(f"\n  분해 {len(removal_results)}/{len(solid_ids)}"
          + (f"  ·  실패 {', '.join(signatures[i] for i in active_ids)}"
             if active_ids else "")
          + f"  ·  탐색 {time.time() - search_loop_started:.0f}s", flush=True)

    failure_diagnoses = {}
    if search_failure_ids:
        print_section("실패 진단")
        diagnosis_started = time.time()
        diagnosis_rows = []
        for moving_solid_id in search_failure_ids:
            obstacle_ids = tuple(i for i in search_failure_ids if i != moving_solid_id)
            session = build_interference_session(moving_solid_id, search_failure_ids)

            assembled_state = assembled_states[moving_solid_id]
            try:
                planner = build_planner(moving_solid_id, search_failure_ids, session)
            except PlanningException as error:
                failure_diagnoses[moving_solid_id] = SolidFailureDiagnosis(
                    reason=("조립 상태부터 이미 간섭 상한을 넘어 탐색을 시작할 수 없다 "
                            f"({error}). 허용 증가값이 이 부품의 조립 상태 맞물림보다 "
                            "작다는 뜻이다."),
                    separation=get_assembled_separation(moving_solid_id, search_failure_ids),
                    required_separation=float(config.removal_clearance),
                    obstacle_solid_ids=obstacle_ids,
                    closest_path_steps=tuple(),
                    last_valid_pose=None,
                    first_blocked_pose=DiagnosedPose(
                        state=assembled_state,
                        overlap_regions=tuple(session.get_overlap_regions(
                            assembled_state.to_transformation_matrix()
                        )),
                    ),
                )
                diagnosis = failure_diagnoses[moving_solid_id]
                blocking_regions = sorted(
                    (region for region in diagnosis.first_blocked_pose.overlap_regions
                     if region.is_over_limit),
                    key=lambda region: -region.overlap_volume,
                )
                diagnosis_rows.append([
                    signatures[moving_solid_id],
                    str(names.get(moving_solid_id, ""))[:14],
                    "—",
                    f"{diagnosis.separation:.1f}",
                    f"{config.removal_clearance:.1f}",
                    "0",
                    "조립상태",
                    ", ".join(f"{signatures[region.obstacle_solid_id]}"
                              f"({region.interference_length:.2f}>"
                              f"{region.interference_limit:.2f})"
                              for region in blocking_regions[:3]) or "—",
                ])
                continue

            cached_attempt = failed_attempts.get(moving_solid_id)
            if cached_attempt is not None and cached_attempt[0] == obstacle_ids:
                result = cached_attempt[1]
            else:
                result = planner.execute_search()

            closest_states, closest_actions, closest_separation = planner.get_closest_path(result)
            if result.is_success:
                reason = ("마지막 라운드에서 시도되지 않았다(시간 상한). 실패가 확정된 "
                          "장애물 집합으로 다시 탐색하니 경로가 있었으므로, 기하학적으로 "
                          "막힌 것이 아니라 탐색 예산에 걸린 것이다.")
            elif len(closest_states) <= 1:
                reason = ("조립 상태에서 어떤 단위 동작으로도 움직일 수 없다 — 여섯 축 "
                          "병진과 24개 이산 자세 전이가 모두 간섭 상한을 넘는다.")
            else:
                stage_summary = f"병진 {result.translation_iteration_count}회"
                if result.rotation_iteration_count > 0:
                    stage_summary += f"·회전 {result.rotation_iteration_count}회"
                reason = (f"RRT* {stage_summary} 반복 안에 추출 상태에 닿지 "
                          "못했다. 반복 수·시간 상한·회전 허용 여부를 바꾸면 달라질 수 있다.")

            last_valid_state = closest_states[-1]
            last_valid_pose = DiagnosedPose(
                state=last_valid_state,
                overlap_regions=tuple(
                    session.get_overlap_regions(last_valid_state.to_transformation_matrix())
                ),
            )
            first_blocked_state = planner.get_first_blocked_state(last_valid_state)
            if first_blocked_state is None:
                first_blocked_pose = None
            else:
                first_blocked_pose = DiagnosedPose(
                    state=first_blocked_state,
                    overlap_regions=tuple(
                        session.get_overlap_regions(
                            first_blocked_state.to_transformation_matrix()
                        )
                    ),
                )
            failure_diagnoses[moving_solid_id] = SolidFailureDiagnosis(
                reason=reason,
                separation=float(closest_separation),
                required_separation=float(config.removal_clearance),
                obstacle_solid_ids=obstacle_ids,
                closest_path_steps=tuple(to_waypoint_steps(
                    moving_solid_id, closest_states, closest_actions
                )),
                last_valid_pose=last_valid_pose,
                first_blocked_pose=first_blocked_pose,
            )

            blocking_pose = (last_valid_pose if first_blocked_pose is None
                             else first_blocked_pose)
            blocking_regions = sorted(
                (region for region in blocking_pose.overlap_regions if region.is_over_limit),
                key=lambda region: -region.overlap_volume,
            )
            if result.is_success:
                direction_label = "—"
            else:
                open_axis_index, open_sign, openness = planner.get_most_open_axis_direction()
                direction_label = (f"{'XYZ'[open_axis_index]}{'+' if open_sign > 0 else '-'}"
                                   f" {openness:.0%}")
            diagnosis_rows.append([
                signatures[moving_solid_id],
                str(names.get(moving_solid_id, ""))[:14],
                direction_label,
                f"{closest_separation:.1f}",
                f"{config.removal_clearance:.1f}",
                str(len(failure_diagnoses[moving_solid_id].closest_path_steps)),
                "—" if first_blocked_state is None else "있음",
                ", ".join(f"{signatures[region.obstacle_solid_id]}"
                          f"({region.interference_length:.2f}>{region.interference_limit:.2f})"
                          for region in blocking_regions[:3]) or "—",
            ])
        print_table(
            ["서명", "이름", "방향 개방도", "분리량", "필요", "경로", "막힘자세",
             "상한 초과 장애물(간섭>상한)"],
            diagnosis_rows,
            ["<", "<", "<", ">", ">", ">", "<", "<"],
        )
        print(f"\n  진단 {time.time() - diagnosis_started:.0f}s  ·  "
              f"각 부품마다 마지막 유효 자세와 첫 막힘 자세의 겹침 메쉬를 저장한다",
              flush=True)
        print("  방향 = 조립 상태에서 부품 투영이 가장 넓게 트인 축·부호(개방도). 경로와 막힘"
              " 자세를 이 방향으로 잡고, 분리량도 이 방향의 값이다.", flush=True)

    trajectory_steps = []
    for moving_solid_id, result in removal_results:
        trajectory_steps.extend(
            to_waypoint_steps(moving_solid_id, result.states, result.actions)
        )
    rotation_step_count = sum(1 for _, _, action in trajectory_steps
                              if action.action_type != ActionType.TRANSLATION)

    removal_orders = {solid_id: index + 1
                      for index, (solid_id, _) in enumerate(removal_results)}
    results_by_id = dict(removal_results)
    parts_metadata = {}
    for solid_id in solid_ids:
        entry = {
            "signature": signatures[solid_id],
            "name": names.get(solid_id),
            "name_source": name_sources.get(solid_id, "occ"),
        }
        if solid_id in removal_orders:
            result = results_by_id[solid_id]
            entry.update({
                "status": "분해 가능",
                "is_removable": True,
                "removal_order": removal_orders[solid_id],
                "path_step_count": len(result.actions),
                "path_cost": float(result.cost),
                "rrt_iteration_count": int(result.iteration_count),
                "resolved_by": resolved_tiers.get(solid_id),
                "failure_reason": None,
            })
        else:
            entry.update({
                "status": "분해 불가능",
                "is_removable": False,
                "removal_order": None,
                "path_step_count": None,
                "path_cost": None,
                "rrt_iteration_count": None,
                "resolved_by": None,
                "failure_reason": (
                    failure_diagnoses[solid_id].reason
                    if solid_id in failure_diagnoses
                    else "RRT* 가 이 설정에서 목표 도달 경로를 찾지 못했다."
                ),
            })
        parts_metadata[int(solid_id)] = entry

    metadata = {
        "excluded_bodies": [
            {"signature": signature, "name": name, "reason": reason}
            for signature, name, reason in excluded_bodies
        ],
    }

    export_meshes = dict(meshes)
    export_names = dict(names)
    conversions = {int(solid_id): "성공" for solid_id in solid_ids}
    for display_id in sorted(display_meshes):
        export_id = max(export_meshes) + 1 if export_meshes else 0
        export_meshes[export_id] = display_meshes[display_id]
        export_names[export_id] = display_names[display_id]
        assembled_states[export_id] = State((0.0, 0.0, 0.0), (0, 0, 0))
        conversions[int(export_id)] = "실패"
        parts_metadata[int(export_id)] = {
            "signature": display_signatures[display_id],
            "name": display_names[display_id],
            "status": "메쉬 변환 실패",
            "removal_order": None,
            "path_step_count": None,
            "resolved_by": None,
        }
    metadata["unwatertight_bodies"] = [
        {"signature": display_signatures[display_id], "name": display_names[display_id],
         "reason": display_reasons[display_id]}
        for display_id in sorted(display_meshes)
    ]

    serializer = MsgpackTrajectorySerializer(step_path, export_meshes, assembled_states,
                                             extra_metadata=metadata,
                                             solid_names=export_names,
                                             conversion_results=conversions,
                                             solid_failures=failure_diagnoses)
    serializer.write_to_file(trajectory_steps, output_path)
    read_back = MsgpackTrajectorySerializer.read_from_file(output_path)

    print_section("결과")
    print_table(
        ["서명", "이름", "상태", "순서", "스텝", "해소"],
        [[entry["signature"], str(entry["name"] or "")[:18], entry["status"],
          str(entry["removal_order"] or "—"), str(entry["path_step_count"] or "—"),
          str(entry["resolved_by"] or "—")]
         for entry in sorted(
             (parts_metadata[int(i)] for i in solid_ids),
             key=lambda e: (e["removal_order"] is None, e["removal_order"] or 0))],
        ["<", "<", "<", ">", ">", "<"],
    )

    seconds = time.time() - search_started
    print_section("요약")
    print(f"  분해        {len(removal_results)}/{len(solid_ids)} 부품"
          + (f"  (실패 {len(search_failure_ids)})" if search_failure_ids else "")
          + (f"  (메쉬 실패 {len(display_meshes)})" if display_meshes else ""), flush=True)
    print(f"  분해 궤적   {len(trajectory_steps)} 스텝  "
          f"(병진 {len(trajectory_steps) - rotation_step_count} · "
          f"회전 {rotation_step_count} · 웨이포인트 간격 "
          f"{TRAJECTORY_WAYPOINT_STEP:.0f})", flush=True)
    print(f"  조립 궤적   위 궤적을 뒤집으면 조립 순서가 된다", flush=True)
    print(f"  소요        {seconds:.0f}초", flush=True)
    print(f"  저장        {output_path}", flush=True)

    print_msgpack_structure(read_back, output_path)
    print("", flush=True)
    return {
        "removable": len(removal_results),
        "total": len(solid_ids),
        "trajectory_step_count": len(trajectory_steps),
        "output_path": output_path,
        "seconds": seconds,
    }


@hydra.main(config_path="config", config_name="config", version_base=None)
def main(config: DictConfig):
    usage = ("예: python main.py step_path=/path/to/assembly.stp "
             "output_path=/path/to/result.msgpack")
    if not config.step_path:
        raise SystemExit(f"step_path 가 비어 있다. 입력 STEP 경로를 지정하시오 — {usage}")
    if not config.output_path:
        raise SystemExit(f"output_path 가 비어 있다. 출력 msgpack 경로를 지정하시오 — {usage}")
    if not os.path.isfile(config.step_path):
        raise SystemExit(f"입력 STEP 파일이 없다: {config.step_path}")

    summary = execute_disassembly_search(
        step_path=config.step_path,
        output_path=config.output_path,
        worker_count=config.search.worker_count,
        iteration_count=config.search.iteration_count,
        does_sample_rotation=config.search.does_sample_rotation,
        random_seed=config.search.random_seed,
        time_budget_seconds=config.search.time_budget_seconds,
        max_interference_growth=config.max_interference_growth,
    )
    return summary


if __name__ == "__main__":
    main()

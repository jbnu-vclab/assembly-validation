"""
assembly_validation_v3 — v2 + 교착(충돌) 부품 조립 궤적

v2 와 동일 파이프라인에 더해, 교착 부품은 **이미 조립된 다른 솔리드가 있는 장면**에서
장애물을 피해 바깥 → 충돌 직전 에이전트 위치까지 MOVE 접근 궤적만 export 합니다.
(분해 역변환 경로는 사용하지 않음 — 애니메이션에서 조립품을 관통하지 않도록)
`assembly.failed_collisions` 는 접촉 복셀 + 에이전트 격자(agent_x/y/z) 를 포함합니다.
`assembly.sequence` 에는 성공 분해 부품만 포함 (v2 와 동일).
"""
import os
import argparse
import numpy as np
import trimesh
import open3d as o3d
import concurrent.futures
import heapq
import msgpack
from tqdm import tqdm
from occwl.compound import Compound

# =====================================================================
# 1. 6-DOF (18방향 회전 포함) 최적화된 A* 경로 탐색 알고리즘
# =====================================================================

def extract_cubic_local_grid(target_voxel):
    indices = np.nonzero(target_voxel)
    if len(indices[0]) == 0: 
        return None, (0,0,0)
        
    min_x, max_x = np.min(indices[0]), np.max(indices[0])
    min_y, max_y = np.min(indices[1]), np.max(indices[1])
    min_z, max_z = np.min(indices[2]), np.max(indices[2])
    
    len_x = max_x - min_x + 1
    len_y = max_y - min_y + 1
    len_z = max_z - min_z + 1
    
    L = max(len_x, len_y, len_z) + 4 
    local_grid = np.zeros((L, L, L), dtype=bool)
    
    ox = (L - len_x) // 2
    oy = (L - len_y) // 2
    oz = (L - len_z) // 2
    
    local_grid[ox:ox+len_x, oy:oy+len_y, oz:oz+len_z] = target_voxel[min_x:max_x+1, min_y:max_y+1, min_z:max_z+1]
    
    cx = min_x + (len_x // 2)
    cy = min_y + (len_y // 2)
    cz = min_z + (len_z // 2)
    
    return local_grid, (cx, cy, cz)

def check_collision_cubic(cx, cy, cz, local_grid, obstacle_voxel):
    Nx, Ny, Nz = obstacle_voxel.shape
    L = local_grid.shape[0]
    half_L = L // 2
    
    gx_start, gx_end = cx - half_L, cx - half_L + L
    gy_start, gy_end = cy - half_L, cy - half_L + L
    gz_start, gz_end = cz - half_L, cz - half_L + L
    
    if (gx_start >= Nx or gx_end <= 0 or 
        gy_start >= Ny or gy_end <= 0 or 
        gz_start >= Nz or gz_end <= 0):
        return False, True 
        
    ox_start, ox_end = max(0, gx_start), min(Nx, gx_end)
    oy_start, oy_end = max(0, gy_start), min(Ny, gy_end)
    oz_start, oz_end = max(0, gz_start), min(Nz, gz_end)
    
    lx_start = ox_start - gx_start
    lx_end = lx_start + (ox_end - ox_start)
    ly_start = oy_start - gy_start
    ly_end = ly_start + (oy_end - oy_start)
    lz_start = oz_start - gz_start
    lz_end = lz_start + (oz_end - oz_start)
    
    t_view = local_grid[lx_start:lx_end, ly_start:ly_end, lz_start:lz_end]
    o_view = obstacle_voxel[ox_start:ox_end, oy_start:oy_end, oz_start:oz_end]
    
    collision = np.any(t_view & o_view)
    return collision, False

def resolve_collision_contact_voxel(cx, cy, cz, local_grid, obstacle_voxel,
                                    agent_x=None, agent_y=None, agent_z=None,
                                    move_dir=None):
    """
    A* 에이전트 위치(부품 bbox 중심 격자)가 아니라, 해당 pose 에서
    part ∧ obstacle 겹침 복셀 중 접촉면 쪽 한 칸을 반환합니다.
    """
    ax = int(agent_x if agent_x is not None else cx)
    ay = int(agent_y if agent_y is not None else cy)
    az = int(agent_z if agent_z is not None else cz)
    Nx, Ny, Nz = obstacle_voxel.shape
    L = local_grid.shape[0]
    half_L = L // 2

    overlap = []
    for lx in range(L):
        for ly in range(L):
            for lz in range(L):
                if not local_grid[lx, ly, lz]:
                    continue
                gx = ax - half_L + lx
                gy = ay - half_L + ly
                gz = az - half_L + lz
                if (
                    0 <= gx < Nx and 0 <= gy < Ny and 0 <= gz < Nz
                    and obstacle_voxel[gx, gy, gz]
                ):
                    overlap.append((gx, gy, gz))

    if not overlap:
        return ax, ay, az

    if move_dir is not None:
        dx, dy, dz = (int(move_dir[0]), int(move_dir[1]), int(move_dir[2]))
        if dx != 0 or dy != 0 or dz != 0:
            return max(overlap, key=lambda p: p[0] * dx + p[1] * dy + p[2] * dz)

    return max(
        overlap,
        key=lambda p: (p[0] - cx) ** 2 + (p[1] - cy) ** 2 + (p[2] - cz) ** 2,
    )

def a_star_6dof_escape(target_voxel, obstacle_voxel):
    Nx, Ny, Nz = obstacle_voxel.shape
    
    base_local_grid, (start_cx, start_cy, start_cz) = extract_cubic_local_grid(target_voxel)
    if base_local_grid is None: 
        return [], None, False

    rot_dict = {base_local_grid.tobytes(): (0, base_local_grid)}
    
    def heuristic(cx, cy, cz):
        h_x = min(max(0, Nx - cx), max(0, cx))
        h_y = min(max(0, Ny - cy), max(0, cy))
        h_z = min(max(0, Nz - cz), max(0, cz))
        return min(h_x, h_y, h_z)

    translations = [
        ((1,0,0), 'X', 1), ((-1,0,0), 'X', -1),
        ((0,1,0), 'Y', 1), ((0,-1,0), 'Y', -1),
        ((0,0,1), 'Z', 1), ((0,0,-1), 'Z', -1)
    ]
    
    rot_actions = [
        ('Roll(X)', (1, 2), 1, 90), ('Roll(X)', (1, 2), -1, -90),
        ('Roll(X)', (1, 2), 2, 180), ('Roll(X)', (1, 2), -2, -180),
        ('Roll(X)', (1, 2), 3, 270), ('Roll(X)', (1, 2), -3, -270),
        ('Pitch(Y)', (0, 2), 1, 90), ('Pitch(Y)', (0, 2), -1, -90),
        ('Pitch(Y)', (0, 2), 2, 180), ('Pitch(Y)', (0, 2), -2, -180),
        ('Pitch(Y)', (0, 2), 3, 270), ('Pitch(Y)', (0, 2), -3, -270),
        ('Yaw(Z)', (0, 1), 1, 90), ('Yaw(Z)', (0, 1), -1, -90),
        ('Yaw(Z)', (0, 1), 2, 180), ('Yaw(Z)', (0, 1), -2, -180),
        ('Yaw(Z)', (0, 1), 3, 270), ('Yaw(Z)', (0, 1), -3, -270)
    ]

    start_state = (start_cx, start_cy, start_cz, 0)
    
    open_set = []
    heapq.heappush(open_set, (0, 0, start_state))
    came_from = {} 
    g_score = {start_state: 0}
    rot_id_counter = 0
    
    last_collision_point = None
    last_collision_from_state = None
    last_collision_action = None

    def reconstruct_path_to_state(end_state):
        path_actions = []
        curr = end_state
        while curr in came_from:
            curr, action = came_from[curr]
            path_actions.append(action)
        return path_actions[::-1]
    
    while open_set:
        _, current_g, current_state = heapq.heappop(open_set)
        cx, cy, cz, rot_id = current_state
        
        current_grid = next(g for i, g in rot_dict.values() if i == rot_id)
        
        is_collision, is_escaped = check_collision_cubic(cx, cy, cz, current_grid, obstacle_voxel)
        
        if is_escaped:
            path_actions = []
            curr = current_state
            while curr in came_from:
                curr, action = came_from[curr]
                path_actions.append(action)
            return path_actions[::-1], last_collision_point, True
            
        for d_vec, axis, val in translations:
            ncx, ncy, ncz = cx + d_vec[0], cy + d_vec[1], cz + d_vec[2]
            neighbor = (ncx, ncy, ncz, rot_id)
            
            is_col, _ = check_collision_cubic(ncx, ncy, ncz, current_grid, obstacle_voxel)
            if is_col:
                tx, ty, tz = resolve_collision_contact_voxel(
                    cx, cy, cz, current_grid, obstacle_voxel,
                    agent_x=ncx, agent_y=ncy, agent_z=ncz,
                    move_dir=d_vec,
                )
                last_collision_point = {
                    "x": int(tx), "y": int(ty), "z": int(tz),
                    "agent_x": int(cx), "agent_y": int(cy), "agent_z": int(cz),
                    "attempt": f"MOVE {axis}",
                    "move_value": int(val),
                }
                last_collision_from_state = current_state
                last_collision_action = ("MOVE", axis, val)
                continue
            
            tentative_g = current_g + 1
            if neighbor not in g_score or tentative_g < g_score[neighbor]:
                came_from[neighbor] = (current_state, ("MOVE", axis, val))
                g_score[neighbor] = tentative_g
                f_score = tentative_g + heuristic(ncx, ncy, ncz)
                heapq.heappush(open_set, (f_score, tentative_g, neighbor))
                
        for r_name, axes, k, angle in rot_actions:
            n_grid = np.rot90(current_grid, k=k, axes=axes)
            n_grid_bytes = n_grid.tobytes()
            
            if n_grid_bytes not in rot_dict:
                rot_id_counter += 1
                rot_dict[n_grid_bytes] = (rot_id_counter, n_grid)
            n_rot_id = rot_dict[n_grid_bytes][0]
            
            neighbor = (cx, cy, cz, n_rot_id)
            
            is_col, _ = check_collision_cubic(cx, cy, cz, n_grid, obstacle_voxel)
            if is_col:
                tx, ty, tz = resolve_collision_contact_voxel(
                    cx, cy, cz, n_grid, obstacle_voxel,
                )
                last_collision_point = {
                    "x": int(tx), "y": int(ty), "z": int(tz),
                    "agent_x": int(cx), "agent_y": int(cy), "agent_z": int(cz),
                    "attempt": f"ROTATION {r_name}"
                }
                last_collision_from_state = current_state
                last_collision_action = ("ROTATION", r_name, angle)
                continue
            
            tentative_g = current_g + 1 
            if neighbor not in g_score or tentative_g < g_score[neighbor]:
                came_from[neighbor] = (current_state, ("ROTATION", r_name, angle))
                g_score[neighbor] = tentative_g
                f_score = tentative_g + heuristic(cx, cy, cz)
                heapq.heappush(open_set, (f_score, tentative_g, neighbor))
                
    if last_collision_from_state is not None:
        path_to_hit = reconstruct_path_to_state(last_collision_from_state)
        if last_collision_action is not None:
            path_to_hit = list(path_to_hit) + [last_collision_action]
        return path_to_hit, last_collision_point, False
    return [], last_collision_point, False

def aggregate_and_reverse_path(disassembly_actions):
    if not disassembly_actions: return []
    
    agg_actions = []
    curr_type, curr_axis, curr_val = disassembly_actions[0]
    
    for act_type, act_axis, act_val in disassembly_actions[1:]:
        if act_type == curr_type and act_axis == curr_axis:
            curr_val += act_val
        else:
            if curr_val != 0:
                agg_actions.append((curr_type, curr_axis, curr_val))
            curr_type, curr_axis, curr_val = act_type, act_axis, act_val
            
    if curr_val != 0:
        agg_actions.append((curr_type, curr_axis, curr_val))
        
    assembly_actions = []
    for act_type, act_axis, act_val in reversed(agg_actions):
        reversed_val = -act_val 
        
        if reversed_val != 0:
            display_axis = act_axis
            if act_type == "MOVE":
                display_axis = f"+{act_axis}" if reversed_val > 0 else f"-{act_axis}"
                reversed_val = abs(reversed_val)
                
            assembly_actions.append((act_type, display_axis, reversed_val))
            
    return assembly_actions

# 교착 부품: 바깥 스폰 거리(격자 칸), A* 접근 탐색 상한
FAILED_APPROACH_SPAWN_CELLS = 8
FAILED_APPROACH_ASTAR_MAX = 12000

MOVE_TRANSLATIONS = [
    ((1, 0, 0), 'X', 1), ((-1, 0, 0), 'X', -1),
    ((0, 1, 0), 'Y', 1), ((0, -1, 0), 'Y', -1),
    ((0, 0, 1), 'Z', 1), ((0, 0, -1), 'Z', -1),
]

def part_voxel_centroid(voxel_grid):
    idx = np.nonzero(voxel_grid)
    if len(idx[0]) == 0:
        return (0, 0, 0)
    return (
        int(round(float(np.mean(idx[0])))),
        int(round(float(np.mean(idx[1])))),
        int(round(float(np.mean(idx[2])))),
    )

def _append_axis_moves(path, axis, step_val, count):
    for _ in range(max(0, int(count))):
        path.append(("MOVE", axis, step_val))

def obstacle_voxels_excluding(voxels_dict, exclude_part_idx):
    """애니메이션 장면: 해당 부품을 제외한 모든 솔리드(이미 조립·교착 포함)."""
    obs = None
    for idx, grid in voxels_dict.items():
        if idx == exclude_part_idx:
            continue
        if obs is None:
            obs = np.zeros_like(grid, dtype=bool)
        obs |= grid
    if obs is None:
        obs = np.zeros_like(next(iter(voxels_dict.values())), dtype=bool)
    return obs

def aggregate_forward_move_path(move_actions):
    """MOVE 시퀀스(조립 방향) → 프론트 표시용 축별 스텝 (역변환 없음)."""
    if not move_actions:
        return []
    agg = []
    curr_type, curr_axis, curr_val = move_actions[0]
    for act_type, act_axis, act_val in move_actions[1:]:
        if act_type == curr_type and act_axis == curr_axis:
            curr_val += act_val
        else:
            if curr_val != 0:
                agg.append((curr_type, curr_axis, curr_val))
            curr_type, curr_axis, curr_val = act_type, act_axis, act_val
    if curr_val != 0:
        agg.append((curr_type, curr_axis, curr_val))

    out = []
    for act_type, act_axis, act_val in agg:
        if act_type != "MOVE" or act_val == 0:
            continue
        display_axis = f"+{act_axis}" if act_val > 0 else f"-{act_axis}"
        out.append((act_type, display_axis, abs(act_val)))
    return out

def find_clear_spawn_center(ax, ay, az, part_center, local_grid, obstacle_voxel):
    """충돌 직전 에이전트 위치에서 바깥(장애물 비접촉) 스폰 격자를 찾습니다."""
    pcx, pcy, pcz = part_center
    preferred = []
    for d_vec, _, _ in MOVE_TRANSLATIONS:
        dx, dy, dz = ax - pcx, ay - pcy, az - pcz
        dot = d_vec[0] * dx + d_vec[1] * dy + d_vec[2] * dz
        preferred.append((-dot, d_vec))
    preferred.sort(key=lambda t: t[0])

    ordered_dirs = [d for _, d in preferred]
    seen = {d for d in ordered_dirs}
    for d_vec, _, _ in MOVE_TRANSLATIONS:
        if d_vec not in seen:
            ordered_dirs.append(d_vec)
            seen.add(d_vec)

    for dist in range(FAILED_APPROACH_SPAWN_CELLS, FAILED_APPROACH_SPAWN_CELLS + 14):
        for d_vec in ordered_dirs:
            sx = ax - d_vec[0] * dist
            sy = ay - d_vec[1] * dist
            sz = az - d_vec[2] * dist
            is_col, is_escaped = check_collision_cubic(
                sx, sy, sz, local_grid, obstacle_voxel
            )
            if not is_col and not is_escaped:
                return int(sx), int(sy), int(sz)
    return int(ax), int(ay - dist), int(az)

def a_star_move_approach(local_grid, obstacle_voxel, start_xyz, goal_xyz):
    """장애물(조립된 다른 부품)을 피해 start → goal MOVE 경로. 회전 없음."""
    sx, sy, sz = start_xyz
    gx, gy, gz = goal_xyz
    start = (sx, sy, sz)
    goal = (gx, gy, gz)
    if start == goal:
        return []

    def heuristic(p):
        return abs(p[0] - gx) + abs(p[1] - gy) + abs(p[2] - gz)

    open_set = [(heuristic(start), 0, start)]
    came_from = {}
    g_score = {start: 0}
    closed = set()
    expansions = 0

    while open_set and expansions < FAILED_APPROACH_ASTAR_MAX:
        expansions += 1
        _, current_g, current = heapq.heappop(open_set)
        if current in closed:
            continue
        closed.add(current)
        cx, cy, cz = current

        if current == goal:
            path = []
            curr = current
            while curr in came_from:
                prev, action = came_from[curr]
                path.append(action)
                curr = prev
            return path[::-1]

        for d_vec, axis, val in MOVE_TRANSLATIONS:
            nxt = (cx + d_vec[0], cy + d_vec[1], cz + d_vec[2])
            if nxt in closed:
                continue
            is_col, is_escaped = check_collision_cubic(
                nxt[0], nxt[1], nxt[2], local_grid, obstacle_voxel
            )
            if is_col or is_escaped:
                continue
            tentative_g = current_g + 1
            if nxt not in g_score or tentative_g < g_score[nxt]:
                came_from[nxt] = (current, ("MOVE", axis, val))
                g_score[nxt] = tentative_g
                f_score = tentative_g + heuristic(nxt)
                heapq.heappush(open_set, (f_score, tentative_g, nxt))

    return []

def manhattan_move_fallback(local_grid, obstacle_voxel, start_xyz, goal_xyz):
    """A* 실패 시 축별 직선 접근(충돌 칸은 건너뜀)."""
    cx, cy, cz = start_xyz
    gx, gy, gz = goal_xyz
    path = []
    for axis, delta in (("X", gx - cx), ("Y", gy - cy), ("Z", gz - cz)):
        if delta == 0:
            continue
        step = 1 if delta > 0 else -1
        _append_axis_moves(path, axis, step, abs(delta))

    safe = []
    x, y, z = start_xyz
    for act_type, axis, val in path:
        if act_type != "MOVE":
            continue
        d = {"X": (val, 0, 0), "Y": (0, val, 0), "Z": (0, 0, val)}[axis]
        nx, ny, nz = x + d[0], y + d[1], z + d[2]
        is_col, is_escaped = check_collision_cubic(
            nx, ny, nz, local_grid, obstacle_voxel
        )
        if not is_col and not is_escaped:
            safe.append((act_type, axis, val))
            x, y, z = nx, ny, nz
    return safe

def build_failed_collision_approach_path(target_voxel, obstacle_voxel, collision, part_center):
    """
    조립 장면(다른 부품 voxel = obstacle)에서 장애물을 관통하지 않고
    바깥 스폰 → 충돌 직전 에이전트 격자까지 MOVE 조립 스텝을 생성합니다.
    """
    col = collision or {}
    local_grid, _ = extract_cubic_local_grid(target_voxel)
    if local_grid is None:
        return []

    ax = int(col.get("agent_x", col.get("x", part_center[0])))
    ay = int(col.get("agent_y", col.get("y", part_center[1])))
    az = int(col.get("agent_z", col.get("z", part_center[2])))

    is_col_goal, is_esc_goal = check_collision_cubic(
        ax, ay, az, local_grid, obstacle_voxel
    )
    if is_col_goal and not is_esc_goal:
        pass
    elif is_esc_goal:
        return []

    sx, sy, sz = find_clear_spawn_center(
        ax, ay, az, part_center, local_grid, obstacle_voxel
    )
    is_col_start, is_esc_start = check_collision_cubic(
        sx, sy, sz, local_grid, obstacle_voxel
    )
    if is_col_start or is_esc_start:
        return []

    raw = a_star_move_approach(
        local_grid, obstacle_voxel, (sx, sy, sz), (ax, ay, az)
    )
    if not raw:
        raw = manhattan_move_fallback(
            local_grid, obstacle_voxel, (sx, sy, sz), (ax, ay, az)
        )
    return raw

worker_voxels_cache = None

def init_escape_worker(voxels_dict):
    global worker_voxels_cache
    worker_voxels_cache = voxels_dict

def try_escape_task(part_idx, remaining_parts_tuple):
    global worker_voxels_cache
    target_voxel = worker_voxels_cache[part_idx]
    
    Nx, Ny, Nz = target_voxel.shape
    obstacle_map = np.zeros((Nx, Ny, Nz), dtype=bool)
    
    for other_idx in remaining_parts_tuple:
        if other_idx != part_idx:
            obstacle_map |= worker_voxels_cache[other_idx]
            
    initial_overlap = target_voxel & obstacle_map
    safe_obstacle_map = obstacle_map & (~initial_overlap)
    
    escape_actions, last_col, escaped = a_star_6dof_escape(target_voxel, safe_obstacle_map)
    
    return part_idx, escape_actions, last_col, escaped

# =====================================================================
# 1. 6-DOF 동적 조립 경로 탐색 (병렬화 적용)
# =====================================================================

def plan_assembly_sequence(voxels_dict):
    print("\n[6-DOF 동적 조립 경로 탐색 시작 (Multiprocessing 가속 적용)]")
    remaining_parts = list(voxels_dict.keys())
    disassembly_sequence = []
    raw_disassembly_paths = {} 
    
    final_failed_collisions = {}
    
    num_cores = min(os.cpu_count() or 4, len(remaining_parts))
    
    with concurrent.futures.ProcessPoolExecutor(
        max_workers=num_cores,
        initializer=init_escape_worker,
        initargs=(voxels_dict,)
    ) as executor:
        
        with tqdm(total=len(remaining_parts), desc="Path Planning", unit="part") as pbar:
            while remaining_parts:
                extracted_in_this_loop = False
                remaining_tuple = tuple(remaining_parts)
                
                temp_collisions_this_loop = {}
                temp_failed_paths_this_loop = {}
                
                futures = {
                    executor.submit(try_escape_task, part_idx, remaining_tuple): part_idx 
                    for part_idx in remaining_parts
                }
                
                for future in concurrent.futures.as_completed(futures):
                    part_idx, escape_actions, last_col, escaped = future.result()
                    
                    temp_collisions_this_loop[part_idx] = last_col
                    
                    if escaped:
                        tqdm.write(f"✅ Solid {part_idx} 추출 성공! (발생 Action: {len(escape_actions)}번)")
                        disassembly_sequence.append(part_idx)
                        raw_disassembly_paths[part_idx] = escape_actions
                        
                        remaining_parts.remove(part_idx)
                        extracted_in_this_loop = True
                        
                        pbar.update(1)
                        pbar.set_postfix({"Extracted": f"Solid {part_idx}"})
                        
                        for f in futures:
                            if not f.done():
                                f.cancel()
                        break 
                    else:
                        temp_failed_paths_this_loop[part_idx] = (
                            list(escape_actions) if escape_actions else []
                        )
                        
                if not extracted_in_this_loop:
                    tqdm.write(f"🚨 교착 상태(Deadlock) 발생! 남은 부품 {remaining_parts} 은/는 분해할 수 없습니다.")
                    for failed_part in remaining_parts:
                        if failed_part in temp_collisions_this_loop:
                            final_failed_collisions[failed_part] = temp_collisions_this_loop[failed_part]
                        if failed_part in temp_failed_paths_this_loop:
                            raw_disassembly_paths[failed_part] = temp_failed_paths_this_loop[failed_part]
                    break
                    
    assembly_sequence = disassembly_sequence[::-1]
    
    print("\n" + "="*55)
    print("🎉 [최종 분석 결과: 최적 조립 순서 및 로봇 궤적 제어 명령]")
    print("="*55)
    
    for step, part_idx in enumerate(assembly_sequence):
        print(f"\n[ {step+1}순위 조립 ]: Solid {part_idx}")
        raw_path = raw_disassembly_paths[part_idx]
        final_assembly_path = aggregate_and_reverse_path(raw_path)
        
        if not final_assembly_path:
            print("  -> (조립 궤적 없음: 현재 위치가 곧 조립 완료 위치입니다)")
        else:
            for idx, (a_type, a_axis, a_val) in enumerate(final_assembly_path):
                unit = "도" if a_type == "ROTATION" else "복셀 단위"
                print(f"  {idx+1:02d}. ({a_type}, {a_axis}, {a_val}{unit})")

    if final_failed_collisions:
        print("\n" + "-" * 55)
        print("⚠️ [교착 부품: 충돌 지점까지 조립 궤적 (프론트 시뮬레이션용)]")
        for failed_part in sorted(final_failed_collisions.keys()):
            print(f"\n[ 충돌 Solid {failed_part} ]")
            col = final_failed_collisions.get(failed_part)
            center = part_voxel_centroid(voxels_dict[failed_part]) if failed_part in voxels_dict else (0, 0, 0)
            obs = obstacle_voxels_excluding(voxels_dict, failed_part)
            raw_path = build_failed_collision_approach_path(
                voxels_dict[failed_part], obs, col, center
            )
            final_assembly_path = aggregate_forward_move_path(raw_path)
            if not final_assembly_path:
                print("  -> (충돌 접근 궤적 없음 — failed_collisions 좌표만 사용)")
            else:
                for idx, (a_type, a_axis, a_val) in enumerate(final_assembly_path):
                    unit = "도" if a_type == "ROTATION" else "복셀 단위"
                    print(f"  {idx+1:02d}. ({a_type}, {a_axis}, {a_val}{unit})")
                
    return assembly_sequence, raw_disassembly_paths, final_failed_collisions

def voxelize_mesh_worker(index, vertices, faces, voxel_size, min_compound, resolution):
    """
    [수정됨] Voxel 인덱스뿐만 아니라 원본 Mesh 데이터(vertices, faces)를 함께 반환합니다.
    """
    try:
        mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=True)
        voxelized = mesh.voxelized(voxel_size)
        if mesh.is_watertight:
            voxelized = voxelized.fill()
            
        indices = np.floor((voxelized.points - min_compound) / voxel_size).astype(int)
        indices[:, 0] = np.clip(indices[:, 0], 0, resolution[0] - 1)
        indices[:, 1] = np.clip(indices[:, 1], 0, resolution[1] - 1)
        indices[:, 2] = np.clip(indices[:, 2], 0, resolution[2] - 1)
        
        # 튜플의 원소를 5개로 늘려 vertices와 faces 원본 데이터를 반환
        return index, indices, vertices, faces, None
    except Exception as e:
        return index, None, None, None, str(e)

def export_to_msgpack(filepath, resolution, voxel_size, min_bound, max_bound, 
                      voxels_dict, meshes_dict, assembly_sequence, raw_disassembly_paths, failed_collisions):
    """
    [수정됨] meshes_dict를 추가로 전달받아 직렬화 페이로드에 포함합니다.
    """
    print(f"\n[STEP 4] 프론트엔드 전송용 MessagePack 직렬화 시작...")
    
    # 1. 메타데이터 구성
    metadata = {
        "resolution": [int(r) for r in resolution],
        "voxel_size": float(voxel_size),
        "min_bound": [float(v) for v in min_bound],
        "max_bound": [float(v) for v in max_bound]
    }
    
    # 2. Voxel 바이너리 압축
    solids_data = {}
    for idx, voxel_grid in voxels_dict.items():
        compressed_bytes = np.packbits(voxel_grid.flatten()).tobytes()
        solids_data[str(idx)] = compressed_bytes
        
    # 3. [추가] Mesh 데이터 바이너리 압축 (Float32, Int32)
    meshes_data = {}
    for idx, mesh_data in meshes_dict.items():
        # JavaScript의 Float32Array로 읽기 용이하도록 타입 캐스팅 후 바이너리로 변환
        v_bytes = np.array(mesh_data["vertices"], dtype=np.float32).tobytes()
        # Three.js의 BufferGeometry index로 활용하기 위해 Int32로 변환
        f_bytes = np.array(mesh_data["faces"], dtype=np.int32).tobytes()
        
        meshes_data[str(idx)] = {
            "vertices": v_bytes,
            "faces": f_bytes
        }
        
    # 4. 조립 궤적(Trajectories) 데이터 포맷팅
    trajectories = {}
    for idx in voxels_dict.keys():
        trajectories[str(idx)] = []
        
    def write_trajectory_for_part(part_idx, is_failed=False):
        if is_failed and part_idx in voxels_dict:
            center = part_voxel_centroid(voxels_dict[part_idx])
            col = failed_collisions.get(part_idx) if failed_collisions else None
            obs = obstacle_voxels_excluding(voxels_dict, part_idx)
            raw_path = build_failed_collision_approach_path(
                voxels_dict[part_idx], obs, col, center
            )
            final_assembly_path = aggregate_forward_move_path(raw_path)
        else:
            raw_path = raw_disassembly_paths.get(part_idx, [])
            final_assembly_path = aggregate_and_reverse_path(raw_path)
        formatted_path = []
        for a_type, a_axis, a_val in final_assembly_path:
            formatted_path.append({
                "type": a_type,
                "axis": str(a_axis),
                "value": int(a_val)
            })
        trajectories[str(part_idx)] = formatted_path

    for part_idx in assembly_sequence:
        write_trajectory_for_part(part_idx, is_failed=False)

    # 교착 부품: 조립 장면 장애물 회피 MOVE 접근 (분해 역변환 아님)
    if failed_collisions:
        for failed_part in failed_collisions.keys():
            write_trajectory_for_part(failed_part, is_failed=True)

    # 실패한 부품의 좌표만 JSON 규격 문자열 Key로 변환
    formatted_failed_collisions = {}
    if failed_collisions:
        for part_idx, col_data in failed_collisions.items():
            if col_data is not None:
                formatted_failed_collisions[str(part_idx)] = col_data

    # 5. 최종 페이로드 조립
    payload = {
        "metadata": metadata,
        "solids": solids_data,
        "meshes": meshes_data, # <-- 메쉬 데이터 신규 할당
        "assembly": {
            "sequence": [int(seq) for seq in assembly_sequence],
            "trajectories": trajectories,
            "failed_collisions": formatted_failed_collisions 
        }
    }
    
    # 6. 바이너리 파일로 기록
    with open(filepath, "wb") as f:
        msgpack.pack(payload, f, use_bin_type=True)
        
    print(f"✅ MessagePack 파일 저장 완료: {filepath}")

# =====================================================================
# 2. 메인 파이프라인 (STEP 로드 및 Voxelize 파트)
# =====================================================================
if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument('-s', '--step', type=str, required=True)
    parser.add_argument('-v', '--voxel_size', type=float, required=True)
    args = parser.parse_args()

    print(f"[STEP 1] STEP 파일 로드 중: {args.step}")
    compound = Compound.load_from_step(args.step)
    compound_box = compound.exact_box()
    min_compound = compound_box.min_point()
    max_compound = compound_box.max_point()
    resolution = np.ceil((max_compound - min_compound) / args.voxel_size).astype(int)
    print(f'Resolution: {resolution}\n')

    tasks = []
    solid_list = list(compound.solids())
    
    print("[STEP 2] 병렬 처리를 위한 형상 데이터 추출 중...")
    for index, solid in tqdm(enumerate(solid_list), total=len(solid_list), desc="Extracting Geometry", unit="solid"):
        vertices, faces = solid.get_triangles()
        if vertices is None or len(vertices) == 0: 
            tqdm.write(f"⚠️ Solid {index}: Mesh data가 비어있어 스킵합니다.")
            continue
        tasks.append((index, vertices, faces, args.voxel_size, min_compound, resolution))

    voxels = dict()
    meshes = dict() # [추가] 추출된 Mesh 원본을 저장할 딕셔너리
    
    num_cores = min(os.cpu_count() or 4, len(tasks))
    print(f"\n[STEP 3] {num_cores}개의 코어를 활용하여 병렬 Voxelization을 시작합니다...")
    
    with concurrent.futures.ProcessPoolExecutor(max_workers=num_cores) as executor:
        futures = {
            executor.submit(voxelize_mesh_worker, *task): task[0] 
            for task in tasks
        }
        
        with tqdm(total=len(tasks), desc="Voxelizing", unit="part", smoothing=0.1) as pbar:
            for future in concurrent.futures.as_completed(futures):
                idx = futures[future]
                try:
                    # [수정] 언패킹 튜플 길이를 5개로 확장하여 vertices, faces를 수신
                    result_idx, indices, verts, facs, err_msg = future.result()
                    
                    if err_msg is not None:
                        tqdm.write(f'🚨 Solid {idx} 에러 발생: {err_msg}')
                    elif indices is not None:
                        # Voxel 데이터 저장
                        voxel_grid = np.zeros(resolution, dtype=bool)
                        voxel_grid[indices[:, 0], indices[:, 1], indices[:, 2]] = True
                        voxels[result_idx] = voxel_grid
                        
                        # [핵심] Mesh 원본 데이터도 딕셔너리에 함께 저장
                        meshes[result_idx] = {"vertices": verts, "faces": facs}
                        
                        pbar.set_postfix({
                            "Last_Done": f"Solid {result_idx}", 
                            "Voxels": f"{len(indices):,}"
                        })
                        
                except Exception as exc:
                    tqdm.write(f'🚨 Solid {idx} 처리 중 예기치 않은 오류 발생: {exc}')
                
                pbar.update(1)

    print("\n✅ 모든 Voxelization 작업이 완료되었습니다!")

    if len(voxels) > 1:
        sequence, raw_paths, failed_cols = plan_assembly_sequence(voxels)
        export_file_name = "assembly_data.msgpack"  # v3: failed trajectories 포함
        export_to_msgpack(
            filepath=export_file_name,
            resolution=resolution,
            voxel_size=args.voxel_size,
            min_bound=min_compound,
            max_bound=max_compound,
            voxels_dict=voxels,
            meshes_dict=meshes,  # [추가] Mesh 데이터 인자 전달
            assembly_sequence=sequence,
            raw_disassembly_paths=raw_paths,
            failed_collisions=failed_cols  
        )
    else:
        print("\n단일 부품이므로 조립 경로 탐색이 필요하지 않습니다.")

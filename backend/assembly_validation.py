"""
assembly_validation — 개발 이력용. 운영 파이프라인은 assembly_validation_v3.py.
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
    """
    부품을 안전하게 회전시키기 위해 가장 긴 변을 기준으로 
    여백이 포함된 정육면체(Cube) 지역 공간을 생성하고 부품을 정중앙에 배치합니다.
    """
    indices = np.nonzero(target_voxel)
    if len(indices[0]) == 0: 
        return None, (0,0,0)
        
    min_x, max_x = np.min(indices[0]), np.max(indices[0])
    min_y, max_y = np.min(indices[1]), np.max(indices[1])
    min_z, max_z = np.min(indices[2]), np.max(indices[2])
    
    len_x = max_x - min_x + 1
    len_y = max_y - min_y + 1
    len_z = max_z - min_z + 1
    
    # 회전 시 잘리지 않도록 가장 긴 변에 여유 공간(Padding) 부여
    L = max(len_x, len_y, len_z) + 4 
    local_grid = np.zeros((L, L, L), dtype=bool)
    
    # 정중앙 배치를 위한 시작점 계산
    ox = (L - len_x) // 2
    oy = (L - len_y) // 2
    oz = (L - len_z) // 2
    
    local_grid[ox:ox+len_x, oy:oy+len_y, oz:oz+len_z] = target_voxel[min_x:max_x+1, min_y:max_y+1, min_z:max_z+1]
    
    cx = min_x + (len_x // 2)
    cy = min_y + (len_y // 2)
    cz = min_z + (len_z // 2)
    
    return local_grid, (cx, cy, cz)

def check_collision_cubic(cx, cy, cz, local_grid, obstacle_voxel):
    """
    지역 큐브(Local Grid)와 전역 장애물(Obstacle) 간의 겹침을 슬라이싱으로 초고속 검사합니다.
    """
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

def a_star_6dof_escape(target_voxel, obstacle_voxel):
    """
    이동(Move) 및 세밀한 다각도 회전(Rotation)을 포함하여 최적의 탈출 경로를 탐색합니다.
    """
    Nx, Ny, Nz = obstacle_voxel.shape
    
    base_local_grid, (start_cx, start_cy, start_cz) = extract_cubic_local_grid(target_voxel)
    if base_local_grid is None: return []

    rot_dict = {base_local_grid.tobytes(): (0, base_local_grid)}
    
    def heuristic(cx, cy, cz):
        h_x = min(max(0, Nx - cx), max(0, cx))
        h_y = min(max(0, Ny - cy), max(0, cy))
        h_z = min(max(0, Nz - cz), max(0, cz))
        return min(h_x, h_y, h_z)

    # 정의된 Action 1: 이동(거리 1)
    translations = [
        ((1,0,0), 'X', 1), ((-1,0,0), 'X', -1),
        ((0,1,0), 'Y', 1), ((0,-1,0), 'Y', -1),
        ((0,0,1), 'Z', 1), ((0,0,-1), 'Z', -1)
    ]
    
    # -------------------------------------------------------------
    # [핵심 수정] 정의된 Action 2: 18방향 회전 (각 축별 ±90, ±180, ±270)
    # np.rot90의 k 파라미터를 사용하여 수학적으로 정확한 회전 배열을 도출합니다.
    # -------------------------------------------------------------
    rot_actions = [
        # Roll (X축 중심)
        ('Roll(X)', (1, 2), 1, 90), ('Roll(X)', (1, 2), -1, -90),
        ('Roll(X)', (1, 2), 2, 180), ('Roll(X)', (1, 2), -2, -180),
        ('Roll(X)', (1, 2), 3, 270), ('Roll(X)', (1, 2), -3, -270),
        # Pitch (Y축 중심)
        ('Pitch(Y)', (0, 2), 1, 90), ('Pitch(Y)', (0, 2), -1, -90),
        ('Pitch(Y)', (0, 2), 2, 180), ('Pitch(Y)', (0, 2), -2, -180),
        ('Pitch(Y)', (0, 2), 3, 270), ('Pitch(Y)', (0, 2), -3, -270),
        # Yaw (Z축 중심)
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
            return path_actions[::-1] 
            
        # 1. 이동 액션 확장
        for d_vec, axis, val in translations:
            ncx, ncy, ncz = cx + d_vec[0], cy + d_vec[1], cz + d_vec[2]
            neighbor = (ncx, ncy, ncz, rot_id)
            
            is_col, _ = check_collision_cubic(ncx, ncy, ncz, current_grid, obstacle_voxel)
            if is_col: continue
            
            tentative_g = current_g + 1
            if neighbor not in g_score or tentative_g < g_score[neighbor]:
                came_from[neighbor] = (current_state, ("MOVE", axis, val))
                g_score[neighbor] = tentative_g
                f_score = tentative_g + heuristic(ncx, ncy, ncz)
                heapq.heappush(open_set, (f_score, tentative_g, neighbor))
                
        # 2. 회전 액션 확장
        for r_name, axes, k, angle in rot_actions:
            n_grid = np.rot90(current_grid, k=k, axes=axes)
            n_grid_bytes = n_grid.tobytes()
            
            if n_grid_bytes not in rot_dict:
                rot_id_counter += 1
                rot_dict[n_grid_bytes] = (rot_id_counter, n_grid)
            n_rot_id = rot_dict[n_grid_bytes][0]
            
            neighbor = (cx, cy, cz, n_rot_id)
            
            is_col, _ = check_collision_cubic(cx, cy, cz, n_grid, obstacle_voxel)
            if is_col: continue
            
            tentative_g = current_g + 1 
            if neighbor not in g_score or tentative_g < g_score[neighbor]:
                came_from[neighbor] = (current_state, ("ROTATION", r_name, angle))
                g_score[neighbor] = tentative_g
                f_score = tentative_g + heuristic(cx, cy, cz)
                heapq.heappush(open_set, (f_score, tentative_g, neighbor))
                
    return None

def aggregate_and_reverse_path(disassembly_actions):
    """
    단위 액션을 병합하고 부호를 완전히 뒤집어 조립 궤적 명령어를 생성합니다.
    """
    if not disassembly_actions: return []
    
    # 1. 연속된 동일 축/동작 병합 (예: MOVE X 1 이 10번 -> MOVE X 10)
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
        
    # 2. 분해(추출)의 역순을 조립(투입)으로 변환
    assembly_actions = []
    for act_type, act_axis, act_val in reversed(agg_actions):
        # [핵심 수정] 정규화를 없애고 도출된 각도의 물리적 반대 방향을 그대로 유지합니다.
        # 예: 분해 시 +270도 돌렸다면 조립 시 -270도로 정확히 되돌아갑니다.
        reversed_val = -act_val 
        
        if reversed_val != 0:
            display_axis = act_axis
            if act_type == "MOVE":
                display_axis = f"+{act_axis}" if reversed_val > 0 else f"-{act_axis}"
                reversed_val = abs(reversed_val)
                
            assembly_actions.append((act_type, display_axis, reversed_val))
            
    return assembly_actions

worker_voxels_cache = None

def init_escape_worker(voxels_dict):
    """
    각 워커 프로세스가 생성될 때 단 한 번 실행되어 
    무거운 Voxel 데이터를 로컬 메모리에 캐싱합니다.
    """
    global worker_voxels_cache
    worker_voxels_cache = voxels_dict

def try_escape_task(part_idx, remaining_parts_tuple):
    """
    단일 부품의 탈출 가능 여부를 탐색하는 독립 Task
    """
    global worker_voxels_cache
    target_voxel = worker_voxels_cache[part_idx]
    
    Nx, Ny, Nz = target_voxel.shape
    obstacle_map = np.zeros((Nx, Ny, Nz), dtype=bool)
    
    # 캐시된 데이터를 이용해 현재 상태의 장애물 맵 구성
    for other_idx in remaining_parts_tuple:
        if other_idx != part_idx:
            obstacle_map |= worker_voxels_cache[other_idx]
            
    initial_overlap = target_voxel & obstacle_map
    safe_obstacle_map = obstacle_map & (~initial_overlap)
    
    # 기존에 구현하신 6-DOF A* 알고리즘 호출
    escape_actions = a_star_6dof_escape(target_voxel, safe_obstacle_map)
    
    return part_idx, escape_actions

# =====================================================================
# 1. 6-DOF 동적 조립 경로 탐색 (병렬화 적용)
# =====================================================================

def plan_assembly_sequence(voxels_dict):
    print("\n[6-DOF 동적 조립 경로 탐색 시작 (Multiprocessing 가속 적용)]")
    remaining_parts = list(voxels_dict.keys())
    disassembly_sequence = []
    raw_disassembly_paths = {} # 각 부품별 원시 궤적을 저장하는 딕셔너리
    
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
                
                futures = {
                    executor.submit(try_escape_task, part_idx, remaining_tuple): part_idx 
                    for part_idx in remaining_parts
                }
                
                for future in concurrent.futures.as_completed(futures):
                    part_idx, escape_actions = future.result()
                    
                    if escape_actions is not None:
                        tqdm.write(f"✅ Solid {part_idx} 추출 성공! (발생한 Action 수: {len(escape_actions)}번)")
                        disassembly_sequence.append(part_idx)
                        
                        # [유지됨] 궤적 데이터를 딕셔너리에 저장
                        raw_disassembly_paths[part_idx] = escape_actions
                        
                        remaining_parts.remove(part_idx)
                        extracted_in_this_loop = True
                        
                        pbar.update(1)
                        pbar.set_postfix({"Extracted": f"Solid {part_idx}"})
                        
                        for f in futures:
                            if not f.done():
                                f.cancel()
                        break 
                        
                if not extracted_in_this_loop:
                    tqdm.write(f"🚨 교착 상태(Deadlock) 발생! 남은 부품 {remaining_parts} 은/는 분해할 수 없습니다.")
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
                
    # [핵심 수정] 조립 순서 배열과 원시 궤적 딕셔너리를 함께 반환
    return assembly_sequence, raw_disassembly_paths

def voxelize_mesh_worker(index, vertices, faces, voxel_size, min_compound, resolution):
    """
    단일 Solid의 Voxelization을 수행하는 Worker 함수.
    경로 탐색용 sparse 인덱스와, 렌더용 원본 mesh(vertices, faces)를 함께 반환합니다.
    """
    try:
        # 1. 전달받은 순수 Numpy 데이터로 Trimesh 객체 재구성
        mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=True)
        
        # 2. Voxelization 수행 (병목 구간)
        voxelized = mesh.voxelized(voxel_size)
        if mesh.is_watertight:
            voxelized = voxelized.fill()
            
        # 3. 해상도에 맞춘 로컬 인덱스 계산
        indices = np.floor((voxelized.points - min_compound) / voxel_size).astype(int)
        indices[:, 0] = np.clip(indices[:, 0], 0, resolution[0] - 1)
        indices[:, 1] = np.clip(indices[:, 1], 0, resolution[1] - 1)
        indices[:, 2] = np.clip(indices[:, 2], 0, resolution[2] - 1)
        
        # Dense Array 대신 계산된 인덱스들만 반환 (렌더용 mesh 원본도 함께 반환)
        return index, indices, vertices, faces, None
    except Exception as e:
        # 디버깅을 위한 에러 반환 로직
        return index, None, None, None, str(e)

def export_to_msgpack(filepath, resolution, voxel_size, min_bound, max_bound, 
                      voxels_dict, meshes_dict, assembly_sequence, raw_disassembly_paths):
    """
    Voxel 데이터와 A* 궤적을 압축하여 지정된 규격의 MessagePack 파일로 내보냅니다.
    """
    print(f"\n[STEP 4] 프론트엔드 전송용 MessagePack 직렬화 시작...")
    
    # 1. 메타데이터 구성 (Numpy 스칼라를 파이썬 기본형으로 캐스팅)
    metadata = {
        "resolution": [int(r) for r in resolution],
        "voxel_size": float(voxel_size),
        "min_bound": [float(v) for v in min_bound],
        "max_bound": [float(v) for v in max_bound]
    }
    
    # 2. Voxel 바이너리 압축 (Uint8Array 대응)
    solids_data = {}
    for idx, voxel_grid in voxels_dict.items():
        # 1차원으로 펼친 후 8개의 bool을 1개의 uint8로 압축
        compressed_bytes = np.packbits(voxel_grid.flatten()).tobytes()
        solids_data[str(idx)] = compressed_bytes

    # 3. Mesh 바이너리 (프론트 렌더 전용 — 경로 계산은 voxel 유지)
    meshes_data = {}
    for idx, mesh_data in meshes_dict.items():
        v_bytes = np.array(mesh_data["vertices"], dtype=np.float32).tobytes()
        f_bytes = np.array(mesh_data["faces"], dtype=np.int32).tobytes()
        meshes_data[str(idx)] = {
            "vertices": v_bytes,
            "faces": f_bytes,
        }
        
    # 4. 조립 궤적(Trajectories) 데이터 포맷팅
    trajectories = {}
    
    # 모든 부품에 대해 빈 배열로 초기화 (궤적이 없는 기준 부품 등을 위해)
    for idx in voxels_dict.keys():
        trajectories[str(idx)] = []
        
    for part_idx in assembly_sequence:
        raw_path = raw_disassembly_paths.get(part_idx, [])
        final_assembly_path = aggregate_and_reverse_path(raw_path)
        
        formatted_path = []
        for a_type, a_axis, a_val in final_assembly_path:
            formatted_path.append({
                "type": a_type,         # "MOVE" or "ROTATION"
                "axis": str(a_axis),    # e.g., "+X", "Roll(X)"
                "value": int(a_val)     # e.g., 15, 90
            })
            
        trajectories[str(part_idx)] = formatted_path

    # 5. 최종 페이로드 조립
    payload = {
        "metadata": metadata,
        "solids": solids_data,
        "meshes": meshes_data,
        "assembly": {
            "sequence": [int(seq) for seq in assembly_sequence],
            "trajectories": trajectories
        }
    }
    
    # 5. 바이너리 파일로 기록 (use_bin_type=True 필수)
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

    # -----------------------------------------------------------------
    # 병렬 처리를 위한 작업(Task) 생성 단계 
    # -----------------------------------------------------------------
    tasks = []
    solid_list = list(compound.solids())
    
    # 작업 추출 과정도 tqdm으로 감싸서 진행률 표시 (Solid 개수가 많을 때 유용)
    print("[STEP 2] 병렬 처리를 위한 형상 데이터 추출 중...")
    for index, solid in tqdm(enumerate(solid_list), total=len(solid_list), desc="Extracting Geometry", unit="solid"):
        vertices, faces = solid.get_triangles()
        if vertices is None or len(vertices) == 0: 
            tqdm.write(f"⚠️ Solid {index}: Mesh data가 비어있어 스킵합니다.")
            continue
        tasks.append((index, vertices, faces, args.voxel_size, min_compound, resolution))

    # -----------------------------------------------------------------
    # 멀티프로세싱 Voxelization 실행 (프로그레스 바 적용)
    # -----------------------------------------------------------------
    voxels = dict()
    meshes = dict()
    num_cores = min(os.cpu_count() or 4, len(tasks))
    print(f"\n[STEP 3] {num_cores}개의 코어를 활용하여 병렬 Voxelization을 시작합니다...")
    
    with concurrent.futures.ProcessPoolExecutor(max_workers=num_cores) as executor:
        futures = {
            executor.submit(voxelize_mesh_worker, *task): task[0] 
            for task in tasks
        }
        
        # [핵심 수정] tqdm 프로그레스 바 컨텍스트 매니저 사용
        with tqdm(total=len(tasks), desc="Voxelizing", unit="part", smoothing=0.1) as pbar:
            for future in concurrent.futures.as_completed(futures):
                idx = futures[future]
                try:
                    result_idx, indices, verts, facs, err_msg = future.result()
                    
                    if err_msg is not None:
                        # 에러 발생 시 프로그레스 바를 깨지 않고 콘솔에 출력
                        tqdm.write(f'🚨 Solid {idx} 에러 발생: {err_msg}')
                    elif indices is not None:
                        # 결과 병합
                        voxel_grid = np.zeros(resolution, dtype=bool)
                        voxel_grid[indices[:, 0], indices[:, 1], indices[:, 2]] = True
                        voxels[result_idx] = voxel_grid
                        meshes[result_idx] = {"vertices": verts, "faces": facs}
                        
                        # [핵심] 프로그레스 바 우측에 최근 완료된 작업의 정보 동적 표시
                        pbar.set_postfix({
                            "Last_Done": f"Solid {result_idx}", 
                            "Voxels": f"{len(indices):,}"
                        })
                        
                except Exception as exc:
                    tqdm.write(f'🚨 Solid {idx} 처리 중 예기치 않은 오류 발생: {exc}')
                
                # 작업이 하나 끝날 때마다 게이지 1 증가
                pbar.update(1)

    print("\n✅ 모든 Voxelization 작업이 완료되었습니다!")

    # -----------------------------------------------------------------
    # 조립 순서 및 경로 계획 실행 → 항상(복셀 ≥1) 프론트용 msgpack 기록
    # (단일 solid 는 경로 탐색 없이 solids + 빈 trajectory 만 내보냄)
    # -----------------------------------------------------------------
    export_file_name = "assembly_data.msgpack"

    if len(voxels) == 0:
        print(
            "\n⚠️ 유효한 복셀이 없어 assembly_data.msgpack 을 쓰지 않습니다. "
            "(STEP 메시가 비어 있거나 복셀화에 실패했을 수 있습니다.)"
        )
    elif len(voxels) == 1:
        sequence = sorted(voxels.keys())
        raw_paths = {}
        print("\n단일 부품: 조립 경로 탐색 생략, MessagePack 만보냅니다.")
        export_to_msgpack(
            filepath=export_file_name,
            resolution=resolution,
            voxel_size=args.voxel_size,
            min_bound=min_compound,
            max_bound=max_compound,
            voxels_dict=voxels,
            meshes_dict=meshes,
            assembly_sequence=sequence,
            raw_disassembly_paths=raw_paths,
        )
    else:
        sequence, raw_paths = plan_assembly_sequence(voxels)
        export_to_msgpack(
            filepath=export_file_name,
            resolution=resolution,
            voxel_size=args.voxel_size,
            min_bound=min_compound,
            max_bound=max_compound,
            voxels_dict=voxels,
            meshes_dict=meshes,
            assembly_sequence=sequence,
            raw_disassembly_paths=raw_paths,
        )

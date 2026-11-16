/**
 * 조립 결과 msgpack 바이트를 화면용 결과 객체로 바꾸는 데이터 계층.
 *
 * 두 모드는 바이트를 얻는 방법만 다르고, 그 뒤는 이 파일의 parseAssemblyBytes 를 탄다.
 *   Debug   : 로컬 파일 (modes/debug_mode.js)
 *   Service : /api 응답 (api.js)
 *   공통    : bytes → decode → normalizeAssemblyPayload → getValidatedPayload
 *
 * 화면(DOM), 서버, Three.js 는 모른다.
 *
 * 정규화는 exporter 원본 포맷(int-key 맵, {min,max} bbox, 조립 자세 solids.state)을
 * 렌더러가 쓰는 dense 구조로 바꾸고, 검증은 그 결과가 규약을 지키는지 확인한다.
 */

import { decode } from "@msgpack/msgpack";

export class ResultLoadException extends Error {
  constructor(message) {
    super(message);
    this.name = "ResultLoadException";
  }
}

function checkIsPlainObject(value, field_name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ResultLoadException(
      `${field_name} must be an object, received ${Object.prototype.toString.call(value)}`,
    );
  }
}

function checkIsArray(value, field_name) {
  if (!Array.isArray(value)) {
    throw new ResultLoadException(
      `${field_name} must be an array, received ${Object.prototype.toString.call(value)}`,
    );
  }
}

function getValidatedMetadata(metadata_entry) {
  checkIsPlainObject(metadata_entry, "metadata");

  const { step_path, global_bbox } = metadata_entry;
  if (typeof step_path !== "string") {
    throw new ResultLoadException("metadata.step_path must be a string");
  }
  checkIsArray(global_bbox, "metadata.global_bbox");
  if (global_bbox.length !== 6) {
    throw new ResultLoadException("metadata.global_bbox must contain exactly 6 values");
  }

  return {
    step_path,
    global_bbox: global_bbox.map(Number),
  };
}

function getValidatedState(state_entry, field_name) {
  checkIsPlainObject(state_entry, field_name);

  const { position, rotation } = state_entry;
  checkIsArray(position, `${field_name}.position`);
  checkIsArray(rotation, `${field_name}.rotation`);
  if (position.length !== 3) {
    throw new ResultLoadException(`${field_name}.position must contain 3 values`);
  }
  if (rotation.length !== 3) {
    throw new ResultLoadException(`${field_name}.rotation must contain 3 values`);
  }

  return {
    position: position.map(Number),
    rotation: rotation.map(Number),
  };
}

function getValidatedPartIndex(part_index_entry, solid_index) {
  if (part_index_entry === undefined) {
    return solid_index;
  }
  if (!Number.isInteger(part_index_entry) || part_index_entry < 0) {
    throw new ResultLoadException(
      `solids[${solid_index}].part_index must be a non-negative integer`,
    );
  }
  return part_index_entry;
}

function getValidatedSolidName(name_entry, solid_index) {
  if (name_entry === undefined) {
    return undefined;
  }
  if (typeof name_entry !== "string" || name_entry.trim() === "") {
    throw new ResultLoadException(
      `solids[${solid_index}].name must be a non-empty string`,
    );
  }
  return name_entry;
}

function getValidatedSolidConversion(conversion_entry, solid_index) {
  if (conversion_entry === undefined) {
    return undefined;
  }
  if (typeof conversion_entry !== "string" || conversion_entry.trim() === "") {
    throw new ResultLoadException(
      `solids[${solid_index}].conversion must be a non-empty string`,
    );
  }
  return conversion_entry;
}

function getValidatedSolid(solid_entry, solid_index) {
  checkIsPlainObject(solid_entry, `solids[${solid_index}]`);

  const {
    mesh,
    state,
    part_index: part_index_entry,
    name: name_entry,
    conversion: conversion_entry,
  } = solid_entry;
  checkIsPlainObject(mesh, `solids[${solid_index}].mesh`);
  checkIsArray(mesh.vertices, `solids[${solid_index}].mesh.vertices`);
  checkIsArray(mesh.faces, `solids[${solid_index}].mesh.faces`);

  const validated_solid = {
    mesh: {
      vertices: mesh.vertices,
      faces: mesh.faces,
    },
    state: getValidatedState(state, `solids[${solid_index}].state`),
    part_index: getValidatedPartIndex(part_index_entry, solid_index),
  };
  const solid_name = getValidatedSolidName(name_entry, solid_index);
  if (solid_name !== undefined) {
    validated_solid.name = solid_name;
  }
  const solid_conversion = getValidatedSolidConversion(conversion_entry, solid_index);
  if (solid_conversion !== undefined) {
    validated_solid.conversion = solid_conversion;
  }
  return validated_solid;
}

function getValidatedTrajectoryFrame(trajectory_frame_entry, frame_index) {
  checkIsPlainObject(trajectory_frame_entry, `trajectories[${frame_index}]`);

  const {
    solid: solid_index,
    state,
    action,
  } = trajectory_frame_entry;

  if (!Number.isInteger(solid_index)) {
    throw new ResultLoadException(
      `trajectories[${frame_index}].solid must be an integer`,
    );
  }

  checkIsPlainObject(action, `trajectories[${frame_index}].action`);
  if (action.type !== "translation" && action.type !== "rotation") {
    throw new ResultLoadException(
      `trajectories[${frame_index}].action.type must be translation or rotation`,
    );
  }
  checkIsArray(action.value, `trajectories[${frame_index}].action.value`);
  if (action.value.length !== 3) {
    throw new ResultLoadException(
      `trajectories[${frame_index}].action.value must contain 3 values`,
    );
  }

  return {
    solid: solid_index,
    state: getValidatedState(state, `trajectories[${frame_index}].state`),
    action: {
      type: action.type,
      value: action.value.map(Number),
    },
  };
}

function getValidatedOverlap(overlap_entry, field_name) {
  checkIsPlainObject(overlap_entry, field_name);

  const { obstacle, is_over_limit, mesh } = overlap_entry;
  if (!Number.isInteger(obstacle)) {
    throw new ResultLoadException(`${field_name}.obstacle must be an integer`);
  }
  if (typeof is_over_limit !== "boolean") {
    throw new ResultLoadException(`${field_name}.is_over_limit must be a boolean`);
  }
  checkIsPlainObject(mesh, `${field_name}.mesh`);
  checkIsArray(mesh.vertices, `${field_name}.mesh.vertices`);
  checkIsArray(mesh.faces, `${field_name}.mesh.faces`);

  return {
    obstacle,
    is_over_limit,
    // 월드 좌표다. 그리는 쪽에서 state 변환을 곱하면 안 된다.
    mesh: { vertices: mesh.vertices, faces: mesh.faces },
  };
}

function getValidatedFailurePose(pose_entry, field_name) {
  // null 은 규약상 정상값이다(조립 상태부터 초과 / 막힘 자세를 찾지 못함).
  if (pose_entry === null) {
    return null;
  }
  checkIsPlainObject(pose_entry, field_name);
  checkIsArray(pose_entry.overlaps, `${field_name}.overlaps`);

  return {
    state: getValidatedState(pose_entry.state, `${field_name}.state`),
    overlaps: pose_entry.overlaps.map((overlap_entry, overlap_index) =>
      getValidatedOverlap(overlap_entry, `${field_name}.overlaps[${overlap_index}]`),
    ),
  };
}

function getValidatedFailure(failure_entry, failure_index) {
  const field_name = `failures[${failure_index}]`;
  checkIsPlainObject(failure_entry, field_name);

  const { solid: solid_index, closest_path } = failure_entry;
  if (!Number.isInteger(solid_index)) {
    throw new ResultLoadException(`${field_name}.solid must be an integer`);
  }
  checkIsArray(closest_path, `${field_name}.closest_path`);

  return {
    solid: solid_index,
    // trajectories 와 같은 스텝 구조이므로 같은 검증기를 쓴다. 빈 배열이면 그 부품은
    // 한 걸음도 움직이지 못한 것이다.
    closest_path: closest_path.map((frame_entry, frame_index) =>
      getValidatedTrajectoryFrame(frame_entry, `${field_name}.closest_path.${frame_index}`),
    ),
    last_valid_pose: getValidatedFailurePose(
      failure_entry.last_valid_pose,
      `${field_name}.last_valid_pose`,
    ),
    first_blocked_pose: getValidatedFailurePose(
      failure_entry.first_blocked_pose,
      `${field_name}.first_blocked_pose`,
    ),
  };
}

function getValidatedFailures(failures_entry) {
  // 전부 성공한 결과에는 failures 가 없다. 없음과 빈 목록을 같게 다룬다.
  if (failures_entry === undefined) {
    return [];
  }
  checkIsArray(failures_entry, "failures");
  return failures_entry.map(getValidatedFailure);
}

function getValidatedPayload(payload) {
  checkIsPlainObject(payload, "payload");

  const { metadata, solids, trajectories, failures } = payload;
  checkIsArray(solids, "solids");
  checkIsArray(trajectories, "trajectories");

  return {
    metadata: getValidatedMetadata(metadata),
    solids: solids.map(getValidatedSolid),
    trajectories: trajectories.map(getValidatedTrajectoryFrame),
    failures: getValidatedFailures(failures),
  };
}

// ---------------------------------------------------------------------------
// 정규화: exporter 원본 포맷 → 렌더러용 dense 구조
// ---------------------------------------------------------------------------

function getIndexedEntriesWithKeys(indexed_entries, field_name) {
  // msgpack int-key map / list 모두 지원. 키(=파서 part_index)를 보존한다.
  if (Array.isArray(indexed_entries)) {
    return indexed_entries.map((entry, index) => ({
      key: index,
      entry,
    }));
  }
  if (indexed_entries === null || typeof indexed_entries !== "object") {
    throw new ResultLoadException(`${field_name} must be a list or int-keyed object`);
  }

  const sorted_keys = Object.keys(indexed_entries).sort(
    (left_key, right_key) => Number(left_key) - Number(right_key),
  );
  return sorted_keys.map((key) => {
    const part_index = Number(key);
    if (!Number.isInteger(part_index) || part_index < 0) {
      throw new ResultLoadException(
        `${field_name} keys must be non-negative integers, received ${key}`,
      );
    }
    return {
      key: part_index,
      entry: indexed_entries[key],
    };
  });
}

function getFlatGlobalBbox(global_bbox_entry) {
  if (Array.isArray(global_bbox_entry)) {
    if (global_bbox_entry.length !== 6) {
      throw new ResultLoadException("global_bbox list must contain exactly 6 values");
    }
    return global_bbox_entry.map(Number);
  }
  if (global_bbox_entry === null || typeof global_bbox_entry !== "object") {
    throw new ResultLoadException("global_bbox must be a list or {min, max} object");
  }

  const minimum_corner = global_bbox_entry.min;
  const maximum_corner = global_bbox_entry.max;
  if (!Array.isArray(minimum_corner) || !Array.isArray(maximum_corner)) {
    throw new ResultLoadException("global_bbox.min and global_bbox.max must be lists");
  }
  if (minimum_corner.length !== 3 || maximum_corner.length !== 3) {
    throw new ResultLoadException(
      "global_bbox.min and global_bbox.max must each contain 3 values",
    );
  }
  return [
    Number(minimum_corner[0]),
    Number(minimum_corner[1]),
    Number(minimum_corner[2]),
    Number(maximum_corner[0]),
    Number(maximum_corner[1]),
    Number(maximum_corner[2]),
  ];
}


function getStateBeforeAction(end_state, action_entry, field_name) {
  if (action_entry === null || typeof action_entry !== "object") {
    throw new ResultLoadException(`${field_name} must be an object`);
  }
  const action_type = action_entry.type;
  const action_value = action_entry.value;
  if (action_type !== "translation" && action_type !== "rotation") {
    throw new ResultLoadException(
      `${field_name}.type must be translation or rotation`,
    );
  }
  if (!Array.isArray(action_value) || action_value.length !== 3) {
    throw new ResultLoadException(`${field_name}.value must contain 3 values`);
  }

  const delta = action_value.map(Number);
  if (action_type === "translation") {
    return {
      position: [
        end_state.position[0] - delta[0],
        end_state.position[1] - delta[1],
        end_state.position[2] - delta[2],
      ],
      rotation: [...end_state.rotation],
    };
  }
  return {
    position: [...end_state.position],
    rotation: [
      end_state.rotation[0] - delta[0],
      end_state.rotation[1] - delta[1],
      end_state.rotation[2] - delta[2],
    ],
  };
}

function getSolidsWithDerivedInitialStates(solid_entries_with_keys, trajectories) {
  const first_trajectory_by_part_index = new Map();
  trajectories.forEach((trajectory_frame) => {
    if (trajectory_frame === null || typeof trajectory_frame !== "object") {
      throw new ResultLoadException("trajectory frame must be an object");
    }
    const part_index = trajectory_frame.solid;
    if (!Number.isInteger(part_index)) {
      throw new ResultLoadException("trajectory solid must be an integer");
    }
    if (!first_trajectory_by_part_index.has(part_index)) {
      first_trajectory_by_part_index.set(part_index, trajectory_frame);
    }
  });

  return solid_entries_with_keys.map(({ key: part_index, entry: solid_entry }) => {
    if (solid_entry === null || typeof solid_entry !== "object") {
      throw new ResultLoadException(`solids[${part_index}] must be an object`);
    }
    const mesh_entry = solid_entry.mesh;
    const state_entry = solid_entry.state;
    if (mesh_entry === null || typeof mesh_entry !== "object") {
      throw new ResultLoadException(`solids[${part_index}].mesh must be an object`);
    }

    let initial_state = getValidatedState(state_entry, `solids[${part_index}].state`);
    const first_trajectory = first_trajectory_by_part_index.get(part_index);
    if (first_trajectory !== undefined) {
      initial_state = getStateBeforeAction(
        getValidatedState(
          first_trajectory.state,
          `trajectories[solid=${part_index}].state`,
        ),
        first_trajectory.action,
        `trajectories[solid=${part_index}].action`,
      );
    }

    const normalized_solid = {
      mesh: mesh_entry,
      state: initial_state,
      part_index,
    };
    const solid_name = solid_entry.name;
    if (typeof solid_name === "string" && solid_name.trim() !== "") {
      normalized_solid.name = solid_name;
    } else if (solid_name !== undefined) {
      throw new ResultLoadException(
        `solids[${part_index}].name must be a non-empty string`,
      );
    }
    const solid_conversion = solid_entry.conversion;
    if (typeof solid_conversion === "string" && solid_conversion.trim() !== "") {
      normalized_solid.conversion = solid_conversion;
    } else if (solid_conversion !== undefined) {
      throw new ResultLoadException(
        `solids[${part_index}].conversion must be a non-empty string`,
      );
    }
    return normalized_solid;
  });
}

function expandBboxWithSolidStates(global_bbox, solids) {
  const expanded_bbox = [...global_bbox];
  solids.forEach((solid_entry) => {
    const position = solid_entry.state?.position;
    if (!Array.isArray(position) || position.length !== 3) {
      return;
    }
    for (let axis_index = 0; axis_index < 3; axis_index += 1) {
      const offset = Number(position[axis_index]);
      expanded_bbox[axis_index] = Math.min(
        expanded_bbox[axis_index],
        global_bbox[axis_index] + offset,
      );
      expanded_bbox[axis_index + 3] = Math.max(
        expanded_bbox[axis_index + 3],
        global_bbox[axis_index + 3] + offset,
      );
    }
  });
  return expanded_bbox;
}

function remapTrajectorySolidIndexes(trajectories, part_index_to_dense_index) {
  // 렌더러는 dense array index를 쓰므로, 파서 part_index → dense index로 재매핑한다.
  return trajectories.map((trajectory_frame, frame_index) => {
    if (trajectory_frame === null || typeof trajectory_frame !== "object") {
      throw new ResultLoadException(`trajectories[${frame_index}] must be an object`);
    }
    const part_index = trajectory_frame.solid;
    if (!Number.isInteger(part_index)) {
      throw new ResultLoadException(
        `trajectories[${frame_index}].solid must be an integer`,
      );
    }
    if (!part_index_to_dense_index.has(part_index)) {
      throw new ResultLoadException(
        `trajectories[${frame_index}].solid=${part_index} is missing from solids`,
      );
    }
    return {
      ...trajectory_frame,
      solid: part_index_to_dense_index.get(part_index),
    };
  });
}

/**
 * failures 를 렌더러가 쓰는 dense index 기준으로 정규화한다.
 *
 * 원본 failures 의 키와 overlaps[].obstacle 은 파서 part_index 다. solids/trajectories 와
 * 같은 재매핑을 태우지 않으면 엉뚱한 부품을 범인으로 지목한다. 부품 식별자는 실행마다
 * 달라지므로(같은 STEP 이라도 sub1/bottom 의 id 가 뒤바뀐 실측이 있다) 이 재매핑은
 * 선택이 아니다.
 *
 * closest_path 는 trajectories 와 구조가 같지만 mergeColinearTrajectoryFrames 를 적용하지
 * 않는다 — 실패 경로는 탐색이 더듬은 스텝 수 자체가 정보이고, 재생은 별도 시퀀스가
 * 담당하기 때문이다.
 */
function getDenseSolidIndex(part_index_entry, part_index_to_dense_index, field_name) {
  if (!Number.isInteger(part_index_entry)) {
    throw new ResultLoadException(`${field_name} must be an integer`);
  }
  if (!part_index_to_dense_index.has(part_index_entry)) {
    throw new ResultLoadException(
      `${field_name}=${part_index_entry} is missing from solids`,
    );
  }
  return part_index_to_dense_index.get(part_index_entry);
}

function getValidatedOverlapMesh(mesh_entry, field_name) {
  if (mesh_entry === null || typeof mesh_entry !== "object") {
    throw new ResultLoadException(`${field_name} must be an object`);
  }
  if (!Array.isArray(mesh_entry.vertices)) {
    throw new ResultLoadException(`${field_name}.vertices must be an array`);
  }
  if (!Array.isArray(mesh_entry.faces)) {
    throw new ResultLoadException(`${field_name}.faces must be an array`);
  }
  // 정점은 해당 자세가 이미 적용된 월드 좌표다. solids[].mesh 와 달리 state 변환을
  // 곱하지 않고 그대로 그린다.
  return { vertices: mesh_entry.vertices, faces: mesh_entry.faces };
}

function getNormalizedOverlaps(overlaps_entry, part_index_to_dense_index, field_name) {
  // 겹침이 하나도 없는 자세가 실제로 존재한다(hair_dryer 의 fan). 빈 목록이 정상이다.
  // overlaps 키가 없어도 빈 목록으로 본다(last_valid_pose 는 생략될 수 있다).
  // 지금은 쓰지 않지만 나중에 조립 설계상 겹침 표시 등에 쓸 수 있어 형식은 유지한다.
  if (overlaps_entry === undefined || overlaps_entry === null) {
    return [];
  }
  return getIndexedEntriesWithKeys(overlaps_entry, field_name).map(
    ({ key: overlap_index, entry: overlap_entry }) => {
      const overlap_field_name = `${field_name}[${overlap_index}]`;
      if (overlap_entry === null || typeof overlap_entry !== "object") {
        throw new ResultLoadException(`${overlap_field_name} must be an object`);
      }
      if (typeof overlap_entry.is_over_limit !== "boolean") {
        throw new ResultLoadException(
          `${overlap_field_name}.is_over_limit must be a boolean`,
        );
      }
      return {
        obstacle: getDenseSolidIndex(
          overlap_entry.obstacle,
          part_index_to_dense_index,
          `${overlap_field_name}.obstacle`,
        ),
        is_over_limit: overlap_entry.is_over_limit,
        mesh: getValidatedOverlapMesh(
          overlap_entry.mesh,
          `${overlap_field_name}.mesh`,
        ),
      };
    },
  );
}

function getNormalizedFailurePose(pose_entry, part_index_to_dense_index, field_name) {
  // null 은 오류가 아니라 규약이다. last_valid_pose 가 null 이면 조립 상태부터 상한을
  // 넘은 것이고, first_blocked_pose 가 null 이면 막은 자세를 찾지 못한 것이다(탐색 한계).
  // 둘이 동시에 null 이 되지는 않으므로 최소 한 자세는 항상 남는다.
  if (pose_entry === null || pose_entry === undefined) {
    return null;
  }
  if (typeof pose_entry !== "object") {
    throw new ResultLoadException(`${field_name} must be an object or null`);
  }
  return {
    state: getValidatedState(pose_entry.state, `${field_name}.state`),
    overlaps: getNormalizedOverlaps(
      pose_entry.overlaps,
      part_index_to_dense_index,
      `${field_name}.overlaps`,
    ),
  };
}

function getNormalizedFailures(failures_entry, part_index_to_dense_index) {
  // 전부 분해에 성공하면 백엔드가 failures 키 자체를 내보내지 않는다(빈 맵이 아니라 부재).
  if (failures_entry === null || failures_entry === undefined) {
    return [];
  }

  return getIndexedEntriesWithKeys(failures_entry, "failures").map(
    ({ key: part_index, entry: failure_entry }) => {
      const field_name = `failures[${part_index}]`;
      if (failure_entry === null || typeof failure_entry !== "object") {
        throw new ResultLoadException(`${field_name} must be an object`);
      }

      const closest_path_entries = getIndexedEntriesWithKeys(
        failure_entry.closest_path,
        `${field_name}.closest_path`,
      ).map(({ entry }) => entry);

      return {
        solid: getDenseSolidIndex(part_index, part_index_to_dense_index, field_name),
        closest_path: remapTrajectorySolidIndexes(
          closest_path_entries,
          part_index_to_dense_index,
        ),
        last_valid_pose: getNormalizedFailurePose(
          failure_entry.last_valid_pose,
          part_index_to_dense_index,
          `${field_name}.last_valid_pose`,
        ),
        first_blocked_pose: getNormalizedFailurePose(
          failure_entry.first_blocked_pose,
          part_index_to_dense_index,
          `${field_name}.first_blocked_pose`,
        ),
      };
    },
  );
}

function getActionDirectionKey(action_entry, field_name) {
  if (action_entry === null || typeof action_entry !== "object") {
    throw new ResultLoadException(`${field_name} must be an object`);
  }
  const action_type = action_entry.type;
  const action_value = action_entry.value;
  if (action_type !== "translation" && action_type !== "rotation") {
    throw new ResultLoadException(
      `${field_name}.type must be translation or rotation`,
    );
  }
  if (!Array.isArray(action_value) || action_value.length !== 3) {
    throw new ResultLoadException(`${field_name}.value must contain 3 values`);
  }

  const numeric_value = action_value.map(Number);
  const magnitude = Math.hypot(
    numeric_value[0],
    numeric_value[1],
    numeric_value[2],
  );
  if (magnitude < 1e-9) {
    return `${action_type}:0,0,0`;
  }
  const direction_components = numeric_value.map(
    (component) => Math.round((component / magnitude) * 1e6) / 1e6,
  );
  return `${action_type}:${direction_components.join(",")}`;
}

/**
 * 같은 solid + 같은 방향의 연속 trajectory를 한 프레임으로 합친다.
 * 예: 오른쪽×3 + 뒷쪽×2 → 오른쪽 1프레임 + 뒷쪽 1프레임 (재생 5초 → 2초).
 */
function mergeColinearTrajectoryFrames(trajectories) {
  if (trajectories.length === 0) {
    return [];
  }

  const merged_trajectories = [];
  let run_start_index = 0;

  for (let frame_index = 1; frame_index <= trajectories.length; frame_index += 1) {
    const run_start_frame = trajectories[run_start_index];
    if (run_start_frame === null || typeof run_start_frame !== "object") {
      throw new ResultLoadException(
        `trajectories[${run_start_index}] must be an object`,
      );
    }

    let can_extend_run = false;
    if (frame_index < trajectories.length) {
      const next_frame = trajectories[frame_index];
      if (next_frame === null || typeof next_frame !== "object") {
        throw new ResultLoadException(`trajectories[${frame_index}] must be an object`);
      }
      can_extend_run =
        next_frame.solid === run_start_frame.solid &&
        getActionDirectionKey(next_frame.action, `trajectories[${frame_index}].action`) ===
          getActionDirectionKey(
            run_start_frame.action,
            `trajectories[${run_start_index}].action`,
          );
    }

    if (can_extend_run) {
      continue;
    }

    const run_frames = trajectories.slice(run_start_index, frame_index);
    const last_frame = run_frames[run_frames.length - 1];
    const merged_action_value = [0, 0, 0];
    for (const run_frame of run_frames) {
      const action_value = run_frame.action.value;
      merged_action_value[0] += Number(action_value[0]);
      merged_action_value[1] += Number(action_value[1]);
      merged_action_value[2] += Number(action_value[2]);
    }

    const end_state = getValidatedState(
      last_frame.state,
      `trajectories[${frame_index - 1}].state`,
    );
    merged_trajectories.push({
      solid: run_start_frame.solid,
      state: end_state,
      action: {
        type: run_start_frame.action.type,
        value: merged_action_value,
      },
    });
    run_start_index = frame_index;
  }

  return merged_trajectories;
}

function normalizeAssemblyPayload(raw_payload) {
  if (raw_payload === null || typeof raw_payload !== "object" || Array.isArray(raw_payload)) {
    throw new ResultLoadException("assembly payload root must be an object");
  }

  const metadata_entry = raw_payload.metadata;
  if (metadata_entry === null || typeof metadata_entry !== "object") {
    throw new ResultLoadException("metadata must be an object");
  }

  const solid_entries_with_keys = getIndexedEntriesWithKeys(raw_payload.solids, "solids");
  const trajectory_entries_with_keys = getIndexedEntriesWithKeys(
    raw_payload.trajectories,
    "trajectories",
  );
  const trajectories = mergeColinearTrajectoryFrames(
    trajectory_entries_with_keys.map(({ entry }) => entry),
  );
  let global_bbox = getFlatGlobalBbox(metadata_entry.global_bbox);
  const normalized_solids = getSolidsWithDerivedInitialStates(
    solid_entries_with_keys,
    trajectories,
  );
  global_bbox = expandBboxWithSolidStates(global_bbox, normalized_solids);

  const part_index_to_dense_index = new Map(
    normalized_solids.map((solid_entry, dense_index) => [
      solid_entry.part_index,
      dense_index,
    ]),
  );
  const remapped_trajectories = remapTrajectorySolidIndexes(
    trajectories,
    part_index_to_dense_index,
  );
  const failures = getNormalizedFailures(
    raw_payload.failures,
    part_index_to_dense_index,
  );

  const step_path =
    typeof metadata_entry.step_path === "string" && metadata_entry.step_path !== ""
      ? metadata_entry.step_path
      : "uploaded.msgpack";

  return {
    metadata: {
      step_path,
      global_bbox,
    },
    solids: normalized_solids,
    trajectories: remapped_trajectories,
    failures,
  };
}

export function parseAssemblyBytes(payload_bytes) {
  let raw_payload;
  try {
    raw_payload = decode(payload_bytes);
  } catch (error) {
    throw new ResultLoadException(
      `payload is not valid msgpack data: ${error.message}`,
    );
  }
  return getValidatedPayload(normalizeAssemblyPayload(raw_payload));
}

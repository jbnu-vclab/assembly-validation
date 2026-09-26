import { decode, encode } from "@msgpack/msgpack";
import { decodeAssemblyResult, ResultLoadException } from "./loader.js";
import { AssemblyRenderer, AssemblyRenderException } from "./renderer.js";
// [서비스 모드][나중에 삭제]
import { initServiceMode } from "./service_mode.js";

const BASE_FRAME_DURATION_SECONDS = 1.0;
const PLAYBACK_SPEED_MULTIPLIERS = [0.25, 0.5, 1, 2];

function getFrameDurationForSpeed(speed_multiplier) {
  return BASE_FRAME_DURATION_SECONDS / speed_multiplier;
}

function formatPlaybackSpeedLabel(speed_multiplier) {
  return `${speed_multiplier}x`;
}
const ALLOWED_ASSEMBLY_SUFFIXES = [".msgpack"];

function getRequiredElement(element_id) {
  const element = document.getElementById(element_id);
  if (element === null) {
    throw new AssemblyRenderException(`element #${element_id} was not found`);
  }
  return element;
}

function formatClockTime(total_seconds) {
  const safe_seconds = Math.max(0, total_seconds);
  const minutes = Math.floor(safe_seconds / 60);
  const seconds = safe_seconds % 60;
  return `${minutes}:${seconds.toFixed(2).padStart(5, "0")}`;
}

function getMovingSolidIndexSet(trajectories) {
  return new Set(trajectories.map((trajectory_frame) => trajectory_frame.solid));
}

function formatPartLabel(solid_entry, solid_index) {
  const part_name = solid_entry?.name;
  if (typeof part_name === "string" && part_name.trim() !== "") {
    return part_name;
  }
  const part_index = getSolidPartIndex(solid_entry, solid_index);
  return `part_${String(part_index).padStart(2, "0")}`;
}

function getConversionDisplay(conversion_entry) {
  if (typeof conversion_entry !== "string" || conversion_entry.trim() === "") {
    return {
      text: "—",
      class_name: "part-conversion is-missing",
    };
  }
  if (conversion_entry === "성공") {
    return {
      text: conversion_entry,
      class_name: "part-conversion is-success",
    };
  }
  return {
    text: conversion_entry,
    class_name: "part-conversion is-failure",
  };
}

function getSolidPartIndex(solid_entry, solid_index) {
  if (Number.isInteger(solid_entry?.part_index)) {
    return solid_entry.part_index;
  }
  return solid_index;
}

/** trajectories에 처음 등장하는 순서로 solid dense index를 정렬한다. */
function getSolidIndexesInTrajectoryOrder(solids, trajectories) {
  const ordered_solid_indexes = [];
  const seen_solid_indexes = new Set();

  for (const trajectory_frame of trajectories) {
    const solid_index = trajectory_frame?.solid;
    if (!Number.isInteger(solid_index)) {
      continue;
    }
    if (solid_index < 0 || solid_index >= solids.length) {
      continue;
    }
    if (seen_solid_indexes.has(solid_index)) {
      continue;
    }
    seen_solid_indexes.add(solid_index);
    ordered_solid_indexes.push(solid_index);
  }

  for (let solid_index = 0; solid_index < solids.length; solid_index += 1) {
    if (!seen_solid_indexes.has(solid_index)) {
      ordered_solid_indexes.push(solid_index);
    }
  }

  return ordered_solid_indexes;
}

/** 실패 부품을 dense solid index 로 찾을 수 있게 색인한다. */
function getFailureBySolidIndex(failures) {
  return new Map((failures ?? []).map((failure_entry) => [failure_entry.solid, failure_entry]));
}

/**
 * 실패 자세에서 상한을 넘긴 겹침만 골라낸다.
 *
 * 한 자세에 is_over_limit 이 참인 항목과 거짓인 항목이 섞여 들어온다. 거짓은 허용치
 * 이내라 원인이 아니므로, 구분하지 않으면 원래 겹쳐 있던 부분까지 원인으로 지목하게
 * 된다. 범인이 둘 이상인 자세도 실제로 있으므로 하나만 찾지 않는다.
 */
function getCulpritOverlaps(pose_entry) {
  if (pose_entry === null) {
    return [];
  }
  return pose_entry.overlaps.filter((overlap_entry) => overlap_entry.is_over_limit);
}

const AXIS_NAMES = ["X", "Y", "Z"];

/**
 * 부품이 빠져나가려던 축과 부호(예: "-Y").
 *
 * 방향은 추정하지 않고 first_blocked_pose 의 변위에서 읽는다. 부품 AABB 로 최단 이탈
 * 축을 다시 고르면 대칭 부품에서 ±축이 동률이라(실측: roundbutton 이 +Z 45.0 / -Z 45.0)
 * 데이터와 다른 축을 짚을 수 있다.
 */
function getEscapeAxisLabel(failure_entry, assembly_result) {
  if (failure_entry.first_blocked_pose === null) {
    return null;
  }
  const initial_position = assembly_result.solids[failure_entry.solid].state.position;
  const displacements = failure_entry.first_blocked_pose.state.position.map(
    (value, axis_index) => value - initial_position[axis_index],
  );
  let axis_index = 0;
  for (let candidate_index = 1; candidate_index < 3; candidate_index += 1) {
    if (Math.abs(displacements[candidate_index]) > Math.abs(displacements[axis_index])) {
      axis_index = candidate_index;
    }
  }
  if (Math.abs(displacements[axis_index]) <= 0) {
    return null;
  }
  return `${displacements[axis_index] > 0 ? "+" : "-"}${AXIS_NAMES[axis_index]}`;
}

/**
 * 실패 한 건을 화면에 뿌릴 구조로 정리한다.
 *
 * [임시] 지금은 이동 방향과 막은 부품만 담는다. 간섭 위치·범위·겹침 형상 내보내기처럼
 * CAD 수정에 쓸 항목은 팀 논의 뒤에 정한다.
 *
 * 결론을 "분해 불가능" 으로 적지 않는다 — 탐색은 예산(반복 횟수·시간) 안에서만 완전하고,
 * first_blocked_pose 는 여섯 축 중 가장 가까운 출구 한 방향의 증거일 뿐이다.
 */
function getFailureReport(failure_entry, assembly_result) {
  const report = {
    part_label: formatPartLabel(
      assembly_result.solids[failure_entry.solid],
      failure_entry.solid,
    ),
    verdict_text: "분해 실패",
    escape_axis_label: getEscapeAxisLabel(failure_entry, assembly_result),
    culprit_labels: [],
    note_text: null,
  };

  if (failure_entry.last_valid_pose === null) {
    // "초기 간섭" 이라고 부르지 않는다 — 조립 상태의 겹침 자체는 정상적인 조립체에
    // 항상 있는 것(압입·삽입)이라, 그 말을 이 비정상 상태의 이름으로 쓰면 둘이 섞인다.
    report.verdict_text = "조립 상태부터 막힘";
    report.note_text = "조립 상태에서 이미 간섭 상한을 넘습니다."
      + " 분해 이전에 조립 자체가 성립하지 않는 형상입니다.";
  }
  if (failure_entry.first_blocked_pose === null) {
    report.verdict_text = "원인 미확정";
    report.note_text = "막은 부품을 찾지 못했습니다."
      + " 형상이 아니라 탐색 한계(반복 횟수·시간)일 수 있습니다.";
    return report;
  }

  report.culprit_labels = getCulpritOverlaps(failure_entry.first_blocked_pose).map(
    (overlap_entry) => formatPartLabel(
      assembly_result.solids[overlap_entry.obstacle],
      overlap_entry.obstacle,
    ),
  );
  if (report.culprit_labels.length === 0 && report.note_text === null) {
    report.note_text = "막힌 자세는 찾았으나 상한을 넘긴 겹침이 없습니다.";
  }
  return report;
}

/** 트리 버튼 툴팁용 한 줄 요약. 리포트를 열지 않고도 무엇이 막았는지 보이게 한다. */
function getFailureSummaryText(failure_entry, assembly_result) {
  const report = getFailureReport(failure_entry, assembly_result);
  if (report.culprit_labels.length === 0) {
    return report.note_text ?? "막은 부품을 특정하지 못했습니다";
  }
  const direction_text = report.escape_axis_label === null
    ? ""
    : `${report.escape_axis_label} 방향 · `;
  return `${direction_text}${report.culprit_labels.join(", ")} 에 막힘`;
}

function checkIsAssemblyFile(file) {
  const lowered_name = file.name.toLowerCase();
  const has_allowed_suffix = ALLOWED_ASSEMBLY_SUFFIXES.some((suffix) =>
    lowered_name.endsWith(suffix),
  );
  if (!has_allowed_suffix) {
    throw new ResultLoadException(
      `조립 결과(.msgpack)만 로드할 수 있습니다: ${file.name}`,
    );
  }
}

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

function getValidatedState(state_entry, field_name) {
  if (state_entry === null || typeof state_entry !== "object") {
    throw new ResultLoadException(`${field_name} must be an object`);
  }
  const { position, rotation } = state_entry;
  if (!Array.isArray(position) || !Array.isArray(rotation)) {
    throw new ResultLoadException(
      `${field_name}.position and ${field_name}.rotation must be lists`,
    );
  }
  if (position.length !== 3 || rotation.length !== 3) {
    throw new ResultLoadException(
      `${field_name}.position and ${field_name}.rotation must each contain 3 values`,
    );
  }
  return {
    position: position.map(Number),
    rotation: rotation.map(Number),
  };
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

async function loadAssemblyFile(assembly_file) {
  if (!(assembly_file instanceof Blob)) {
    throw new ResultLoadException("selected input must be an assembly msgpack file");
  }

  let payload_bytes;
  try {
    payload_bytes = await assembly_file.arrayBuffer();
  } catch (error) {
    throw new ResultLoadException(`failed to read assembly file: ${error.message}`);
  }

  let raw_payload;
  try {
    raw_payload = decode(payload_bytes);
  } catch (error) {
    throw new ResultLoadException(
      `failed to decode assembly msgpack: ${error.message}`,
    );
  }

  const normalized_payload = normalizeAssemblyPayload(raw_payload);
  return decodeAssemblyResult(encode(normalized_payload));
}

class ViewerDashboard {
  constructor(assembly_renderer) {
    this._assembly_renderer = assembly_renderer;
    this._source_label = "";
    this._loaded_step_result = null;
    this._assembly_result = null;
    this._loaded_step_filename = null;
    this._has_assembly_plan = false;
    this._selected_solid_index = null;
    this._is_slider_dragging = false;
    this._playback_speed_multiplier = 1;
    // [서비스 모드][나중에 삭제] service_mode.js 가 활성일 때 true
    this._is_service_mode = false;

    this._viewer_status = getRequiredElement("viewer-status");
    this._failure_report = getRequiredElement("failure-report");
    this._summary_normal = getRequiredElement("summary-normal");
    this._summary_collision = getRequiredElement("summary-collision");
    this._hud_frames = getRequiredElement("hud-frames");
    this._empty_state = getRequiredElement("empty-state");
    this._empty_state_title = getRequiredElement("empty-state-title");
    this._empty_state_body = getRequiredElement("empty-state-body");
    this._empty_state_pipeline = getRequiredElement("empty-state-pipeline");
    this._part_tree = getRequiredElement("part-tree");
    this._tree_count = getRequiredElement("tree-count");
    this._play_button = getRequiredElement("play-button");
    this._pause_button = getRequiredElement("pause-button");
    this._stop_button = getRequiredElement("stop-button");
    this._reset_view_button = getRequiredElement("reset-view-button");
    this._playback_speed_button = getRequiredElement("playback-speed-button");
    this._timeline_slider = getRequiredElement("timeline-slider");
    this._playback_status = getRequiredElement("playback-status");
    this._frame_label = getRequiredElement("frame-label");
    this._time_label = getRequiredElement("time-label");
    this._export_button = getRequiredElement("export-button");
    this._load_assembly_button = getRequiredElement("load-assembly-button");
    this._assembly_file_input = getRequiredElement("assembly-file-input");
    // [서비스 모드][나중에 삭제]
    this._assemble_button = getRequiredElement("assemble-button");

    this._bindPlaybackControls();
    this._bindAssemblyControls();
    this._assembly_renderer.setOnFrameChange((frame_state) => {
      this._syncPlaybackUi(frame_state);
    });
  }

  // [서비스 모드][나중에 삭제]
  setServiceMode(is_service_mode) {
    this._is_service_mode = is_service_mode;
  }

  // [서비스 모드][나중에 삭제]
  isServiceMode() {
    return this._is_service_mode;
  }

  // [서비스 모드][나중에 삭제]
  bindParsedStep(loaded_step_result, source_label) {
    this._loaded_step_result = loaded_step_result;
    this._assembly_result = loaded_step_result;
    this._source_label = source_label;
    this._has_assembly_plan = false;
    this._selected_solid_index = null;
    this._assemble_button.disabled = this._loaded_step_filename === null;

    this._assembly_renderer.clearAssembly();
    this._part_tree.replaceChildren();
    this._hideViewerStatus();
    this._showEmptyState(
      "파싱 완료",
      "조립 계산 버튼을 눌러 시퀀스를 불러오세요",
      "파싱 ✓ · 경로 계산 — · 충돌 —",
    );
    this._updateHeader(loaded_step_result, source_label);
    this._tree_count.textContent = `${loaded_step_result.solids.length} parts`;
    this._syncPlaybackUi({
      playback_position: 0,
      playback_time_seconds: 0,
      total_duration_seconds: 0,
      frame_count: 0,
      is_playing: false,
      frame_duration_seconds: this._assembly_renderer.getFrameDurationSeconds(),
    });
  }

  bindAssembly(assembly_result, source_label, has_assembly_plan) {
    this._assembly_result = assembly_result;
    this._source_label = source_label;
    this._has_assembly_plan = has_assembly_plan;
    this._selected_solid_index = null;
    this._empty_state.classList.add("hidden");
    // [서비스 모드][나중에 삭제]
    this._assemble_button.disabled = this._loaded_step_filename === null;
    this._hideViewerStatus();

    this._assembly_renderer.loadAssembly(assembly_result);
    this._updateHeader(assembly_result, source_label);
    this._renderPartTree(assembly_result);
    const frame_duration_seconds = this._assembly_renderer.getFrameDurationSeconds();
    this._syncPlaybackUi({
      playback_position: 0,
      playback_time_seconds: 0,
      total_duration_seconds:
        assembly_result.trajectories.length * frame_duration_seconds,
      frame_count: assembly_result.trajectories.length,
      is_playing: false,
      frame_duration_seconds,
    });
  }

  showIdleMessage(message) {
    this._hideViewerStatus();
    this._showEmptyState(
      "조립 결과가 없습니다",
      message,
      "파싱 — · 경로 계산 — · 충돌 —",
    );
  }

  resetWorkspace(idle_message) {
    this._assembly_renderer.clearAssembly();
    this._part_tree.replaceChildren();
    this._loaded_step_result = null;
    this._assembly_result = null;
    this._loaded_step_filename = null;
    this._has_assembly_plan = false;
    this._selected_solid_index = null;
    // [서비스 모드][나중에 삭제]
    this._assemble_button.disabled = true;
    this._summary_normal.textContent = "0/0";
    this._summary_collision.textContent = "N/A";
    this._hud_frames.textContent = "Frames: 0";
    this._tree_count.textContent = "0 parts";
    this._hideViewerStatus();
    this._syncPlaybackUi({
      playback_position: 0,
      playback_time_seconds: 0,
      total_duration_seconds: 0,
      frame_count: 0,
      is_playing: false,
      frame_duration_seconds: this._assembly_renderer.getFrameDurationSeconds(),
    });
    this.showIdleMessage(idle_message);
  }

  showError(error) {
    const message =
      error instanceof ResultLoadException || error instanceof AssemblyRenderException
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    this._setViewerStatus(message, false);
  }

  _setViewerStatus(message, is_busy) {
    this._hideFailureReport();
    this._viewer_status.textContent = message;
    this._viewer_status.classList.toggle("is-busy", is_busy);
    this._viewer_status.classList.remove("hidden");
  }

  _hideViewerStatus() {
    this._viewer_status.textContent = "";
    this._viewer_status.classList.add("hidden");
    this._viewer_status.classList.remove("is-busy");
  }

  _showEmptyState(title, body, pipeline) {
    this._empty_state_title.textContent = title;
    this._empty_state_body.textContent = body;
    this._empty_state_pipeline.textContent = pipeline;
    this._empty_state.classList.remove("hidden");
  }

  _updateHeader(assembly_result, source_label) {
    const solid_count = assembly_result.solids.length;
    this._source_label = source_label;
    this._summary_normal.textContent = `${solid_count}/${solid_count}`;
    this._summary_collision.textContent = "N/A";
    this._hud_frames.textContent = `Frames: ${assembly_result.trajectories.length}`;
    this._tree_count.textContent = `${solid_count} parts`;
  }

  _renderPartTree(assembly_result) {
    const moving_solid_indexes = getMovingSolidIndexSet(assembly_result.trajectories);
    const failure_by_solid_index = getFailureBySolidIndex(assembly_result.failures);
    const solid_indexes = this._has_assembly_plan
      ? getSolidIndexesInTrajectoryOrder(
          assembly_result.solids,
          assembly_result.trajectories,
        )
      : assembly_result.solids.map((_, solid_index) => solid_index);
    this._part_tree.replaceChildren();

    solid_indexes.forEach((solid_index) => {
      const solid_entry = assembly_result.solids[solid_index];
      const part_index = getSolidPartIndex(solid_entry, solid_index);
      const list_item = document.createElement("li");
      list_item.className = "part-item";
      list_item.dataset.solidIndex = String(solid_index);
      list_item.dataset.partIndex = String(part_index);

      const visibility_checkbox = document.createElement("input");
      visibility_checkbox.type = "checkbox";
      visibility_checkbox.checked = true;
      visibility_checkbox.title = "가시성";
      visibility_checkbox.addEventListener("click", (event) => {
        event.stopPropagation();
      });
      visibility_checkbox.addEventListener("change", () => {
        this._assembly_renderer.setSolidVisibility(
          solid_index,
          visibility_checkbox.checked,
        );
      });

      const color_swatch = document.createElement("span");
      color_swatch.className = "part-swatch";
      color_swatch.style.background = this._assembly_renderer.getSolidColorHex(solid_index);

      const part_label = formatPartLabel(solid_entry, solid_index);
      const part_name = document.createElement("span");
      part_name.className = "part-name";
      part_name.textContent = part_label;
      part_name.title = part_label;

      // 부품 상태는 세 갈래다.
      //   궤적 있음            -> 재생 버튼 + conversion 라벨 (기존 그대로)
      //   궤적 없음 + failures -> 실패 분석 버튼 하나가 두 칸을 차지
      //   그 외                -> 경로 없음 (판정에서 빠진 부품 등)
      // 궤적과 failures 는 서로소이고 합집합이 전체 부품이라, 세 번째 갈래는 실측
      // 데이터에서는 나오지 않는다. 방어용으로만 둔다.
      const failure_entry = failure_by_solid_index.get(solid_index) ?? null;
      let action_element = null;
      let trailing_element = null;
      if (this._has_assembly_plan) {
        if (moving_solid_indexes.has(solid_index)) {
          action_element = document.createElement("button");
          action_element.type = "button";
          action_element.className = "part-play-button";
          action_element.title = "이 부품 구간 재생";
          action_element.textContent = "▶";
          action_element.addEventListener("click", (event) => {
            event.stopPropagation();
            this._playSolidTrajectory(solid_index);
          });
          const conversion_display = getConversionDisplay(solid_entry.conversion);
          trailing_element = document.createElement("span");
          trailing_element.className = conversion_display.class_name;
          trailing_element.textContent = conversion_display.text;
          trailing_element.title = `conversion: ${conversion_display.text}`;
        } else if (failure_entry !== null) {
          action_element = document.createElement("button");
          action_element.type = "button";
          action_element.className = "part-failure-button";
          action_element.textContent = "실패 분석";
          action_element.title = getFailureSummaryText(failure_entry, assembly_result);
          action_element.addEventListener("click", (event) => {
            event.stopPropagation();
            this._openFailureAnalysis(solid_index);
          });
        } else {
          action_element = document.createElement("span");
          action_element.className = "part-path-error";
          action_element.textContent = "분해 경로 없음";
          action_element.title = "분해 경로 없음";
        }
      } else {
        const conversion_display = getConversionDisplay(solid_entry.conversion);
        trailing_element = document.createElement("span");
        trailing_element.className = conversion_display.class_name;
        trailing_element.textContent = conversion_display.text;
        trailing_element.title = `conversion: ${conversion_display.text}`;
      }

      list_item.append(visibility_checkbox, color_swatch, part_name);
      if (action_element !== null) {
        list_item.append(action_element);
      }
      if (trailing_element !== null) {
        list_item.append(trailing_element);
      }
      list_item.addEventListener("click", () => {
        this._selectSolid(solid_index);
      });
      this._part_tree.append(list_item);
    });
  }

  _playSolidTrajectory(solid_index) {
    this._hideFailureReport();
    this._selectSolid(solid_index);
    this._assembly_renderer.playSolid(solid_index);
  }

  _openFailureAnalysis(solid_index) {
    if (this._assembly_result === null) {
      throw new AssemblyRenderException("failure analysis requires a loaded assembly result");
    }
    const failure_entry = getFailureBySolidIndex(this._assembly_result.failures).get(solid_index);
    if (failure_entry === undefined) {
      throw new AssemblyRenderException(
        `solid ${solid_index} has no failure entry to analyse`,
      );
    }

    this._selectSolid(solid_index);
    // 실패 시점에 남아 있던 부품 = 실패 부품 전체다. 성공한 부품은 이미 400 밖으로
    // 나가 있어 장애물도 아니고 카메라만 벌린다.
    const visible_solid_indexes = this._assembly_result.failures.map(
      (entry) => entry.solid,
    );
    this._assembly_renderer.startFailureAnalysis({
      solid_index,
      visible_solid_indexes,
      closest_path: failure_entry.closest_path,
      last_valid_pose: failure_entry.last_valid_pose,
      first_blocked_pose: failure_entry.first_blocked_pose,
    });

    this._renderFailureReport(getFailureReport(failure_entry, this._assembly_result));
    this._viewer_status.classList.add("hidden");
  }

  _hideFailureReport() {
    this._failure_report.replaceChildren();
    this._failure_report.classList.add("hidden");
  }

  _renderFailureReport(report) {
    const createText = (text, class_name) => {
      const text_element = document.createElement("span");
      text_element.className = class_name;
      text_element.textContent = text;
      return text_element;
    };
    const appendRow = (parent_element, label_text, value_element) => {
      const row_element = document.createElement("div");
      row_element.className = "failure-row";
      row_element.append(createText(label_text, "failure-row-label"), value_element);
      parent_element.append(row_element);
    };

    this._failure_report.replaceChildren();

    const header_element = document.createElement("div");
    header_element.className = "failure-header";
    header_element.append(
      createText(report.part_label, "failure-part"),
      createText(report.verdict_text, "failure-verdict"),
    );

    const body_element = document.createElement("div");
    body_element.className = "failure-body";
    if (report.escape_axis_label !== null) {
      appendRow(
        body_element,
        "이동 방향",
        createText(report.escape_axis_label, "failure-value"),
      );
    }
    // 범인이 둘 이상인 자세가 실제로 있으므로(실측: handpart 는 3개) 전부 나열한다.
    for (const [index, culprit_label] of report.culprit_labels.entries()) {
      appendRow(
        body_element,
        index === 0 ? "막은 부품" : "",
        createText(culprit_label, "failure-obstacle-name"),
      );
    }
    if (report.note_text !== null) {
      body_element.append(createText(report.note_text, "failure-note"));
    }

    this._failure_report.append(header_element, body_element);
    this._failure_report.classList.remove("hidden");
  }

  _selectSolid(solid_index) {
    this._selected_solid_index = solid_index;
    this._assembly_renderer.clearSolidHighlights();
    this._assembly_renderer.setSolidHighlight(solid_index, true);

    for (const list_item of this._part_tree.children) {
      const item_solid_index = Number(list_item.dataset.solidIndex);
      list_item.classList.toggle("is-selected", item_solid_index === solid_index);
    }
  }

  _syncPlaybackUi(frame_state) {
    const {
      playback_position,
      playback_time_seconds,
      total_duration_seconds,
      frame_count,
      is_playing,
      frame_duration_seconds,
    } = frame_state;

    if (!this._is_slider_dragging) {
      this._timeline_slider.max = String(total_duration_seconds);
      this._timeline_slider.value = String(playback_time_seconds);
    }

    const active_frame =
      frame_count === 0 || playback_time_seconds <= 0
        ? 0
        : Math.min(
            Math.ceil(playback_time_seconds / frame_duration_seconds),
            frame_count,
          );

    this._frame_label.textContent = `Frame ${active_frame} / ${frame_count}`;
    this._time_label.textContent =
      `${formatClockTime(playback_time_seconds)} / ${formatClockTime(total_duration_seconds)}`;
    this._playback_status.textContent = is_playing
      ? "재생 중 · trajectory"
      : playback_position >= frame_count && frame_count > 0
        ? "재생 완료"
        : "대기";
    this._play_button.disabled = is_playing || frame_count === 0;
    this._pause_button.disabled = !is_playing;
    this._playback_speed_button.textContent = formatPlaybackSpeedLabel(
      this._playback_speed_multiplier,
    );
    this._playback_speed_button.title =
      `배속 ${formatPlaybackSpeedLabel(this._playback_speed_multiplier)}`;
  }

  _cyclePlaybackSpeed() {
    const current_index = PLAYBACK_SPEED_MULTIPLIERS.indexOf(
      this._playback_speed_multiplier,
    );
    const next_index =
      current_index < 0
        ? 0
        : (current_index + 1) % PLAYBACK_SPEED_MULTIPLIERS.length;
    this._playback_speed_multiplier = PLAYBACK_SPEED_MULTIPLIERS[next_index];
    this._assembly_renderer.setFrameDurationSeconds(
      getFrameDurationForSpeed(this._playback_speed_multiplier),
    );
  }

  _bindPlaybackControls() {
    this._play_button.addEventListener("click", () => {
      this._hideFailureReport();
      this._assembly_renderer.play();
    });
    this._pause_button.addEventListener("click", () => {
      this._assembly_renderer.pause();
    });
    this._stop_button.addEventListener("click", () => {
      this._hideFailureReport();
      this._assembly_renderer.stop();
    });
    this._reset_view_button.addEventListener("click", () => {
      this._assembly_renderer.resetCamera();
    });
    this._playback_speed_button.addEventListener("click", () => {
      this._cyclePlaybackSpeed();
    });

    this._timeline_slider.addEventListener("pointerdown", () => {
      this._is_slider_dragging = true;
      this._assembly_renderer.pause();
    });
    this._timeline_slider.addEventListener("input", () => {
      this._assembly_renderer.seekToTime(Number(this._timeline_slider.value));
    });
    this._timeline_slider.addEventListener("pointerup", () => {
      this._is_slider_dragging = false;
    });
  }

  async _loadAssemblyFromFile(file) {
    checkIsAssemblyFile(file);
    this._setViewerStatus(`${file.name} 로드 중…`, true);
    try {
      const assembly_result = await loadAssemblyFile(file);
      this.bindAssembly(assembly_result, file.name, true);
    } catch (error) {
      this.showError(error);
    }
  }

  _bindAssemblyControls() {
    this._export_button.addEventListener("click", () => {
      if (this._assembly_result === null) {
        this._setViewerStatus("내보낼 조립 결과가 없습니다", false);
        return;
      }
      this._setViewerStatus(
        "Export Report는 충돌 리포트 스키마 확정 후 연결 예정입니다",
        false,
      );
    });

    this._load_assembly_button.addEventListener("click", () => {
      this._assembly_file_input.click();
    });

    this._assembly_file_input.addEventListener("change", async () => {
      const selected_files = this._assembly_file_input.files;
      if (selected_files === null || selected_files.length === 0) {
        return;
      }
      try {
        await this._loadAssemblyFromFile(selected_files[0]);
      } finally {
        this._assembly_file_input.value = "";
      }
    });

    window.addEventListener("dragenter", (event) => {
      event.preventDefault();
      document.body.classList.add("is-dragging");
    });
    window.addEventListener("dragover", (event) => {
      event.preventDefault();
    });
    window.addEventListener("dragleave", (event) => {
      if (event.relatedTarget === null) {
        document.body.classList.remove("is-dragging");
      }
    });
    window.addEventListener("drop", async (event) => {
      // [서비스 모드][나중에 삭제] 서비스 모드 drop 은 service_mode.js 가 처리
      if (this._is_service_mode) {
        return;
      }
      event.preventDefault();
      document.body.classList.remove("is-dragging");
      const dropped_files = event.dataTransfer?.files;
      if (dropped_files === undefined || dropped_files.length === 0) {
        return;
      }
      try {
        await this._loadAssemblyFromFile(dropped_files[0]);
      } catch (error) {
        this.showError(error);
      }
    });
  }

}

async function main() {
  const viewport_element = getRequiredElement("viewport");
  const assembly_renderer = new AssemblyRenderer(
    viewport_element,
    BASE_FRAME_DURATION_SECONDS,
  );
  const viewer_dashboard = new ViewerDashboard(assembly_renderer);
  viewer_dashboard.showIdleMessage("조립 결과 msgpack을 로드해 주세요");
  // [서비스 모드][나중에 삭제]
  initServiceMode(viewer_dashboard);
}

main();

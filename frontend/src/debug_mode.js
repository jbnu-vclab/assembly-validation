/**
 * [디버그 모드][나중에 삭제]
 * 알고리즘 시각화용 디버그 모드.
 * Service Mode ↔ Debug Mode 토글과 Load Assembly 흐름만 담당한다.
 * Load Assembly → Cleaner(15) / Hair Dryer(16) 선택 후 msgpack 로드,
 * mesh 누락 개수는 조립 트리 옆에 표시한다.
 * 디버그 모드 제거 시 이 파일 전체를 삭제한다.
 */

import { decode, encode } from "@msgpack/msgpack";
import { decodeAssemblyResult, ResultLoadException } from "./loader.js";

// [디버그 모드][나중에 삭제]
const ALLOWED_ASSEMBLY_SUFFIXES = [".msgpack"];

// [디버그 모드][나중에 삭제] part_cache 기준 기대 solid 수
const DEBUG_ASSEMBLY_TARGETS = {
  cleaner: {
    button_id: "load-cleaner-assembly-button",
    label: "Cleaner",
    expected_solid_count: 15,
  },
  hair_dryer: {
    button_id: "load-hair-dryer-assembly-button",
    label: "Hair Dryer",
    expected_solid_count: 16,
  },
};

function getRequiredElement(element_id) {
  // [디버그 모드][나중에 삭제]
  const element = document.getElementById(element_id);
  if (element === null) {
    throw new Error(`debug mode element #${element_id} was not found`);
  }
  return element;
}

function checkIsAssemblyFile(file) {
  // [디버그 모드][나중에 삭제]
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

function getIndexedEntriesAsList(indexed_entries, field_name) {
  // [디버그 모드][나중에 삭제]
  if (Array.isArray(indexed_entries)) {
    return indexed_entries;
  }
  if (indexed_entries === null || typeof indexed_entries !== "object") {
    throw new ResultLoadException(`${field_name} must be a list or int-keyed object`);
  }

  const sorted_keys = Object.keys(indexed_entries).sort(
    (left_key, right_key) => Number(left_key) - Number(right_key),
  );
  const expected_keys = sorted_keys.map((_, index) => String(index));
  if (sorted_keys.join(",") !== expected_keys.join(",")) {
    throw new ResultLoadException(
      `${field_name} keys must be contiguous integers starting at 0`,
    );
  }
  return sorted_keys.map((key) => indexed_entries[key]);
}

function getFlatGlobalBbox(global_bbox_entry) {
  // [디버그 모드][나중에 삭제]
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
  // [디버그 모드][나중에 삭제]
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
  // [디버그 모드][나중에 삭제]
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

function getSolidsWithDerivedInitialStates(solids, trajectories) {
  // [디버그 모드][나중에 삭제]
  const first_trajectory_by_solid = new Map();
  trajectories.forEach((trajectory_frame) => {
    if (trajectory_frame === null || typeof trajectory_frame !== "object") {
      throw new ResultLoadException("trajectory frame must be an object");
    }
    const solid_index = trajectory_frame.solid;
    if (!Number.isInteger(solid_index)) {
      throw new ResultLoadException("trajectory solid must be an integer");
    }
    if (!first_trajectory_by_solid.has(solid_index)) {
      first_trajectory_by_solid.set(solid_index, trajectory_frame);
    }
  });

  return solids.map((solid_entry, solid_index) => {
    if (solid_entry === null || typeof solid_entry !== "object") {
      throw new ResultLoadException(`solids[${solid_index}] must be an object`);
    }
    const mesh_entry = solid_entry.mesh;
    const state_entry = solid_entry.state;
    if (mesh_entry === null || typeof mesh_entry !== "object") {
      throw new ResultLoadException(`solids[${solid_index}].mesh must be an object`);
    }

    let initial_state = getValidatedState(state_entry, `solids[${solid_index}].state`);
    const first_trajectory = first_trajectory_by_solid.get(solid_index);
    if (first_trajectory !== undefined) {
      initial_state = getStateBeforeAction(
        getValidatedState(
          first_trajectory.state,
          `trajectories[solid=${solid_index}].state`,
        ),
        first_trajectory.action,
        `trajectories[solid=${solid_index}].action`,
      );
    }

    return {
      mesh: mesh_entry,
      state: initial_state,
    };
  });
}

function expandBboxWithSolidStates(global_bbox, solids) {
  // [디버그 모드][나중에 삭제]
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

function normalizeAssemblyPayload(raw_payload) {
  // [디버그 모드][나중에 삭제]
  if (raw_payload === null || typeof raw_payload !== "object" || Array.isArray(raw_payload)) {
    throw new ResultLoadException("assembly payload root must be an object");
  }

  const metadata_entry = raw_payload.metadata;
  if (metadata_entry === null || typeof metadata_entry !== "object") {
    throw new ResultLoadException("metadata must be an object");
  }

  const solids = getIndexedEntriesAsList(raw_payload.solids, "solids");
  const trajectories = getIndexedEntriesAsList(raw_payload.trajectories, "trajectories");
  let global_bbox = getFlatGlobalBbox(metadata_entry.global_bbox);
  const normalized_solids = getSolidsWithDerivedInitialStates(solids, trajectories);
  global_bbox = expandBboxWithSolidStates(global_bbox, normalized_solids);

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
    trajectories,
  };
}

async function loadDebugAssemblyFile(assembly_file) {
  // [디버그 모드][나중에 삭제]
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

export function initDebugMode(viewer_dashboard) {
  // [디버그 모드][나중에 삭제]
  const service_mode_button = getRequiredElement("service-mode-button");
  const debug_mode_button = getRequiredElement("debug-mode-button");
  const open_button = getRequiredElement("open-button");
  const assemble_button = getRequiredElement("assemble-button");
  const load_assembly_button = getRequiredElement("load-assembly-button");
  const assembly_file_input = getRequiredElement("assembly-file-input");
  const assembly_picker = getRequiredElement("debug-assembly-picker");
  const service_actions = getRequiredElement("service-actions");
  const debug_actions = getRequiredElement("debug-actions");
  const missing_chip = getRequiredElement("debug-missing-chip");
  const missing_count_label = getRequiredElement("debug-missing-count");

  let is_debug_mode = false;
  let pending_assembly_target = null;

  function setAssemblyPickerOpen(is_open) {
    assembly_picker.classList.toggle("hidden", !is_open);
    load_assembly_button.classList.toggle("is-picker-open", is_open);
  }

  function setMissingCount(missing_count) {
    const safe_count = Math.max(0, Number(missing_count) || 0);
    missing_count_label.textContent = String(safe_count);
    missing_chip.classList.toggle("hidden", safe_count <= 0);
  }

  function setDebugMode(next_is_debug_mode) {
    // [디버그 모드][나중에 삭제] 전환 시 상대 모드 상태를 완전히 초기화한다.
    if (is_debug_mode === next_is_debug_mode) {
      return;
    }

    is_debug_mode = next_is_debug_mode;
    document.body.classList.toggle("debug-mode", is_debug_mode);
    service_mode_button.classList.toggle("is-active", !is_debug_mode);
    debug_mode_button.classList.toggle("is-active", is_debug_mode);
    service_actions.classList.toggle("hidden", is_debug_mode);
    debug_actions.classList.toggle("hidden", !is_debug_mode);
    pending_assembly_target = null;
    setAssemblyPickerOpen(false);
    setMissingCount(0);

    if (is_debug_mode) {
      viewer_dashboard.resetWorkspace("조립 결과 msgpack을 로드해 주세요");
    } else {
      viewer_dashboard.resetWorkspace("STEP 파일을 로드해 주세요");
    }
  }

  async function loadAssemblyFromFile(file, assembly_target) {
    checkIsAssemblyFile(file);
    const target_label = assembly_target?.label ?? "Assembly";
    const expected_solid_count = assembly_target?.expected_solid_count ?? null;
    viewer_dashboard._setViewerStatus(
      `${target_label}: ${file.name} 디버그 로드 중…`,
      true,
    );
    try {
      const assembly_result = await loadDebugAssemblyFile(file);
      viewer_dashboard.bindAssembly(
        assembly_result,
        `debug-${target_label.toLowerCase().replaceAll(" ", "-")}`,
        true,
      );
      if (expected_solid_count !== null) {
        setMissingCount(expected_solid_count - assembly_result.solids.length);
      } else {
        setMissingCount(0);
      }
    } catch (error) {
      setMissingCount(0);
      viewer_dashboard.showError(error);
    }
  }

  function openAssemblyPicker(assembly_target) {
    pending_assembly_target = assembly_target;
    setAssemblyPickerOpen(false);
    assembly_file_input.click();
  }

  service_mode_button.addEventListener("click", () => {
    setDebugMode(false);
  });
  debug_mode_button.addEventListener("click", () => {
    setDebugMode(true);
  });

  load_assembly_button.addEventListener("click", (event) => {
    event.stopPropagation();
    setAssemblyPickerOpen(assembly_picker.classList.contains("hidden"));
  });

  Object.values(DEBUG_ASSEMBLY_TARGETS).forEach((assembly_target) => {
    const target_button = getRequiredElement(assembly_target.button_id);
    target_button.addEventListener("click", (event) => {
      event.stopPropagation();
      openAssemblyPicker(assembly_target);
    });
  });

  document.addEventListener("click", (event) => {
    if (!is_debug_mode || assembly_picker.classList.contains("hidden")) {
      return;
    }
    const click_target = event.target;
    if (!(click_target instanceof Node)) {
      return;
    }
    if (
      assembly_picker.contains(click_target) ||
      load_assembly_button.contains(click_target)
    ) {
      return;
    }
    setAssemblyPickerOpen(false);
  });

  assembly_file_input.addEventListener("change", async () => {
    const selected_files = assembly_file_input.files;
    if (selected_files === null || selected_files.length === 0) {
      return;
    }
    const assembly_target = pending_assembly_target;
    pending_assembly_target = null;
    try {
      await loadAssemblyFromFile(selected_files[0], assembly_target);
    } finally {
      assembly_file_input.value = "";
    }
  });

  // [디버그 모드][나중에 삭제] debug 모드에서는 STEP 드롭 대신 assembly msgpack 드롭
  window.addEventListener(
    "drop",
    async (event) => {
      if (!is_debug_mode) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      document.body.classList.remove("is-dragging");
      setAssemblyPickerOpen(false);
      const dropped_files = event.dataTransfer?.files;
      if (dropped_files === undefined || dropped_files.length === 0) {
        return;
      }
      // 드롭은 대상 미지정 → 누락 비교 없이 로드
      await loadAssemblyFromFile(dropped_files[0], null);
    },
    true,
  );

  void open_button;
  void assemble_button;

  // 초기 진입은 리셋 없이 서비스 모드 UI만 맞춘다.
  is_debug_mode = true;
  setDebugMode(false);
}

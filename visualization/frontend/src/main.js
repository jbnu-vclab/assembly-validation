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

      let action_element = null;
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
        } else {
          action_element = document.createElement("span");
          action_element.className = "part-path-error";
          action_element.textContent = "빈 조립경로";
          action_element.title = "빈 조립경로";
        }
      }

      const conversion_display = getConversionDisplay(solid_entry.conversion);
      const conversion_label = document.createElement("span");
      conversion_label.className = conversion_display.class_name;
      conversion_label.textContent = conversion_display.text;
      conversion_label.title = `conversion: ${conversion_display.text}`;

      list_item.append(visibility_checkbox, color_swatch, part_name);
      if (action_element !== null) {
        list_item.append(action_element);
      }
      list_item.append(conversion_label);
      list_item.addEventListener("click", () => {
        this._selectSolid(solid_index);
      });
      this._part_tree.append(list_item);
    });
  }

  _playSolidTrajectory(solid_index) {
    this._selectSolid(solid_index);
    this._assembly_renderer.playSolid(solid_index);
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
      this._assembly_renderer.play();
    });
    this._pause_button.addEventListener("click", () => {
      this._assembly_renderer.pause();
    });
    this._stop_button.addEventListener("click", () => {
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

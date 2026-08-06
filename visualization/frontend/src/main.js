import {
  assembleStepFile,
  loadStepFile,
  ResultLoadException,
} from "./loader.js";
import { AssemblyRenderer, AssemblyRenderException } from "./renderer.js";
// [디버그 모드][나중에 삭제]
import { initDebugMode } from "./debug_mode.js";

const LOAD_STEP_URL = "/api/load-step";
const ASSEMBLE_URL = "/api/assemble";
const FRAME_DURATION_SECONDS = 1.0;
const ALLOWED_STEP_SUFFIXES = [".step", ".stp"];

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

function formatPartLabel(part_index) {
  return `part_${String(part_index).padStart(2, "0")}`;
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

function checkIsStepFile(file) {
  const lowered_name = file.name.toLowerCase();
  const has_allowed_suffix = ALLOWED_STEP_SUFFIXES.some((suffix) =>
    lowered_name.endsWith(suffix),
  );
  if (!has_allowed_suffix) {
    throw new ResultLoadException(
      `STEP 파일(.step/.stp)만 로드할 수 있습니다: ${file.name}`,
    );
  }
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
    this._timeline_slider = getRequiredElement("timeline-slider");
    this._playback_status = getRequiredElement("playback-status");
    this._frame_label = getRequiredElement("frame-label");
    this._time_label = getRequiredElement("time-label");
    this._open_button = getRequiredElement("open-button");
    this._assemble_button = getRequiredElement("assemble-button");
    this._export_button = getRequiredElement("export-button");
    this._file_input = getRequiredElement("file-input");

    this._bindPlaybackControls();
    this._bindFileControls();
    this._assembly_renderer.setOnFrameChange((frame_state) => {
      this._syncPlaybackUi(frame_state);
    });
  }

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
      frame_duration_seconds: FRAME_DURATION_SECONDS,
    });
  }

  bindAssembly(assembly_result, source_label, has_assembly_plan) {
    this._assembly_result = assembly_result;
    this._source_label = source_label;
    this._has_assembly_plan = has_assembly_plan;
    this._selected_solid_index = null;
    this._empty_state.classList.add("hidden");
    this._assemble_button.disabled = this._loaded_step_filename === null;
    this._hideViewerStatus();

    this._assembly_renderer.loadAssembly(assembly_result);
    this._updateHeader(assembly_result, source_label);
    this._renderPartTree(assembly_result);
    this._syncPlaybackUi({
      playback_position: 0,
      playback_time_seconds: 0,
      total_duration_seconds:
        assembly_result.trajectories.length * FRAME_DURATION_SECONDS,
      frame_count: assembly_result.trajectories.length,
      is_playing: false,
      frame_duration_seconds: FRAME_DURATION_SECONDS,
    });
  }

  showIdleMessage(message) {
    this._hideViewerStatus();
    this._showEmptyState(
      "STEP 파일이 없습니다",
      message,
      "파싱 — · 경로 계산 — · 충돌 —",
    );
  }

  // [디버그 모드][나중에 삭제] 모드 전환 시 워크스페이스 초기화
  resetWorkspace(idle_message) {
    this._assembly_renderer.clearAssembly();
    this._part_tree.replaceChildren();
    this._loaded_step_result = null;
    this._assembly_result = null;
    this._loaded_step_filename = null;
    this._has_assembly_plan = false;
    this._selected_solid_index = null;
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
      frame_duration_seconds: FRAME_DURATION_SECONDS,
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

      const part_name = document.createElement("span");
      part_name.className = "part-name";
      part_name.textContent = formatPartLabel(part_index);
      part_name.title = formatPartLabel(part_index);

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

      const status_dot = document.createElement("span");
      status_dot.className = moving_solid_indexes.has(solid_index)
        ? "part-status is-moving"
        : "part-status";
      status_dot.title = moving_solid_indexes.has(solid_index)
        ? "trajectory 포함"
        : "정적 부품";

      list_item.append(visibility_checkbox, color_swatch, part_name);
      if (action_element !== null) {
        list_item.append(action_element);
      }
      list_item.append(status_dot);
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
    } = frame_state;

    if (!this._is_slider_dragging) {
      this._timeline_slider.max = String(total_duration_seconds);
      this._timeline_slider.value = String(playback_time_seconds);
    }

    const active_frame =
      frame_count === 0 || playback_time_seconds <= 0
        ? 0
        : Math.min(
            Math.ceil(playback_time_seconds / FRAME_DURATION_SECONDS),
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

  _bindFileControls() {
    this._open_button.addEventListener("click", () => {
      this._file_input.click();
    });

    this._assemble_button.addEventListener("click", async () => {
      try {
        await this.assembleLoadedStep();
      } catch (error) {
        this.showError(error);
        this._assemble_button.disabled = this._loaded_step_filename === null;
      }
    });

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

    this._file_input.addEventListener("change", async () => {
      const selected_files = this._file_input.files;
      if (selected_files === null || selected_files.length === 0) {
        return;
      }
      try {
        await this.loadFromStepFile(selected_files[0]);
      } catch (error) {
        this.showError(error);
      } finally {
        this._file_input.value = "";
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
      event.preventDefault();
      document.body.classList.remove("is-dragging");
      const dropped_files = event.dataTransfer?.files;
      if (dropped_files === undefined || dropped_files.length === 0) {
        return;
      }
      try {
        await this.loadFromStepFile(dropped_files[0]);
      } catch (error) {
        this.showError(error);
      }
    });
  }

  async loadFromStepFile(file) {
    checkIsStepFile(file);
    this._loaded_step_filename = file.name;
    this._has_assembly_plan = false;
    this._assemble_button.disabled = true;
    this._assembly_renderer.clearAssembly();
    this._part_tree.replaceChildren();
    this._setViewerStatus(`${file.name} 파싱 중…`, true);
    this._showEmptyState(
      "STEP 파싱 중",
      "잠시만 기다려 주세요",
      "파싱 … · 경로 계산 — · 충돌 —",
    );

    try {
      const loaded_step_result = await loadStepFile(file, LOAD_STEP_URL);
      this.bindParsedStep(loaded_step_result, "step-loader");
    } catch (error) {
      this._assemble_button.disabled = true;
      this._loaded_step_filename = null;
      throw error;
    }
  }

  async assembleLoadedStep() {
    if (this._loaded_step_filename === null) {
      throw new ResultLoadException("먼저 STEP 파일을 로드해 주세요");
    }

    this._assemble_button.disabled = true;
    this._setViewerStatus(`${this._loaded_step_filename} 조립 계산 중…`, true);

    const assembly_result = await assembleStepFile(
      this._loaded_step_filename,
      ASSEMBLE_URL,
    );
    this.bindAssembly(assembly_result, "dummy-output", true);
  }
}

async function main() {
  const viewport_element = getRequiredElement("viewport");
  const assembly_renderer = new AssemblyRenderer(viewport_element, FRAME_DURATION_SECONDS);
  const viewer_dashboard = new ViewerDashboard(assembly_renderer);
  viewer_dashboard.showIdleMessage("STEP 파일을 로드해 주세요");
  // [디버그 모드][나중에 삭제]
  initDebugMode(viewer_dashboard);
}

main();

/**
 * ViewerDashboard: 3D 캔버스를 뺀 화면 전체(헤더 · 조립 트리 · 재생바 · 실패 리포트 · 상태 메시지).
 * 사용자 조작을 렌더러 명령으로 바꾸고, 렌더러의 재생 상태를 화면에 반영한다.
 * 데이터를 어디서 가져오는지는 모른다. 모드가 bindParsedStep / bindAssembly 로 넘겨준다.
 */

import { AssemblyRenderException } from "../renderer.js";
import { getRequiredElement } from "./dom.js";
import {
  getFailureBySolidIndex,
  getFailureReport,
  getFailureSummaryText,
} from "./failure_report.js";
import {
  formatClockTime,
  formatPartLabel,
  formatPlaybackSpeedLabel,
  getConversionDisplay,
  getSolidPartIndex,
} from "./format.js";

const PLAYBACK_SPEED_MULTIPLIERS = [0.25, 0.5, 1, 2];

function getMovingSolidIndexSet(trajectories) {
  return new Set(trajectories.map((trajectory_frame) => trajectory_frame.solid));
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

/**
 * 두 모드가 공유하는 화면. 모드 모듈은 아래 공개 메서드만 부른다.
 *   showBusy / showStage / showError / resetWorkspace / bindParsedStep / bindAssembly
 */
export class ViewerDashboard {
  constructor(assembly_renderer) {
    this._assembly_renderer = assembly_renderer;
    this._source_label = "";
    this._assembly_result = null;
    // false 면 STEP 파싱만 끝난 상태(메시만 있고 경로 없음)다.
    this._has_assembly_plan = false;
    this._selected_solid_index = null;
    this._is_slider_dragging = false;

    this._viewer_status = getRequiredElement("viewer-status");
    this._failure_report = getRequiredElement("failure-report");
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

    this._bindPlaybackControls();
    this._assembly_renderer.setOnFrameChange((frame_state) => {
      this._syncPlaybackUi(frame_state);
    });
  }

  showBusy(message) {
    this._setViewerStatus(message, true);
  }

  /** 결과를 비우고 가운데 안내(제목 / 본문 / 파이프라인 진행)를 띄운다. */
  showStage(title, body, pipeline) {
    this._clearLoadedAssembly();
    this._hideViewerStatus();
    this._showEmptyState(title, body, pipeline);
    this._syncIdlePlaybackUi();
  }

  showError(error) {
    const message = error instanceof Error ? error.message : String(error);
    this._setViewerStatus(message, false);
  }

  resetWorkspace(idle_message) {
    this._clearLoadedAssembly();
    this._tree_count.textContent = "0 parts";
    this.showStage(
      "조립 결과가 없습니다",
      idle_message,
      "파싱 — · 경로 계산 — · 충돌 —",
    );
  }

  /** STEP 파싱 결과(메시만, 경로 없음). 조립 계산 전 단계라 3D 는 비워 둔다. */
  bindParsedStep(loaded_step_result, source_label) {
    this.showStage(
      "파싱 완료",
      "조립 계산 버튼을 눌러 시퀀스를 불러오세요",
      "파싱 ✓ · 경로 계산 — · 충돌 —",
    );
    this._assembly_result = loaded_step_result;
    this._has_assembly_plan = false;
    this._updateHeader(loaded_step_result, source_label);
    this._renderPartNameList(loaded_step_result);
  }

  /** 파싱 직후의 조립 트리. 3D 는 아직 비워 두므로 버튼 없이 부품 이름만 보여 준다. */
  _renderPartNameList(loaded_step_result) {
    this._part_tree.replaceChildren();
    loaded_step_result.solids.forEach((solid_entry, solid_index) => {
      const list_item = document.createElement("li");
      list_item.className = "part-item is-preview";
      const part_name = document.createElement("span");
      part_name.className = "part-name";
      part_name.textContent = formatPartLabel(solid_entry, solid_index);
      part_name.title = part_name.textContent;
      list_item.append(part_name);
      this._part_tree.append(list_item);
    });
  }

  bindAssembly(assembly_result, source_label) {
    this._assembly_result = assembly_result;
    this._has_assembly_plan = true;
    this._selected_solid_index = null;
    this._empty_state.classList.add("hidden");
    this._hideViewerStatus();
    this._hideFailureReport();

    this._assembly_renderer.loadAssembly(assembly_result);
    this._updateHeader(assembly_result, source_label);
    this._renderPartTree(assembly_result);
    this._syncPlaybackUi(this._assembly_renderer.getFrameState());
  }

  _clearLoadedAssembly() {
    // 결과에 딸린 화면(실패 리포트 포함)은 결과와 함께 비운다. 모드 전환 · 새 파일 로드 모두 여기를 지난다.
    this._hideFailureReport();
    this._assembly_renderer.clearAssembly();
    this._part_tree.replaceChildren();
    this._assembly_result = null;
    this._has_assembly_plan = false;
    this._selected_solid_index = null;
  }

  _syncIdlePlaybackUi() {
    this._syncPlaybackUi(this._assembly_renderer.getFrameState());
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
      active_frame_number,
      is_playing,
    } = frame_state;

    if (!this._is_slider_dragging) {
      this._timeline_slider.max = String(total_duration_seconds);
      this._timeline_slider.value = String(playback_time_seconds);
    }

    this._frame_label.textContent = `Frame ${active_frame_number} / ${frame_count}`;
    this._time_label.textContent =
      `${formatClockTime(playback_time_seconds)} / ${formatClockTime(total_duration_seconds)}`;
    this._playback_status.textContent = is_playing
      ? "재생 중 · trajectory"
      : playback_position >= frame_count && frame_count > 0
        ? "재생 완료"
        : "대기";
    this._play_button.disabled = is_playing || frame_count === 0;
    this._pause_button.disabled = !is_playing;
    const speed_label = formatPlaybackSpeedLabel(
      this._assembly_renderer.getPlaybackSpeedMultiplier(),
    );
    this._playback_speed_button.textContent = speed_label;
    this._playback_speed_button.title = `배속 ${speed_label}`;
  }

  _cyclePlaybackSpeed() {
    const current_index = PLAYBACK_SPEED_MULTIPLIERS.indexOf(
      this._assembly_renderer.getPlaybackSpeedMultiplier(),
    );
    const next_index =
      current_index < 0
        ? 0
        : (current_index + 1) % PLAYBACK_SPEED_MULTIPLIERS.length;
    this._assembly_renderer.setPlaybackSpeedMultiplier(
      PLAYBACK_SPEED_MULTIPLIERS[next_index],
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
}

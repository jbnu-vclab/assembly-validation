/**
 * [서비스 모드][나중에 삭제]
 * STEP 업로드 → /api/load-step → /api/assemble 서비스 화면.
 * Debug(기본) ↔ Service 토글과 Load STEP / 조립 계산만 담당한다.
 * 서비스 모드 제거 시 이 파일 전체를 삭제한다.
 */

import { assembleStepFile, loadStepFile, ResultLoadException } from "./loader.js";

// [서비스 모드][나중에 삭제]
const LOAD_STEP_URL = "/api/load-step";
const ASSEMBLE_URL = "/api/assemble";
const ALLOWED_STEP_SUFFIXES = [".step", ".stp"];

function getRequiredElement(element_id) {
  // [서비스 모드][나중에 삭제]
  const element = document.getElementById(element_id);
  if (element === null) {
    throw new Error(`service mode element #${element_id} was not found`);
  }
  return element;
}

function checkIsStepFile(file) {
  // [서비스 모드][나중에 삭제]
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

export function initServiceMode(viewer_dashboard) {
  // [서비스 모드][나중에 삭제]
  const service_mode_button = getRequiredElement("service-mode-button");
  const debug_mode_button = getRequiredElement("debug-mode-button");
  const open_button = getRequiredElement("open-button");
  const assemble_button = getRequiredElement("assemble-button");
  const file_input = getRequiredElement("file-input");
  const service_actions = getRequiredElement("service-actions");
  const debug_actions = getRequiredElement("debug-actions");
  const drop_overlay = getRequiredElement("drop-overlay");

  let is_service_mode = false;

  function setServiceMode(next_is_service_mode) {
    // [서비스 모드][나중에 삭제] 전환 시 상대 모드 상태를 완전히 초기화한다.
    if (is_service_mode === next_is_service_mode) {
      return;
    }

    is_service_mode = next_is_service_mode;
    viewer_dashboard.setServiceMode(is_service_mode);
    document.body.classList.toggle("service-mode", is_service_mode);
    service_mode_button.classList.toggle("is-active", is_service_mode);
    debug_mode_button.classList.toggle("is-active", !is_service_mode);
    service_actions.classList.toggle("hidden", !is_service_mode);
    debug_actions.classList.toggle("hidden", is_service_mode);
    drop_overlay.textContent = is_service_mode
      ? "Drop STEP file to process"
      : "Drop assembly msgpack";

    if (is_service_mode) {
      viewer_dashboard.resetWorkspace("STEP 파일을 로드해 주세요");
    } else {
      viewer_dashboard.resetWorkspace("조립 결과 msgpack을 로드해 주세요");
    }
  }

  async function loadFromStepFile(file) {
    checkIsStepFile(file);
    viewer_dashboard._loaded_step_filename = file.name;
    viewer_dashboard._has_assembly_plan = false;
    assemble_button.disabled = true;
    viewer_dashboard._assembly_renderer.clearAssembly();
    viewer_dashboard._part_tree.replaceChildren();
    viewer_dashboard._setViewerStatus(`${file.name} 파싱 중…`, true);
    viewer_dashboard._showEmptyState(
      "STEP 파싱 중",
      "잠시만 기다려 주세요",
      "파싱 … · 경로 계산 — · 충돌 —",
    );

    try {
      const loaded_step_result = await loadStepFile(file, LOAD_STEP_URL);
      viewer_dashboard.bindParsedStep(loaded_step_result, "step-loader");
    } catch (error) {
      assemble_button.disabled = true;
      viewer_dashboard._loaded_step_filename = null;
      throw error;
    }
  }

  async function assembleLoadedStep() {
    if (viewer_dashboard._loaded_step_filename === null) {
      throw new ResultLoadException("먼저 STEP 파일을 로드해 주세요");
    }

    assemble_button.disabled = true;
    viewer_dashboard._setViewerStatus(
      `${viewer_dashboard._loaded_step_filename} 조립 계산 중…`,
      true,
    );

    const assembly_result = await assembleStepFile(
      viewer_dashboard._loaded_step_filename,
      ASSEMBLE_URL,
    );
    viewer_dashboard.bindAssembly(assembly_result, "dummy-output", true);
  }

  service_mode_button.addEventListener("click", () => {
    setServiceMode(true);
  });
  debug_mode_button.addEventListener("click", () => {
    setServiceMode(false);
  });

  open_button.addEventListener("click", () => {
    file_input.click();
  });

  assemble_button.addEventListener("click", async () => {
    try {
      await assembleLoadedStep();
    } catch (error) {
      viewer_dashboard.showError(error);
      assemble_button.disabled = viewer_dashboard._loaded_step_filename === null;
    }
  });

  file_input.addEventListener("change", async () => {
    const selected_files = file_input.files;
    if (selected_files === null || selected_files.length === 0) {
      return;
    }
    try {
      await loadFromStepFile(selected_files[0]);
    } catch (error) {
      viewer_dashboard.showError(error);
    } finally {
      file_input.value = "";
    }
  });

  // [서비스 모드][나중에 삭제] 서비스 모드에서는 STEP 드롭
  window.addEventListener(
    "drop",
    async (event) => {
      if (!is_service_mode) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      document.body.classList.remove("is-dragging");
      const dropped_files = event.dataTransfer?.files;
      if (dropped_files === undefined || dropped_files.length === 0) {
        return;
      }
      try {
        await loadFromStepFile(dropped_files[0]);
      } catch (error) {
        viewer_dashboard.showError(error);
      }
    },
    true,
  );

  // 초기 진입은 리셋 없이 디버그(기본) 모드 UI만 맞춘다.
  is_service_mode = true;
  setServiceMode(false);
}

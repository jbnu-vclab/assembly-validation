/**
 * Service 모드: STEP 업로드 → 서버(api.js) → 화면. 최종 사용자 흐름이다.
 *   [Load STEP]  → requestStepPreview → 메시 미리보기
 *   [조립 계산]  → requestAssembly    → 조립 결과 재생
 * 응답은 api.js 안에서 Debug 모드와 같은 result_loader 경로(정규화 · 검증)를 탄다.
 *
 * debug_mode.js 와 같은 모양의 모드 객체를 반환한다. 모드 전환과 드롭은 main.js 가 맡는다.
 */

import { requestAssembly, requestStepPreview } from "../api.js";
import { bindFilePicker, checkFileSuffix, getRequiredElement } from "../ui/dom.js";

const ALLOWED_STEP_SUFFIXES = [".step", ".stp"];

export function createServiceMode(viewer_dashboard) {
  const toggle_button = getRequiredElement("service-mode-button");
  const actions_element = getRequiredElement("service-actions");
  const open_button = getRequiredElement("open-button");
  const assemble_button = getRequiredElement("assemble-button");
  const file_input = getRequiredElement("file-input");

  // 파싱까지 끝난 STEP 파일. 조립 계산 요청에 다시 보낸다(서버는 업로드를 보관하지 않음).
  let loaded_step_file = null;

  function setLoadedStepFile(step_file) {
    loaded_step_file = step_file;
    assemble_button.disabled = step_file === null;
  }

  async function loadFile(file) {
    checkFileSuffix(file, ALLOWED_STEP_SUFFIXES, "STEP 파일(.step/.stp)만 로드할 수 있습니다");
    setLoadedStepFile(null);
    viewer_dashboard.showStage(
      "STEP 파싱 중",
      "잠시만 기다려 주세요",
      "파싱 … · 경로 계산 — · 충돌 —",
    );
    viewer_dashboard.showBusy(`${file.name} 파싱 중…`);
    const loaded_step_result = await requestStepPreview(file);
    viewer_dashboard.bindParsedStep(loaded_step_result, "step-loader");
    setLoadedStepFile(file);
  }

  async function assembleLoadedStep() {
    if (loaded_step_file === null) {
      throw new Error("먼저 STEP 파일을 로드해 주세요");
    }

    assemble_button.disabled = true;
    viewer_dashboard.showBusy(`${loaded_step_file.name} 조립 계산 중… (부품 수에 따라 수 분 걸릴 수 있습니다)`);
    try {
      const assembly_result = await requestAssembly(loaded_step_file);
      viewer_dashboard.bindAssembly(assembly_result, loaded_step_file.name);
    } finally {
      assemble_button.disabled = loaded_step_file === null;
    }
  }

  bindFilePicker(open_button, file_input, loadFile, (error) => {
    viewer_dashboard.showError(error);
  });
  assemble_button.addEventListener("click", async () => {
    try {
      await assembleLoadedStep();
    } catch (error) {
      viewer_dashboard.showError(error);
    }
  });

  return {
    key: "service",
    toggle_button,
    actions_element,
    idle_message: "STEP 파일을 로드해 주세요",
    drop_label: "Drop STEP file to process",
    loadFile,
    reset() {
      setLoadedStepFile(null);
    },
  };
}

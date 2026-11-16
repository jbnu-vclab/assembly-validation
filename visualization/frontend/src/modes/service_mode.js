/**
 * Service 모드: STEP 업로드 → 서버(api.js)의 조립 계산 → 결과 화면. 최종 사용자 흐름이다.
 *   [Load STEP] → requestAssembly → 시퀀스 재생 · 조립 트리 · 실패 분석
 * 결과는 api.js 안에서 Debug 모드와 같은 result_loader 경로(정규화 · 검증)를 탄다.
 *
 * 계산하는 동안 서버가 알려 주는 단계로 메인 화면 문구를 바꾼다.
 *   Mesh 변환 중 → 조립 계산 중 → 조립 완료 → 결과 화면 (실패하면 조립 계산 실패)
 *
 * debug_mode.js 와 같은 모양의 모드 객체를 반환한다. 모드 전환과 드롭은 main.js 가 맡는다.
 */

import { requestAssembly } from "../api.js";
import { bindFilePicker, checkFileSuffix, getRequiredElement } from "../ui/dom.js";

const ALLOWED_STEP_SUFFIXES = [".step", ".stp"];
const ELAPSED_REFRESH_MILLISECONDS = 1000;

// 서버 단계 → 메인 화면 제목 · 진행 줄
const STAGE_DISPLAY = {
  queued: { title: "Mesh 변환 중", pipeline: "Mesh 변환 … · 조립 계산 — · 결과 표시 —" },
  mesh: { title: "Mesh 변환 중", pipeline: "Mesh 변환 … · 조립 계산 — · 결과 표시 —" },
  assembly: { title: "조립 계산 중", pipeline: "Mesh 변환 ✓ · 조립 계산 … · 결과 표시 —" },
  done: { title: "조립 완료", pipeline: "Mesh 변환 ✓ · 조립 계산 ✓ · 결과 표시 …" },
};

function formatElapsed(elapsed_milliseconds) {
  const total_seconds = Math.floor(elapsed_milliseconds / 1000);
  const minutes = Math.floor(total_seconds / 60);
  const seconds = total_seconds % 60;
  return minutes > 0 ? `${minutes}분 ${seconds}초` : `${seconds}초`;
}

export function createServiceMode(viewer_dashboard) {
  const toggle_button = getRequiredElement("service-mode-button");
  const actions_element = getRequiredElement("service-actions");
  const open_button = getRequiredElement("open-button");
  const file_input = getRequiredElement("file-input");

  let elapsed_timer = null;
  // 요청마다 번호를 매긴다. 계산 중에 모드를 바꾸면 번호가 달라져 조회를 멈추고 결과를 버린다.
  let request_serial = 0;

  function stopElapsedTimer() {
    if (elapsed_timer !== null) {
      clearInterval(elapsed_timer);
      elapsed_timer = null;
    }
  }


  async function loadFile(file) {
    checkFileSuffix(file, ALLOWED_STEP_SUFFIXES, "STEP 파일(.step/.stp)만 로드할 수 있습니다");
    const serial = ++request_serial;
    const isCancelled = () => serial !== request_serial;
    const started_at = Date.now();
    let stage = "queued";
    const render = () => {
      const display = STAGE_DISPLAY[stage] ?? STAGE_DISPLAY.mesh;
      viewer_dashboard.updateStage(
        display.title,
        `${file.name} · ${formatElapsed(Date.now() - started_at)} 경과`,
        display.pipeline,
      );
    };

    // 계산 중에 STEP 을 다시 올리면 이전 요청은 번호가 달라져 버려지고(서버도 이전 계산을
    // 멈춘다) 이 파일로 처음부터 다시 시작한다.
    stopElapsedTimer();
    viewer_dashboard.showStage("", "", "");
    render();
    elapsed_timer = setInterval(render, ELAPSED_REFRESH_MILLISECONDS);

    try {
      const assembly_result = await requestAssembly(file, {
        onStage: (next_stage) => {
          if (isCancelled()) {
            return;
          }
          stage = next_stage;
          if (stage === "done") {
            stopElapsedTimer();
          }
          render();
        },
        isCancelled,
      });
      if (assembly_result === null || isCancelled()) {
        return;
      }
      viewer_dashboard.bindAssembly(assembly_result, file.name);
    } catch (error) {
      if (isCancelled()) {
        return;
      }
      viewer_dashboard.updateStage(
        "조립 계산 실패",
        `${file.name} · 상단 메시지를 확인해 주세요`,
        (STAGE_DISPLAY[stage] ?? STAGE_DISPLAY.mesh).pipeline.replace("…", "✕"),
      );
      throw error;
    } finally {
      if (!isCancelled()) {
        stopElapsedTimer();
      }
    }
  }

  bindFilePicker(open_button, file_input, loadFile, (error) => {
    viewer_dashboard.showError(error);
  });

  return {
    key: "service",
    toggle_button,
    actions_element,
    idle_message: "STEP 파일을 로드해 주세요",
    drop_label: "Drop STEP file to process",
    loadFile,
    reset() {
      // 진행 중인 계산이 있으면 조회를 멈추고 결과는 버린다(서버 계산은 다음 업로드 때 멈춘다).
      request_serial += 1;
      stopElapsedTimer();
    },
  };
}

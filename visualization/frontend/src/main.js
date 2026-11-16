/**
 * 앱 진입점. 렌더러 · 대시보드 · 두 모드를 만들고 서로 연결한다.
 *
 * 모드는 modes/ 의 두 파일이 같은 모양의 객체로 만든다.
 *   { key, toggle_button, actions_element, idle_message, drop_label, loadFile, reset }
 * 여기서는 활성 모드를 고르고, 드롭된 파일을 활성 모드의 loadFile 로 넘긴다.
 */

import { AssemblyRenderer } from "./renderer.js";
import { ViewerDashboard } from "./ui/dashboard.js";
import { getRequiredElement } from "./ui/dom.js";
import { createDebugMode } from "./modes/debug_mode.js";
import { createServiceMode } from "./modes/service_mode.js";

/** 파일 드롭은 모드와 무관하게 한 곳에서 받아 활성 모드에 넘긴다. */
function bindFileDrop(getActiveMode, viewer_dashboard) {
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
      await getActiveMode().loadFile(dropped_files[0]);
    } catch (error) {
      viewer_dashboard.showError(error);
    }
  });
}

function main() {
  const assembly_renderer = new AssemblyRenderer(getRequiredElement("viewport"));
  const viewer_dashboard = new ViewerDashboard(assembly_renderer);
  const drop_overlay = getRequiredElement("drop-overlay");

  const modes = [
    createDebugMode(viewer_dashboard),
    createServiceMode(viewer_dashboard),
  ];
  let active_mode = null;

  // 전환 시 떠나는 모드의 상태와 화면을 완전히 비운다.
  function setActiveMode(next_mode) {
    if (next_mode === active_mode) {
      return;
    }
    active_mode = next_mode;
    for (const mode of modes) {
      const is_active = mode === next_mode;
      document.body.classList.toggle(`${mode.key}-mode`, is_active);
      mode.toggle_button.classList.toggle("is-active", is_active);
      mode.actions_element.classList.toggle("hidden", !is_active);
      if (!is_active) {
        mode.reset();
      }
    }
    drop_overlay.textContent = next_mode.drop_label;
    viewer_dashboard.resetWorkspace(next_mode.idle_message);
  }

  for (const mode of modes) {
    mode.toggle_button.addEventListener("click", () => {
      setActiveMode(mode);
    });
  }
  bindFileDrop(() => active_mode, viewer_dashboard);
  setActiveMode(modes[0]);
}

main();

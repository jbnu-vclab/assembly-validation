/**
 * Debug 모드: 로컬 조립 결과 msgpack → result_loader → 화면. 서버를 쓰지 않는다.
 * CLI(python main.py)로 미리 계산한 결과(output/*.msgpack)를 바로 확인하는 용도다.
 *
 * service_mode.js 와 같은 모양의 모드 객체를 반환한다. 모드 전환과 드롭은 main.js 가 맡는다.
 */

import { parseAssemblyBytes, ResultLoadException } from "../result_loader.js";
import { bindFilePicker, checkFileSuffix, getRequiredElement } from "../ui/dom.js";

const ALLOWED_ASSEMBLY_SUFFIXES = [".msgpack"];

export function createDebugMode(viewer_dashboard) {
  const toggle_button = getRequiredElement("debug-mode-button");
  const actions_element = getRequiredElement("debug-actions");
  const load_button = getRequiredElement("load-assembly-button");
  const file_input = getRequiredElement("assembly-file-input");

  async function loadFile(file) {
    checkFileSuffix(file, ALLOWED_ASSEMBLY_SUFFIXES, "조립 결과(.msgpack)만 로드할 수 있습니다");
    viewer_dashboard.showBusy(`${file.name} 로드 중…`);
    const assembly_result = parseAssemblyBytes(await readFileBytes(file));
    viewer_dashboard.bindAssembly(assembly_result, file.name);
  }

  bindFilePicker(load_button, file_input, loadFile, (error) => {
    viewer_dashboard.showError(error);
  });

  return {
    key: "debug",
    toggle_button,
    actions_element,
    idle_message: "조립 결과 msgpack을 로드해 주세요",
    drop_label: "Drop assembly msgpack",
    loadFile,
    reset() {
      // Debug 모드는 대시보드 밖에 들고 있는 상태가 없다.
    },
  };
}

/** 브라우저 안에서 로컬 파일을 바이트로 읽는다. Service 모드의 api.js 에 해당하는 자리다. */
async function readFileBytes(file) {
  try {
    return await file.arrayBuffer();
  } catch (error) {
    throw new ResultLoadException(`failed to read assembly file: ${error.message}`);
  }
}

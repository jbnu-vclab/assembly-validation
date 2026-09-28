/**
 * 서버(FastAPI) 통신. 프론트엔드에서 서버로 요청을 보내는 곳은 이 파일뿐이다.
 *
 * 주소 · 메서드 · 필드 이름은 서버 api/routes.py 와 맞춰야 한다.
 *   POST /api/load-step  (step_file) → 메시 미리보기 msgpack
 *   POST /api/assemble   (step_file) → 조립 결과 msgpack
 * 응답 바이트는 result_loader.js 가 Debug 모드와 같은 방식으로 해석한다.
 */

import { parseAssemblyBytes, ResultLoadException } from "./result_loader.js";

const LOAD_STEP_URL = "/api/load-step";
const ASSEMBLE_URL = "/api/assemble";

/** STEP 파일을 올려 메시 미리보기 결과를 받는다. */
export async function requestStepPreview(step_file) {
  return postStepFile(LOAD_STEP_URL, step_file, "load STEP file");
}

/**
 * STEP 파일을 올려 조립(분해) 경로 결과를 받는다. 수 분이 걸릴 수 있다.
 * 서버는 /load-step 의 업로드를 보관하지 않으므로 같은 파일을 다시 보낸다.
 */
export async function requestAssembly(step_file) {
  return postStepFile(ASSEMBLE_URL, step_file, "assemble STEP file");
}

async function postStepFile(request_url, step_file, action_label) {
  if (!(step_file instanceof Blob)) {
    throw new ResultLoadException("selected input must be a STEP file");
  }

  // 필드 이름 "step_file" 은 서버 엔드포인트의 매개변수 이름과 같아야 한다.
  const form_data = new FormData();
  form_data.append("step_file", step_file, step_file.name || "upload.step");

  let response;
  try {
    response = await fetch(request_url, {
      method: "POST",
      body: form_data,
    });
  } catch (error) {
    throw new ResultLoadException(`failed to ${action_label}: ${error.message}`);
  }

  if (!response.ok) {
    throw new ResultLoadException(await getErrorDetail(response, action_label));
  }

  return parseAssemblyBytes(await response.arrayBuffer());
}

/** 서버 오류 응답 {"detail": "..."} 에서 문구를 꺼낸다. JSON 이 아니면 상태 코드로 대신한다. */
async function getErrorDetail(response, action_label) {
  try {
    const error_payload = await response.json();
    if (typeof error_payload.detail === "string") {
      return error_payload.detail;
    }
  } catch (_error) {
    // JSON 이 아닌 응답이면 아래 기본 문구를 쓴다.
  }
  return `${action_label} failed with status ${response.status}`;
}

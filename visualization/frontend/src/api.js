/**
 * 서버(FastAPI) 통신. 프론트엔드에서 서버로 요청을 보내는 곳은 이 파일뿐이다.
 *
 * 주소 · 메서드 · 필드 이름은 서버 api/routes.py 와 맞춰야 한다.
 *   POST /api/assemble (step_file)       → {"job_id"}            계산 시작
 *   GET  /api/assemble/{job_id}          → {"stage", "error"}     진행 단계
 *   GET  /api/assemble/{job_id}/result   → 조립 결과 msgpack
 * 결과 바이트는 result_loader.js 가 Debug 모드와 같은 방식으로 해석한다.
 */

import { parseAssemblyBytes, ResultLoadException } from "./result_loader.js";

const ASSEMBLE_URL = "/api/assemble";
const STATUS_POLL_MILLISECONDS = 1000;

/**
 * STEP 파일을 올려 조립(분해) 경로 결과를 받는다. 수 분이 걸릴 수 있다.
 * 서버가 STEP → Mesh 변환부터 경로 탐색까지 연산 모듈로 처리하는 동안 진행 단계를 조회한다.
 *
 * @param onStage  단계가 바뀔 때마다 부른다: "queued" · "mesh" · "assembly" · "done"
 * @param isCancelled  true 를 돌려주면 조회를 멈추고 null 을 돌려준다(모드 전환 등).
 * @returns 결과 객체, 또는 취소됐으면 null
 */
export async function requestAssembly(step_file, { onStage, isCancelled } = {}) {
  if (!(step_file instanceof Blob)) {
    throw new ResultLoadException("selected input must be a STEP file");
  }

  // 필드 이름 "step_file" 은 서버 엔드포인트의 매개변수 이름과 같아야 한다.
  const form_data = new FormData();
  form_data.append("step_file", step_file, step_file.name || "upload.step");
  const { job_id } = await (await request(ASSEMBLE_URL, { method: "POST", body: form_data }, "start assembly")).json();

  let last_stage = null;
  for (;;) {
    if (isCancelled?.()) {
      return null;
    }
    const status = await (await request(`${ASSEMBLE_URL}/${job_id}`, {}, "check assembly status")).json();
    if (status.stage !== last_stage) {
      last_stage = status.stage;
      onStage?.(status.stage);
    }
    if (status.stage === "failed") {
      throw new ResultLoadException(status.error ?? "assembly failed");
    }
    if (status.stage === "done") {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_MILLISECONDS));
  }

  const response = await request(`${ASSEMBLE_URL}/${job_id}/result`, {}, "download assembly result");
  return parseAssemblyBytes(await response.arrayBuffer());
}

/** fetch 한 번. 네트워크 오류와 실패 응답을 ResultLoadException 으로 바꾼다. */
async function request(url, options, action_label) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    throw new ResultLoadException(`failed to ${action_label}: ${error.message}`);
  }
  if (!response.ok) {
    throw new ResultLoadException(await getErrorDetail(response, action_label));
  }
  return response;
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

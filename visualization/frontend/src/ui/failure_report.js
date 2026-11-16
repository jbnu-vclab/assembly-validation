/**
 * 실패 부품의 원인을 화면용 문장으로 정리하는 순수 함수.
 * failures(분해 실패 정보)를 받아 판정 · 이동 방향 · 막은 부품을 만든다. 화면(DOM)은 건드리지 않는다.
 */

import { formatPartLabel } from "./format.js";

/** 실패 부품을 dense solid index 로 찾을 수 있게 색인한다. */
export function getFailureBySolidIndex(failures) {
  return new Map((failures ?? []).map((failure_entry) => [failure_entry.solid, failure_entry]));
}

/**
 * 실패 자세에서 상한을 넘긴 겹침만 골라낸다.
 *
 * 한 자세에 is_over_limit 이 참인 항목과 거짓인 항목이 섞여 들어온다. 거짓은 허용치
 * 이내라 원인이 아니므로, 구분하지 않으면 원래 겹쳐 있던 부분까지 원인으로 지목하게
 * 된다. 범인이 둘 이상인 자세도 실제로 있으므로 하나만 찾지 않는다.
 */
function getCulpritOverlaps(pose_entry) {
  if (pose_entry === null) {
    return [];
  }
  return pose_entry.overlaps.filter((overlap_entry) => overlap_entry.is_over_limit);
}

const AXIS_NAMES = ["X", "Y", "Z"];

/**
 * 부품이 빠져나가려던 축과 부호(예: "-Y").
 *
 * 방향은 추정하지 않고 first_blocked_pose 의 변위에서 읽는다. 부품 AABB 로 최단 이탈
 * 축을 다시 고르면 대칭 부품에서 ±축이 동률이라(실측: roundbutton 이 +Z 45.0 / -Z 45.0)
 * 데이터와 다른 축을 짚을 수 있다.
 */
function getEscapeAxisLabel(failure_entry, assembly_result) {
  if (failure_entry.first_blocked_pose === null) {
    return null;
  }
  const initial_position = assembly_result.solids[failure_entry.solid].state.position;
  const displacements = failure_entry.first_blocked_pose.state.position.map(
    (value, axis_index) => value - initial_position[axis_index],
  );
  let axis_index = 0;
  for (let candidate_index = 1; candidate_index < 3; candidate_index += 1) {
    if (Math.abs(displacements[candidate_index]) > Math.abs(displacements[axis_index])) {
      axis_index = candidate_index;
    }
  }
  if (Math.abs(displacements[axis_index]) <= 0) {
    return null;
  }
  return `${displacements[axis_index] > 0 ? "+" : "-"}${AXIS_NAMES[axis_index]}`;
}

/**
 * 실패 한 건을 화면에 뿌릴 구조로 정리한다.
 *
 * [임시] 지금은 이동 방향과 막은 부품만 담는다. 간섭 위치·범위·겹침 형상 내보내기처럼
 * CAD 수정에 쓸 항목은 팀 논의 뒤에 정한다.
 *
 * 결론을 "분해 불가능" 으로 적지 않는다 — 탐색은 예산(반복 횟수·시간) 안에서만 완전하고,
 * first_blocked_pose 는 여섯 축 중 가장 가까운 출구 한 방향의 증거일 뿐이다.
 */
export function getFailureReport(failure_entry, assembly_result) {
  const report = {
    part_label: formatPartLabel(
      assembly_result.solids[failure_entry.solid],
      failure_entry.solid,
    ),
    verdict_text: "분해 실패",
    escape_axis_label: getEscapeAxisLabel(failure_entry, assembly_result),
    culprit_labels: [],
    note_text: null,
  };

  if (failure_entry.last_valid_pose === null) {
    // "초기 간섭" 이라고 부르지 않는다 — 조립 상태의 겹침 자체는 정상적인 조립체에
    // 항상 있는 것(압입·삽입)이라, 그 말을 이 비정상 상태의 이름으로 쓰면 둘이 섞인다.
    report.verdict_text = "조립 상태부터 막힘";
    report.note_text = "조립 상태에서 이미 간섭 상한을 넘습니다."
      + " 분해 이전에 조립 자체가 성립하지 않는 형상입니다.";
  }
  if (failure_entry.first_blocked_pose === null) {
    report.verdict_text = "원인 미확정";
    report.note_text = "막은 부품을 찾지 못했습니다."
      + " 형상이 아니라 탐색 한계(반복 횟수·시간)일 수 있습니다.";
    return report;
  }

  report.culprit_labels = getCulpritOverlaps(failure_entry.first_blocked_pose).map(
    (overlap_entry) => formatPartLabel(
      assembly_result.solids[overlap_entry.obstacle],
      overlap_entry.obstacle,
    ),
  );
  if (report.culprit_labels.length === 0 && report.note_text === null) {
    report.note_text = "막힌 자세는 찾았으나 상한을 넘긴 겹침이 없습니다.";
  }
  return report;
}

/** 트리 버튼 툴팁용 한 줄 요약. 리포트를 열지 않고도 무엇이 막았는지 보이게 한다. */
export function getFailureSummaryText(failure_entry, assembly_result) {
  const report = getFailureReport(failure_entry, assembly_result);
  if (report.culprit_labels.length === 0) {
    return report.note_text ?? "막은 부품을 특정하지 못했습니다";
  }
  const direction_text = report.escape_axis_label === null
    ? ""
    : `${report.escape_axis_label} 방향 · `;
  return `${direction_text}${report.culprit_labels.join(", ")} 에 막힘`;
}

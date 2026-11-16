/**
 * solids / trajectories를 Three.js mesh로 렌더링하고 궤적 애니메이션을 재생한다.
 *
 * 회전 규약: 팀 State 와 동일하게 scipy "XYZ" intrinsic(degrees) = R = Rx·Ry·Rz.
 * three.js 의 Euler order "XYZ" 가 같은 곱 순서이므로 그대로 쓴다.
 * (core/state.py 는 대문자 "XYZ" = intrinsic 이다. 소문자 "xyz" = extrinsic 으로 읽고
 *  three.js "ZYX" 로 매핑하면 역순이 되어 4 가지 시험 자세 모두 어긋난다.)
 *
 * 재생 시간표: 프레임(= 한 부품의 한 방향 구간)마다 길이가 다르다.
 *   병진 프레임 = 이동 거리 / TRANSLATION_SPEED_UNITS_PER_SECOND  (모든 구간이 같은 속도)
 *   회전 프레임 = ROTATION_FRAME_SECONDS                          (거리 개념이 없어 고정)
 * 프레임 k 는 [frame_start_times[k], frame_end_times[k]) 동안 선형(등속)으로 보간한다.
 *
 * _timeline_seconds 는 1배속 기준 시각이다. 배속은 시계가 흐르는 빠르기만 바꾸므로
 * 시간표를 다시 계산하지 않는다. 밖으로 내보내는 시각(getPlaybackTimeSeconds 등)은
 * 배속을 반영한 실제 재생 시간이다.
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";

const SOLID_COLORS = [
  0x4c78a8,
  0xf58518,
  0xe45756,
  0x72b7b2,
  0x54a24b,
  0xeeca3b,
  0xb279a2,
  0xff9da6,
  0x9d755d,
  0xbab0ac,
  0x17becf,
  0xbcbd22,
  0x9467bd,
  0x8c564b,
  0x7f7f7f,
];

// 실패 분석 연출 상수.
// 이동량이 조립체 크기의 0.5% 안팎인 경우가 많아(실측: 10건 중 7건) 속도로 승부할 수
// 없다. 구간마다 고정 시간을 주고 정지 구간을 끼워 "어디서 멈췄는지"를 읽히게 한다.
const FAILURE_PATH_TOTAL_SECONDS = 1.2;
const FAILURE_HOLD_VALID_SECONDS = 0.6;
const FAILURE_PUSH_SECONDS = 0.8;
const FAILURE_BLOCKED_SECONDS = 1.6;
// 초당 3회 이상 깜빡이면 광과민성 발작 위험이 있어 1.25Hz 로 둔다.
const FAILURE_PULSE_FREQUENCY_HZ = 1.25;
const CULPRIT_OVERLAP_COLOR = 0xff4d4d;
const CONTACT_OVERLAP_COLOR = 0x5aa9ff;
// 실패 분석 중 부품 불투명도. 모든 부품을 반투명으로 두되, 충돌에 관련된 부품(움직이는
// 부품 · 막은 부품)을 조금 더 진하게 둔다.
const FAILURE_FOCUS_OPACITY = 0.45;
const FAILURE_BACKGROUND_OPACITY = 0.3;
// 충돌 영역(겹침 메시) 테두리. WebGL 기본 선은 1픽셀 고정이라 굵은 선 애드온을 쓴다.
// 색은 겹침 색을 밝게 올려 겹침 면과 구분한다.
const OVERLAP_OUTLINE_WIDTH_PIXELS = 2.5;
const OVERLAP_OUTLINE_LIGHTEN = 0.22;
// 이웃한 면이 이 각도 이상 꺾인 모서리만 테두리로 뽑는다. 곡면을 나눈 삼각형 경계는 빠진다.
const OVERLAP_OUTLINE_THRESHOLD_DEGREES = 30;

// 궤적 재생 속도(1배속). 이탈 거리 400(main.py ESCAPE_DISTANCE)이 1초가 되도록 잡았다.
const TRANSLATION_SPEED_UNITS_PER_SECOND = 400;
const ROTATION_FRAME_SECONDS = 0.5;

// 이웃한 두 면이 이 각도보다 크게 꺾이면 모서리로 보고 음영을 나눈다. 결과 메시를 재 보면
// 곡면을 나눈 삼각형은 대부분 10° 미만, 실제 모서리는 30° 이상이라 그 사이로 잡았다.
const SMOOTH_SHADING_MAX_ANGLE = THREE.MathUtils.degToRad(30);

// 백엔드 State 의 회전 규약. scipy "XYZ" intrinsic 과 three.js "XYZ" 가 같은 곱 순서다.
const STATE_EULER_ORDER = "XYZ";

export class AssemblyRenderException extends Error {
  constructor(message) {
    super(message);
    this.name = "AssemblyRenderException";
  }
}

function flattenNestedNumberArrays(nested_values) {
  const flattened_values = [];
  for (const row of nested_values) {
    if (Array.isArray(row)) {
      for (const value of row) {
        flattened_values.push(Number(value));
      }
    } else {
      flattened_values.push(Number(row));
    }
  }
  return flattened_values;
}

function createSolidGeometry(mesh_entry) {
  const position_values = flattenNestedNumberArrays(mesh_entry.vertices);
  const index_values = flattenNestedNumberArrays(mesh_entry.faces);

  if (position_values.length % 3 !== 0) {
    throw new AssemblyRenderException("mesh vertices length must be a multiple of 3");
  }
  if (index_values.length % 3 !== 0) {
    throw new AssemblyRenderException("mesh faces length must be a multiple of 3");
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(position_values, 3),
  );
  geometry.setIndex(index_values);
  // 꼭짓점을 공유한 채 법선을 평균하면 각진 모서리의 법선이 양쪽 면의 어중간한 방향이 되어
  // 모서리 근처 음영이 둥글게 번진다. 이웃 면이 SMOOTH_SHADING_MAX_ANGLE 보다 크게 꺾인
  // 모서리에서는 꼭짓점을 나눠 각진 곳은 각지게, 완만한 곡면은 부드럽게 그린다.
  return toCreasedNormals(geometry, SMOOTH_SHADING_MAX_ANGLE);
}

function applyStateToObject(object3d, state) {
  const [position_x, position_y, position_z] = state.position;
  const [rotation_x_degrees, rotation_y_degrees, rotation_z_degrees] = state.rotation;

  object3d.position.set(position_x, position_y, position_z);
  object3d.rotation.set(
    THREE.MathUtils.degToRad(rotation_x_degrees),
    THREE.MathUtils.degToRad(rotation_y_degrees),
    THREE.MathUtils.degToRad(rotation_z_degrees),
    STATE_EULER_ORDER,
  );
}

const SOLID_LOOK_OPACITY = {
  opaque: 1.0,
  focus: FAILURE_FOCUS_OPACITY,
  background: FAILURE_BACKGROUND_OPACITY,
};

/**
 * 부품 재질의 표시 방식을 바꾼다. 어느 방식이든 z-buffer 에 깊이를 기록한다.
 *   "opaque"     : 불투명 (일반 재생)
 *   "focus"      : 반투명, 조금 진하게 (실패 분석의 움직이는 부품 · 막은 부품)
 *   "background" : 반투명 (실패 분석의 나머지 부품)
 *
 * 반투명이어도 깊이를 기록하므로 앞뒤가 뒤섞이는 붕괴가 없다. 대신 먼저 그려진 반투명
 * 부품이 그 뒤의 부품을 가릴 수 있다(Three.js 는 반투명 부품을 중심 거리 기준 뒤 → 앞으로
 * 그리므로, 서로 감싸는 부품에서 주로 생긴다).
 */
function setSolidMaterialLook(material, look) {
  material.transparent = look !== "opaque";
  material.opacity = SOLID_LOOK_OPACITY[look];
  material.depthWrite = true;
  // transparent 는 셰이더 컴파일 시점에 반영된다(false 면 OPAQUE 로 컴파일돼 opacity 가
  // 1.0 으로 고정). 바꿀 때마다 셰이더를 다시 만들게 해야 반투명이 실제로 적용된다.
  material.needsUpdate = true;
}

/**
 * 막힌 자세에서 상한을 넘겨 부품을 막은 장애물들의 dense index.
 * 상한 이내의 겹침(is_over_limit=false)은 원래 맞물린 부분이라 원인이 아니다.
 */
function getBlockingObstacleIndexes(first_blocked_pose) {
  if (first_blocked_pose === null) {
    return [];
  }
  return first_blocked_pose.overlaps
    .filter((overlap_entry) => overlap_entry.is_over_limit)
    .map((overlap_entry) => overlap_entry.obstacle);
}

/**
 * 겹침 메시의 꺾인 모서리를 굵은 선으로 덧그린다. 겹침 메시의 자식으로 붙여 겹침이
 * 켜지고 꺼질 때 같이 따라간다. 겹침과 같이 깊이 검사를 끄고 겹침 바로 위에 그린다.
 *
 * @param viewport_size 화면 크기(CSS 픽셀). 굵기를 픽셀 단위로 계산하는 데 쓴다.
 */
function addOverlapOutline(overlap_mesh, overlap_color, viewport_size) {
  const edges_geometry = new THREE.EdgesGeometry(
    overlap_mesh.geometry,
    OVERLAP_OUTLINE_THRESHOLD_DEGREES,
  );
  const outline_geometry = new LineSegmentsGeometry().fromEdgesGeometry(edges_geometry);
  edges_geometry.dispose();

  const outline_material = new LineMaterial({
    color: new THREE.Color(overlap_color).offsetHSL(0, 0, OVERLAP_OUTLINE_LIGHTEN).getHex(),
    linewidth: OVERLAP_OUTLINE_WIDTH_PIXELS,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 1.0,
  });
  outline_material.resolution.copy(viewport_size);

  const outline_line = new LineSegments2(outline_geometry, outline_material);
  outline_line.renderOrder = 1000;
  outline_line.userData.is_overlap_outline = true;
  overlap_mesh.add(outline_line);
}

function getStateFromObject(object3d) {
  // applyStateToObject 가 STATE_EULER_ORDER 로 넣은 값을 그대로 되읽는다.
  return {
    position: [object3d.position.x, object3d.position.y, object3d.position.z],
    rotation: [
      THREE.MathUtils.radToDeg(object3d.rotation.x),
      THREE.MathUtils.radToDeg(object3d.rotation.y),
      THREE.MathUtils.radToDeg(object3d.rotation.z),
    ],
  };
}

function getEasedAlpha(linear_alpha) {
  const clamped_alpha = Math.max(0, Math.min(1, linear_alpha));
  return clamped_alpha * clamped_alpha * (3 - 2 * clamped_alpha);
}

// 보간용 임시 객체. 프레임마다 새로 만들지 않으려고 모듈 수준에 둔다.
const START_EULER = new THREE.Euler();
const END_EULER = new THREE.Euler();
const START_QUATERNION = new THREE.Quaternion();
const END_QUATERNION = new THREE.Quaternion();
const INTERPOLATED_EULER = new THREE.Euler();

/**
 * 두 상태 사이를 보간한다. 위치는 선형, 자세는 사원수 구면 보간(slerp)이다.
 * alpha 를 그대로 쓰므로 등속이다. 가감속이 필요하면 호출하는 쪽이 getEasedAlpha 를 씌운다.
 *
 * 오일러 성분을 따로 선형 보간하면 같은 자세로 도착하더라도 중간에 실재하지 않는
 * 방향으로 휘고, 특정 조합에서는 짐벌락으로 축이 무너진다. 백엔드 플래너도 회전 구간
 * 검사에 scipy Slerp 를 쓰므로(core/planner.py) 같은 방식으로 맞춘다.
 */
function interpolateState(start_state, end_state, alpha) {
  const clamped_alpha = Math.max(0, Math.min(1, alpha));
  const position = [
    start_state.position[0]
      + (end_state.position[0] - start_state.position[0]) * clamped_alpha,
    start_state.position[1]
      + (end_state.position[1] - start_state.position[1]) * clamped_alpha,
    start_state.position[2]
      + (end_state.position[2] - start_state.position[2]) * clamped_alpha,
  ];

  const has_same_rotation = start_state.rotation[0] === end_state.rotation[0]
    && start_state.rotation[1] === end_state.rotation[1]
    && start_state.rotation[2] === end_state.rotation[2];
  if (has_same_rotation) {
    return { position, rotation: [...start_state.rotation] };
  }

  START_EULER.set(
    THREE.MathUtils.degToRad(start_state.rotation[0]),
    THREE.MathUtils.degToRad(start_state.rotation[1]),
    THREE.MathUtils.degToRad(start_state.rotation[2]),
    STATE_EULER_ORDER,
  );
  END_EULER.set(
    THREE.MathUtils.degToRad(end_state.rotation[0]),
    THREE.MathUtils.degToRad(end_state.rotation[1]),
    THREE.MathUtils.degToRad(end_state.rotation[2]),
    STATE_EULER_ORDER,
  );
  START_QUATERNION.setFromEuler(START_EULER);
  END_QUATERNION.setFromEuler(END_EULER);
  START_QUATERNION.slerp(END_QUATERNION, clamped_alpha);
  INTERPOLATED_EULER.setFromQuaternion(START_QUATERNION, STATE_EULER_ORDER);

  return {
    position,
    rotation: [
      THREE.MathUtils.radToDeg(INTERPOLATED_EULER.x),
      THREE.MathUtils.radToDeg(INTERPOLATED_EULER.y),
      THREE.MathUtils.radToDeg(INTERPOLATED_EULER.z),
    ],
  };
}

/** 프레임 하나를 1배속으로 재생하는 시간. 병진은 거리에 비례해 모든 구간이 같은 속도가 된다. */
function getFrameDurationSeconds(trajectory_frame) {
  if (trajectory_frame.action.type === "rotation") {
    return ROTATION_FRAME_SECONDS;
  }
  const [delta_x, delta_y, delta_z] = trajectory_frame.action.value;
  return Math.hypot(delta_x, delta_y, delta_z) / TRANSLATION_SPEED_UNITS_PER_SECOND;
}

/** 프레임마다 [시작, 끝) 시각(1배속)을 누적해 시간표를 만든다. */
function buildFrameTimetable(trajectory_frames) {
  const frame_start_times = [];
  const frame_end_times = [];
  let elapsed_seconds = 0;
  for (const trajectory_frame of trajectory_frames) {
    frame_start_times.push(elapsed_seconds);
    elapsed_seconds += getFrameDurationSeconds(trajectory_frame);
    frame_end_times.push(elapsed_seconds);
  }
  return { frame_start_times, frame_end_times };
}

function getBoundingBoxCenter(global_bbox) {
  const [minimum_x, minimum_y, minimum_z, maximum_x, maximum_y, maximum_z] = global_bbox;
  return new THREE.Vector3(
    (minimum_x + maximum_x) * 0.5,
    (minimum_y + maximum_y) * 0.5,
    (minimum_z + maximum_z) * 0.5,
  );
}

function getBoundingBoxDiagonal(global_bbox) {
  const [minimum_x, minimum_y, minimum_z, maximum_x, maximum_y, maximum_z] = global_bbox;
  return Math.hypot(maximum_x - minimum_x, maximum_y - minimum_y, maximum_z - minimum_z);
}

export class AssemblyRenderer {
  constructor(viewport_element) {
    if (!(viewport_element instanceof HTMLElement)) {
      throw new AssemblyRenderException("viewport_element must be an HTMLElement");
    }

    this._viewport_element = viewport_element;
    this._playback_speed_multiplier = 1;
    this._solid_meshes = [];
    this._initial_states = [];
    this._trajectory_frames = [];
    this._all_trajectory_frames = [];
    this._frame_start_times = [];
    this._frame_end_times = [];
    this._global_bbox = null;
    // 적용을 마친 프레임 수. 프레임 k 가 보간 중이면 k 다.
    this._playback_position = 0;
    this._timeline_seconds = 0;
    this._playback_range_end_timeline_seconds = null;
    this._is_playing = false;
    this._active_transition = null;
    this._on_frame_change = null;
    this._clock = new THREE.Clock(false);

    this._scene = new THREE.Scene();
    this._scene.background = new THREE.Color(0x10151f);

    const viewport_width = viewport_element.clientWidth || window.innerWidth;
    const viewport_height = viewport_element.clientHeight || window.innerHeight;

    this._camera = new THREE.PerspectiveCamera(
      45,
      viewport_width / viewport_height,
      0.01,
      10000,
    );
    this._camera.up.set(0, 0, 1);

    this._renderer = new THREE.WebGLRenderer({ antialias: true });
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this._renderer.setSize(viewport_width, viewport_height);
    viewport_element.appendChild(this._renderer.domElement);

    this._orbit_controls = new OrbitControls(this._camera, this._renderer.domElement);
    this._orbit_controls.enableDamping = true;

    const ambient_light = new THREE.AmbientLight(0xffffff, 0.5);
    const key_light = new THREE.DirectionalLight(0xffffff, 0.9);
    key_light.position.set(2.5, -1.5, 4.0);
    const fill_light = new THREE.DirectionalLight(0x9fb7ff, 0.35);
    fill_light.position.set(-2.0, 1.5, 1.5);
    this._scene.add(ambient_light, key_light, fill_light);

    this._grid_helper = null;
    this._onWindowResize = this._onWindowResize.bind(this);
    window.addEventListener("resize", this._onWindowResize);

    this._failure_analysis = null;

    this._renderer.setAnimationLoop(() => {
      const delta_seconds = this._clock.getDelta();
      this._updateAnimation(delta_seconds);
      this._updateFailureAnimation(delta_seconds);
      this._orbit_controls.update();
      this._renderer.render(this._scene, this._camera);
    });
  }

  setOnFrameChange(callback) {
    this._on_frame_change = callback;
  }

  loadAssembly(assembly_result) {
    this.stopFailureAnalysis();
    this._clearSolids();
    this.pause();

    const { metadata, solids, trajectories } = assembly_result;
    this._all_trajectory_frames = trajectories;
    this._trajectory_frames = trajectories;
    ({
      frame_start_times: this._frame_start_times,
      frame_end_times: this._frame_end_times,
    } = buildFrameTimetable(trajectories));
    this._global_bbox = metadata.global_bbox;
    this._playback_position = 0;
    this._timeline_seconds = 0;
    this._active_transition = null;
    this._initial_states = solids.map((solid_entry) => solid_entry.state);

    solids.forEach((solid_entry, solid_index) => {
      const geometry = createSolidGeometry(solid_entry.mesh);
      const part_index = Number.isInteger(solid_entry.part_index)
        ? solid_entry.part_index
        : solid_index;
      const material = new THREE.MeshStandardMaterial({
        color: SOLID_COLORS[part_index % SOLID_COLORS.length],
        metalness: 0.08,
        roughness: 0.52,
      });
      const solid_mesh = new THREE.Mesh(geometry, material);
      solid_mesh.userData.part_index = part_index;
      applyStateToObject(solid_mesh, solid_entry.state);
      this._scene.add(solid_mesh);
      this._solid_meshes.push(solid_mesh);
    });

    this._updateGridHelper(metadata.global_bbox);
    this.resetCamera();
    this._notifyFrameChange();
  }

  clearAssembly() {
    this.stopFailureAnalysis();
    this.pause();
    this._clearPlaybackRange();
    this._clearSolids();
    this._global_bbox = null;
    this._playback_position = 0;
    this._timeline_seconds = 0;
    if (this._grid_helper !== null) {
      this._scene.remove(this._grid_helper);
      this._grid_helper.geometry.dispose();
      if (Array.isArray(this._grid_helper.material)) {
        for (const material of this._grid_helper.material) {
          material.dispose();
        }
      } else {
        this._grid_helper.material.dispose();
      }
      this._grid_helper = null;
    }
    this._notifyFrameChange();
  }

  getSolidCount() {
    return this._solid_meshes.length;
  }

  getFrameCount() {
    return this._trajectory_frames.length;
  }

  getPlaybackPosition() {
    return this._playback_position;
  }

  /** 배속을 반영한 현재 재생 시각(초). */
  getPlaybackTimeSeconds() {
    return this._timeline_seconds / this._playback_speed_multiplier;
  }

  /** 배속을 반영한 전체 재생 시간(초). */
  getTotalDurationSeconds() {
    return this._getTotalTimelineSeconds() / this._playback_speed_multiplier;
  }

  /**
   * 화면에 "Frame k / N" 으로 보여줄 k. 0 이면 시작 전, 프레임 k 를 보간 중이거나 막
   * 끝냈으면 k(1부터)다.
   */
  getActiveFrameNumber() {
    const frame_count = this._trajectory_frames.length;
    if (frame_count === 0 || this._timeline_seconds <= 0) {
      return 0;
    }
    const is_inside_next_frame = this._playback_position < frame_count
      && this._timeline_seconds > this._frame_start_times[this._playback_position];
    return Math.min(this._playback_position + (is_inside_next_frame ? 1 : 0), frame_count);
  }

  getPlaybackSpeedMultiplier() {
    return this._playback_speed_multiplier;
  }

  /** 배속은 시계가 흐르는 빠르기만 바꾼다. 현재 자세와 시간표는 그대로다. */
  setPlaybackSpeedMultiplier(speed_multiplier) {
    if (!(speed_multiplier > 0)) {
      throw new AssemblyRenderException(
        `speed_multiplier must be positive, received ${speed_multiplier}`,
      );
    }
    this._playback_speed_multiplier = speed_multiplier;
    this._notifyFrameChange();
  }

  getFrameState() {
    return {
      playback_position: this._playback_position,
      playback_time_seconds: this.getPlaybackTimeSeconds(),
      total_duration_seconds: this.getTotalDurationSeconds(),
      frame_count: this._trajectory_frames.length,
      active_frame_number: this.getActiveFrameNumber(),
      is_playing: this._is_playing,
    };
  }

  _getTotalTimelineSeconds() {
    const frame_count = this._frame_end_times.length;
    return frame_count === 0 ? 0 : this._frame_end_times[frame_count - 1];
  }

  isPlaying() {
    return this._is_playing;
  }

  getSolidColorHex(solid_index) {
    const solid_mesh = this._solid_meshes[solid_index];
    if (solid_mesh === undefined) {
      throw new AssemblyRenderException(`solid index ${solid_index} is out of range`);
    }
    return `#${solid_mesh.material.color.getHexString()}`;
  }

  play() {
    this.stopFailureAnalysis();
    this._clearPlaybackRange();
    this._restoreFullTrajectoryPlaylist();
    if (this._trajectory_frames.length === 0) {
      return;
    }
    if (this._timeline_seconds >= this._getTotalTimelineSeconds()) {
      this._seekToTimelineSeconds(0);
    }
    this._is_playing = true;
    this._clock.start();
    this._notifyFrameChange();
  }

  playSolid(solid_index) {
    this.stopFailureAnalysis();
    if (!Number.isInteger(solid_index)) {
      throw new AssemblyRenderException(
        `solid_index must be an integer, received ${solid_index}`,
      );
    }
    if (solid_index < 0 || solid_index >= this._solid_meshes.length) {
      throw new AssemblyRenderException(`solid index ${solid_index} is out of range`);
    }

    this._restoreFullTrajectoryPlaylist();
    const solid_frame_indexes = [];
    this._all_trajectory_frames.forEach((trajectory_frame, frame_index) => {
      if (trajectory_frame.solid === solid_index) {
        solid_frame_indexes.push(frame_index);
      }
    });
    if (solid_frame_indexes.length === 0) {
      return false;
    }

    const range_start_seconds = this._frame_start_times[solid_frame_indexes[0]];
    const range_end_seconds =
      this._frame_end_times[solid_frame_indexes[solid_frame_indexes.length - 1]];

    this.pause();
    this._seekToTimelineSeconds(range_start_seconds);
    this._playback_range_end_timeline_seconds = range_end_seconds;
    this._is_playing = true;
    this._clock.start();
    this._notifyFrameChange();
    return true;
  }

  pause() {
    this._is_playing = false;
    this._clock.stop();
    this._notifyFrameChange();
  }

  stop() {
    this.stopFailureAnalysis();
    this.pause();
    this._clearPlaybackRange();
    this._restoreFullTrajectoryPlaylist();
    this.seekToTime(0);
  }

  /** 배속을 반영한 재생 시각(초)으로 이동한다. 타임라인 슬라이더가 이 값을 쓴다. */
  seekToTime(playback_time_seconds) {
    if (!Number.isFinite(playback_time_seconds)) {
      throw new AssemblyRenderException(
        `playback_time_seconds must be a finite number, received ${playback_time_seconds}`,
      );
    }
    this._seekToTimelineSeconds(playback_time_seconds * this._playback_speed_multiplier);
  }

  /** 1배속 시간표 기준 시각으로 이동한다. 초기 자세부터 다시 적용한다. */
  _seekToTimelineSeconds(timeline_seconds) {
    this.stopFailureAnalysis();
    this._restoreFullTrajectoryPlaylist();
    this._timeline_seconds = Math.max(
      0,
      Math.min(timeline_seconds, this._getTotalTimelineSeconds()),
    );

    this._restoreInitialStates();
    this._active_transition = null;
    this._playback_position = 0;
    this._applyFramesUpToTimeline();
    this._notifyFrameChange();
  }

  /**
   * _timeline_seconds 까지 끝난 프레임을 적용하고, 걸쳐 있는 프레임은 등속으로 보간한다.
   * 재생(_updateAnimation)과 이동(_seekToTimelineSeconds)이 같이 쓴다.
   */
  _applyFramesUpToTimeline() {
    const frame_count = this._trajectory_frames.length;
    while (
      this._playback_position < frame_count
      && this._frame_end_times[this._playback_position] <= this._timeline_seconds
    ) {
      this._applyTrajectoryFrame(this._trajectory_frames[this._playback_position]);
      this._playback_position += 1;
      this._active_transition = null;
    }

    if (this._playback_position >= frame_count) {
      return;
    }
    const frame_start_seconds = this._frame_start_times[this._playback_position];
    if (this._timeline_seconds <= frame_start_seconds) {
      return;
    }
    if (this._active_transition === null) {
      this._beginTransitionToCurrentFrame();
    }
    const frame_duration_seconds =
      this._frame_end_times[this._playback_position] - frame_start_seconds;
    this._applyInterpolatedTransition(
      (this._timeline_seconds - frame_start_seconds) / frame_duration_seconds,
    );
  }

  _restoreFullTrajectoryPlaylist() {
    this._trajectory_frames = this._all_trajectory_frames;
  }

  _clearPlaybackRange() {
    this._playback_range_end_timeline_seconds = null;
  }

  setSolidVisibility(solid_index, is_visible) {
    const solid_mesh = this._solid_meshes[solid_index];
    if (solid_mesh === undefined) {
      throw new AssemblyRenderException(`solid index ${solid_index} is out of range`);
    }
    solid_mesh.visible = is_visible;
  }

  setSolidHighlight(solid_index, is_highlighted) {
    const solid_mesh = this._solid_meshes[solid_index];
    if (solid_mesh === undefined) {
      throw new AssemblyRenderException(`solid index ${solid_index} is out of range`);
    }
    solid_mesh.material.emissive.setHex(is_highlighted ? 0x224466 : 0x000000);
    solid_mesh.material.emissiveIntensity = is_highlighted ? 0.45 : 0.0;
  }

  clearSolidHighlights() {
    for (const solid_mesh of this._solid_meshes) {
      solid_mesh.material.emissive.setHex(0x000000);
      solid_mesh.material.emissiveIntensity = 0.0;
    }
  }

  resetCamera() {
    if (this._global_bbox === null) {
      return;
    }
    this._fitCameraToBoundingBox(this._global_bbox);
  }

  _updateAnimation(delta_seconds) {
    if (!this._is_playing || this._trajectory_frames.length === 0) {
      return;
    }

    // 부품 구간 재생(playSolid)이면 그 구간 끝, 아니면 전체 끝에서 멈춘다.
    const stop_timeline_seconds = this._playback_range_end_timeline_seconds
      ?? this._getTotalTimelineSeconds();
    this._timeline_seconds = Math.min(
      this._timeline_seconds + delta_seconds * this._playback_speed_multiplier,
      stop_timeline_seconds,
    );
    this._applyFramesUpToTimeline();

    if (this._timeline_seconds >= stop_timeline_seconds) {
      this._clearPlaybackRange();
      this.pause();
      return;
    }
    this._notifyFrameChange();
  }

  _beginTransitionToCurrentFrame() {
    const trajectory_frame = this._trajectory_frames[this._playback_position];
    const solid_mesh = this._solid_meshes[trajectory_frame.solid];
    if (solid_mesh === undefined) {
      throw new AssemblyRenderException(
        `trajectory solid index ${trajectory_frame.solid} is out of range`,
      );
    }

    this._active_transition = {
      solid_index: trajectory_frame.solid,
      start_state: getStateFromObject(solid_mesh),
      end_state: trajectory_frame.state,
    };
  }

  _applyInterpolatedTransition(transition_alpha) {
    if (this._active_transition === null) {
      return;
    }

    const solid_mesh = this._solid_meshes[this._active_transition.solid_index];
    const interpolated_state = interpolateState(
      this._active_transition.start_state,
      this._active_transition.end_state,
      transition_alpha,
    );
    applyStateToObject(solid_mesh, interpolated_state);
  }

  _restoreInitialStates() {
    this._solid_meshes.forEach((solid_mesh, solid_index) => {
      applyStateToObject(solid_mesh, this._initial_states[solid_index]);
    });
  }

  _applyTrajectoryFrame(trajectory_frame) {
    const solid_mesh = this._solid_meshes[trajectory_frame.solid];
    if (solid_mesh === undefined) {
      throw new AssemblyRenderException(
        `trajectory solid index ${trajectory_frame.solid} is out of range`,
      );
    }
    applyStateToObject(solid_mesh, trajectory_frame.state);
  }

  _updateGridHelper(global_bbox) {
    if (this._grid_helper !== null) {
      this._scene.remove(this._grid_helper);
      this._grid_helper.geometry.dispose();
      if (Array.isArray(this._grid_helper.material)) {
        for (const material of this._grid_helper.material) {
          material.dispose();
        }
      } else {
        this._grid_helper.material.dispose();
      }
      this._grid_helper = null;
    }

    const diagonal = Math.max(getBoundingBoxDiagonal(global_bbox), 1);
    const grid_size = Math.ceil(diagonal * 2.0);
    this._grid_helper = new THREE.GridHelper(grid_size, 20, 0x2a3344, 0x1a2230);
    this._grid_helper.rotation.x = Math.PI / 2;
    this._grid_helper.position.copy(getBoundingBoxCenter(global_bbox));
    this._grid_helper.position.z = global_bbox[2];
    this._scene.add(this._grid_helper);
  }

  _fitCameraToBoundingBox(global_bbox) {
    const center = getBoundingBoxCenter(global_bbox);
    const diagonal = Math.max(getBoundingBoxDiagonal(global_bbox), 1e-3);
    const distance = diagonal * 1.6;

    this._camera.position.set(
      center.x + distance,
      center.y - distance,
      center.z + distance * 0.75,
    );
    this._camera.near = Math.max(diagonal / 1000, 0.01);
    this._camera.far = Math.max(diagonal * 100, 1000);
    this._camera.updateProjectionMatrix();

    this._orbit_controls.target.copy(center);
    this._orbit_controls.update();
  }

  /**
   * 실패 분석 모드로 들어간다.
   *
   * 화면에는 실패한 부품들만 남긴다. 분해에 성공한 부품은 이미 400 밖으로 나가 있어
   * 카메라를 크게 벌리기만 하고, 실패 시점에는 장애물도 아니다. 실측으로 확인한 대로
   * overlaps 의 장애물은 모두 실패 부품 집합 안에 있으므로 숨겨진 부품이 범인일 일은
   * 없다(그리디 루프가 멈춘 시점의 남은 부품이 곧 실패 집합이기 때문이다).
   *
   * @param failure_analysis {solid_index, visible_solid_indexes, closest_path,
   *                          last_valid_pose, first_blocked_pose}
   */
  startFailureAnalysis(failure_analysis) {
    const {
      solid_index,
      visible_solid_indexes,
      closest_path,
      last_valid_pose,
      first_blocked_pose,
    } = failure_analysis;

    const moving_solid_mesh = this._solid_meshes[solid_index];
    if (moving_solid_mesh === undefined) {
      throw new AssemblyRenderException(`solid index ${solid_index} is out of range`);
    }

    this.pause();
    this._clearPlaybackRange();
    this.stopFailureAnalysis();
    this._restoreInitialStates();

    // 부품은 모두 반투명으로 낮춰 겹침이 어느 부품 속인지 읽히게 하고, 충돌에 관련된
    // 부품(움직이는 부품 + 막은 부품)은 조금 더 진하게 둔다. 깊이는 계속 기록해 앞뒤가
    // 뒤섞이지 않게 한다(setSolidMaterialLook 참고). 겹침 메시는 깊이 검사를 끄고
    // 마지막에 그리므로 부품 속에 있어도 항상 보인다.
    const focus_index_set = new Set([
      solid_index,
      ...getBlockingObstacleIndexes(first_blocked_pose),
    ]);
    const visible_index_set = new Set(visible_solid_indexes);
    this._solid_meshes.forEach((solid_mesh, index) => {
      solid_mesh.visible = visible_index_set.has(index);
      if (!solid_mesh.visible) {
        return;
      }
      setSolidMaterialLook(
        solid_mesh.material,
        focus_index_set.has(index) ? "focus" : "background",
      );
    });

    const initial_state = this._initial_states[solid_index];
    const valid_state = last_valid_pose === null ? initial_state : last_valid_pose.state;
    const blocked_state = first_blocked_pose === null ? null : first_blocked_pose.state;

    this._failure_analysis = {
      solid_index,
      path_frames: closest_path,
      initial_state,
      valid_state,
      blocked_state,
      // 막힌 자세의 겹침만 만든다. 마지막 정상 자세의 맞물림 겹침은 조각 수가
      // 수백 개인 경우가 있어(실측 507개) 기본으로는 만들지 않는다.
      overlap_meshes: first_blocked_pose === null
        ? []
        : this._buildFailureOverlapMeshes(first_blocked_pose),
      phase_name: "path",
      phase_elapsed_seconds: 0,
    };

    this._applyFailurePhase(0);
    this._fitCameraToFailure(this._failure_analysis);
    this._clock.start();
  }

  stopFailureAnalysis() {
    if (this._failure_analysis === null) {
      return;
    }
    this._clearFailureOverlapMeshes();
    this._failure_analysis = null;

    for (const solid_mesh of this._solid_meshes) {
      solid_mesh.visible = true;
      setSolidMaterialLook(solid_mesh.material, "opaque");
    }
    this._restoreInitialStates();
    this._clock.stop();
    this._notifyFrameChange();
  }

  isAnalysingFailure() {
    return this._failure_analysis !== null;
  }

  /** 설계상의 맞물림(is_over_limit=false) 겹침을 함께 보여줄지 전환한다. */
  setContactOverlapVisibility(is_visible) {
    if (this._failure_analysis === null) {
      return;
    }
    for (const overlap_mesh of this._failure_analysis.overlap_meshes) {
      if (!overlap_mesh.userData.is_over_limit) {
        overlap_mesh.userData.is_shown = is_visible;
      }
    }
  }

  _buildFailureOverlapMeshes(pose_entry) {
    return pose_entry.overlaps.map((overlap_entry) => {
      const geometry = createSolidGeometry(overlap_entry.mesh);
      const is_over_limit = overlap_entry.is_over_limit;
      const material = new THREE.MeshStandardMaterial({
        color: is_over_limit ? CULPRIT_OVERLAP_COLOR : CONTACT_OVERLAP_COLOR,
        emissive: is_over_limit ? CULPRIT_OVERLAP_COLOR : 0x000000,
        emissiveIntensity: 0.0,
        metalness: 0.0,
        roughness: 0.4,
        // 겹침은 정의상 두 부품 내부라 그냥 그리면 부품 껍데기에 가려 한 픽셀도
        // 나오지 않는다. 게다가 A∩B 의 표면은 A·B 의 표면 조각으로 이루어져 있어
        // 부품 삼각형과 같은 평면에 놓이므로 z-fighting 이 반드시 난다.
        // 깊이 검사를 끄고 마지막에 그려 두 문제를 함께 없앤다.
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.95,
      });
      const overlap_mesh = new THREE.Mesh(geometry, material);
      overlap_mesh.renderOrder = 999;
      // 정점이 이미 월드 좌표다. state 변환을 곱하면 안 된다.
      overlap_mesh.position.set(0, 0, 0);
      overlap_mesh.rotation.set(0, 0, 0);
      overlap_mesh.visible = false;
      overlap_mesh.userData.is_over_limit = is_over_limit;
      overlap_mesh.userData.is_shown = is_over_limit;
      addOverlapOutline(overlap_mesh, material.color.getHex(), this._getViewportSize());
      this._scene.add(overlap_mesh);
      return overlap_mesh;
    });
  }

  _clearFailureOverlapMeshes() {
    for (const overlap_mesh of this._failure_analysis.overlap_meshes) {
      this._scene.remove(overlap_mesh);
      overlap_mesh.geometry.dispose();
      overlap_mesh.material.dispose();
      for (const outline_line of overlap_mesh.children) {
        outline_line.geometry.dispose();
        outline_line.material.dispose();
      }
    }
    this._failure_analysis.overlap_meshes = [];
  }

  _fitCameraToFailure(failure_analysis) {
    const solid_mesh = this._solid_meshes[failure_analysis.solid_index];
    const bounding_box = new THREE.Box3().setFromObject(solid_mesh);
    for (const overlap_mesh of failure_analysis.overlap_meshes) {
      bounding_box.union(new THREE.Box3().setFromObject(overlap_mesh));
    }
    if (bounding_box.isEmpty()) {
      return;
    }
    this._fitCameraToBoundingBox([
      bounding_box.min.x, bounding_box.min.y, bounding_box.min.z,
      bounding_box.max.x, bounding_box.max.y, bounding_box.max.z,
    ]);
  }

  /**
   * 실패 분석 재생을 한 프레임 진행한다.
   *
   * 네 구간을 순환한다.
   *   path    closest_path 를 따라 마지막 정상 자세까지 간다(스텝이 0 이면 건너뛴다)
   *   valid   마지막 정상 자세에서 멈춘다 — "여기까지는 정상" 을 읽을 시간
   *   push    막힌 자세까지 민다
   *   blocked 상한을 넘긴 겹침을 붉게 맥동시킨다
   * first_blocked_pose 가 null 이면(막은 증거를 찾지 못한 경우) push·blocked 를 건너뛴다.
   */
  _updateFailureAnimation(delta_seconds) {
    if (this._failure_analysis === null) {
      return;
    }
    const failure_analysis = this._failure_analysis;
    failure_analysis.phase_elapsed_seconds += delta_seconds;

    const phase_duration = this._getFailurePhaseDuration(failure_analysis);
    if (failure_analysis.phase_elapsed_seconds >= phase_duration) {
      failure_analysis.phase_elapsed_seconds -= phase_duration;
      failure_analysis.phase_name = this._getNextFailurePhase(failure_analysis);
    }
    this._applyFailurePhase(failure_analysis.phase_elapsed_seconds);
  }

  _getFailurePhaseDuration(failure_analysis) {
    switch (failure_analysis.phase_name) {
      case "path":
        // 스텝 수와 무관하게 총 시간을 고정한다. 스텝당 고정 시간을 주면 7 스텝짜리는
        // 늘어지고 1 스텝짜리는 눈에 안 들어온다.
        return failure_analysis.path_frames.length === 0 ? 0 : FAILURE_PATH_TOTAL_SECONDS;
      case "valid":
        return FAILURE_HOLD_VALID_SECONDS;
      case "push":
        return FAILURE_PUSH_SECONDS;
      default:
        return FAILURE_BLOCKED_SECONDS;
    }
  }

  _getNextFailurePhase(failure_analysis) {
    const has_blocked_pose = failure_analysis.blocked_state !== null;
    switch (failure_analysis.phase_name) {
      case "path":
        return "valid";
      case "valid":
        return has_blocked_pose ? "push" : "path";
      case "push":
        return "blocked";
      default:
        return "path";
    }
  }

  _applyFailurePhase(phase_elapsed_seconds) {
    const failure_analysis = this._failure_analysis;
    const solid_mesh = this._solid_meshes[failure_analysis.solid_index];
    const phase_duration = this._getFailurePhaseDuration(failure_analysis);
    const phase_alpha = phase_duration <= 0
      ? 1
      : Math.min(1, phase_elapsed_seconds / phase_duration);

    let is_blocked_phase = false;
    if (failure_analysis.phase_name === "path") {
      applyStateToObject(
        solid_mesh,
        this._getFailurePathState(failure_analysis, phase_alpha),
      );
    } else if (failure_analysis.phase_name === "valid") {
      applyStateToObject(solid_mesh, failure_analysis.valid_state);
    } else if (failure_analysis.phase_name === "push") {
      applyStateToObject(
        solid_mesh,
        interpolateState(
          failure_analysis.valid_state,
          failure_analysis.blocked_state,
          getEasedAlpha(phase_alpha),
        ),
      );
    } else {
      applyStateToObject(solid_mesh, failure_analysis.blocked_state);
      is_blocked_phase = true;
    }

    // 겹침은 막힌 자세의 것이므로 그 자세에 도달한 뒤에만 보여준다. 그 전에 띄우면
    // 부품이 아직 없는 자리에 덩어리만 떠 있게 된다.
    const pulse_alpha = is_blocked_phase
      ? 0.35 + 0.65 * (0.5 - 0.5 * Math.cos(
          2 * Math.PI * FAILURE_PULSE_FREQUENCY_HZ * phase_elapsed_seconds))
      : 0;
    for (const overlap_mesh of failure_analysis.overlap_meshes) {
      overlap_mesh.visible = is_blocked_phase && overlap_mesh.userData.is_shown;
      if (overlap_mesh.userData.is_over_limit) {
        overlap_mesh.material.emissiveIntensity = pulse_alpha;
      }
    }
  }

  _getFailurePathState(failure_analysis, phase_alpha) {
    const path_frames = failure_analysis.path_frames;
    if (path_frames.length === 0) {
      return failure_analysis.valid_state;
    }
    const scaled_position = phase_alpha * path_frames.length;
    const frame_index = Math.min(path_frames.length - 1, Math.floor(scaled_position));
    const start_state = frame_index === 0
      ? failure_analysis.initial_state
      : path_frames[frame_index - 1].state;
    return interpolateState(
      start_state,
      path_frames[frame_index].state,
      getEasedAlpha(scaled_position - frame_index),
    );
  }

  _clearSolids() {
    for (const solid_mesh of this._solid_meshes) {
      this._scene.remove(solid_mesh);
      solid_mesh.geometry.dispose();
      solid_mesh.material.dispose();
    }
    this._solid_meshes = [];
    this._initial_states = [];
    this._trajectory_frames = [];
    this._all_trajectory_frames = [];
    this._frame_start_times = [];
    this._frame_end_times = [];
    this._active_transition = null;
  }

  _notifyFrameChange() {
    if (typeof this._on_frame_change === "function") {
      this._on_frame_change(this.getFrameState());
    }
  }

  _onWindowResize() {
    const viewport_width = this._viewport_element.clientWidth || window.innerWidth;
    const viewport_height = this._viewport_element.clientHeight || window.innerHeight;
    this._camera.aspect = viewport_width / viewport_height;
    this._camera.updateProjectionMatrix();
    this._renderer.setSize(viewport_width, viewport_height);
    // 굵은 선은 화면 크기로 픽셀 굵기를 계산하므로 창 크기가 바뀌면 같이 맞춘다.
    for (const overlap_mesh of this._failure_analysis?.overlap_meshes ?? []) {
      for (const outline_line of overlap_mesh.children) {
        outline_line.material.resolution.copy(this._getViewportSize());
      }
    }
  }

  _getViewportSize() {
    return this._renderer.getSize(new THREE.Vector2());
  }
}

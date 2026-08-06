/**
 * solids / trajectories를 Three.js mesh로 렌더링하고 궤적 애니메이션을 재생한다.
 *
 * 회전 규약: 팀 State와 동일하게 scipy 'xyz' extrinsic(degrees).
 * Three.js에서는 extrinsic XYZ ≡ intrinsic ZYX 로 매핑한다.
 *
 * playback_time_seconds: 연속 재생 시각.
 *   0 = 초기 분해 자세,
 *   k * frame_duration = trajectories[0..k-1] 적용 완료,
 *   그 사이는 현재 프레임을 보간한다.
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

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
  geometry.computeVertexNormals();
  return geometry;
}

function applyStateToObject(object3d, state) {
  const [position_x, position_y, position_z] = state.position;
  const [rotation_x_degrees, rotation_y_degrees, rotation_z_degrees] = state.rotation;

  object3d.position.set(position_x, position_y, position_z);
  object3d.rotation.set(
    THREE.MathUtils.degToRad(rotation_x_degrees),
    THREE.MathUtils.degToRad(rotation_y_degrees),
    THREE.MathUtils.degToRad(rotation_z_degrees),
    "ZYX",
  );
}

function getStateFromObject(object3d) {
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

function interpolateState(start_state, end_state, alpha) {
  const eased_alpha = getEasedAlpha(alpha);
  return {
    position: [
      start_state.position[0]
        + (end_state.position[0] - start_state.position[0]) * eased_alpha,
      start_state.position[1]
        + (end_state.position[1] - start_state.position[1]) * eased_alpha,
      start_state.position[2]
        + (end_state.position[2] - start_state.position[2]) * eased_alpha,
    ],
    rotation: [
      start_state.rotation[0]
        + (end_state.rotation[0] - start_state.rotation[0]) * eased_alpha,
      start_state.rotation[1]
        + (end_state.rotation[1] - start_state.rotation[1]) * eased_alpha,
      start_state.rotation[2]
        + (end_state.rotation[2] - start_state.rotation[2]) * eased_alpha,
    ],
  };
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
  constructor(viewport_element, frame_duration_seconds) {
    if (!(viewport_element instanceof HTMLElement)) {
      throw new AssemblyRenderException("viewport_element must be an HTMLElement");
    }
    if (frame_duration_seconds <= 0) {
      throw new AssemblyRenderException(
        `frame_duration_seconds must be positive, received ${frame_duration_seconds}`,
      );
    }

    this._viewport_element = viewport_element;
    this._frame_duration_seconds = frame_duration_seconds;
    this._solid_meshes = [];
    this._initial_states = [];
    this._trajectory_frames = [];
    this._all_trajectory_frames = [];
    this._global_bbox = null;
    this._playback_position = 0;
    this._elapsed_seconds = 0;
    this._playback_range_end_seconds = null;
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

    this._renderer.setAnimationLoop(() => {
      this._updateAnimation(this._clock.getDelta());
      this._orbit_controls.update();
      this._renderer.render(this._scene, this._camera);
    });
  }

  setOnFrameChange(callback) {
    this._on_frame_change = callback;
  }

  loadAssembly(assembly_result) {
    this._clearSolids();
    this.pause();

    const { metadata, solids, trajectories } = assembly_result;
    this._all_trajectory_frames = trajectories;
    this._trajectory_frames = trajectories;
    this._global_bbox = metadata.global_bbox;
    this._playback_position = 0;
    this._elapsed_seconds = 0;
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
    this.pause();
    this._clearPlaybackRange();
    this._clearSolids();
    this._global_bbox = null;
    this._playback_position = 0;
    this._elapsed_seconds = 0;
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

  getPlaybackTimeSeconds() {
    return (
      this._playback_position * this._frame_duration_seconds + this._elapsed_seconds
    );
  }

  getTotalDurationSeconds() {
    return this._trajectory_frames.length * this._frame_duration_seconds;
  }

  getFrameDurationSeconds() {
    return this._frame_duration_seconds;
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
    this._clearPlaybackRange();
    this._restoreFullTrajectoryPlaylist();
    if (this._trajectory_frames.length === 0) {
      return;
    }
    if (this.getPlaybackTimeSeconds() >= this.getTotalDurationSeconds()) {
      this.seekToTime(0);
    }
    this._is_playing = true;
    this._clock.start();
    this._notifyFrameChange();
  }

  playSolid(solid_index) {
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

    const range_start_seconds =
      solid_frame_indexes[0] * this._frame_duration_seconds;
    const range_end_seconds =
      (solid_frame_indexes[solid_frame_indexes.length - 1] + 1)
      * this._frame_duration_seconds;

    this.pause();
    this._playback_range_end_seconds = range_end_seconds;
    this.seekToTime(range_start_seconds);
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
    this.pause();
    this._clearPlaybackRange();
    this._restoreFullTrajectoryPlaylist();
    this.seekToTime(0);
  }

  seekToTime(playback_time_seconds) {
    if (!Number.isFinite(playback_time_seconds)) {
      throw new AssemblyRenderException(
        `playback_time_seconds must be a finite number, received ${playback_time_seconds}`,
      );
    }

    this._restoreFullTrajectoryPlaylist();
    const total_duration_seconds = this.getTotalDurationSeconds();
    const clamped_time = Math.max(
      0,
      Math.min(playback_time_seconds, total_duration_seconds),
    );

    this._restoreInitialStates();
    this._active_transition = null;

    if (total_duration_seconds === 0 || clamped_time <= 0) {
      this._playback_position = 0;
      this._elapsed_seconds = 0;
      this._notifyFrameChange();
      return;
    }

    if (clamped_time >= total_duration_seconds) {
      for (const trajectory_frame of this._trajectory_frames) {
        this._applyTrajectoryFrame(trajectory_frame);
      }
      this._playback_position = this._trajectory_frames.length;
      this._elapsed_seconds = 0;
      this._notifyFrameChange();
      return;
    }

    const completed_frame_count = Math.floor(
      clamped_time / this._frame_duration_seconds,
    );
    for (let frame_index = 0; frame_index < completed_frame_count; frame_index += 1) {
      this._applyTrajectoryFrame(this._trajectory_frames[frame_index]);
    }

    this._playback_position = completed_frame_count;
    this._elapsed_seconds = clamped_time - completed_frame_count * this._frame_duration_seconds;
    this._beginTransitionToCurrentFrame();
    this._applyInterpolatedTransition(
      this._elapsed_seconds / this._frame_duration_seconds,
    );
    this._notifyFrameChange();
  }

  _restoreFullTrajectoryPlaylist() {
    this._trajectory_frames = this._all_trajectory_frames;
  }

  _clearPlaybackRange() {
    this._playback_range_end_seconds = null;
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

    this._elapsed_seconds += delta_seconds;

    while (this._is_playing && this._playback_position < this._trajectory_frames.length) {
      if (
        this._playback_range_end_seconds !== null
        && this.getPlaybackTimeSeconds() >= this._playback_range_end_seconds
      ) {
        this.seekToTime(this._playback_range_end_seconds);
        this._clearPlaybackRange();
        this.pause();
        break;
      }

      if (this._active_transition === null) {
        this._beginTransitionToCurrentFrame();
      }

      const transition_alpha = Math.min(
        1,
        this._elapsed_seconds / this._frame_duration_seconds,
      );
      this._applyInterpolatedTransition(transition_alpha);

      if (this._elapsed_seconds < this._frame_duration_seconds) {
        this._notifyFrameChange();
        break;
      }

      this._applyTrajectoryFrame(this._trajectory_frames[this._playback_position]);
      this._playback_position += 1;
      this._elapsed_seconds -= this._frame_duration_seconds;
      this._active_transition = null;

      if (
        this._playback_range_end_seconds !== null
        && this.getPlaybackTimeSeconds() >= this._playback_range_end_seconds
      ) {
        this._clearPlaybackRange();
        this.pause();
        break;
      }

      if (this._playback_position >= this._trajectory_frames.length) {
        this._elapsed_seconds = 0;
        this._clearPlaybackRange();
        this.pause();
        break;
      }
    }
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
    this._active_transition = null;
  }

  _notifyFrameChange() {
    if (typeof this._on_frame_change === "function") {
      this._on_frame_change({
        playback_position: this._playback_position,
        playback_time_seconds: this.getPlaybackTimeSeconds(),
        total_duration_seconds: this.getTotalDurationSeconds(),
        frame_count: this._trajectory_frames.length,
        is_playing: this._is_playing,
        frame_duration_seconds: this._frame_duration_seconds,
      });
    }
  }

  _onWindowResize() {
    const viewport_width = this._viewport_element.clientWidth || window.innerWidth;
    const viewport_height = this._viewport_element.clientHeight || window.innerHeight;
    this._camera.aspect = viewport_width / viewport_height;
    this._camera.updateProjectionMatrix();
    this._renderer.setSize(viewport_width, viewport_height);
  }
}

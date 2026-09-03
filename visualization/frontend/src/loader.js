/**
 * 팀 msgpack 조립 결과를 브라우저에서 디코딩한다.
 * 디코딩은 JS(@msgpack/msgpack)에서만 수행한다.
 */

import { decode } from "@msgpack/msgpack";

export class ResultLoadException extends Error {
  constructor(message) {
    super(message);
    this.name = "ResultLoadException";
  }
}

function checkIsPlainObject(value, field_name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ResultLoadException(
      `${field_name} must be an object, received ${Object.prototype.toString.call(value)}`,
    );
  }
}

function checkIsArray(value, field_name) {
  if (!Array.isArray(value)) {
    throw new ResultLoadException(
      `${field_name} must be an array, received ${Object.prototype.toString.call(value)}`,
    );
  }
}

function getValidatedMetadata(metadata_entry) {
  checkIsPlainObject(metadata_entry, "metadata");

  const { step_path, global_bbox } = metadata_entry;
  if (typeof step_path !== "string") {
    throw new ResultLoadException("metadata.step_path must be a string");
  }
  checkIsArray(global_bbox, "metadata.global_bbox");
  if (global_bbox.length !== 6) {
    throw new ResultLoadException("metadata.global_bbox must contain exactly 6 values");
  }

  return {
    step_path,
    global_bbox: global_bbox.map(Number),
  };
}

function getValidatedState(state_entry, field_name) {
  checkIsPlainObject(state_entry, field_name);

  const { position, rotation } = state_entry;
  checkIsArray(position, `${field_name}.position`);
  checkIsArray(rotation, `${field_name}.rotation`);
  if (position.length !== 3) {
    throw new ResultLoadException(`${field_name}.position must contain 3 values`);
  }
  if (rotation.length !== 3) {
    throw new ResultLoadException(`${field_name}.rotation must contain 3 values`);
  }

  return {
    position: position.map(Number),
    rotation: rotation.map(Number),
  };
}

function getValidatedPartIndex(part_index_entry, solid_index) {
  if (part_index_entry === undefined) {
    return solid_index;
  }
  if (!Number.isInteger(part_index_entry) || part_index_entry < 0) {
    throw new ResultLoadException(
      `solids[${solid_index}].part_index must be a non-negative integer`,
    );
  }
  return part_index_entry;
}

function getValidatedSolidName(name_entry, solid_index) {
  if (name_entry === undefined) {
    return undefined;
  }
  if (typeof name_entry !== "string" || name_entry.trim() === "") {
    throw new ResultLoadException(
      `solids[${solid_index}].name must be a non-empty string`,
    );
  }
  return name_entry;
}

function getValidatedSolidConversion(conversion_entry, solid_index) {
  if (conversion_entry === undefined) {
    return undefined;
  }
  if (typeof conversion_entry !== "string" || conversion_entry.trim() === "") {
    throw new ResultLoadException(
      `solids[${solid_index}].conversion must be a non-empty string`,
    );
  }
  return conversion_entry;
}

function getValidatedSolid(solid_entry, solid_index) {
  checkIsPlainObject(solid_entry, `solids[${solid_index}]`);

  const {
    mesh,
    state,
    part_index: part_index_entry,
    name: name_entry,
    conversion: conversion_entry,
  } = solid_entry;
  checkIsPlainObject(mesh, `solids[${solid_index}].mesh`);
  checkIsArray(mesh.vertices, `solids[${solid_index}].mesh.vertices`);
  checkIsArray(mesh.faces, `solids[${solid_index}].mesh.faces`);

  const validated_solid = {
    mesh: {
      vertices: mesh.vertices,
      faces: mesh.faces,
    },
    state: getValidatedState(state, `solids[${solid_index}].state`),
    part_index: getValidatedPartIndex(part_index_entry, solid_index),
  };
  const solid_name = getValidatedSolidName(name_entry, solid_index);
  if (solid_name !== undefined) {
    validated_solid.name = solid_name;
  }
  const solid_conversion = getValidatedSolidConversion(conversion_entry, solid_index);
  if (solid_conversion !== undefined) {
    validated_solid.conversion = solid_conversion;
  }
  return validated_solid;
}

function getValidatedTrajectoryFrame(trajectory_frame_entry, frame_index) {
  checkIsPlainObject(trajectory_frame_entry, `trajectories[${frame_index}]`);

  const {
    solid: solid_index,
    state,
    action,
  } = trajectory_frame_entry;

  if (!Number.isInteger(solid_index)) {
    throw new ResultLoadException(
      `trajectories[${frame_index}].solid must be an integer`,
    );
  }

  checkIsPlainObject(action, `trajectories[${frame_index}].action`);
  if (action.type !== "translation" && action.type !== "rotation") {
    throw new ResultLoadException(
      `trajectories[${frame_index}].action.type must be translation or rotation`,
    );
  }
  checkIsArray(action.value, `trajectories[${frame_index}].action.value`);
  if (action.value.length !== 3) {
    throw new ResultLoadException(
      `trajectories[${frame_index}].action.value must contain 3 values`,
    );
  }

  return {
    solid: solid_index,
    state: getValidatedState(state, `trajectories[${frame_index}].state`),
    action: {
      type: action.type,
      value: action.value.map(Number),
    },
  };
}

function getValidatedPayload(payload) {
  checkIsPlainObject(payload, "payload");

  const { metadata, solids, trajectories } = payload;
  checkIsArray(solids, "solids");
  checkIsArray(trajectories, "trajectories");

  return {
    metadata: getValidatedMetadata(metadata),
    solids: solids.map(getValidatedSolid),
    trajectories: trajectories.map(getValidatedTrajectoryFrame),
  };
}

export function decodeAssemblyResult(payload_bytes) {
  let payload;
  try {
    payload = decode(payload_bytes);
  } catch (error) {
    throw new ResultLoadException(
      `payload is not valid msgpack data: ${error.message}`,
    );
  }

  return getValidatedPayload(payload);
}

export async function loadAssemblyResultFromFile(file) {
  if (!(file instanceof Blob)) {
    throw new ResultLoadException("selected input must be a file");
  }

  let payload_bytes;
  try {
    payload_bytes = await file.arrayBuffer();
  } catch (error) {
    throw new ResultLoadException(
      `failed to read msgpack file: ${error.message}`,
    );
  }

  return decodeAssemblyResult(payload_bytes);
}

export async function loadAssemblyResultFromUrl(result_url) {
  let response;
  try {
    response = await fetch(result_url);
  } catch (error) {
    throw new ResultLoadException(
      `failed to fetch assembly result from ${result_url}: ${error.message}`,
    );
  }

  if (!response.ok) {
    throw new ResultLoadException(
      `assembly result request failed with status ${response.status}`,
    );
  }

  const payload_bytes = await response.arrayBuffer();
  return decodeAssemblyResult(payload_bytes);
}

export async function loadStepFile(step_file, load_url) {
  if (!(step_file instanceof Blob)) {
    throw new ResultLoadException("selected input must be a STEP file");
  }

  const form_data = new FormData();
  form_data.append("step_file", step_file, step_file.name || "upload.step");

  let response;
  try {
    response = await fetch(load_url, {
      method: "POST",
      body: form_data,
    });
  } catch (error) {
    throw new ResultLoadException(
      `failed to load STEP file: ${error.message}`,
    );
  }

  if (!response.ok) {
    let detail_message = `STEP loading failed with status ${response.status}`;
    try {
      const error_payload = await response.json();
      if (typeof error_payload.detail === "string") {
        detail_message = error_payload.detail;
      }
    } catch (_error) {
      // keep status message when response body is not JSON
    }
    throw new ResultLoadException(detail_message);
  }

  const payload_bytes = await response.arrayBuffer();
  return decodeAssemblyResult(payload_bytes);
}

export async function assembleStepFile(step_filename, assemble_url) {
  if (typeof step_filename !== "string" || step_filename.trim() === "") {
    throw new ResultLoadException("step_filename must be a non-empty string");
  }

  const form_data = new FormData();
  form_data.append("step_filename", step_filename);

  let response;
  try {
    response = await fetch(assemble_url, {
      method: "POST",
      body: form_data,
    });
  } catch (error) {
    throw new ResultLoadException(
      `failed to assemble STEP file: ${error.message}`,
    );
  }

  if (!response.ok) {
    let detail_message = `STEP assembly failed with status ${response.status}`;
    try {
      const error_payload = await response.json();
      if (typeof error_payload.detail === "string") {
        detail_message = error_payload.detail;
      }
    } catch (_error) {
      // keep status message when response body is not JSON
    }
    throw new ResultLoadException(detail_message);
  }

  const payload_bytes = await response.arrayBuffer();
  return decodeAssemblyResult(payload_bytes);
}

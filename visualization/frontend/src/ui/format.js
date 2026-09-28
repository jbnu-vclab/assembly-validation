/** 화면에 보여줄 값을 만드는 포맷 함수. 계산만 하고 화면(DOM)은 건드리지 않는다. */

export function formatPlaybackSpeedLabel(speed_multiplier) {
  return `${speed_multiplier}x`;
}

export function formatClockTime(total_seconds) {
  const safe_seconds = Math.max(0, total_seconds);
  const minutes = Math.floor(safe_seconds / 60);
  const seconds = safe_seconds % 60;
  return `${minutes}:${seconds.toFixed(2).padStart(5, "0")}`;
}

export function formatPartLabel(solid_entry, solid_index) {
  const part_name = solid_entry?.name;
  if (typeof part_name === "string" && part_name.trim() !== "") {
    return part_name;
  }
  const part_index = getSolidPartIndex(solid_entry, solid_index);
  return `part_${String(part_index).padStart(2, "0")}`;
}

export function getConversionDisplay(conversion_entry) {
  if (typeof conversion_entry !== "string" || conversion_entry.trim() === "") {
    return {
      text: "—",
      class_name: "part-conversion is-missing",
    };
  }
  if (conversion_entry === "성공") {
    return {
      text: conversion_entry,
      class_name: "part-conversion is-success",
    };
  }
  return {
    text: conversion_entry,
    class_name: "part-conversion is-failure",
  };
}

export function getSolidPartIndex(solid_entry, solid_index) {
  if (Number.isInteger(solid_entry?.part_index)) {
    return solid_entry.part_index;
  }
  return solid_index;
}

/** 모드와 대시보드가 같이 쓰는 DOM 도구. 다른 프로젝트 파일에 의존하지 않는다. */

export function getRequiredElement(element_id) {
  const element = document.getElementById(element_id);
  if (element === null) {
    throw new Error(`element #${element_id} was not found`);
  }
  return element;
}

export function checkFileSuffix(file, allowed_suffixes, error_message) {
  const lowered_name = file.name.toLowerCase();
  const has_allowed_suffix = allowed_suffixes.some((suffix) =>
    lowered_name.endsWith(suffix),
  );
  if (!has_allowed_suffix) {
    throw new Error(`${error_message}: ${file.name}`);
  }
}

/** 버튼 → 숨은 file input → onFile. 같은 파일을 다시 골라도 change 가 뜨도록 비운다. */
export function bindFilePicker(open_button, file_input, onFile, onError) {
  open_button.addEventListener("click", () => {
    file_input.click();
  });
  file_input.addEventListener("change", async () => {
    const selected_files = file_input.files;
    if (selected_files === null || selected_files.length === 0) {
      return;
    }
    try {
      await onFile(selected_files[0]);
    } catch (error) {
      onError(error);
    } finally {
      file_input.value = "";
    }
  });
}

# 상태를 바꾸는 단위 동작(Action)을 정의한다: 평행이동 또는 90도 단위 회전.
from dataclasses import dataclass
from enum import Enum
from typing import Tuple

import numpy as np
from scipy.spatial.transform import Rotation


# 동작 종류
class ActionType(Enum):
    TRANSLATION = "translation"
    ROTATION = "rotation"


# 동작 값이 잘못되었을 때 발생시키는 예외
class InvalidActionException(Exception):
    pass


# 불변 동작. value는 평행이동이면 이동량 (dx, dy, dz),
# 회전이면 XYZ intrinsic 오일러 각 (도, 90의 배수)이다.
@dataclass(frozen=True)
class Action:
    action_type: ActionType
    value: Tuple[float, float, float] | Tuple[int, int, int]
    # 값을 검사하고 정규화한다: 평행이동은 float, 회전은 90의 배수인 int.
    def __post_init__(self) -> None:
        if not isinstance(self.action_type, ActionType):
            raise InvalidActionException(
                f"action_type must be an ActionType, received {type(self.action_type)}"
            )
        if len(self.value) != 3:
            raise InvalidActionException(
                f"value must contain exactly 3 components, received {len(self.value)}"
            )

        if self.action_type is ActionType.TRANSLATION:
            try:
                normalized_value = tuple(float(component) for component in self.value)
            except (TypeError, ValueError) as error:
                raise InvalidActionException(
                    f"translation value must be numeric, received {self.value!r}"
                ) from error
        else:
            try:
                normalized_value = tuple(int(component) for component in self.value)
            except (TypeError, ValueError) as error:
                raise InvalidActionException(
                    f"rotation value must be integer angles, received {self.value!r}"
                ) from error
            for angle in normalized_value:
                if angle % 90 != 0:
                    raise InvalidActionException(
                        f"rotation component {angle} must be a multiple of 90 degrees"
                    )

        object.__setattr__(self, "value", normalized_value)

    # 평행이동 동작인지 여부
    def is_translation(self) -> bool:
        return self.action_type is ActionType.TRANSLATION

    # 회전 동작인지 여부
    def is_rotation(self) -> bool:
        return self.action_type is ActionType.ROTATION

    # 원점 기준 4x4 변환 행렬: 평행이동은 이동 성분만, 회전은 회전 성분만 채운다.
    def _to_origin_transformation_matrix(self) -> np.ndarray:
        transformation_matrix = np.eye(4)
        if self.is_translation():
            transformation_matrix[:3, 3] = self.value
        else:
            rotation_matrix = np.rint(
                Rotation.from_euler("XYZ", self.value, degrees=True).as_matrix()
            )
            rotation_matrix[rotation_matrix == 0.0] = 0.0
            transformation_matrix[:3, :3] = rotation_matrix
        return transformation_matrix

    # center를 중심으로 하는 4x4 변환 행렬.
    # 회전은 T(center)·R·T(-center)이고, 평행이동은 중심과 무관하므로 원점 기준 행렬 그대로다.
    def to_transformation_matrix_about(
        self, center: Tuple[float, float, float]
    ) -> np.ndarray:
        if len(center) != 3:
            raise InvalidActionException(
                f"center must contain exactly 3 coordinates, received {len(center)}"
            )
        try:
            normalized_center = tuple(float(coordinate) for coordinate in center)
        except (TypeError, ValueError) as error:
            raise InvalidActionException(
                f"center must contain numeric coordinates, received {center!r}"
            ) from error

        transformation_matrix = self._to_origin_transformation_matrix()
        if self.is_translation():
            return transformation_matrix

        # 중심을 원점으로 옮겨 회전한 뒤 다시 제자리로 돌려놓는다.
        translation_to_center = np.eye(4)
        translation_to_center[:3, 3] = normalized_center
        translation_from_center = np.eye(4)
        translation_from_center[:3, 3] = np.negative(normalized_center)

        return translation_to_center @ transformation_matrix @ translation_from_center

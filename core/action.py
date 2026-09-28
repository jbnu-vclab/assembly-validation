from dataclasses import dataclass
from enum import Enum
from typing import Tuple

import numpy as np
from scipy.spatial.transform import Rotation


class ActionType(Enum):
    TRANSLATION = "translation"
    ROTATION = "rotation"


class InvalidActionException(Exception):
    pass


@dataclass(frozen=True)
class Action:
    action_type: ActionType
    value: Tuple[float, float, float] | Tuple[int, int, int]
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

    def is_translation(self) -> bool:
        return self.action_type is ActionType.TRANSLATION

    def is_rotation(self) -> bool:
        return self.action_type is ActionType.ROTATION

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

        translation_to_center = np.eye(4)
        translation_to_center[:3, 3] = normalized_center
        translation_from_center = np.eye(4)
        translation_from_center[:3, 3] = np.negative(normalized_center)

        return translation_to_center @ transformation_matrix @ translation_from_center

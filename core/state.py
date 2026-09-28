from dataclasses import dataclass
from typing import Tuple

import numpy as np
from scipy.spatial.transform import Rotation


ALLOWED_ROTATION_ANGLES = frozenset({0, 90, 180, 270})


class InvalidStateException(Exception):
    pass


@dataclass(frozen=True)
class State:
    position: Tuple[float, float, float]
    rotation: Tuple[int, int, int]

    def __post_init__(self) -> None:
        if len(self.position) != 3:
            raise InvalidStateException(
                f"position must contain exactly 3 coordinates, received {len(self.position)}"
            )
        if len(self.rotation) != 3:
            raise InvalidStateException(
                f"rotation must contain exactly 3 angles, received {len(self.rotation)}"
            )

        try:
            normalized_position = tuple(float(coordinate) for coordinate in self.position)
        except (TypeError, ValueError) as error:
            raise InvalidStateException(
                f"position must contain numeric coordinates, received {self.position!r}"
            ) from error
        try:
            normalized_rotation = tuple(int(angle) for angle in self.rotation)
        except (TypeError, ValueError) as error:
            raise InvalidStateException(
                f"rotation must contain integer angles, received {self.rotation!r}"
            ) from error

        for angle in normalized_rotation:
            if angle not in ALLOWED_ROTATION_ANGLES:
                raise InvalidStateException(
                    f"rotation angle {angle} is not one of {sorted(ALLOWED_ROTATION_ANGLES)}"
                )

        object.__setattr__(self, "position", normalized_position)
        object.__setattr__(self, "rotation", normalized_rotation)

    def to_rotation_matrix(self) -> np.ndarray:
        rotation_matrix = np.rint(
            Rotation.from_euler("XYZ", self.rotation, degrees=True).as_matrix()
        )
        rotation_matrix[rotation_matrix == 0.0] = 0.0
        return rotation_matrix

    def to_transformation_matrix(self) -> np.ndarray:
        transformation_matrix = np.eye(4)
        transformation_matrix[:3, :3] = self.to_rotation_matrix()
        transformation_matrix[:3, 3] = self.position
        return transformation_matrix

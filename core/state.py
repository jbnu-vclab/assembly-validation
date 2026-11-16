# 부품 하나의 상태(State)를 정의한다.
# 위치는 연속값, 회전은 축마다 0/90/180/270도인 이산값(XYZ intrinsic 오일러 각)이다.
from dataclasses import dataclass
from typing import Tuple

import numpy as np
from scipy.spatial.transform import Rotation


# 축마다 허용하는 회전 각도(도)
ALLOWED_ROTATION_ANGLES = frozenset({0, 90, 180, 270})


# 상태 값이 잘못되었을 때 발생시키는 예외
class InvalidStateException(Exception):
    pass


# 불변 상태. 로컬 정점 v의 월드 좌표는 R·v + position이다(R은 rotation의 회전 행렬).
# position: 평행이동량 (x, y, z), rotation: XYZ intrinsic 오일러 각 (도)
@dataclass(frozen=True)
class State:
    position: Tuple[float, float, float]
    rotation: Tuple[int, int, int]

    # 길이·숫자 여부·허용 각도를 검사하고, 위치는 float, 회전은 int 튜플로 정규화한다.
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

        # frozen이라 일반 대입이 막혀 있으므로 object.__setattr__로 정규화한 값을 넣는다.
        object.__setattr__(self, "position", normalized_position)
        object.__setattr__(self, "rotation", normalized_rotation)

    # 3x3 회전 행렬. 90도 단위라 성분이 -1/0/1이 되도록 반올림한다.
    def to_rotation_matrix(self) -> np.ndarray:
        rotation_matrix = np.rint(
            Rotation.from_euler("XYZ", self.rotation, degrees=True).as_matrix()
        )
        # -0.0을 0.0으로 바꿔 행렬 비교와 키 생성에서 부호 차이를 없앤다.
        rotation_matrix[rotation_matrix == 0.0] = 0.0
        return rotation_matrix

    # 회전과 평행이동을 합친 4x4 동차 변환 행렬
    def to_transformation_matrix(self) -> np.ndarray:
        transformation_matrix = np.eye(4)
        transformation_matrix[:3, :3] = self.to_rotation_matrix()
        transformation_matrix[:3, 3] = self.position
        return transformation_matrix

"""조립 결과 및 부품 mesh를 시각화하는 모듈.

PyVista를 사용해 Trimesh 데이터와 State 변환을 3D 뷰어에 렌더링한다.
"""

from typing import Tuple

import numpy as np
import pyvista as pv
from trimesh import Trimesh

from core.state import State


class VisualizationException(Exception):
    """시각화 과정에서 입력 또는 렌더링이 실패했을 때 발생."""


class AssemblyVisualizer:
    """조립 부품 mesh와 상태를 PyVista Plotter에 표시하는 클래스."""

    def __init__(self, window_size: Tuple[int, int]) -> None:
        if len(window_size) != 2:
            raise VisualizationException(
                f"window_size must contain exactly 2 components, received {len(window_size)}"
            )
        width, height = window_size
        if width <= 0 or height <= 0:
            raise VisualizationException(
                f"window_size components must be positive, received {window_size}"
            )

        self._plotter = pv.Plotter(window_size=window_size)
        self._plotter.set_background("white")

    def add_solid(
        self,
        mesh: Trimesh,
        state: State,
        color: Tuple[float, float, float],
    ) -> None:
        """Trimesh 부품을 주어진 State 변환을 적용해 Plotter에 추가한다."""
        pyvista_mesh = self._to_pyvista_mesh(mesh)
        transformed_mesh = self._apply_state(pyvista_mesh, state)
        self._plotter.add_mesh(transformed_mesh, color=color, show_edges=True)

    def show(self) -> None:
        """Plotter 창을 연다."""
        self._plotter.show()

    def _to_pyvista_mesh(self, mesh: Trimesh) -> pv.PolyData:
        if mesh.vertices.size == 0 or mesh.faces.size == 0:
            raise VisualizationException("mesh must contain at least one vertex and one face")

        faces = np.hstack(
            [np.full((len(mesh.faces), 1), 3, dtype=np.int64), mesh.faces.astype(np.int64)]
        ).ravel()
        return pv.PolyData(mesh.vertices, faces)

    def _apply_state(self, mesh: pv.PolyData, state: State) -> pv.PolyData:
        transformed_mesh = mesh.copy(deep=True)
        transformed_mesh.transform(state.to_transformation_matrix(), inplace=True)
        return transformed_mesh

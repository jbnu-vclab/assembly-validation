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
        self._local_meshes: dict[int, pv.PolyData] = {}
        self._solid_actors: dict[int, pv.Actor] = {}

    def register_solid(
        self,
        solid_index: int,
        mesh: Trimesh,
        color: Tuple[float, float, float],
    ) -> None:
        """로컬 좌표 mesh를 solid index에 등록한다."""
        if solid_index in self._solid_actors:
            raise VisualizationException(
                f"solid index {solid_index} is already registered"
            )

        pyvista_mesh = self._to_pyvista_mesh(mesh)
        actor = self._plotter.add_mesh(
            pyvista_mesh,
            color=color,
            show_edges=False,
            smooth_shading=True,
            split_sharp_edges=True,
        )
        actor.user_matrix = np.eye(4)
        self._local_meshes[solid_index] = pyvista_mesh
        self._solid_actors[solid_index] = actor

    def update_solid_state(self, solid_index: int, state: State) -> None:
        """등록된 solid actor의 변환 행렬을 갱신한다."""
        if solid_index not in self._solid_actors:
            raise VisualizationException(
                f"solid index {solid_index} is not registered"
            )

        self._solid_actors[solid_index].user_matrix = state.to_transformation_matrix()

    def add_solid(
        self,
        mesh: Trimesh,
        state: State,
        color: Tuple[float, float, float],
    ) -> None:
        """Trimesh 부품을 등록하고 주어진 State 변환을 적용한다."""
        solid_index = len(self._solid_actors)
        self.register_solid(solid_index, mesh, color)
        self.update_solid_state(solid_index, state)

    def get_plotter(self) -> pv.Plotter:
        """내부 PyVista Plotter를 반환한다."""
        return self._plotter

    def render(self) -> None:
        """현재 장면을 한 프레임 렌더링한다."""
        self._plotter.render()

    def show(self) -> None:
        """Plotter 창을 연다."""
        self._plotter.show()

    def render_screenshot(self, output_path: str) -> None:
        """현재 장면을 이미지 파일로 저장한다."""
        self._plotter.show(screenshot=output_path, auto_close=False)

    def _to_pyvista_mesh(self, mesh: Trimesh) -> pv.PolyData:
        if mesh.vertices.size == 0 or mesh.faces.size == 0:
            raise VisualizationException("mesh must contain at least one vertex and one face")

        faces = np.hstack(
            [np.full((len(mesh.faces), 1), 3, dtype=np.int64), mesh.faces.astype(np.int64)]
        ).ravel()
        return pv.PolyData(mesh.vertices, faces)

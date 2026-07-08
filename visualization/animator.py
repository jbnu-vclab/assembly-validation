"""trajectory 프레임을 순차 재생하는 모듈."""

import time

from visualization.result_loader import TrajectoryFrame
from visualization.visualizer import AssemblyVisualizer, VisualizationException


class AnimationException(Exception):
    """trajectory 재생 과정에서 실패했을 때 발생."""


class TrajectoryAnimator:
    """TrajectoryFrame 목록을 순회하며 AssemblyVisualizer의 solid 상태를 갱신한다."""

    def __init__(
        self,
        visualizer: AssemblyVisualizer,
        trajectory_frames: list[TrajectoryFrame],
        frame_duration_seconds: float,
    ) -> None:
        if not isinstance(visualizer, AssemblyVisualizer):
            raise AnimationException(
                f"visualizer must be an AssemblyVisualizer, received {type(visualizer)}"
            )
        if frame_duration_seconds <= 0:
            raise AnimationException(
                f"frame_duration_seconds must be positive, received {frame_duration_seconds}"
            )

        self._visualizer = visualizer
        self._trajectory_frames = trajectory_frames
        self._frame_duration_seconds = frame_duration_seconds

    def play(self) -> None:
        """trajectory 프레임을 순차 재생한다."""
        plotter = self._visualizer.get_plotter()
        plotter.show(auto_close=False, interactive_update=True)

        for trajectory_frame in self._trajectory_frames:
            self._apply_trajectory_frame(trajectory_frame)
            plotter.render()
            if plotter.iren is not None:
                plotter.iren.process_events()
            time.sleep(self._frame_duration_seconds)

    def export_gif(self, output_path: str) -> None:
        """trajectory 프레임을 GIF 파일로 저장한다."""
        plotter = self._visualizer.get_plotter()
        plotter.open_gif(output_path)

        for trajectory_frame in self._trajectory_frames:
            self._apply_trajectory_frame(trajectory_frame)
            plotter.write_frame()

        plotter.close()

    def _apply_trajectory_frame(self, trajectory_frame: TrajectoryFrame) -> None:
        try:
            self._visualizer.update_solid_state(
                trajectory_frame.solid_index,
                trajectory_frame.state,
            )
        except VisualizationException as error:
            raise AnimationException(
                f"failed to apply trajectory frame for solid {trajectory_frame.solid_index}"
            ) from error

"""
조립 계산 작업. 계산을 별도 프로세스로 돌리고 진행 단계와 결과를 보관한다.

    create_job → (업로드 저장) → start_job → get_job 로 진행 조회 → take_result 로 결과 수령

한 번에 한 작업만 돈다. 새 작업을 만들면 진행 중이던 작업은 프로세스째 멈추고 버린다
(사용자가 STEP 을 다시 올리면 처음부터 다시 계산한다). 팀 파이프라인이 내부에서 자식
프로세스를 fork 하므로, 계산 프로세스를 새 세션으로 띄워 프로세스 그룹 전체를 종료한다.
작업은 서버 메모리에만 있어 서버를 다시 켜면 사라진다.
"""

import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from server.app.config import PROJECT_ROOT
from server.app.services import assembly_service

STAGE_QUEUED = "queued"
STAGE_DONE = "done"
STAGE_FAILED = "failed"

# 계산 프로세스는 visualization/ 에서 `-m server.app...` 로 띄운다.
_WORKER_CWD = PROJECT_ROOT / "visualization"
_WORKER_MODULE = "server.app.services.assembly_worker"


@dataclass
class AssemblyJob:
    job_id: str
    display_name: str
    working_directory: tempfile.TemporaryDirectory
    started_at: float = field(default_factory=time.monotonic)
    stage: str = STAGE_QUEUED
    error: str | None = None
    result: bytes | None = None
    process: subprocess.Popen | None = None
    is_cancelled: bool = False

    @property
    def directory(self) -> Path:
        return Path(self.working_directory.name)

    @property
    def is_running(self) -> bool:
        return self.stage not in (STAGE_DONE, STAGE_FAILED)


_jobs: dict[str, AssemblyJob] = {}
_lock = threading.Lock()


def _cancel(job: AssemblyJob) -> None:
    """계산 프로세스 그룹(팀 파이프라인이 fork 한 자식 포함)을 종료한다."""
    job.is_cancelled = True
    process = job.process
    if process is not None and process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def create_job(display_name: str) -> AssemblyJob:
    """새 작업 자리와 업로드 폴더를 만든다. 진행 중이던 작업은 멈추고 이전 작업은 모두 버린다."""
    with _lock:
        for previous_job in _jobs.values():
            _cancel(previous_job)
        _jobs.clear()
        job = AssemblyJob(
            job_id=uuid.uuid4().hex,
            display_name=display_name,
            working_directory=tempfile.TemporaryDirectory(prefix="assembly-job-"),
        )
        _jobs[job.job_id] = job
        return job


def discard_job(job_id: str) -> None:
    """작업과 그 폴더를 지운다(업로드가 잘못됐을 때)."""
    with _lock:
        job = _jobs.pop(job_id, None)
    if job is not None:
        _cancel(job)
        job.working_directory.cleanup()


def start_job(job: AssemblyJob, step_path: Path) -> None:
    """저장된 STEP 파일로 계산 프로세스를 띄우고, 출력을 읽는 감시 스레드를 시작한다."""
    output_path = job.directory / "assembly_result.msgpack"
    job.process = subprocess.Popen(
        [sys.executable, "-u", "-m", _WORKER_MODULE, str(step_path), str(output_path)],
        cwd=_WORKER_CWD,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    job.stage = assembly_service.STAGE_MESH

    def watch() -> None:
        process = job.process
        for line in process.stdout:
            sys.stdout.write(line)  # 서버 로그에도 팀 함수 출력을 남긴다
            stage = assembly_service.detect_stage(line)
            if stage is not None and not job.is_cancelled:
                job.stage = stage
        error_output = process.stderr.read().strip()
        return_code = process.wait()

        if job.is_cancelled:
            job.working_directory.cleanup()
            return
        if return_code == 0 and output_path.is_file():
            job.result = output_path.read_bytes()
            job.stage = STAGE_DONE
        else:
            last_line = error_output.splitlines()[-1] if error_output else f"exit code {return_code}"
            job.error = f"failed to assemble STEP file {job.display_name!r}: {last_line}"
            job.stage = STAGE_FAILED
        # 결과는 메모리에 있으니 업로드한 STEP 파일과 결과 파일은 바로 지운다.
        job.working_directory.cleanup()

    threading.Thread(target=watch, name=f"assembly-{job.job_id[:8]}", daemon=True).start()


def get_job(job_id: str) -> AssemblyJob | None:
    with _lock:
        return _jobs.get(job_id)


def take_result(job_id: str) -> bytes | None:
    """끝난 작업의 결과를 꺼내고 작업을 지운다. 아직 안 끝났으면 None."""
    with _lock:
        job = _jobs.get(job_id)
        if job is None or job.stage != STAGE_DONE:
            return None
        _jobs.pop(job_id)
    return job.result

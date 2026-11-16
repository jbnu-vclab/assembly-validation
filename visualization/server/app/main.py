"""Service 모드 API 서버 진입점. 앱을 만들고 미들웨어와 라우터를 붙인다."""

import sys

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from server.app.config import PROJECT_ROOT

# 팀 모듈(data/, core/, 루트 main.py)을 import 할 수 있게 프로젝트 루트를 맨 앞에 둔다.
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from server.app.api.routes import router  # noqa: E402  (sys.path 설정 뒤에 import)

app = FastAPI(title="Assembly Validation Pipeline")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router, prefix="/api")

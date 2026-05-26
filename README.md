# Design Collision — Assembly Validation

STEP CAD 파일을 업로드하면 **조립 가능성·충돌(교착)** 을 분석하고, Three.js 웹 뷰어에서 **mesh 렌더링·조립 애니메이션·충돌 시각화**를 제공합니다.

## 저장소 구조

```
├── README.md
├── LICENSE
├── package.json              ← npm start / npm run dev
├── requirements.txt          ← pip (conda activate `dc` 후 설치)
├── scripts/
│   ├── check-dc-env.sh       ← conda `dc` 사전 검사
│   └── dev.sh
├── backend/
│   ├── assembly_validation_v3.py   ← 운영 파이프라인 (서버가 호출)
│   ├── assembly_validation_v2.py   ← 개발 이력
│   └── assembly_validation.py      ← 개발 이력
└── frontend/
    ├── package.json
    ├── server.js             ← HTTP 서버 + STEP API
    ├── index.html
    ├── src/
    ├── data/                 ← STEP·산출물 (git 제외)
    └── voxel_test/           ← 복셀 렌더 테스트
```

## 동작 흐름

1. 저장소 루트에서 `npm start` (또는 `npm run dev`)
2. 브라우저에서 STEP (`.step` / `.stp`) 업로드
3. `frontend/server.js`가 conda **`dc`** 로 `backend/assembly_validation_v3.py` 실행
4. Python: STEP → voxel/mesh, 조립 순서·궤적·충돌 계산
5. `frontend/data/`에 저장 → 뷰어에서 mesh·조립·충돌 애니메이션

**stem**: 파일명에서 확장자 제외. 예: `Cleaner.step` → `Cleaner`

백엔드는 **상시 HTTP 서버가 아닙니다.** STEP 업로드마다 Python subprocess가 1회 실행됩니다. `npm start` 시 `scripts/check-dc-env.sh`로 conda `dc` 준비 여부만 먼저 확인합니다.

## 요구사항

| 구분 | 버전·도구 |
|------|-----------|
| Node.js | **`dc` 환경에 conda로 설치** (`nodejs`, 18+) |
| Conda | Miniconda 또는 Anaconda |
| Python | conda 환경 **`dc`** (이름 고정, `server.js` 참조) |

## 설치

저장소 clone 후 **저장소 루트**에서:

### 1. Conda 환경 `dc` (Python + Node)

환경을 만든 뒤 **activate한 상태에서** Python·Node 의존성을 모두 설치합니다.

```bash
conda create -n dc python=3.10 -y
conda activate dc

conda install -c conda-forge numpy trimesh pythonocc-core nodejs -y
pip install -r requirements.txt
```

확인 (`dc` activate 상태):

```bash
python -c "import numpy, trimesh, open3d; from occwl.compound import Compound; import msgpack, tqdm; print('dc ok')"
node -v && npm -v
```

### 2. Node 패키지 (프로젝트)

**`dc` activate 상태**에서 저장소 루트:

```bash
npm install    # frontend/ 의존성도 postinstall 로 설치
```

- **`open3d`·`occwl`은 pip** (`requirements.txt`). `occwl`은 PyPI에 없어 GitHub에서 설치합니다.
- **`requirements.txt`**: open3d, occwl(GitHub), msgpack, tqdm.
- **`nodejs`는 conda-forge**로 `dc`에 설치합니다. `npm`/`node`는 **`conda activate dc` 후** 사용합니다.
- 환경 이름을 `dc`가 아니게 쓰면 `frontend/server.js`와 `scripts/check-dc-env.sh`의 `dc`를 같이 바꾸세요.

## 실행

**`dc` activate 상태**에서 저장소 루트:

```bash
conda activate dc
npm start
```

(`npm run dev`와 동일)

| 명령 | 설명 |
|------|------|
| `npm start` | conda `dc` 검사 → 프론트 서버 |
| `npm run start:frontend` | 프론트만 |
| `npm run start:backend` | conda 검사만 |
| `cd frontend && npm start` | 프론트만 (검사 생략) |

| URL | 설명 |
|-----|------|
| http://localhost:3000/ | 메인 뷰어 |
| http://localhost:3000/voxel_test/ | 복셀 테스트 |

### 환경 변수 (선택)

기본값 그대로 쓰려면 `npm start`만 실행하면 됩니다.  
**포트나 voxel 크기를 바꿀 때**는 명령 앞에 `변수=값`을 붙입니다. 필요한 것만 적어도 되고, 여러 개를 함께 쓸 수 있습니다.

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `PORT` | `3000` | HTTP 포트 |
| `HOST` | `0.0.0.0` | 바인드 주소 |
| `PIPELINE_VOXEL_SIZE` | `20` | STEP 변환 voxel 크기 (mm) |

예 — 포트 8080, voxel 14mm 로 실행:

```bash
PORT=8080 PIPELINE_VOXEL_SIZE=14 npm start
```

포트만 바꿀 때:

```bash
PORT=8080 npm start
```

voxel 크기만 바꿀 때:

```bash
PIPELINE_VOXEL_SIZE=14 npm start
```

## 데이터 경로

런타임 데이터는 **`frontend/data/`** (git 제외).

| 항목 | 경로 |
|------|------|
| 업로드 STEP | `frontend/data/step/<name>.step` |
| Solid 메타 | `frontend/data/<stem>_solids.json` |
| 조립 msgpack | `frontend/data/<stem>_assembly.msgpack` |

clone 직후에는 `frontend/data/.gitkeep`, `frontend/data/step/.gitkeep`만 있습니다.

## API

| 메서드 | 경로 | 설명 |
|--------|------|------|
| `POST` | `/api/load-step` | STEP 업로드 → `{ jobId }` |
| `GET` | `/api/load-step-status?jobId=` | 변환 진행·로그 |
| `GET` | `/api/assembly-data?stem=` | 조립 msgpack |
| `GET` | `/data/<stem>_solids.json` | solid 메타 JSON |
| `GET` | `/data/<stem>_assembly.msgpack` | 조립 msgpack (정적) |

## 백엔드

운영: **`backend/assembly_validation_v3.py`**

- STEP → voxel/mesh
- A* 조립·분해 경로
- v3: 교착 부품 접근 궤적 + `failed_collisions`

```bash
conda activate dc
python -u backend/assembly_validation_v3.py -s <step_path> -v <voxel_mm>
conda deactivate
```

중간 출력 `backend/assembly_data.msgpack` → 서버가 `frontend/data/<stem>_*.json/msgpack`으로 저장.

`assembly_validation.py`, `assembly_validation_v2.py`는 이전 버전(참고용).

## 프론트 주요 파일

| 파일 | 역할 |
|------|------|
| `frontend/server.js` | HTTP, STEP API, 파이프라인 spawn |
| `frontend/src/main_viewer.js` | 메인 뷰어 |
| `frontend/src/step_load.js` | STEP 업로드·폴링 |
| `frontend/src/assembly_animation.js` | 조립·충돌 애니 |
| `frontend/src/mesh_render.js` | mesh·대기열·충돌 마커 |
| `frontend/src/assembly_trajectory.js` | msgpack 파싱 |

Three.js: CDN `three@0.170.0`

## 문제 해결

**conda / `dc` 없음** — 위 [설치](#1-conda-환경-dc) 절차.

**`occwl` conda 설치 실패** — `open3d`·`occwl`을 conda가 아니라 `pip install -r requirements.txt`로 설치하세요. `occwl`은 PyPI에 없고 GitHub URL로 설치됩니다.

**`npm: command not found`** — `conda activate dc` 후 실행하세요. README 1단계에서 `nodejs` conda 설치가 필요합니다.

**`pythonocc-core` conda 충돌** — `conda activate dc` 후 설치하고, Python 3.10 환경을 유지하세요.

**`assembly_data.msgpack 없음`** — 터미널 `[pipeline]` 로그 확인. `PIPELINE_VOXEL_SIZE` 조정.

**mesh 데이터 없음** — STEP 재업로드 (v3 파이프라인 필요).

**`data/`가 git에 없음** — 정상. 업로드 후 로컬 생성.

## 라이선스

MIT — [LICENSE](LICENSE)

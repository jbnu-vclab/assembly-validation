# Design Collision — frontend

Three.js로 STEP을 voxel로 변환해 시각화하는 앱입니다. **이 디렉터리가 Git 저장소 루트**라는 전제(클론 후 이 폴더에서 바로 작업)로 설명합니다.

## 동작 흐름

1. `npm run start`로 Node 서버를 띄운 뒤 브라우저로 접속합니다.
2. **STEP 파일 로드**로 `.step` / `.stp`를 고릅니다.
3. 서버는 업로드한 파일을 **데이터 루트** 아래 `step/`에 저장하고, `conda` 환경 `dc`에서 `tools/step_to_voxel.py`를 실행합니다.
4. 변환 결과는 `data/voxel/<stem>_voxel/`에 NPY로 쌓이고, 같은 stem으로 `data/<stem>.json`이 갱신됩니다.
5. 프론트는 `/data/...` URL로 NPY와 매니페스트를 읽고, 조립·애니메이션은 msgpack(아래)으로 받습니다.

**stem**: 업로드 파일명에서 확장자를 뺀 이름(안전 문자만 유지, 대소문자 유지). 예: `Cleaner.step` → `Cleaner`.

## 실행 전 요구사항

- Node.js 18+ (npm 포함)
- [Conda](https://docs.conda.io/) — 환경 이름 **`dc`**, 서버가 이 이름으로 `conda run -n dc python ...`를 호출합니다.
- `dc`에 Python 패키지: `numpy`, `trimesh`, `open3d`, `pythonocc-core` (conda-forge 권장)

## Conda 환경 설정(`dc`, 필수)

서버(`server.js`)가 변환 스크립트를 `conda run -n dc ...`로 실행하므로, 로컬/다른 PC에서도 **환경 이름을 반드시 `dc`로 생성**해야 합니다.

### 한 번에 생성 (`environment.yml`, 권장)

저장소 기준 백엔드 디렉터리에 `../backend/environment.yml` 이 있습니다.

```bash
# 프론트 폴더에서 상대 경로 예시
conda env create -f ../backend/environment.yml

# 이미 dc가 있으면 갱신
conda env update -f ../backend/environment.yml --prune
```

`pip`로 `occwl`, `msgpack`, `tqdm` 등이 같이 설치됩니다. 확인:

```bash
conda run -n dc python -c "import numpy, trimesh, open3d; from occwl.compound import Compound; import msgpack, tqdm; print('dc ok')"
```

### 수동 설치 (동일 스택)

```bash
# 1) 환경 생성 (python 버전은 팀 표준에 맞게 조정 가능)
conda create -n dc python=3.10 -y

# 2) 패키지 설치 (conda-forge 권장)
conda install -n dc -c conda-forge numpy trimesh open3d pythonocc-core -y

# 3) 백엔드 requirements.txt (pip)
conda run -n dc pip install -r ../backend/requirements.txt
conda run -n dc pip install occwl

# 4) 설치 확인
conda run -n dc python -c "import numpy, trimesh, open3d; print('dc ok')"
```

문제 발생 시 먼저 `conda env list`에서 `dc` 환경 존재 여부를 확인하세요.

## 실행 방법

```bash
# 저장소 루트(이 폴더)에서
npm install
npm run start
```

기본: [http://localhost:3000/](http://localhost:3000/) → `index.html`로 리다이렉트.

## 데이터 경로(고정)

이 프로젝트는 데이터를 항상 `frontend/data` 아래에 저장합니다.

| 항목 | 경로 |
| --- | --- |
| 루트 | `<repo>/data` |
| 업로드 STEP | `<repo>/data/step/` |
| Voxel NPY | `<repo>/data/voxel/<stem>_voxel/*.npy` |
| parts 매니페스트 | `<repo>/data/<stem>.json` (예: `Cleaner.json`) |
| 조립(애니메이션·복셀) | `/api/assembly-data?stem=<stem>` 또는 `<repo>/data/<stem>_assembly.msgpack` |
| solid 메타 | `<repo>/data/<stem>_solids.json` |

**로컬에서 STEP 업로드 후 데이터가 자동 생성**됩니다. `data/` 하위는 `.gitignore`에 의해 커밋되지 않습니다.

환경 변수 예시는 [`.env.example`](.env.example) 참고(`PORT`만 선택 설정).

## 주요 파일

- `server.js` — 정적·`/data/*`·STEP 업로드 API·변환·`<stem>.json` 기록
- `src/main_viewer.js` — 엔트리·씬·카메라·STEP UI
- `src/voxel.js` — NPY 로드·그리드 메타·복셀 InstancedMesh·대기열 레이아웃
- `src/step_load.js` — STEP 파일 선택·업로드·상태 폴링·말줄임 상태 애니
- `src/viewer_constants.js` — 이동축·회전축·레이어 상수(조립·메인 뷰 공용)
- `src/assembly_animation.js` — 조립 msgpack 디코드·궤적 파싱·THREE 재생
- `tools/step_to_voxel.py` — STEP → voxel

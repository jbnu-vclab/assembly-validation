# Assembly Validation
## Get Started
```
conda env create -f environment.yml
```

## Run
터미널 2개를 띄운 뒤 각각 실행합니다. (서버 먼저)

**서버**
```
conda activate assembly-validation
cd visualization
uvicorn server.app.main:app --reload --port 8001
```

**프론트엔드**
```
conda activate assembly-validation
cd visualization/frontend
npm run dev
```

## Code Structure
```
├── config/
│   └── config.yaml : configuration file
├── core/
│   ├── action.py : action class
│   ├── collision.py : collision detection module using trimesh
│   ├── planner.py : path planner module
│   └── state.py : state class
├── data/
│   ├── exporter.py : result exporter module using msgpack
│   └── loader.py : step loader and mesh converter using occwl and trimesh
├── step/ : input CAD STEP files 
├── part_cache/ : cached STEP parse meshes 
├── output/ : assembly result msgpack 
├── visualization/
│   ├── server/
│   │   ├── requirements.txt
│   │   └── app/
│   │       ├── main.py : FastAPI entry (CORS, router)
│   │       ├── config.py : paths and settings
│   │       ├── api/
│   │       │   ├── routes.py : endpoints only — /api/assemble, /api/health
│   │       │   └── http_utils.py : upload storage (400 checks), msgpack response
│   │       └── services/
│   │           ├── assembly_service.py : STEP → RRT* result msgpack (calls root main.py pipeline)
│   │           └── errors.py : service exceptions
│   └── frontend/
│       ├── index.html : Three.js dashboard
│       ├── package.json
│       ├── vite.config.js
│       ├── public/
│       └── src/
│           ├── main.js : entry — creates renderer, dashboard, modes and wires them (mode switch, file drop)
│           ├── modes/
│           │   ├── debug_mode.js : [debug] local result msgpack → result_loader (no server)
│           │   └── service_mode.js : [service] STEP upload → api.js → assembly result (progress text on the viewer)
│           ├── api.js : server requests (POST /api/assemble)
│           ├── result_loader.js : result msgpack bytes → decode → normalize → validate (shared)
│           ├── ui/
│           │   ├── dashboard.js : ViewerDashboard — header, part tree, playback bar, failure report
│           │   ├── failure_report.js : failure cause → report text (pure functions)
│           │   ├── format.js : display formatting helpers
│           │   └── dom.js : shared DOM helpers
│           ├── renderer.js : Three.js scene, trajectory playback, failure analysis animation
│           ├── styles.css : base styles + mode toggle
│           └── service_style.css : service mode theme
├── environment.yml
└── main.py
```
## Pipeline (current)
- **Debug 모드**: `python main.py ...` 로 만든 `output/*.msgpack` 을 브라우저에서 직접 로드 (서버 불필요)
- **Service 모드**
  - **Load STEP** (`POST /api/assemble`, `step_file`): 루트 `main.py` 의 `execute_disassembly_search` 가 STEP → Mesh · 간섭 판정 · 분해 경로 탐색을 `config/config.yaml` 설정으로 한 번에 실행 → 결과 msgpack → 결과 화면
     - 분해 실패 부품의 진단(`failures`)도 함께 담겨 실패 분석 화면에 쓰인다

## Output Structure
```
├── metadata
    ├── step_path
    ├── global_bbox
├── solids
    ├── 0
        ├── mesh
            ├── vertices
            ├── faces
        ├── state
            ├── position
            ├── rotation
    ├── 1
        ├── mesh
            ├── vertices
            ├── faces
        ├── state
            ├── position
            ├── rotation
├── trajectories
    ├── 0
        ├── solid
        ├── state
            ├── position
            ├── rotation
        ├── action
            ├── type
            ├── value
    ├── 1
        ├── solid
        ├── state
            ├── position
            ├── rotation
        ├── action
            ├── type
            ├── value
├── failures
    ├── <id>
        ├── closest_path
            ├── <index>
                ├── solid
                ├── state
                    ├── position
                    ├── rotation
                ├── action
                    ├── type
                    ├── value
        ├── last_valid_pose
            ├── state
                ├── position
                ├── rotation
        ├── first_blocked_pose
            ├── state
                ├── position
                ├── rotation
            ├── overlaps
                ├── <index>
                    ├── obstacle
                    ├── is_over_limit
                    ├── mesh
                        ├── vertices
                        ├── faces
```

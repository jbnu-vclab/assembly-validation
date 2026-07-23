# Assembly Validation
## Get Started
```
conda env create -f environment.yml
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
│   ├── loader.py : step loader and mesh converter using occwl and trimesh
│   └── dummy_data_exporter.py : temporary assembly-sequence bridge (until planner/exporter land)
├── step/ : input CAD STEP files 
├── part_cache/ : cached STEP parse meshes 
├── output/ : assembly result msgpack 
├── server/
│   ├── requirements.txt
│   └── app/
│       ├── main.py : FastAPI entry
│       └── api/
│           └── routes.py : /api/load-step (STEP→mesh), /api/assemble (dummy output/*.msgpack)
├── frontend/
│   ├── index.html : Three.js dashboard
│   ├── package.json
│   ├── vite.config.js
│   ├── public/
│   └── src/
│       ├── main.js : Load STEP / playback / part tree
│       ├── loader.js : STEP upload + msgpack decode
│       ├── renderer.js : Three.js scene and trajectory playback
│       ├── styles.css
│       ├── debug_mode.js : [debug] Service/Debug toggle + Load Assembly
│       └── debug_style.css : [debug] debug theme / layout
├── environment.yml
└── main.py
```
## Pipeline (current)
1. **Load STEP** (`POST /api/load-step`): `STEPLoader` 파싱 → solids mesh msgpack (`trajectories=[]`) → 프론트 보관/표시
2. **조립 계산** (`POST /api/assemble`): STEP 파일명으로 `output/{name}.msgpack` 더미 반환 (예: `Cleaner.STEP` → `output/cleaner.msgpack`)
   - 예정: `core/planner` · `core/collision` · `data/exporter` 로 교체 후 더미 경로 삭제

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
```

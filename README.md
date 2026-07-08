# Assembly Validation
## Get Started
```
conda env create -f environment.yml
```
## Code Structure
```
├── config/
    ├── config.yaml : configuration file
├── core/
    ├── action.py : action class
    ├── collision.py : collision detection module using trimesh
    ├── planner.py : path planner module
    ├── state.py : state class
├── data/
    ├── exporter.py : result exporter module using msgpack
    ├── loader.py : step loader and mesh converter using occwl and trimesh
├── test/
├── visualization/
    ├── visualizer.py : static mesh visualizer using PyVista
    ├── animator.py : trajectory playback module
    ├── result_loader.py : msgpack result loader for visualization
├── main.py
```
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

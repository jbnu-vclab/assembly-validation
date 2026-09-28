# Assembly Validation
## Get Started
```
conda env create -f environment.yml
conda activate assembly-validation
```
## Run
```
python main.py step_path=<step_path.st*p> output_path=<output_path.msgpack>
```
## Code Structure
```
├── config/
    ├── config.yaml
├── core/
    ├── state.py
    ├── action.py
    ├── planner.py
    ├── interference.py
├── data/
    ├── loader.py
    ├── exporter.py
├── pipeline.py
├── main.py
```
## Output Structure
```
├── metadata
    ├── step_path
    ├── global_bbox
├── solids
    ├── <id>
        ├── name
        ├── conversion
        ├── mesh
            ├── vertices
            ├── faces
        ├── state
            ├── position
            ├── rotation
├── trajectories
    ├── <index>
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

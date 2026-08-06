import numpy as np
from concurrent.futures import ThreadPoolExecutor
from trimesh import Trimesh
from occwl.compound import Compound
from occwl.solid import Solid

class STEPLoader:
    def __init__(self, filename: str, face_tolerance: float, angle_tolerance: float, max_workers: int):
        self.filename = filename
        self.face_tolerance = face_tolerance
        self.angle_tolerance = angle_tolerance
        self.max_workers = max_workers

    def load(self, solid: Solid):
        vertices, faces = list(), list()
        vertex_offset = 0

        solid.triangulate_all_faces(triangle_face_tol = self.face_tolerance, angle_tol_rads = self.angle_tolerance)
        for face in solid.faces():
            vertex, face = face.get_triangles()
            if len(vertex) == 0 or len(face) == 0:
                continue
            vertices.append(vertex)
            faces.append(face + vertex_offset)
            vertex_offset += len(vertex)

        return Trimesh(vertices = np.vstack(vertices), faces = np.vstack(faces))

    def load_all(self):
        compound = Compound.load_from_step(self.filename)
        solids = list(compound.solids())

        with ThreadPoolExecutor(max_workers = self.max_workers) as executor:
            # as_completed 대신 제출 순서를 유지해 part_index = compound.solids() 순번이 되게 한다.
            futures = [executor.submit(self.load, solid) for solid in solids]
            return [future.result() for future in futures]

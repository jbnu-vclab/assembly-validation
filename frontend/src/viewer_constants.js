import * as THREE from 'three'

export const DIR_TO_WORLD_AXIS = {
	LEFT: new THREE.Vector3(-1, 0, 0),
	RIGHT: new THREE.Vector3(1, 0, 0),
	UP: new THREE.Vector3(0, 1, 0),
	DOWN: new THREE.Vector3(0, -1, 0),
	FRONT: new THREE.Vector3(0, 0, 1),
	BACK: new THREE.Vector3(0, 0, -1),
}

export const ROTATION_AXIS_TO_WORLD_AXIS = {
	ROLL: new THREE.Vector3(1, 0, 0),
	PITCH: new THREE.Vector3(0, 1, 0),
	YAW: new THREE.Vector3(0, 0, 1),
}

export const MAIN_VIEW_LAYER = 0
export const QUEUE_VIEW_LAYER = 1

export function traverseSetLayer(root, layer) {
	root.traverse((obj) => {
		obj.layers.set(layer)
	})
}

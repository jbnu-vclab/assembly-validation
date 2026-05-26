/**
 * voxel_test: STEP 업로드 후 solid 복셀 렌더링 테스트.
 * http://localhost:3000/voxel_test/
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

import { WEBGL } from '/src/webgl.js'
import { pickStepFile, uploadAndBuildFromStep } from '/src/step_load.js'
import {
	loadGridMeta,
	createMainWorldVoxelGroup,
	bboxCenterFromVoxels,
	gridMetaFromAssemblyDecoded,
	mergeVoxelLists,
	voxelCenterWorld,
} from '/src/voxel.js'
import {
	decodeAssemblyBuffer,
	voxelsForManifestPartIndex,
} from '/src/assembly_trajectory.js'

const statusEl = document.getElementById('status')
const btnUpload = document.getElementById('btn-upload')
const canvasWrap = document.getElementById('canvas-wrap')

let renderer
let scene
let camera
let controls
let modelRoot = null

function setStatus(text) {
	if (statusEl) statusEl.textContent = text
}

function setBusy(busy) {
	if (btnUpload) btnUpload.disabled = busy
}

function clearModel() {
	if (modelRoot) {
		scene.remove(modelRoot)
		modelRoot.traverse((obj) => {
			if (obj.geometry) obj.geometry.dispose()
			if (obj.material) {
				if (Array.isArray(obj.material)) {
					obj.material.forEach((m) => m.dispose())
				} else {
					obj.material.dispose()
				}
			}
		})
		modelRoot = null
	}
}

function fitCameraToVoxels(voxels, grid) {
	if (!voxels.length) return
	const box = new THREE.Box3()
	const p = new THREE.Vector3()
	for (const v of voxels) {
		voxelCenterWorld(v, grid, p)
		box.expandByPoint(p)
	}
	if (box.isEmpty()) return
	const size = box.getSize(new THREE.Vector3())
	const center = box.getCenter(new THREE.Vector3())
	const aspect = canvasWrap.clientWidth / Math.max(1, canvasWrap.clientHeight)
	const vFov = THREE.MathUtils.degToRad(camera.fov)
	const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect)
	const fitHeight = (size.y * 0.5) / Math.tan(vFov / 2)
	const fitWidth = (size.x * 0.5) / Math.tan(hFov / 2)
	const dist = Math.max(fitHeight, fitWidth, size.z * 0.5) * 2.4
	const dir = new THREE.Vector3(1, 0.65, 1).normalize()
	camera.position.copy(center.clone().addScaledVector(dir, dist))
	camera.lookAt(center)
	camera.near = Math.max(0.1, dist / 200)
	camera.far = Math.max(5000, dist * 24)
	camera.updateProjectionMatrix()
	controls.target.copy(center)
	controls.update()
}

function initScene() {
	if (!WEBGL.isWebGLAvailable()) {
		document.body.appendChild(WEBGL.getWebGLErrorMessage())
		return false
	}

	scene = new THREE.Scene()
	scene.background = new THREE.Color(0x1a1b1e)

	const w = canvasWrap.clientWidth
	const h = canvasWrap.clientHeight
	camera = new THREE.PerspectiveCamera(50, w / Math.max(1, h), 0.1, 10000)
	camera.position.set(400, 280, 400)

	renderer = new THREE.WebGLRenderer({ antialias: true })
	renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
	renderer.setSize(w, h)
	canvasWrap.appendChild(renderer.domElement)

	controls = new OrbitControls(camera, renderer.domElement)
	controls.enableDamping = true

	const amb = new THREE.AmbientLight(0xffffff, 0.55)
	const dir = new THREE.DirectionalLight(0xffffff, 0.85)
	dir.position.set(200, 400, 300)
	scene.add(amb, dir)

	const grid = new THREE.GridHelper(800, 40, 0x444444, 0x2a2a2a)
	grid.position.y = -120
	scene.add(grid)

	window.addEventListener('resize', onResize)
	animate()
	return true
}

function onResize() {
	if (!renderer || !camera) return
	const w = canvasWrap.clientWidth
	const h = canvasWrap.clientHeight
	camera.aspect = w / Math.max(1, h)
	camera.updateProjectionMatrix()
	renderer.setSize(w, h)
}

function animate() {
	requestAnimationFrame(animate)
	if (controls) controls.update()
	if (renderer && scene && camera) renderer.render(scene, camera)
}

async function loadAndRender(stem, solidsPath, assemblyMsgpackPath) {
	const manifestRes = await fetch(solidsPath, { cache: 'no-store' })
	if (!manifestRes.ok) {
		throw new Error(`매니페스트 로드 실패: ${manifestRes.status}`)
	}
	const manifest = await manifestRes.json()

	let assemblyUrl = assemblyMsgpackPath
	if (!assemblyUrl) {
		assemblyUrl = `/api/assembly-data?stem=${encodeURIComponent(stem)}`
	}
	const asmRes = await fetch(assemblyUrl, { cache: 'no-store' })
	if (!asmRes.ok) {
		throw new Error(`msgpack 로드 실패: ${asmRes.status}`)
	}
	const decoded = decodeAssemblyBuffer(await asmRes.arrayBuffer())

	let grid = await loadGridMeta(manifest)
	if (!grid) grid = gridMetaFromAssemblyDecoded(decoded)
	if (!grid) {
		throw new Error('grid 메타(origin, voxelSize)를 찾을 수 없습니다.')
	}

	const specs = Array.isArray(manifest.solids) ? manifest.solids : []
	const partRows = []
	for (let i = 0; i < specs.length; i += 1) {
		const voxels = voxelsForManifestPartIndex(decoded, i)
		if (voxels?.length) {
			partRows.push({ voxels, spec: specs[i] })
		}
	}
	if (partRows.length === 0) {
		throw new Error('표시할 복셀이 없습니다.')
	}

	clearModel()
	const merged = mergeVoxelLists(partRows)
	const mainAnchor = bboxCenterFromVoxels(merged, grid, new THREE.Vector3())

	modelRoot = new THREE.Group()
	for (const { voxels, spec } of partRows) {
		const group = createMainWorldVoxelGroup(voxels, spec, grid, mainAnchor, null)
		modelRoot.add(group)
	}
	scene.add(modelRoot)
	fitCameraToVoxels(merged, grid)

	const vs = grid.voxelSize
	const res = grid.resolution ? grid.resolution.join('×') : '—'
	setStatus(
		`${stem}: ${partRows.length}개 solid · 복셀 ${merged.length.toLocaleString()}칸 · ${vs}mm · 격자 ${res}`
	)
}

async function onUploadClick() {
	try {
		const file = await pickStepFile()
		setBusy(true)
		setStatus(`${file.name} 업로드·복셀화 중...`)

		const done = await uploadAndBuildFromStep(file, {
			onStatus: (msg) => setStatus(msg),
		})

		const stem = done.voxelBase || file.name.replace(/\.(step|stp)$/i, '')
		const solidsPath = done.solidsPath || done.manifestPath
		const assemblyMsgpackPath = done.assemblyMsgpackPath

		setStatus('결과 로드 중...')
		await loadAndRender(stem, solidsPath, assemblyMsgpackPath)
	} catch (err) {
		console.error(err)
		setStatus(err?.message || String(err))
	} finally {
		setBusy(false)
	}
}

if (initScene()) {
	btnUpload?.addEventListener('click', onUploadClick)
}

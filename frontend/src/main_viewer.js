import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

import { WEBGL } from './webgl.js'
import { createAssemblyPlayback, decodeAssemblyBuffer } from './assembly_animation.js'
import { pickStepFile, uploadAndBuildFromStep, createEllipsisAnimator } from './step_load.js'
import {
	MAIN_VIEW_LAYER,
	QUEUE_VIEW_LAYER,
	traverseSetLayer,
} from './viewer_constants.js'
import {
	loadGridMeta,
	QUEUE_DETAIL_TARGET_SIZE,
	gridMetaFromAssemblyDecoded,
} from './voxel.js'
import {
	bboxCenterFromMeshParts,
	collisionMarkerOffsetInQueueGroup,
	createCollisionFogGroup,
	createMainWorldMeshGroup,
	queueMeshPreviewFrame,
	createQueueMeshGroup,
	updateCollisionMarkerPulse,
} from './mesh_render.js'
import {
	queuePartNamesFromMsgpack,
	parseFailedCollisionsMap,
	meshForManifestPartIndex,
} from './assembly_trajectory.js'
import {
	createQueuePanelUI,
	createQueueDetailChrome,
	VISIBLE_QUEUE_SLOTS,
} from './queue_panel_ui.js'
import { createMainToolbar } from './main_toolbar_ui.js'

/**
 * @param lookAtYFactor  lookAt 시 center.y에 더할 보정 = size.y * 이 값 (0에 가까울수록 수직 중앙에 가깝게)
 */
function fitPerspectiveCameraToBox(
	camera,
	box,
	aspect,
	viewDir,
	pad = 2.45,
	lookAtYFactor = 0.08
) {
	if (box.isEmpty()) return
	const size = box.getSize(new THREE.Vector3())
	const center = box.getCenter(new THREE.Vector3())
	const vFov = THREE.MathUtils.degToRad(camera.fov)
	const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect)
	const fitHeightDist = (size.y * 0.5) / Math.tan(vFov / 2)
	const fitWidthDist = (size.x * 0.5) / Math.tan(hFov / 2)
	const fitDepthDist = size.z * 0.5
	const distance =
		Math.max(fitHeightDist, fitWidthDist, fitDepthDist) * pad
	const dir = viewDir.clone().normalize()
	camera.position.copy(center.clone().addScaledVector(dir, distance))
	camera.lookAt(center.x, center.y + size.y * lookAtYFactor, center.z)
	camera.near = Math.max(0.1, distance / 200)
	camera.far = Math.max(3000, distance * 20)
	camera.updateProjectionMatrix()
}

/**
 * msgpack 로드 직후 대기열용 — assembly.sequence(분해 성공 순의 역순)만, 재생과 무관.
 */
function buildQueuePartList(loadedParts, assembly, manifestParts, decodedFull) {
	const failedMap = parseFailedCollisionsMap(
		assembly,
		manifestParts,
		decodedFull
	)
	const seqNames = queuePartNamesFromMsgpack(
		assembly,
		manifestParts,
		decodedFull
	)
	const byName = new Map()
	for (const p of loadedParts) {
		const nm = p.spec?.name
		if (nm) byName.set(nm, p)
	}
	const enrich = (p) => {
		const nm = p.spec?.name
		const fc = nm ? failedMap.get(nm) : null
		return {
			...p,
			failedCollision: fc ?? null,
		}
	}
	const ordered = []
	const seen = new Set()
	for (const nm of seqNames) {
		const p = byName.get(nm)
		if (p?.mesh?.vertices?.length) {
			ordered.push(enrich(p))
			seen.add(nm)
		}
	}
	// 분해 실패·궤적 없음 부품 포함 → solids 전체(예: Cleaner 15개)
	for (const p of loadedParts) {
		const nm = p.spec?.name
		if (!nm || seen.has(nm) || !p.mesh?.vertices?.length) continue
		ordered.push(enrich(p))
		seen.add(nm)
	}
	return ordered
}

function findQueuePartRoot(object) {
	let o = object
	while (o) {
		if (o.userData?.partName) return o
		o = o.parent
	}
	return null
}

function centerObjectGroupAtOrigin(group) {
	const box = new THREE.Box3().setFromObject(group)
	if (box.isEmpty()) return
	const c = box.getCenter(new THREE.Vector3())
	group.position.sub(c)
}

/**
 * DOM 슬롯 rect → renderer.setViewport 좌표 (캔버스 CSS px, 하단-left).
 * Three.js는 setViewport에 pixelRatio를 내부에서 한 번 더 곱함 — drawing buffer px로 넘기면 이중 스케일되어 안 보임.
 */
function viewportRectForRenderer(rect, canvasRect) {
	return {
		x: Math.max(0, Math.floor(rect.left - canvasRect.left)),
		y: Math.max(0, Math.floor(canvasRect.bottom - rect.bottom)),
		w: Math.max(1, Math.floor(rect.width)),
		h: Math.max(1, Math.floor(rect.height)),
	}
}

async function fetchAssemblyDecoded(stem) {
	if (!stem) return null
	const assemblyUrls = [
		`/api/assembly-data?stem=${encodeURIComponent(stem)}`,
		`/data/${encodeURIComponent(stem)}_assembly.msgpack`,
	]
	let decoded = null
	for (const url of assemblyUrls) {
		try {
			const asmRes = await fetch(url, { cache: 'no-store' })
			if (!asmRes.ok) continue
			decoded = decodeAssemblyBuffer(await asmRes.arrayBuffer())
			break
		} catch (e) {
			console.warn('assembly msgpack preload:', url, e.message)
		}
	}
	if (!decoded) return null
	return decoded
}

async function main() {
	if (!WEBGL.isWebGLAvailable()) {
		document.body.appendChild(WEBGL.getWebGLErrorMessage())
		return
	}

	const scene = new THREE.Scene()
	scene.background = null
	const LEFT_PANEL_RATIO = 0.7
	const MAIN_PANEL_BG = 0x080d18
	const QUEUE_PANEL_BG = 0xf4f6fb
	const QUEUE_SLOT_BG = 0xffffff

	const renderer = new THREE.WebGLRenderer({
		antialias: false,
		powerPreference: 'high-performance',
	})
	renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
	renderer.setSize(window.innerWidth, window.innerHeight)
	document.body.appendChild(renderer.domElement)

	const ambientLight = new THREE.AmbientLight(0xffffff, 0.4)
	scene.add(ambientLight)

	const directionalLight = new THREE.DirectionalLight(0xffffff, 1.1)
	directionalLight.position.set(6, 10, 4)
	scene.add(directionalLight)

	let hasLoadedConfig = false

	// Service-like overlay UI
	const uiLayer = document.createElement('div')
	uiLayer.style.position = 'fixed'
	uiLayer.style.inset = '0'
	uiLayer.style.pointerEvents = 'none'
	uiLayer.style.zIndex = '10'
	document.body.appendChild(uiLayer)

	const appTitle = document.createElement('div')
	appTitle.textContent = 'Design Collision Viewer'
	appTitle.style.position = 'fixed'
	appTitle.style.top = '12px'
	appTitle.style.left = '50%'
	appTitle.style.transform = 'translateX(-50%)'
	appTitle.style.padding = '8px 14px'
	appTitle.style.borderRadius = '999px'
	appTitle.style.font = '600 12px system-ui, -apple-system, sans-serif'
	appTitle.style.letterSpacing = '0.2px'
	appTitle.style.color = '#e5e7eb'
	appTitle.style.background = 'rgba(17, 24, 39, 0.72)'
	appTitle.style.border = '1px solid rgba(148, 163, 184, 0.28)'
	uiLayer.appendChild(appTitle)

	const mainPanelLabel = document.createElement('div')
	mainPanelLabel.textContent = '메인 화면'
	mainPanelLabel.style.position = 'fixed'
	mainPanelLabel.style.padding = '6px 10px'
	mainPanelLabel.style.borderRadius = '10px'
	mainPanelLabel.style.font = '600 12px system-ui, -apple-system, sans-serif'
	mainPanelLabel.style.color = '#dbeafe'
	mainPanelLabel.style.background = 'rgba(30, 41, 59, 0.65)'
	mainPanelLabel.style.border = '1px solid rgba(96, 165, 250, 0.35)'
	uiLayer.appendChild(mainPanelLabel)

	const queuePanelLabel = document.createElement('div')
	queuePanelLabel.textContent = '대기열 화면'
	queuePanelLabel.style.position = 'fixed'
	queuePanelLabel.style.padding = '6px 10px'
	queuePanelLabel.style.borderRadius = '10px'
	queuePanelLabel.style.font = '600 12px system-ui, -apple-system, sans-serif'
	queuePanelLabel.style.color = '#374151'
	queuePanelLabel.style.background = 'rgba(255, 255, 255, 0.78)'
	queuePanelLabel.style.border = '1px solid rgba(148, 163, 184, 0.55)'
	uiLayer.appendChild(queuePanelLabel)

	const panelDivider = document.createElement('div')
	panelDivider.style.position = 'fixed'
	panelDivider.style.width = '2px'
	panelDivider.style.background =
		'linear-gradient(to bottom, rgba(148,163,184,0.2), rgba(148,163,184,0.7), rgba(148,163,184,0.2))'
	panelDivider.style.boxShadow = '0 0 18px rgba(148,163,184,0.35)'
	uiLayer.appendChild(panelDivider)

	const leftPanelFrame = document.createElement('div')
	leftPanelFrame.style.position = 'fixed'
	leftPanelFrame.style.border = '1px solid rgba(148, 163, 184, 0.2)'
	leftPanelFrame.style.borderRadius = '16px'
	leftPanelFrame.style.boxShadow = 'inset 0 0 0 1px rgba(255,255,255,0.03)'
	uiLayer.appendChild(leftPanelFrame)

	const rightPanelFrame = document.createElement('div')
	rightPanelFrame.style.position = 'fixed'
	rightPanelFrame.style.border = '1px solid rgba(148, 163, 184, 0.38)'
	rightPanelFrame.style.borderRadius = '16px'
	/* 테두리만 — 배경은 투명 (오른쪽 3D가 uiLayer 아래 캔버스에 그려짐) */
	rightPanelFrame.style.background = 'transparent'
	rightPanelFrame.style.boxShadow = 'none'
	uiLayer.appendChild(rightPanelFrame)

	function layoutServiceUI() {
		const w = window.innerWidth
		const h = Math.max(1, window.innerHeight)
		const leftW = Math.max(1, Math.floor(w * LEFT_PANEL_RATIO))
		const rightW = Math.max(1, w - leftW)
		const panelTop = 48
		const panelBottom = 10
		const panelHeight = Math.max(1, h - panelTop - panelBottom)

		mainPanelLabel.style.left = `${Math.max(12, Math.floor(leftW * 0.5) - 38)}px`
		mainPanelLabel.style.top = '14px'
		queuePanelLabel.style.left = `${leftW + Math.max(12, Math.floor(rightW * 0.5) - 44)}px`
		queuePanelLabel.style.top = '14px'

		panelDivider.style.left = `${leftW - 1}px`
		panelDivider.style.top = `${panelTop}px`
		panelDivider.style.height = `${panelHeight}px`

		leftPanelFrame.style.left = '8px'
		leftPanelFrame.style.top = `${panelTop}px`
		leftPanelFrame.style.width = `${Math.max(1, leftW - 16)}px`
		leftPanelFrame.style.height = `${panelHeight}px`

		rightPanelFrame.style.left = `${leftW + 8}px`
		rightPanelFrame.style.top = `${panelTop}px`
		rightPanelFrame.style.width = `${Math.max(1, rightW - 16)}px`
		rightPanelFrame.style.height = `${panelHeight}px`
	}

	layoutServiceUI()
	const loadButton = document.createElement('button')
	loadButton.textContent = 'STEP 파일 로드'
	loadButton.style.position = 'fixed'
	loadButton.style.left = '16px'
	loadButton.style.top = '14px'
	loadButton.style.padding = '9px 14px'
	loadButton.style.fontSize = '13px'
	loadButton.style.fontWeight = '600'
	loadButton.style.zIndex = '30'
	loadButton.style.cursor = 'pointer'
	loadButton.style.color = '#f8fafc'
	loadButton.style.border = '1px solid rgba(148,163,184,0.4)'
	loadButton.style.borderRadius = '10px'
	loadButton.style.background = 'linear-gradient(135deg, #2563eb, #1d4ed8)'
	loadButton.style.boxShadow = '0 6px 16px rgba(37, 99, 235, 0.35)'
	document.body.appendChild(loadButton)
	const loadStatus = document.createElement('div')
	loadStatus.style.position = 'fixed'
	loadStatus.style.left = '16px'
	loadStatus.style.top = '56px'
	loadStatus.style.padding = '5px 9px'
	loadStatus.style.font = '12px monospace'
	loadStatus.style.color = '#e2e8f0'
	loadStatus.style.background = 'rgba(15, 23, 42, 0.5)'
	loadStatus.style.border = '1px solid rgba(148, 163, 184, 0.28)'
	loadStatus.style.borderRadius = '8px'
	loadStatus.style.zIndex = '30'
	loadStatus.style.maxWidth = 'min(520px, calc(70vw - 24px))'
	loadStatus.textContent = 'STEP 파일을 선택하면 변환 후 렌더링합니다.'
	document.body.appendChild(loadStatus)

	const loadLogTail = document.createElement('pre')
	loadLogTail.style.position = 'fixed'
	loadLogTail.style.left = '16px'
	loadLogTail.style.top = '108px'
	loadLogTail.style.margin = '0'
	loadLogTail.style.padding = '8px 10px'
	loadLogTail.style.fontSize = '10px'
	loadLogTail.style.lineHeight = '1.35'
	loadLogTail.style.fontFamily = 'ui-monospace, monospace'
	loadLogTail.style.color = '#cbd5e1'
	loadLogTail.style.background = 'rgba(15, 23, 42, 0.72)'
	loadLogTail.style.border = '1px solid rgba(148, 163, 184, 0.35)'
	loadLogTail.style.borderRadius = '8px'
	loadLogTail.style.zIndex = '30'
	loadLogTail.style.maxWidth = 'min(560px, calc(92vw - 32px))'
	loadLogTail.style.maxHeight = 'min(200px, 28vh)'
	loadLogTail.style.overflow = 'auto'
	loadLogTail.style.whiteSpace = 'pre-wrap'
	loadLogTail.style.wordBreak = 'break-word'
	loadLogTail.style.display = 'none'
	document.body.appendChild(loadLogTail)

	const loadEllipsis = createEllipsisAnimator((t) => {
		loadStatus.textContent = t
	})

	const emptyMainCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 3000)
	emptyMainCamera.position.set(40, 24, 44)
	emptyMainCamera.lookAt(0, 0, 0)
	const emptyQueueCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 3000)
	emptyQueueCamera.position.set(40, 24, 44)
	emptyQueueCamera.lookAt(0, 0, 0)
	function renderInitialPanels() {
		if (hasLoadedConfig) return
		const w = window.innerWidth
		const h = Math.max(1, window.innerHeight)
		const leftW = Math.max(1, Math.floor(w * LEFT_PANEL_RATIO))
		const rightW = Math.max(1, w - leftW)

		emptyMainCamera.aspect = leftW / h
		emptyMainCamera.updateProjectionMatrix()
		emptyQueueCamera.aspect = rightW / h
		emptyQueueCamera.updateProjectionMatrix()

		renderer.setScissorTest(true)
		renderer.setViewport(0, 0, leftW, h)
		renderer.setScissor(0, 0, leftW, h)
		renderer.setClearColor(MAIN_PANEL_BG, 1)
		renderer.clear(true, true, true)
		renderer.render(scene, emptyMainCamera)

		renderer.setViewport(leftW, 0, rightW, h)
		renderer.setScissor(leftW, 0, rightW, h)
		renderer.setClearColor(QUEUE_PANEL_BG, 1)
		renderer.clear(true, true, true)
		renderer.render(scene, emptyQueueCamera)
		renderer.setScissorTest(false)
	}
	window.addEventListener('resize', () => {
		renderer.setSize(window.innerWidth, window.innerHeight)
		layoutServiceUI()
		renderInitialPanels()
	})
	renderInitialPanels()

	const loadResult = await new Promise((resolve) => {
		loadButton.addEventListener('click', async () => {
			try {
				loadButton.disabled = true
				loadEllipsis.stop()
				loadStatus.textContent = 'STEP 파일 선택 대기 중…'
				const stepFile = await pickStepFile()
				loadEllipsis.start(`업로드·전처리 중: ${stepFile.name}`)
				const buildStatus = await uploadAndBuildFromStep(stepFile, {
					onStatus: (msg, meta) => {
						loadEllipsis.start(`${msg} (${stepFile.name})`)
						const logs = meta?.logs
						if (Array.isArray(logs) && logs.length > 0) {
							loadLogTail.textContent = logs.join('\n')
							loadLogTail.style.display = 'block'
						}
					},
				})
				loadEllipsis.stop()
				loadLogTail.style.display = 'none'
				loadEllipsis.start('solid 메타 로드 중')
				const solidsPath =
					buildStatus?.solidsPath || buildStatus?.manifestPath
				if (!solidsPath) {
					throw new Error('서버 응답에 solidsPath가 없습니다.')
				}
				const solidsRes = await fetch(solidsPath, { cache: 'no-store' })
				if (!solidsRes.ok) {
					throw new Error(`${solidsPath}: ${solidsRes.status}`)
				}
				const solidsDoc = await solidsRes.json()
				const partsList = solidsDoc?.solids ?? solidsDoc?.parts
				const doc = {
					...solidsDoc,
					parts: Array.isArray(partsList) ? partsList : [],
				}
				loadEllipsis.setFinal('렌더링 준비 중')
				resolve({ voxelDoc: doc, voxelBase: buildStatus?.voxelBase || '' })
			} catch (e) {
				console.error(e)
				loadLogTail.style.display = 'none'
				alert(e.message)
				loadEllipsis.setFinal(`오류: ${e.message}`)
				loadButton.disabled = false
			}
		})
	})
	const { voxelDoc, voxelBase } = loadResult

	const isPartsMode = Array.isArray(voxelDoc?.parts) && voxelDoc.parts.length > 0
	if (!isPartsMode) {
		throw new Error('<stem>_solids.json에 solids 배열이 필요합니다.')
	}
	const stemForAssembly = String(voxelBase || '').trim()

	// 왼쪽: 조립 애니(sequence). 오른쪽 대기열: sequence 와 같은 순(위=먼저 조립).
	try {
		ambientLight.layers.enable(MAIN_VIEW_LAYER)
		ambientLight.layers.enable(QUEUE_VIEW_LAYER)
		directionalLight.layers.enable(MAIN_VIEW_LAYER)
		directionalLight.layers.enable(QUEUE_VIEW_LAYER)

		const mainCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 3000)
		// 대기열: 약간 넓은 시야로 상·하 빈 여백을 줄임
		const queueCamera = new THREE.PerspectiveCamera(46, 1, 0.1, 3000)

		let mainCameraOrbitReady = false
		let mainZoomDistMin = 12
		let mainZoomDistMax = 220
		let mainZoomSyncFromControls = false

		/** @type {ReturnType<typeof createAssemblyPlayback> | null} */
		let assemblyPlayback = null

		const mainToolbarUI = createMainToolbar(uiLayer, {
			onPlayFull: () => {
				if (assemblyPlayback?.isPaused()) {
					assemblyPlayback.resumeAssemblyPlayback()
				} else if (!assemblyPlayback?.isPlaybackActive()) {
					assemblyPlayback?.runAssemblyPlayFull()
				}
			},
			onStop: () => assemblyPlayback?.pauseAssemblyPlayback(),
			onResetView: () => resetMainView(),
			onZoomInput: (norm) => applyMainZoomNorm(norm),
			onScrubStart: () => {
				if (
					assemblyPlayback?.isPlaybackActive() &&
					!assemblyPlayback?.isPaused()
				) {
					assemblyPlayback.pauseAssemblyPlayback()
				}
			},
			onScrubInput: (norm) => {
				const total = assemblyPlayback?.getPlaybackDuration() ?? 0
				if (total > 0) {
					mainToolbarUI.setScrubberProgress(norm * total, total)
				}
				const seek = assemblyPlayback?.seekToProgress(norm)
				if (seek && typeof seek.then === 'function') {
					seek.then(() => {
						syncMainAssembledVisibility()
						layoutPartsCameras()
					})
				}
			},
		})

		const mainOrbitControls = new OrbitControls(
			mainCamera,
			mainToolbarUI.orbitPad
		)
		mainOrbitControls.enablePan = false
		mainOrbitControls.enableZoom = false
		mainOrbitControls.enableDamping = true
		mainOrbitControls.dampingFactor = 0.08
		mainOrbitControls.enabled = true

		function mainZoomNormFromCamera() {
			const d = mainCamera.position.distanceTo(mainOrbitControls.target)
			const span = Math.max(1e-6, mainZoomDistMax - mainZoomDistMin)
			return THREE.MathUtils.clamp(1 - (d - mainZoomDistMin) / span, 0, 1)
		}

		function applyMainZoomNorm(norm) {
			const t = mainOrbitControls.target
			const dist = THREE.MathUtils.lerp(
				mainZoomDistMax,
				mainZoomDistMin,
				THREE.MathUtils.clamp(norm, 0, 1)
			)
			const offset = mainCamera.position.clone().sub(t)
			if (offset.lengthSq() < 1e-8) {
				offset.set(1, 0.55, 1).normalize()
			}
			offset.setLength(dist)
			mainCamera.position.copy(t).add(offset)
			mainOrbitControls.update()
			mainZoomSyncFromControls = true
			mainToolbarUI.setZoomSlider(mainZoomNormFromCamera())
			mainZoomSyncFromControls = false
		}

		function syncMainZoomSliderFromCamera() {
			if (mainZoomSyncFromControls) return
			mainToolbarUI.setZoomSlider(mainZoomNormFromCamera())
		}

		mainOrbitControls.addEventListener('change', () => {
			syncMainZoomSliderFromCamera()
		})

		function layoutMainToolbar() {
			const w = window.innerWidth
			const leftW = Math.max(1, Math.floor(w * LEFT_PANEL_RATIO))
			mainToolbarUI.layout(8, 12, Math.max(1, leftW - 16))
		}

		mainCamera.layers.disable(QUEUE_VIEW_LAYER)
		mainCamera.layers.enable(MAIN_VIEW_LAYER)
		queueCamera.layers.disable(MAIN_VIEW_LAYER)
		queueCamera.layers.enable(QUEUE_VIEW_LAYER)

		let preloadedAssemblyDecoded = null
		if (stemForAssembly) {
			preloadedAssemblyDecoded = await fetchAssemblyDecoded(stemForAssembly)
		}
		if (!preloadedAssemblyDecoded) {
			throw new Error(
				`${stemForAssembly}_assembly.msgpack을 불러올 수 없습니다. 변환이 완료됐는지 확인하세요.`
			)
		}

		const gridMeta =
			gridMetaFromAssemblyDecoded(preloadedAssemblyDecoded) ??
			(await loadGridMeta(voxelDoc))

		const loadedParts = await Promise.all(
			voxelDoc.parts.map(async (spec, idx) => {
				const mesh = meshForManifestPartIndex(
					preloadedAssemblyDecoded,
					idx
				)
				if (!mesh?.vertices?.length) {
					console.warn('mesh 없음:', spec?.name, 'solidId=', spec?.solidId)
				}
				if (!spec.colors) {
					const hue = (idx * 137.5) % 360
					spec.colors = {
						main: `hsl(${hue}, 80%, 60%)`,
						accent: `hsl(${(hue + 25) % 360}, 85%, 68%)`,
					}
				}
				return { spec, mesh: mesh ?? null }
			})
		)

		const partsWithMesh = loadedParts.filter((p) => p.mesh?.vertices?.length)
		if (partsWithMesh.length === 0) {
			throw new Error(
				'msgpack에 meshes 데이터가 없습니다. STEP을 다시 변환해 주세요 (assembly_validation.py mesh 포함).'
			)
		}

		const mainAnchorVec = new THREE.Vector3()
		bboxCenterFromMeshParts(partsWithMesh, mainAnchorVec)
		const queuePartList = buildQueuePartList(
			loadedParts,
			preloadedAssemblyDecoded?.assembly ?? null,
			voxelDoc.parts,
			preloadedAssemblyDecoded
		).filter((p) => p.mesh?.vertices?.length)
		const failedN = queuePartList.filter((p) => p.failedCollision).length
		console.info(
			`[queue] ${queuePartList.length}개 (조립·충돌 실패 포함${failedN ? `, 충돌 ${failedN}개` : ''})`
		)

		const assemblyStagingRoot = new THREE.Group()
		traverseSetLayer(assemblyStagingRoot, MAIN_VIEW_LAYER)
		scene.add(assemblyStagingRoot)

		/** 재생 전 메인: 조립 완료 pose mesh 미리보기 */
		const mainPreviewRoot = new THREE.Group()
		traverseSetLayer(mainPreviewRoot, MAIN_VIEW_LAYER)
		scene.add(mainPreviewRoot)

		/** 메인 미리보기는 사용하지 않음 — 재생·스크럽은 assemblyStagingRoot 만 */
		function syncMainAssembledVisibility() {
			mainPreviewRoot.visible = false
		}

		function clearMainPreview() {
			while (mainPreviewRoot.children.length > 0) {
				mainPreviewRoot.remove(mainPreviewRoot.children[0])
			}
			syncMainAssembledVisibility()
		}

		/** 초기·리셋: 메인 메쉬 없음, 스크럽 0초 */
		function applyMainEmptyInitialView() {
			assemblyPlayback?.returnToPrePlaybackIdle()
			clearMainPreview()
			const total = assemblyPlayback?.getPlaybackDuration() ?? 0
			mainToolbarUI.setScrubberProgress(0, total)
			if (total > 0) {
				mainToolbarUI.setScrubberEnabled(true)
			}
			mainCameraOrbitReady = false
			updateMainZoomRangeFromScene()
			layoutPartsCameras()
		}

		clearMainPreview()

		function updateMainZoomRangeFromScene() {
			assemblyStagingRoot.updateMatrixWorld(true)
			const box = new THREE.Box3().setFromObject(assemblyStagingRoot)
			if (!box.isEmpty()) {
				const size = box.getSize(new THREE.Vector3()).length()
				mainZoomDistMin = Math.max(6, size * 0.12)
				mainZoomDistMax = Math.max(mainZoomDistMin * 1.8, size * 2.2)
			} else {
				const box = new THREE.Box3()
				for (const part of partsWithMesh) {
					const v = part.mesh.vertices
					const p = new THREE.Vector3()
					for (let i = 0; i < v.length; i += 3) {
						p.set(v[i], v[i + 1], v[i + 2])
						box.expandByPoint(p)
					}
				}
				if (!box.isEmpty()) {
					const size = box.getSize(new THREE.Vector3()).length()
					mainZoomDistMin = Math.max(6, size * 0.12)
					mainZoomDistMax = Math.max(mainZoomDistMin * 1.8, size * 2.2)
				}
			}
		}

		function resetMainView() {
			applyMainEmptyInitialView()
			applyMainZoomNorm(0.5)
		}

		const queueGroups = queuePartList.map((part) => {
			const g = createQueueMeshGroup(part.mesh, part.spec, undefined, {
				collisionFailed: Boolean(part.failedCollision),
			})
			g.userData.partName = part.spec?.name ?? ''
			traverseSetLayer(g, QUEUE_VIEW_LAYER)
			return g
		})

		const VISIBLE_QUEUE_COUNT = VISIBLE_QUEUE_SLOTS
		let queueStartIndex = 0

		const queueParent = new THREE.Group()
		queueParent.position.set(0, 0, 0)
		traverseSetLayer(queueParent, QUEUE_VIEW_LAYER)
		scene.add(queueParent)

		const queueSlotRoots = Array.from({ length: VISIBLE_QUEUE_COUNT }, () => {
			const slotRoot = new THREE.Group()
			traverseSetLayer(slotRoot, QUEUE_VIEW_LAYER)
			queueParent.add(slotRoot)
			return slotRoot
		})

		const queuePanelUI = createQueuePanelUI(VISIBLE_QUEUE_COUNT, uiLayer, {
			onSlotPlay: (queueIndex) => {
				if (assemblyPlayback.isPlaybackActive()) return
				assemblyPlayback.runAssemblyPlaySingleAtQueueIndex(queueIndex)
			},
		})
		queuePanelLabel.style.display = 'none'

		const queueDetailRoot = new THREE.Group()
		traverseSetLayer(queueDetailRoot, QUEUE_VIEW_LAYER)
		scene.add(queueDetailRoot)

		const queuePartByName = new Map()
		for (const part of queuePartList) {
			const nm = part.spec?.name
			if (nm) queuePartByName.set(nm, part)
		}

		let queueDetailMode = false
		let queueDetailCameraNeedsFit = false
		let queueScrollbarEl = null

		const queueInteractionLayer = document.createElement('div')
		queueInteractionLayer.style.position = 'fixed'
		queueInteractionLayer.style.display = 'none'
		queueInteractionLayer.style.zIndex = '22'
		queueInteractionLayer.style.background = 'transparent'
		queueInteractionLayer.style.pointerEvents = 'auto'
		queueInteractionLayer.style.cursor = 'grab'
		queueInteractionLayer.style.touchAction = 'none'
		document.body.appendChild(queueInteractionLayer)

		const queueBackButton = document.createElement('button')
		queueBackButton.type = 'button'
		queueBackButton.textContent = '← 목록'
		queueBackButton.style.padding = '8px 12px'
		queueBackButton.style.borderRadius = '10px'
		queueBackButton.style.border = '1px solid rgba(148, 163, 184, 0.55)'
		queueBackButton.style.background = '#ffffff'
		queueBackButton.style.color = '#374151'
		queueBackButton.style.font = '600 12px system-ui, -apple-system, sans-serif'
		queueBackButton.style.cursor = 'pointer'
		queueBackButton.style.boxShadow = '0 2px 10px rgba(0,0,0,0.12)'

		const queueDetailChrome = createQueueDetailChrome(
			uiLayer,
			queueBackButton
		)


		const queueRaycaster = new THREE.Raycaster()
		queueRaycaster.layers.set(QUEUE_VIEW_LAYER)

		const queueOrbitControls = new OrbitControls(
			queueCamera,
			queueInteractionLayer
		)
		queueOrbitControls.enabled = false
		queueOrbitControls.enablePan = false
		queueOrbitControls.autoRotate = true
		queueOrbitControls.autoRotateSpeed = 1.35
		queueOrbitControls.dampingFactor = 0.08
		queueOrbitControls.enableDamping = true

		function getQueuePointerNDCForDetail(event) {
			const viewRect = queueDetailChrome.viewEl.getBoundingClientRect()
			if (viewRect.width < 2 || viewRect.height < 2) return null
			if (
				event.clientX < viewRect.left ||
				event.clientX > viewRect.right ||
				event.clientY < viewRect.top ||
				event.clientY > viewRect.bottom
			) {
				return null
			}
			const x = ((event.clientX - viewRect.left) / viewRect.width) * 2 - 1
			const y = -((event.clientY - viewRect.top) / viewRect.height) * 2 + 1
			return new THREE.Vector2(x, y)
		}

		function getQueuePointerNDCForSlot(event, slotIdx) {
			const viewportEl = queuePanelUI.slotViewportEls[slotIdx]
			if (!viewportEl) return null
			const rect = viewportEl.getBoundingClientRect()
			if (rect.width < 2 || rect.height < 2) return null
			const x = ((event.clientX - rect.left) / rect.width) * 2 - 1
			const y = -((event.clientY - rect.top) / rect.height) * 2 + 1
			return new THREE.Vector2(x, y)
		}

		function visibleQueueSlotCount() {
			return Math.min(
				VISIBLE_QUEUE_COUNT,
				Math.max(0, queueGroups.length - queueStartIndex)
			)
		}

		function raycastQueuePart(event) {
			if (queueDetailMode) return null
			const slotIdx = queuePanelUI.findSlotIndexAt(
				event.clientX,
				event.clientY
			)
			if (slotIdx < 0) return null
			const slotRoot = queueSlotRoots[slotIdx]
			if (!slotRoot?.children.length) return null
			const ndc = getQueuePointerNDCForSlot(event, slotIdx)
			if (!ndc) return null
			queueRaycaster.setFromCamera(ndc, queueCamera)
			const hits = queueRaycaster.intersectObjects(slotRoot.children, true)
			if (!hits.length) return null
			return findQueuePartRoot(hits[0].object)
		}

		function layoutQueueDetailCamera() {
			if (!queueDetailMode) return
			const canvasRect = renderer.domElement.getBoundingClientRect()
			const viewRect = queueDetailChrome.viewEl.getBoundingClientRect()
			if (viewRect.width < 2 || viewRect.height < 2) return

			queueDetailRoot.updateMatrixWorld(true)
			const detailBox = new THREE.Box3().setFromObject(queueDetailRoot)
			const detailAspect = viewRect.width / viewRect.height
			queueCamera.aspect = detailAspect
			queueCamera.updateProjectionMatrix()
			if (!detailBox.isEmpty()) {
				fitPerspectiveCameraToBox(
					queueCamera,
					detailBox,
					detailAspect,
					new THREE.Vector3(0.35, 0.2, 1),
					1.22,
					0
				)
				queueOrbitControls.target.copy(
					detailBox.getCenter(new THREE.Vector3())
				)
			}
			queueOrbitControls.update()
			queueDetailCameraNeedsFit = false
		}

		function layoutQueuePanelChrome() {
			const w = window.innerWidth
			const h = Math.max(1, window.innerHeight)
			const leftW = Math.max(1, Math.floor(w * LEFT_PANEL_RATIO))
			const rightW = Math.max(1, w - leftW)
			const panelTop = 48
			const panelBottom = 10
			const panelHeight = Math.max(1, h - panelTop - panelBottom)
			const chromeLeft = leftW + 8
			const chromeTop = panelTop + 4
			const chromeW = Math.max(1, rightW - 16)
			const chromeH = panelHeight - 8

			if (queueDetailMode) {
				queueDetailChrome.layout(chromeLeft, chromeTop, chromeW, chromeH)
				rightPanelFrame.style.background = 'transparent'
				rightPanelFrame.style.boxShadow = 'none'

				const viewRect = queueDetailChrome.viewEl.getBoundingClientRect()
				queueInteractionLayer.style.left = `${viewRect.left}px`
				queueInteractionLayer.style.top = `${viewRect.top}px`
				queueInteractionLayer.style.width = `${Math.max(1, viewRect.width)}px`
				queueInteractionLayer.style.height = `${Math.max(1, viewRect.height)}px`
			} else {
				queuePanelUI.layout(chromeLeft, chromeTop, chromeW, chromeH)
				rightPanelFrame.style.background = 'transparent'
				rightPanelFrame.style.boxShadow = 'none'

				queueInteractionLayer.style.left = `${leftW}px`
				queueInteractionLayer.style.top = `${panelTop}px`
				queueInteractionLayer.style.width = `${rightW}px`
				queueInteractionLayer.style.height = `${panelHeight}px`
			}

			if (queueScrollbarEl && !queueDetailMode) {
				queueScrollbarEl.style.right = 'auto'
				queueScrollbarEl.style.left = `${leftW + rightW - 40}px`
				queueScrollbarEl.style.top = `${panelTop + 52}px`
				queueScrollbarEl.style.height = `${Math.max(120, panelHeight - 64)}px`
			}
		}

		/** @type {THREE.Group | null} */
		let queueDetailCollisionMarker = null

		function clearQueueDetail() {
			queueDetailCollisionMarker = null
			while (queueDetailRoot.children.length > 0) {
				queueDetailRoot.remove(queueDetailRoot.children[0])
			}
			queueDetailChrome.hideCollisionCallout()
		}

		function exitQueueDetail() {
			if (!queueDetailMode) return
			queueDetailMode = false
			clearQueueDetail()
			queueParent.visible = true
			queuePanelUI.setListModeVisible(true)
			queueInteractionLayer.style.display = 'none'
			queueOrbitControls.enabled = false
			queueDetailChrome.hide()
			if (queueScrollbarEl) queueScrollbarEl.style.display = ''
			relayoutQueueWindow()
			layoutQueuePanelChrome()
			layoutPartsCameras()
		}

		function showQueuePartDetail(partRow) {
			const name = partRow.spec?.name ?? ''
			const col = partRow.failedCollision
			clearQueueDetail()
			queueDetailMode = true
			queueParent.visible = false
			queuePanelUI.setListModeVisible(false)

			const g = createQueueMeshGroup(
				partRow.mesh,
				partRow.spec,
				QUEUE_DETAIL_TARGET_SIZE
			)
			g.userData.partName = name
			traverseSetLayer(g, QUEUE_VIEW_LAYER)
			if (col && gridMeta && partRow.mesh) {
				const { scale } = queueMeshPreviewFrame(
					partRow.mesh,
					QUEUE_DETAIL_TARGET_SIZE
				)
				const offset = collisionMarkerOffsetInQueueGroup(
					partRow.mesh,
					col,
					gridMeta,
					mainAnchorVec,
					QUEUE_DETAIL_TARGET_SIZE
				)
				const marker = createCollisionFogGroup(
					gridMeta.voxelSize * scale,
					offset
				)
				marker.position.copy(offset)
				marker.renderOrder = 12
				marker.traverse((obj) => {
					if (obj.isMesh) obj.renderOrder = 12
				})
				traverseSetLayer(marker, QUEUE_VIEW_LAYER)
				g.add(marker)
				queueDetailCollisionMarker = marker
			}

			queueDetailRoot.add(g)
			centerObjectGroupAtOrigin(g)

			if (col) {
				queueDetailChrome.showCollisionCallout(col, name)
			}

			queueDetailChrome.show(
				col ? `${name} · 충돌 지점` : name
			)
			queueDetailCameraNeedsFit = true
			queueInteractionLayer.style.display = 'block'
			layoutQueuePanelChrome()
			layoutQueueDetailCamera()
			queueOrbitControls.enabled = true

			if (queueScrollbarEl) queueScrollbarEl.style.display = 'none'
			layoutPartsCameras()
		}

		function relayoutQueueWindow() {
			for (const slotRoot of queueSlotRoots) {
				while (slotRoot.children.length > 0) {
					slotRoot.remove(slotRoot.children[0])
				}
			}
			const n = queueGroups.length
			if (n === 0) {
				queuePanelUI.updateSlots({
					startIndex: 0,
					total: 0,
					visibleCount: 0,
				})
				return
			}
			const visible = queueGroups.slice(
				queueStartIndex,
				queueStartIndex + VISIBLE_QUEUE_COUNT
			)
			if (visible.length === 0) return
			for (let i = 0; i < visible.length; i += 1) {
				const g = visible[i]
				if (g.parent) g.parent.remove(g)
				g.position.set(0, 0, 0)
				g.rotation.set(0, 0, 0)
				centerObjectGroupAtOrigin(g)
				queueSlotRoots[i].add(g)
			}
			const collisionFlags = visible.map((_, i) =>
				Boolean(queuePartList[queueStartIndex + i]?.failedCollision)
			)
			queuePanelUI.updateSlots({
				startIndex: queueStartIndex,
				total: n,
				visibleCount: visible.length,
				collisionFlags,
			})
		}

		function setupQueueScrollbar() {
			document
				.querySelectorAll('[data-dc-queue-scroll]')
				.forEach((el) => el.remove())
			const maxStart = Math.max(0, queueGroups.length - VISIBLE_QUEUE_COUNT)
			if (maxStart === 0) return

			const queueScrollbar = document.createElement('input')
			queueScrollbar.type = 'range'
			queueScrollbar.min = '0'
			queueScrollbar.max = String(maxStart)
			queueScrollbar.step = '1'
			queueScrollbar.value = String(maxStart)
			queueScrollbar.dataset.dcQueueScroll = '1'
			queueScrollbar.style.position = 'fixed'
			queueScrollbar.style.width = '28px'
			queueScrollbar.style.margin = '0'
			queueScrollbar.style.zIndex = '20'
			queueScrollbar.style.writingMode = 'bt-lr'
			queueScrollbar.style.webkitAppearance = 'slider-vertical'
			queueScrollbar.style.cursor = 'pointer'
			queueScrollbar.style.accentColor = '#64748b'
			queueScrollbar.setAttribute('orient', 'vertical')
			document.body.appendChild(queueScrollbar)
			queueScrollbarEl = queueScrollbar

			queueScrollbar.addEventListener('input', () => {
				const next = Number(queueScrollbar.value)
				if (!Number.isFinite(next)) return
				queueStartIndex = Math.max(
					0,
					Math.min(maxStart, maxStart - Math.round(next))
				)
				relayoutQueueWindow()
				layoutQueuePanelChrome()
				layoutPartsCameras()
			})
		}

		relayoutQueueWindow()
		setupQueueScrollbar()
		layoutQueuePanelChrome()

		renderer.domElement.addEventListener('pointerdown', (event) => {
			if (queueDetailMode || event.button !== 0) return
			const hit = raycastQueuePart(event)
			if (!hit) return
			const partRow = queuePartByName.get(hit.userData.partName)
			if (!partRow) return
			showQueuePartDetail(partRow)
		})

		renderer.domElement.addEventListener('pointermove', (event) => {
			if (queueDetailMode) {
				renderer.domElement.style.cursor = 'default'
				return
			}
			const slotIdx = queuePanelUI.findSlotIndexAt(
				event.clientX,
				event.clientY
			)
			if (slotIdx < 0) {
				renderer.domElement.style.cursor = 'default'
				return
			}
			const ndc = getQueuePointerNDCForSlot(event, slotIdx)
			const slotRoot = queueSlotRoots[slotIdx]
			if (!ndc || !slotRoot?.children.length) {
				renderer.domElement.style.cursor = 'default'
				return
			}
			queueRaycaster.setFromCamera(ndc, queueCamera)
			const hits = queueRaycaster.intersectObjects(slotRoot.children, true)
			renderer.domElement.style.cursor = hits.length ? 'pointer' : 'default'
		})

		queueBackButton.addEventListener('click', () => exitQueueDetail())
		window.addEventListener('keydown', (event) => {
			if (event.key === 'Escape') exitQueueDetail()
		})

		assemblyPlayback = createAssemblyPlayback({
			assemblyStagingRoot,
			gridMeta,
			mainAnchorVec,
			queuePartList,
			voxelDocParts: voxelDoc.parts,
			stemForAssembly,
			getPreloadedDecoded: () => preloadedAssemblyDecoded,
			setPreloadedDecoded: (v) => {
				preloadedAssemblyDecoded = v
			},
			onPlaybackActiveChange: (state) => {
				mainToolbarUI.setPlaybackState(state)
				syncMainAssembledVisibility()
			},
			onPlaybackProgress: (elapsed, total) => {
				mainToolbarUI.setScrubberProgress(elapsed, total)
				mainToolbarUI.setScrubberEnabled(total > 0)
			},
			onMainCameraLayout: layoutPartsCameras,
		})

		if (preloadedAssemblyDecoded) {
			void assemblyPlayback.ensureTimelineReady().then(() => {
				applyMainEmptyInitialView()
			})
		}

		const syncQueueSlotPlayLock = () => {
			queuePanelUI.setSlotsPlaybackLocked(assemblyPlayback.isPlaybackActive())
		}

		function layoutPartsCameras() {
			const w = window.innerWidth
			const h = Math.max(1, window.innerHeight)
			const leftW = Math.max(1, Math.floor(w * LEFT_PANEL_RATIO))
			const rightW = Math.max(1, w - leftW)
			mainCamera.aspect = leftW / h
			mainCamera.updateProjectionMatrix()
			queueCamera.aspect = rightW / h
			queueCamera.updateProjectionMatrix()

			assemblyStagingRoot.updateMatrixWorld(true)
			mainPreviewRoot.updateMatrixWorld(true)
			const mainFocusBox = new THREE.Box3().setFromObject(assemblyStagingRoot)
			if (mainFocusBox.isEmpty()) {
				mainFocusBox.setFromObject(mainPreviewRoot)
			}
			const focusCenter = new THREE.Vector3()
			if (!mainFocusBox.isEmpty()) {
				mainFocusBox.getCenter(focusCenter)
			} else {
				focusCenter.copy(mainAnchorVec)
			}

			if (!mainCameraOrbitReady) {
				if (!mainFocusBox.isEmpty()) {
					fitPerspectiveCameraToBox(
						mainCamera,
						mainFocusBox,
						mainCamera.aspect,
						new THREE.Vector3(1, 0.65, 1.2),
						2.08,
						0.055
					)
				} else {
					mainCamera.position.set(
						mainAnchorVec.x + 32,
						mainAnchorVec.y + 22,
						mainAnchorVec.z + 48
					)
					mainCamera.lookAt(mainAnchorVec)
					mainCamera.updateProjectionMatrix()
				}
				mainCameraOrbitReady = true
			}
			mainOrbitControls.target.copy(focusCenter)
			mainOrbitControls.update()
			updateMainZoomRangeFromScene()
			syncMainZoomSliderFromCamera()
			layoutMainToolbar()
		}
		layoutPartsCameras()
		mainToolbarUI.setVisible(true)

		const clock = new THREE.Clock()

		function animateParts() {
			requestAnimationFrame(animateParts)
			const delta = clock.getDelta()
			assemblyPlayback.tick(delta)
			mainOrbitControls.update()
			syncQueueSlotPlayLock()
			if (queueDetailMode && queueOrbitControls.enabled) {
				if (queueDetailCameraNeedsFit) layoutQueueDetailCamera()
				queueOrbitControls.update()
				if (queueDetailCollisionMarker) {
					updateCollisionMarkerPulse(
						queueDetailCollisionMarker,
						clock.getElapsedTime()
					)
				}
			}
			const w = window.innerWidth
			const h = Math.max(1, window.innerHeight)
			const leftW = Math.max(1, Math.floor(w * LEFT_PANEL_RATIO))
			const rightW = Math.max(1, w - leftW)

			renderer.setScissorTest(true)

			renderer.setViewport(0, 0, leftW, h)
			renderer.setScissor(0, 0, leftW, h)
			renderer.setClearColor(MAIN_PANEL_BG, 1)
			renderer.clear(true, true, true)
			renderer.render(scene, mainCamera)

			if (queueDetailMode) {
				const viewRect = queueDetailChrome.viewEl.getBoundingClientRect()
				queueInteractionLayer.style.left = `${viewRect.left}px`
				queueInteractionLayer.style.top = `${viewRect.top}px`
				queueInteractionLayer.style.width = `${Math.max(1, viewRect.width)}px`
				queueInteractionLayer.style.height = `${Math.max(1, viewRect.height)}px`

				renderer.setViewport(leftW, 0, rightW, h)
				renderer.setScissor(leftW, 0, rightW, h)
				renderer.setClearColor(QUEUE_PANEL_BG, 1)
				renderer.clear(true, true, true)

				const canvasRect = renderer.domElement.getBoundingClientRect()
				const vp = viewportRectForRenderer(viewRect, canvasRect)
				if (vp.w >= 2 && vp.h >= 2) {
					const detailAspect = vp.w / vp.h
					if (Math.abs(queueCamera.aspect - detailAspect) > 0.001) {
						queueCamera.aspect = detailAspect
						queueCamera.updateProjectionMatrix()
					}
					renderer.setViewport(vp.x, vp.y, vp.w, vp.h)
					renderer.setScissor(vp.x, vp.y, vp.w, vp.h)
					renderer.setClearColor(QUEUE_SLOT_BG, 1)
					renderer.clear(true, true, true)
					renderer.render(scene, queueCamera)
				}
			} else {
				renderer.setViewport(leftW, 0, rightW, h)
				renderer.setScissor(leftW, 0, rightW, h)
				renderer.setClearColor(QUEUE_PANEL_BG, 1)
				renderer.clear(true, true, true)

				const canvasRect = renderer.domElement.getBoundingClientRect()
				const slotViewports = queuePanelUI.getSlotViewportElements()
				const activeSlots = visibleQueueSlotCount()

				for (let i = 0; i < activeSlots; i += 1) {
					for (let j = 0; j < queueSlotRoots.length; j += 1) {
						queueSlotRoots[j].visible = j === i
					}

					const slotRoot = queueSlotRoots[i]
					if (!slotRoot.children.length) continue

					const rect = slotViewports[i].getBoundingClientRect()
					const vp = viewportRectForRenderer(rect, canvasRect)
					if (vp.w < 2 || vp.h < 2) continue

					slotRoot.updateMatrixWorld(true)
					const slotBox = new THREE.Box3().setFromObject(slotRoot)
					const slotAspect = vp.w / vp.h
					queueCamera.aspect = slotAspect
					queueCamera.updateProjectionMatrix()
					if (!slotBox.isEmpty()) {
						fitPerspectiveCameraToBox(
							queueCamera,
							slotBox,
							slotAspect,
							new THREE.Vector3(0.3, 0.12, 1),
							1.14,
							0
						)
					}

					renderer.setViewport(vp.x, vp.y, vp.w, vp.h)
					renderer.setScissor(vp.x, vp.y, vp.w, vp.h)
					renderer.setClearColor(QUEUE_SLOT_BG, 1)
					renderer.clear(true, true, true)
					renderer.render(scene, queueCamera)
				}

				for (let j = 0; j < queueSlotRoots.length; j += 1) {
					queueSlotRoots[j].visible =
						j < activeSlots && queueSlotRoots[j].children.length > 0
				}
			}

			renderer.setScissorTest(false)
		}
		animateParts()

		window.addEventListener('resize', () => {
			renderer.setSize(window.innerWidth, window.innerHeight)
			layoutQueuePanelChrome()
			layoutMainToolbar()
			if (queueDetailMode) queueDetailCameraNeedsFit = true
			layoutPartsCameras()
		})

		loadButton.remove()
		loadStatus.remove()
		hasLoadedConfig = true
	} catch (setupErr) {
		console.error(setupErr)
		alert(setupErr.message || String(setupErr))
		loadButton.disabled = false
	}
}

main().catch((err) => {
	console.error(err)
	alert(`뷰어 오류: ${err.message || err}`)
})

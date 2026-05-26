const MAIN_TOOLBAR_STYLE_ID = 'dc-main-toolbar-styles'

const MAIN_TOOLBAR_STYLES = `
.dc-main-toolbar {
	position: fixed;
	z-index: 38;
	display: flex;
	align-items: flex-end;
	justify-content: space-between;
	gap: 12px;
	padding: 0 14px 14px;
	box-sizing: border-box;
	pointer-events: none;
	font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
}

.dc-main-toolbar--hidden {
	display: none;
}

.dc-main-toolbar-left {
	display: flex;
	align-items: flex-end;
	gap: 10px;
	pointer-events: auto;
	flex: 1 1 auto;
	min-width: 0;
	max-width: calc(100% - 108px);
}

.dc-main-toolbar-right {
	display: flex;
	align-items: flex-end;
	gap: 10px;
	pointer-events: auto;
	flex-shrink: 0;
}

.dc-main-scrub-wrap {
	display: flex;
	flex-direction: column;
	justify-content: center;
	gap: 4px;
	flex: 1 1 auto;
	min-width: 260px;
	width: 100%;
	max-width: 100%;
	padding-bottom: 2px;
}

.dc-main-scrub-wrap--disabled {
	opacity: 0.45;
	pointer-events: none;
}

.dc-main-scrub-slider {
	width: 100%;
	height: 10px;
	margin: 0;
	padding: 0;
	cursor: pointer;
	accent-color: #60a5fa;
}

.dc-main-scrub-time {
	font-size: 9px;
	font-weight: 600;
	color: #94a3b8;
	text-align: center;
	letter-spacing: 0.02em;
	font-variant-numeric: tabular-nums;
}

.dc-main-icon-btn {
	width: 44px;
	height: 44px;
	padding: 0;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	border-radius: 12px;
	border: 1px solid rgba(96, 165, 250, 0.45);
	background: rgba(30, 41, 59, 0.92);
	color: #e0e7ff;
	cursor: pointer;
	box-shadow: 0 4px 12px rgba(0, 0, 0, 0.28);
	flex-shrink: 0;
}

.dc-main-icon-btn:hover:not(:disabled) {
	background: rgba(51, 65, 85, 0.95);
	border-color: rgba(147, 197, 253, 0.55);
}

.dc-main-icon-btn:disabled {
	opacity: 0.4;
	cursor: not-allowed;
}

.dc-main-icon-btn-play .dc-icon-play {
	width: 0;
	height: 0;
	margin-left: 4px;
	border-top: 9px solid transparent;
	border-bottom: 9px solid transparent;
	border-left: 14px solid #93c5fd;
}

.dc-main-icon-btn-stop .dc-icon-stop {
	display: flex;
	gap: 5px;
	align-items: center;
	justify-content: center;
}

.dc-main-icon-btn-stop .dc-icon-stop-bar {
	width: 5px;
	height: 18px;
	border-radius: 2px;
	background: #fca5a5;
}

.dc-main-icon-btn-reset .dc-icon-reset {
	width: 16px;
	height: 16px;
	border: 2px solid #cbd5e1;
	border-radius: 3px;
	box-sizing: border-box;
}

.dc-main-orbit-pad {
	width: 80px;
	height: 80px;
	border-radius: 50%;
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 2px;
	box-sizing: border-box;
	border: 1px solid rgba(96, 165, 250, 0.45);
	background: radial-gradient(
		circle at 35% 30%,
		rgba(51, 65, 85, 0.95) 0%,
		rgba(30, 41, 59, 0.92) 100%
	);
	box-shadow: 0 4px 14px rgba(0, 0, 0, 0.32);
	color: #e0e7ff;
	cursor: grab;
	touch-action: none;
	user-select: none;
	flex-shrink: 0;
}

.dc-main-orbit-pad:active {
	cursor: grabbing;
}

.dc-main-orbit-pad-icon {
	font-size: 20px;
	line-height: 1;
}

.dc-main-orbit-pad-label {
	font-size: 10px;
	font-weight: 700;
}

.dc-main-zoom-wrap {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 4px;
	height: 80px;
	flex-shrink: 0;
}

.dc-main-zoom-label {
	font-size: 9px;
	font-weight: 600;
	color: #94a3b8;
	letter-spacing: 0.02em;
}

.dc-main-zoom-slider {
	width: 28px;
	height: 64px;
	margin: 0;
	padding: 0;
	cursor: pointer;
	accent-color: #60a5fa;
	writing-mode: bt-lr;
	-webkit-appearance: slider-vertical;
}

.dc-main-zoom-slider[orient='vertical'] {
	writing-mode: vertical-lr;
	direction: rtl;
}
`

function ensureMainToolbarStyles() {
	if (document.getElementById(MAIN_TOOLBAR_STYLE_ID)) return
	const style = document.createElement('style')
	style.id = MAIN_TOOLBAR_STYLE_ID
	style.textContent = MAIN_TOOLBAR_STYLES
	document.head.appendChild(style)
}

/**
 * @param {HTMLElement} parentLayer
 * @param {{ onPlayFull: () => void, onStop: () => void, onResetView: () => void, onZoomInput: (norm: number) => void, onScrubStart?: () => void, onScrubInput: (norm: number) => void }} handlers
 */
export function createMainToolbar(parentLayer, handlers) {
	ensureMainToolbarStyles()

	const bar = document.createElement('div')
	bar.className = 'dc-main-toolbar dc-main-toolbar--hidden'

	const left = document.createElement('div')
	left.className = 'dc-main-toolbar-left'

	const playBtn = document.createElement('button')
	playBtn.type = 'button'
	playBtn.className = 'dc-main-icon-btn dc-main-icon-btn-play'
	playBtn.title = '전체 조립 재생'
	playBtn.setAttribute('aria-label', '전체 조립 재생')
	const playIcon = document.createElement('span')
	playIcon.className = 'dc-icon-play'
	playIcon.setAttribute('aria-hidden', 'true')
	playBtn.appendChild(playIcon)

	const stopBtn = document.createElement('button')
	stopBtn.type = 'button'
	stopBtn.className = 'dc-main-icon-btn dc-main-icon-btn-stop'
	stopBtn.title = '일시정지'
	stopBtn.setAttribute('aria-label', '일시정지')
	stopBtn.disabled = true
	const stopIcon = document.createElement('span')
	stopIcon.className = 'dc-icon-stop'
	stopIcon.setAttribute('aria-hidden', 'true')
	const bar1 = document.createElement('span')
	bar1.className = 'dc-icon-stop-bar'
	const bar2 = document.createElement('span')
	bar2.className = 'dc-icon-stop-bar'
	stopIcon.append(bar1, bar2)
	stopBtn.appendChild(stopIcon)

	const resetBtn = document.createElement('button')
	resetBtn.type = 'button'
	resetBtn.className = 'dc-main-icon-btn dc-main-icon-btn-reset'
	resetBtn.title = '메인 화면 초기 상태'
	resetBtn.setAttribute('aria-label', '메인 화면 초기 상태')
	const resetIcon = document.createElement('span')
	resetIcon.className = 'dc-icon-reset'
	resetIcon.setAttribute('aria-hidden', 'true')
	resetBtn.appendChild(resetIcon)

	const scrubWrap = document.createElement('div')
	scrubWrap.className = 'dc-main-scrub-wrap dc-main-scrub-wrap--disabled'
	const scrubSlider = document.createElement('input')
	scrubSlider.type = 'range'
	scrubSlider.className = 'dc-main-scrub-slider'
	scrubSlider.min = '0'
	scrubSlider.max = '10000'
	scrubSlider.step = '1'
	scrubSlider.value = '0'
	scrubSlider.disabled = true
	scrubSlider.title = '조립 애니메이션 시점'
	scrubSlider.setAttribute('aria-label', '조립 애니메이션 시점')
	const scrubTime = document.createElement('span')
	scrubTime.className = 'dc-main-scrub-time'
	scrubTime.textContent = '0:00 / 0:00'
	scrubWrap.append(scrubSlider, scrubTime)

	left.append(playBtn, stopBtn, resetBtn, scrubWrap)

	const right = document.createElement('div')
	right.className = 'dc-main-toolbar-right'

	const zoomWrap = document.createElement('div')
	zoomWrap.className = 'dc-main-zoom-wrap'
	const zoomLabel = document.createElement('span')
	zoomLabel.className = 'dc-main-zoom-label'
	zoomLabel.textContent = '확대'
	const zoomSlider = document.createElement('input')
	zoomSlider.type = 'range'
	zoomSlider.className = 'dc-main-zoom-slider'
	zoomSlider.min = '0'
	zoomSlider.max = '100'
	zoomSlider.step = '1'
	zoomSlider.value = '50'
	zoomSlider.setAttribute('orient', 'vertical')
	zoomSlider.title = '확대 · 축소'
	zoomWrap.append(zoomLabel, zoomSlider)

	const orbitPad = document.createElement('div')
	orbitPad.className = 'dc-main-orbit-pad'
	orbitPad.title = '드래그하여 회전'
	const orbitIcon = document.createElement('span')
	orbitIcon.className = 'dc-main-orbit-pad-icon'
	orbitIcon.textContent = '↻'
	const orbitLabel = document.createElement('span')
	orbitLabel.className = 'dc-main-orbit-pad-label'
	orbitLabel.textContent = '360°'
	orbitPad.append(orbitIcon, orbitLabel)

	right.append(zoomWrap, orbitPad)
	bar.append(left, right)
	parentLayer.appendChild(bar)

	playBtn.addEventListener('click', () => handlers.onPlayFull())
	stopBtn.addEventListener('click', () => handlers.onStop())
	resetBtn.addEventListener('click', () => handlers.onResetView())
	zoomSlider.addEventListener('input', () => {
		const norm = Number(zoomSlider.value) / 100
		if (Number.isFinite(norm)) handlers.onZoomInput(norm)
	})

	let scrubSyncing = false
	const scrubScale = 10000
	scrubSlider.addEventListener('pointerdown', () => {
		handlers.onScrubStart?.()
	})
	scrubSlider.addEventListener('input', () => {
		if (scrubSyncing) return
		const norm = Number(scrubSlider.value) / scrubScale
		if (Number.isFinite(norm)) handlers.onScrubInput(norm)
	})

	function formatScrubSec(sec) {
		const s = Math.max(0, Math.floor(sec))
		const m = Math.floor(s / 60)
		const r = s % 60
		return `${m}:${String(r).padStart(2, '0')}`
	}

	function layout(leftPx, bottomPx, widthPx) {
		bar.style.left = `${leftPx}px`
		bar.style.bottom = `${bottomPx}px`
		bar.style.width = `${Math.max(1, widthPx)}px`
	}

	function setVisible(visible) {
		bar.classList.toggle('dc-main-toolbar--hidden', !visible)
	}

	/** @param {'idle' | 'playing' | 'paused'} state */
	function setPlaybackState(state) {
		if (state === 'playing') {
			playBtn.disabled = true
			stopBtn.disabled = false
		} else if (state === 'paused') {
			playBtn.disabled = false
			stopBtn.disabled = true
		} else {
			playBtn.disabled = false
			stopBtn.disabled = true
		}
	}

	/** @param {number} norm 0=멀리, 1=가깝게 */
	function setZoomSlider(norm) {
		const v = Math.round(Math.min(1, Math.max(0, norm)) * 100)
		if (Number(zoomSlider.value) !== String(v)) {
			zoomSlider.value = String(v)
		}
	}

	function setScrubberEnabled(enabled) {
		scrubWrap.classList.toggle('dc-main-scrub-wrap--disabled', !enabled)
		scrubSlider.disabled = !enabled
	}

	/** @param {number} elapsedSec @param {number} totalSec */
	function setScrubberProgress(elapsedSec, totalSec) {
		const total = Math.max(0, totalSec)
		const elapsed = Math.max(0, Math.min(total, elapsedSec))
		const norm = total > 0 ? elapsed / total : 0
		const v = Math.round(norm * scrubScale)
		scrubSyncing = true
		if (Number(scrubSlider.value) !== v) {
			scrubSlider.value = String(v)
		}
		scrubTime.textContent = `${formatScrubSec(elapsed)} / ${formatScrubSec(total)}`
		scrubSyncing = false
	}

	return {
		bar,
		orbitPad,
		zoomSlider,
		scrubSlider,
		layout,
		setVisible,
		setPlaybackState,
		setZoomSlider,
		setScrubberEnabled,
		setScrubberProgress,
	}
}

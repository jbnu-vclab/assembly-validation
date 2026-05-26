const QUEUE_UI_STYLE_ID = 'dc-queue-panel-styles'

/** 대기열에 동시에 보여 줄 부품 수 */
export const VISIBLE_QUEUE_SLOTS = 3

const QUEUE_PANEL_STYLES = `
.dc-queue-panel {
	position: fixed;
	display: flex;
	flex-direction: column;
	gap: 10px;
	padding: 12px 14px 10px;
	pointer-events: none;
	z-index: 11;
	box-sizing: border-box;
	font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
}

.dc-queue-panel--hidden {
	display: none;
}

.dc-queue-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 10px;
	padding: 4px 4px 8px;
	border-bottom: 1px solid rgba(148, 163, 184, 0.35);
	background: rgba(255, 255, 255, 0.72);
	border-radius: 10px 10px 0 0;
}

.dc-queue-header-title {
	margin: 0;
	font-size: 14px;
	font-weight: 700;
	letter-spacing: -0.02em;
	color: #111827;
}

.dc-queue-header-range {
	font-size: 11px;
	font-weight: 600;
	color: #4b5563;
	padding: 4px 10px;
	border-radius: 999px;
	background: rgba(255, 255, 255, 0.9);
	border: 1px solid rgba(148, 163, 184, 0.45);
	white-space: nowrap;
}

.dc-queue-slots {
	flex: 1;
	min-height: 0;
	display: flex;
	flex-direction: column;
	gap: 10px;
}

.dc-queue-slot {
	position: relative;
	flex: 1;
	min-height: 0;
	display: flex;
	flex-direction: column;
	border-radius: 12px;
	border: 1px solid rgba(148, 163, 184, 0.55);
	/* 3D는 캔버스에 그림 — 칸 배경은 투명해야 가리지 않음 */
	background: transparent;
	box-shadow: 0 1px 4px rgba(15, 23, 42, 0.08);
	overflow: hidden;
}

.dc-queue-slot--empty {
	opacity: 0.35;
}

.dc-queue-slot--collision {
	background: rgba(229, 57, 53, 0.14);
	border-color: rgba(229, 57, 53, 0.42);
}

.dc-queue-slot--collision .dc-queue-slot-viewport::after {
	border-color: rgba(229, 57, 53, 0.28);
}

.dc-queue-slot-collision-badge {
	position: absolute;
	top: 8px;
	right: 8px;
	z-index: 2;
	display: none;
	align-items: center;
	padding: 3px 8px;
	border-radius: 6px;
	font-size: 10px;
	font-weight: 700;
	letter-spacing: -0.02em;
	color: #b91c1c;
	background: rgba(254, 226, 226, 0.92);
	border: 1px solid rgba(229, 57, 53, 0.35);
	box-shadow: 0 1px 4px rgba(185, 28, 28, 0.12);
	line-height: 1.2;
	pointer-events: none;
}

.dc-queue-slot--collision .dc-queue-slot-collision-badge {
	display: inline-flex;
}

.dc-queue-slot-play {
	position: absolute;
	left: 8px;
	bottom: 8px;
	z-index: 3;
	width: 30px;
	height: 30px;
	padding: 0;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	border-radius: 8px;
	border: 1px solid rgba(96, 165, 250, 0.5);
	background: linear-gradient(180deg, #ffffff 0%, #f1f5f9 100%);
	color: #2563eb;
	font-size: 13px;
	font-weight: 700;
	line-height: 1;
	cursor: pointer;
	pointer-events: auto;
	box-shadow: 0 2px 6px rgba(37, 99, 235, 0.15);
}

.dc-queue-slot-play:hover:not(:disabled) {
	background: #eff6ff;
	border-color: rgba(59, 130, 246, 0.65);
}

.dc-queue-slot-play:disabled {
	opacity: 0.45;
	cursor: not-allowed;
}

.dc-queue-slot-num {
	position: absolute;
	top: 8px;
	left: 8px;
	z-index: 2;
	min-width: 22px;
	height: 22px;
	padding: 0 6px;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	border-radius: 7px;
	font-size: 12px;
	font-weight: 700;
	color: #f8fafc;
	background: linear-gradient(135deg, #475569, #334155);
	border: 1px solid rgba(15, 23, 42, 0.2);
	box-shadow: 0 2px 6px rgba(15, 23, 42, 0.18);
	line-height: 1;
}

.dc-queue-slot-viewport {
	position: relative;
	flex: 1 1 auto;
	min-height: 72px;
	width: 100%;
	margin: 0;
	background: transparent;
}

.dc-queue-slot-viewport::after {
	content: '';
	position: absolute;
	inset: 6px 8px;
	border: 1px dashed rgba(148, 163, 184, 0.38);
	border-radius: 8px;
	pointer-events: none;
}

.dc-queue-slot--hidden {
	display: none;
}

.dc-queue-footer {
	text-align: center;
	font-size: 10px;
	font-weight: 500;
	color: #9ca3af;
	padding-top: 2px;
}

.dc-queue-detail {
	position: fixed;
	display: none;
	flex-direction: column;
	z-index: 12;
	box-sizing: border-box;
	pointer-events: none;
	font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
}

.dc-queue-detail--visible {
	display: flex;
}

.dc-queue-detail-header {
	flex: 0 0 48px;
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 0 12px 0 8px;
	background: #f4f6fb;
	border-bottom: 1px solid rgba(148, 163, 184, 0.38);
	pointer-events: auto;
}

.dc-queue-detail-title {
	flex: 1;
	min-width: 0;
	margin: 0;
	font-size: 12px;
	font-weight: 600;
	color: #4b5563;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.dc-queue-detail-view {
	flex: 1;
	min-height: 0;
	position: relative;
	/* 상세 3D 영역 — 캔버스가 비치도록 투명 */
	background: transparent;
}

.dc-collision-callout {
	position: absolute;
	right: 12px;
	top: 11%;
	transform: none;
	z-index: 4;
	display: none;
	flex-direction: column;
	gap: 6px;
	max-width: min(240px, 42vw);
	padding: 10px 12px 10px 14px;
	border-radius: 10px;
	background: rgba(255, 251, 251, 0.96);
	border: 1px solid rgba(229, 57, 53, 0.45);
	box-shadow: 0 6px 20px rgba(185, 28, 28, 0.18);
	pointer-events: none;
	font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
}

.dc-collision-callout::before {
	content: '';
	position: absolute;
	left: 28px;
	bottom: -9px;
	border-left: 9px solid transparent;
	border-right: 9px solid transparent;
	border-top: 9px solid rgba(229, 57, 53, 0.45);
}

.dc-collision-callout::after {
	content: '';
	position: absolute;
	left: 29px;
	bottom: -8px;
	border-left: 8px solid transparent;
	border-right: 8px solid transparent;
	border-top: 8px solid rgba(255, 251, 251, 0.96);
}

.dc-collision-callout--visible {
	display: flex;
}

.dc-collision-callout__badge {
	align-self: flex-start;
	padding: 2px 8px;
	border-radius: 999px;
	font-size: 10px;
	font-weight: 700;
	color: #fff;
	background: linear-gradient(135deg, #ef4444, #b91c1c);
	letter-spacing: -0.02em;
}

.dc-collision-callout__title {
	margin: 0;
	font-size: 12px;
	font-weight: 700;
	color: #7f1d1d;
	line-height: 1.3;
}

.dc-collision-callout__coords {
	margin: 0;
	font-size: 11px;
	font-weight: 600;
	font-variant-numeric: tabular-nums;
	color: #991b1b;
	letter-spacing: 0.02em;
}

.dc-collision-callout__detail {
	margin: 0;
	font-size: 10px;
	font-weight: 500;
	color: #6b7280;
	line-height: 1.45;
}
`

/**
 * @param {{ x: number, y: number, z: number, attempt?: string }} col
 * @param {string} [partTitle]
 */
export function formatCollisionCalloutContent(col, partTitle = '') {
	const attempt = String(col?.attempt ?? '').trim()
	let detail = '조립 경로 탐색 중 주변 솔리드와 겹쳐 분해가 중단되었습니다.'
	if (attempt.startsWith('MOVE')) {
		const axis = attempt.replace(/^MOVE\s*/i, '').trim() || '축'
		detail = `${axis} 방향 이동 시도 중 인접 솔리드와 겹침이 감지되었습니다.`
	} else if (attempt.startsWith('ROTATION')) {
		const kind = attempt.replace(/^ROTATION\s*/i, '').trim() || '회전'
		detail = `${kind} 중 형상이 주변 솔리드와 간섭했습니다.`
	}
	return {
		badge: '충돌 로그',
		title: partTitle ? `${partTitle} · 접촉 지점` : '접촉 지점',
		coords: `접촉 복셀  X ${col.x}  ·  Y ${col.y}  ·  Z ${col.z}`,
		detail,
	}
}

function ensureQueuePanelStyles() {
	if (document.getElementById(QUEUE_UI_STYLE_ID)) return
	const style = document.createElement('style')
	style.id = QUEUE_UI_STYLE_ID
	style.textContent = QUEUE_PANEL_STYLES
	document.head.appendChild(style)
}

/**
 * @param {number} slotCount
 * @param {HTMLElement} parentLayer pointer-events:none UI 레이어
 * @param {{ onSlotPlay?: (seqIndex: number) => void }} [options]
 */
export function createQueuePanelUI(slotCount, parentLayer, options = {}) {
	const { onSlotPlay } = options
	ensureQueuePanelStyles()

	const panel = document.createElement('div')
	panel.className = 'dc-queue-panel'
	panel.dataset.dcQueuePanel = '1'

	const header = document.createElement('header')
	header.className = 'dc-queue-header'

	const title = document.createElement('h2')
	title.className = 'dc-queue-header-title'
	title.textContent = '조립 대기열'

	const rangeEl = document.createElement('span')
	rangeEl.className = 'dc-queue-header-range'
	rangeEl.textContent = '—'

	header.append(title, rangeEl)

	const slotsWrap = document.createElement('div')
	slotsWrap.className = 'dc-queue-slots'

	/** @type {HTMLElement[]} */
	const slotElements = []
	/** @type {HTMLElement[]} */
	const slotViewportEls = []
	/** @type {HTMLElement[]} */
	const slotNumEls = []
	/** @type {HTMLButtonElement[]} */
	const slotPlayBtns = []

	for (let i = 0; i < slotCount; i += 1) {
		const slot = document.createElement('div')
		slot.className = 'dc-queue-slot'
		slot.dataset.slotIndex = String(i)

		const num = document.createElement('span')
		num.className = 'dc-queue-slot-num'
		num.textContent = String(i + 1)

		const collisionBadge = document.createElement('span')
		collisionBadge.className = 'dc-queue-slot-collision-badge'
		collisionBadge.textContent = '충돌 발생'

		const viewport = document.createElement('div')
		viewport.className = 'dc-queue-slot-viewport'

		const playBtn = document.createElement('button')
		playBtn.type = 'button'
		playBtn.className = 'dc-queue-slot-play'
		playBtn.title = '이 부품 조립 재생'
		playBtn.setAttribute('aria-label', '이 부품 조립 재생')
		playBtn.textContent = '▶'
		playBtn.addEventListener('click', (event) => {
			event.stopPropagation()
			const idx = Number(playBtn.dataset.seqIndex)
			if (!Number.isFinite(idx) || idx < 0) return
			onSlotPlay?.(idx)
		})

		slot.append(num, collisionBadge, viewport, playBtn)
		slotsWrap.appendChild(slot)

		slotElements.push(slot)
		slotViewportEls.push(viewport)
		slotNumEls.push(num)
		slotPlayBtns.push(playBtn)
	}

	const footer = document.createElement('div')
	footer.className = 'dc-queue-footer'
	footer.textContent = '부품 클릭 · 상세에서 드래그로 회전'

	panel.append(header, slotsWrap, footer)
	parentLayer.appendChild(panel)

	let panelLeft = 0
	let panelTop = 48
	let panelWidth = 300
	let panelHeight = 400

	function layout(leftPx, topPx, widthPx, heightPx) {
		panelLeft = leftPx
		panelTop = topPx
		panelWidth = Math.max(1, widthPx)
		panelHeight = Math.max(1, heightPx)
		panel.style.left = `${panelLeft}px`
		panel.style.top = `${panelTop}px`
		panel.style.width = `${panelWidth}px`
		panel.style.height = `${panelHeight}px`
	}

	/**
	 * @param {{ startIndex: number, total: number, visibleCount: number, collisionFlags?: boolean[] }} info
	 */
	function updateSlots(info) {
		const { startIndex, total, visibleCount, collisionFlags = [] } = info
		const end = Math.min(startIndex + visibleCount, total)
		rangeEl.textContent =
			total > 0 ? `${startIndex + 1}–${end} / ${total}` : '0 / 0'

		for (let i = 0; i < slotCount; i += 1) {
			const hasPart = i < visibleCount
			slotElements[i].classList.toggle('dc-queue-slot--empty', !hasPart)
			slotElements[i].classList.toggle('dc-queue-slot--hidden', !hasPart)
			slotElements[i].classList.toggle(
				'dc-queue-slot--collision',
				hasPart && Boolean(collisionFlags[i])
			)
			if (hasPart) {
				const seqIndex = startIndex + i
				slotNumEls[i].textContent = String(seqIndex + 1)
				slotPlayBtns[i].dataset.seqIndex = String(seqIndex)
				slotPlayBtns[i].style.display = ''
			} else {
				slotNumEls[i].textContent = '—'
				slotPlayBtns[i].style.display = 'none'
			}
		}
	}

	function setSlotsPlaybackLocked(locked) {
		for (const btn of slotPlayBtns) {
			btn.disabled = locked
		}
	}

	function setListModeVisible(visible) {
		panel.classList.toggle('dc-queue-panel--hidden', !visible)
	}

	/** 슬롯별 3D가 그려질 영역 (뷰포트 엘리먼트) */
	function getSlotViewportElements() {
		return slotViewportEls
	}

	/**
	 * @param {number} clientX
	 * @param {number} clientY
	 * @returns {number} 슬롯 인덱스 (0..slotCount-1), 없으면 -1
	 */
	function findSlotIndexAt(clientX, clientY) {
		for (let i = 0; i < slotViewportEls.length; i += 1) {
			const r = slotViewportEls[i].getBoundingClientRect()
			if (
				clientX >= r.left &&
				clientX <= r.right &&
				clientY >= r.top &&
				clientY <= r.bottom
			) {
				return i
			}
		}
		return -1
	}

	return {
		panel,
		rangeEl,
		footer,
		slotElements,
		slotViewportEls,
		layout,
		updateSlots,
		setListModeVisible,
		getSlotViewportElements,
		findSlotIndexAt,
		setSlotsPlaybackLocked,
	}
}

/**
 * 상세 보기: 상단 고체 툴바 + 그 아래만 3D (부품이 UI에 가리지 않음)
 * @param {HTMLElement} parentLayer
 * @param {HTMLButtonElement} backButton
 */
export function createQueueDetailChrome(parentLayer, backButton) {
	ensureQueuePanelStyles()

	const wrap = document.createElement('div')
	wrap.className = 'dc-queue-detail'

	const header = document.createElement('header')
	header.className = 'dc-queue-detail-header'

	backButton.style.position = 'static'
	backButton.style.display = ''

	const title = document.createElement('p')
	title.className = 'dc-queue-detail-title'
	title.textContent = '부품 상세'

	const viewEl = document.createElement('div')
	viewEl.className = 'dc-queue-detail-view'

	const collisionCallout = document.createElement('aside')
	collisionCallout.className = 'dc-collision-callout'
	collisionCallout.setAttribute('aria-live', 'polite')
	collisionCallout.innerHTML = `
		<span class="dc-collision-callout__badge"></span>
		<p class="dc-collision-callout__title"></p>
		<p class="dc-collision-callout__coords"></p>
		<p class="dc-collision-callout__detail"></p>
	`
	viewEl.appendChild(collisionCallout)

	const calloutBadge = collisionCallout.querySelector('.dc-collision-callout__badge')
	const calloutTitle = collisionCallout.querySelector('.dc-collision-callout__title')
	const calloutCoords = collisionCallout.querySelector('.dc-collision-callout__coords')
	const calloutDetail = collisionCallout.querySelector('.dc-collision-callout__detail')

	header.append(backButton, title)
	wrap.append(header, viewEl)
	parentLayer.appendChild(wrap)

	function layout(leftPx, topPx, widthPx, heightPx) {
		wrap.style.left = `${leftPx}px`
		wrap.style.top = `${topPx}px`
		wrap.style.width = `${Math.max(1, widthPx)}px`
		wrap.style.height = `${Math.max(1, heightPx)}px`
	}

	function show(partTitle) {
		title.textContent = partTitle
			? `${partTitle} · 드래그로 회전`
			: '부품 상세 · 드래그로 회전'
		wrap.classList.add('dc-queue-detail--visible')
	}

	function hide() {
		wrap.classList.remove('dc-queue-detail--visible')
		hideCollisionCallout()
	}

	/**
	 * @param {{ x: number, y: number, z: number, attempt?: string }} collision
	 * @param {string} [partTitle]
	 */
	function showCollisionCallout(collision, partTitle = '') {
		const content = formatCollisionCalloutContent(collision, partTitle)
		calloutBadge.textContent = content.badge
		calloutTitle.textContent = content.title
		calloutCoords.textContent = content.coords
		calloutDetail.textContent = content.detail
		collisionCallout.classList.add('dc-collision-callout--visible')
	}

	function hideCollisionCallout() {
		collisionCallout.classList.remove('dc-collision-callout--visible')
	}

	return {
		wrap,
		viewEl,
		titleEl: title,
		layout,
		show,
		hide,
		showCollisionCallout,
		hideCollisionCallout,
	}
}

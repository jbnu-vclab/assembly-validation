/**
 * Three.js 예제와 동일한 WEBGL 헬퍼 (브라우저 전용)
 */
const WEBGL = {
	isWebGLAvailable: function () {
		try {
			const canvas = document.createElement('canvas')
			return !!(
				window.WebGLRenderingContext &&
				(canvas.getContext('webgl') || canvas.getContext('experimental-webgl'))
			)
		} catch (e) {
			return false
		}
	},

	getWebGLErrorMessage: function () {
		const element = document.createElement('div')
		element.id = 'webglmessage'
		element.style.fontFamily = 'monospace'
		element.style.fontSize = '13px'
		element.style.fontWeight = 'normal'
		element.style.textAlign = 'center'
		element.style.background = '#fff'
		element.style.color = '#000'
		element.style.padding = '1.5em'
		element.style.width = '400px'
		element.style.margin = '5em auto 0'

		element.innerHTML =
			'Your browser does not seem to support <a href="http://khronos.org/webgl/wiki/Getting_a_WebGL_Implementation" style="color:#000">WebGL</a>.'

		return element
	},
}

export { WEBGL }

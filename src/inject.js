// Content script: applies an "e-ink" friendly style.
//
// Design:
//   - All visual rules live in an injected <style> scoped under
//     html.eink-viewable-on, so toggling the effect is just a class flip
//     (no page reload required).
//   - JS only handles the dynamic bits that need computed-style inspection:
//     dark backgrounds, gradients, light borders. Those nodes are tagged
//     with marker classes; the actual styling still comes from CSS.
//   - Each node is processed at most once (WeakSet). Mutations are
//     batched via requestIdleCallback to avoid blocking the main thread.

const HTML_CLASS = 'eink-viewable-on'
const STYLE_ID = 'eink-viewable-style'
const SVG_WRAPPER_ID = 'eink-viewable-svg-wrapper'
const SVG_FILTER_ID = 'eink-viewable-svg-defs'
const IMG_FILTER_ID = 'eink-img-filter'
const FIX_BG_CLASS = 'eink-viewable-fix-bg'
const FIX_BORDER_CLASS = 'eink-viewable-fix-border'
const SVG_CLASS = 'eink-viewable-svg'
const SKIP_FILTER_CLASS = 'eink-skip-filter'

// Live image filter parameters; replaced from storage on activation and
// whenever the user moves the sliders in the options page.
let currentImageFilter = { gamma: 0.75, brightness: 0.05, sharpness: 0.3, smallThreshold: 24 }

// Build the SVG <filter> markup from a parameter object.
//   gamma       — exponent on each channel (< 1 brightens, > 1 darkens)
//   brightness  — additive offset (and small amplitude lift) on each channel
//   sharpness   — side weight in a 3x3 unsharp-mask kernel; the kernel is
//                 always normalized so its center = 1 + 4 * sharpness so
//                 global brightness is preserved through this step.
function buildSvgFilterMarkup(f) {
    const amp = (1 + f.brightness).toFixed(3)
    const exp = f.gamma.toFixed(3)
    const off = f.brightness.toFixed(3)
    const s = f.sharpness.toFixed(3)
    const center = (1 + 4 * f.sharpness).toFixed(3)
    return `
<svg id="${SVG_FILTER_ID}" aria-hidden="true"
     style="position:absolute;width:0;height:0;pointer-events:none;overflow:hidden"
     xmlns="http://www.w3.org/2000/svg">
    <filter id="${IMG_FILTER_ID}" color-interpolation-filters="sRGB">
        <feColorMatrix type="saturate" values="0"/>
        <feComponentTransfer>
            <feFuncR type="gamma" amplitude="${amp}" exponent="${exp}" offset="${off}"/>
            <feFuncG type="gamma" amplitude="${amp}" exponent="${exp}" offset="${off}"/>
            <feFuncB type="gamma" amplitude="${amp}" exponent="${exp}" offset="${off}"/>
        </feComponentTransfer>
        <feConvolveMatrix order="3" preserveAlpha="true"
            kernelMatrix="0 -${s} 0  -${s} ${center} -${s}  0 -${s} 0"/>
    </filter>
</svg>
`
}

const STATIC_CSS = `
html.${HTML_CLASS},
html.${HTML_CLASS} body {
    background: #fff !important;
    color: #000 !important;
}

/* Force every element + pseudo to render text in solid black. We have to
   set -webkit-text-fill-color (used by gradient text), text-decoration
   color, and caret color in addition to the regular color property. */
html.${HTML_CLASS} *,
html.${HTML_CLASS} *::before,
html.${HTML_CLASS} *::after,
html.${HTML_CLASS} *::placeholder,
html.${HTML_CLASS} *::first-letter,
html.${HTML_CLASS} *::first-line {
    color: #000 !important;
    -webkit-text-fill-color: #000 !important;
    text-decoration-color: #000 !important;
    caret-color: #000 !important;
    text-shadow: none !important;
    box-shadow: none !important;
    filter: none !important;
}

/* Defeat gradient-text patterns: many sites use
   background: linear-gradient(...); -webkit-background-clip: text; color: transparent;
   Reset the clip so the text becomes solid (and our color rule wins). */
html.${HTML_CLASS} * {
    -webkit-background-clip: border-box !important;
    background-clip: border-box !important;
}

/* SVG fills / strokes — applies to <svg> AND every descendant so icons
   that hard-code fill="white" or fill: var(--brand) still render black. */
html.${HTML_CLASS} svg,
html.${HTML_CLASS} svg *,
html.${HTML_CLASS} .${SVG_CLASS},
html.${HTML_CLASS} .${SVG_CLASS} * {
    fill: currentColor !important;
    stroke: currentColor !important;
}

/* Re-enable a desaturating filter for raster media. The universal
   filter:none rule above is overridden by these more-targeted selectors
   appearing later in source order. We use an SVG filter (defined in the
   injected <svg>) which gives gamma + light sharpening on top of pure
   grayscale — much more legible on greyscale e-ink panels. */
html.${HTML_CLASS} img:not(.${SKIP_FILTER_CLASS}),
html.${HTML_CLASS} video:not(.${SKIP_FILTER_CLASS}),
html.${HTML_CLASS} canvas:not(.${SKIP_FILTER_CLASS}),
html.${HTML_CLASS} picture:not(.${SKIP_FILTER_CLASS}),
html.${HTML_CLASS} svg image:not(.${SKIP_FILTER_CLASS}) {
    filter: url(#${IMG_FILTER_ID}) !important;
}

/* Small icons / avatars / favicons get marked as skipped — keep their
   original color since grayscale-then-shrink looks muddy at <24px. */
html.${HTML_CLASS} .${SKIP_FILTER_CLASS} {
    filter: none !important;
}

html.${HTML_CLASS} .${FIX_BG_CLASS} {
    background-color: #fff !important;
    background-image: none !important;
}
html.${HTML_CLASS} pre.${FIX_BG_CLASS} {
    border: 1px solid #000 !important;
}
html.${HTML_CLASS} .${FIX_BORDER_CLASS} {
    border-color: #000 !important;
}

/* <mark> highlights: a white bg + black text loses its purpose, so give
   it an underline instead. */
html.${HTML_CLASS} mark {
    background: #fff !important;
    color: #000 !important;
    border-bottom: 2px solid #000 !important;
    padding: 0 1px !important;
}

/* Form controls often have OS-level styles that ignore our overrides. */
html.${HTML_CLASS} input,
html.${HTML_CLASS} textarea,
html.${HTML_CLASS} select,
html.${HTML_CLASS} button {
    background-color: #fff !important;
    color: #000 !important;
    -webkit-text-fill-color: #000 !important;
}
html.${HTML_CLASS} input::placeholder,
html.${HTML_CLASS} textarea::placeholder {
    color: #555 !important;
    -webkit-text-fill-color: #555 !important;
}
`

function parseRgbString(rgb) {
    return rgb.replace(/[^\d,.]/g, '').split(',')
}

function getBrightness(color) {
    const c = parseRgbString(color)
    return (c[0] * 299 + c[1] * 587 + c[2] * 114) / 1000
}

function isDark(color) {
    return getBrightness(color) < 128
}

const ignoreTagNames = new Set([
    'html', 'head', 'script', 'style', 'link', 'meta', 'title',
    'img', 'video', 'audio', 'picture', 'canvas', 'iframe'
])

function ignoreTag(node) {
    if (!node || node.nodeType !== 1 || !node.tagName) return true
    const tag = node.tagName.toLowerCase()
    if (ignoreTagNames.has(tag)) return true
    if (tag.includes('-') && /(video|audio|img|player|canvas)/.test(tag)) return true
    if (tag === 'input' && (node.type === 'checkbox' || node.type === 'radio')) return true
    return false
}

const processed = new WeakSet()

// Decide whether an <img>/<video>/<canvas> is small enough that we'd
// rather leave it alone than apply the e-ink filter to it.
function applySmallMediaSkip(media) {
    let w = 0
    let h = 0
    if (media.tagName === 'IMG') {
        w = media.naturalWidth || 0
        h = media.naturalHeight || 0
    }
    if (!w || !h) {
        const r = media.getBoundingClientRect()
        w = Math.max(w, r.width)
        h = Math.max(h, r.height)
    }
    const max = Math.max(w, h)
    if (max > 0 && max <= currentImageFilter.smallThreshold) {
        media.classList.add(SKIP_FILTER_CLASS)
    } else {
        media.classList.remove(SKIP_FILTER_CLASS)
    }
}

function processMedia(media) {
    if (media.tagName === 'IMG') {
        if (media.complete && media.naturalWidth) {
            applySmallMediaSkip(media)
        } else {
            const onReady = () => applySmallMediaSkip(media)
            media.addEventListener('load', onReady, { once: true })
            media.addEventListener('error', onReady, { once: true })
            // Also try right now in case layout already gave it a size.
            applySmallMediaSkip(media)
        }
        return
    }
    // Videos and canvases: use rendered size only.
    applySmallMediaSkip(media)
}

function processNode(node) {
    if (!node || node.nodeType !== 1) return
    if (processed.has(node)) return
    if (!node.isConnected) return
    if (!node.tagName) return

    const tag = node.tagName.toLowerCase()

    // Media tags get a separate, lightweight pass: we only need to decide
    // whether to skip the e-ink filter, not rewrite their backgrounds.
    if (tag === 'img' || tag === 'video' || tag === 'canvas') {
        processed.add(node)
        processMedia(node)
        return
    }

    if (ignoreTag(node)) return
    processed.add(node)

    const style = window.getComputedStyle(node)

    // Aggressive background normalization: convert any opaque, non-near-white
    // background to white. This catches saturated highlight colors (deep
    // reds, brand blues, etc.) whose brightness happens to land above the
    // old isDark() threshold but still looks dark on greyscale e-ink.
    let needBgFix = false
    const bg = style.backgroundColor
    if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') {
        const c = parseRgbString(bg)
        const alpha = isNaN(parseFloat(c[3])) ? 1 : parseFloat(c[3])
        if (alpha >= 0.3) {
            const brightness = getBrightness(bg)
            // Anything not visually "almost white" gets flattened.
            if (brightness < 240) {
                needBgFix = true
            }
        }
    }

    const bgImage = style.backgroundImage
    if (bgImage && bgImage !== 'none') {
        // Any kind of gradient or image background risks dark patches.
        if (
            bgImage.includes('gradient') ||
            bgImage.includes('url(')
        ) {
            // Don't flatten background images on tags that rely on them
            // for icons (often <i>, <span> with explicit width/height
            // and no text). Only flatten if the element has children or
            // text — i.e. it's a content container, not an icon.
            const hasContent = node.textContent && node.textContent.trim().length > 0
            if (hasContent || bgImage.includes('gradient')) {
                needBgFix = true
            }
        }
    }

    if (needBgFix) node.classList.add(FIX_BG_CLASS)

    const borderColor = style.borderColor
    if (borderColor && borderColor !== 'rgb(0, 0, 0)' && !isDark(borderColor)) {
        const borderWidth = parseFloat(style.borderTopWidth) +
            parseFloat(style.borderRightWidth) +
            parseFloat(style.borderBottomWidth) +
            parseFloat(style.borderLeftWidth)
        if (borderWidth > 0) node.classList.add(FIX_BORDER_CLASS)
    }
}

// Batched, idle-scheduled processing queue.
let pending = []
let scheduled = false
const SCHEDULER = (typeof requestIdleCallback === 'function')
    ? (cb) => requestIdleCallback(cb, { timeout: 250 })
    : (cb) => setTimeout(cb, 16)

function flush() {
    scheduled = false
    const start = performance.now()
    const queue = pending
    pending = []
    for (let i = 0; i < queue.length; i++) {
        processNode(queue[i])
        // Yield if we've been processing too long; reschedule the rest.
        if ((i & 0xff) === 0xff && performance.now() - start > 8) {
            pending = pending.concat(queue.slice(i + 1))
            schedule()
            return
        }
    }
}

function schedule() {
    if (scheduled) return
    scheduled = true
    SCHEDULER(flush)
}

function enqueue(node) {
    if (!node || node.nodeType !== 1) return
    if (processed.has(node)) return
    pending.push(node)
    schedule()
}

function enqueueSubtree(root) {
    enqueue(root)
    if (root.nodeType !== 1 || !root.querySelectorAll) return
    const all = root.querySelectorAll('*')
    for (let i = 0; i < all.length; i++) enqueue(all[i])
}

function ensureStyleInjected() {
    if (!document.getElementById(STYLE_ID)) {
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = STATIC_CSS
        const target = document.head || document.documentElement
        if (target) target.appendChild(style)
    }
    ensureSvgFilterInjected()
}

function ensureSvgFilterInjected() {
    // Only attach to <body>. Attaching to <html> directly (as a sibling of
    // <head>) is invalid HTML and can interfere with the page's
    // render-blocking expectations (e.g. <link rel="expect">), so we wait
    // until the body is available.
    if (!document.body) {
        document.addEventListener('DOMContentLoaded', ensureSvgFilterInjected, { once: true })
        return
    }
    let wrapper = document.getElementById(SVG_WRAPPER_ID)
    if (!wrapper) {
        wrapper = document.createElement('div')
        wrapper.id = SVG_WRAPPER_ID
        wrapper.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none'
        wrapper.setAttribute('aria-hidden', 'true')
        document.body.appendChild(wrapper)
    }
    wrapper.innerHTML = buildSvgFilterMarkup(currentImageFilter)
}

// Re-evaluate the small-image skip class on every media element, used
// after the user changes smallThreshold so existing imgs respond live.
function rebalanceSmallMediaSkip() {
    const all = document.querySelectorAll('img, video, canvas')
    for (let i = 0; i < all.length; i++) applySmallMediaSkip(all[i])
}

let observer = null

function startObserving() {
    if (observer || !document.body) return
    // Only watch childList - attribute changes used to trigger an entire
    // subtree rewalk in the old code, which caused noticeable jank on SPAs.
    // Newly inserted nodes are picked up via childList + subtree.
    observer = new MutationObserver((list) => {
        for (let i = 0; i < list.length; i++) {
            const m = list[i]
            const added = m.addedNodes
            for (let j = 0; j < added.length; j++) {
                enqueueSubtree(added[j])
            }
        }
    })
    observer.observe(document.body, { childList: true, subtree: true })
}

function stopObserving() {
    if (!observer) return
    observer.disconnect()
    observer = null
}

function activate() {
    ensureStyleInjected()
    document.documentElement.classList.add(HTML_CLASS)
    if (document.body) {
        enqueueSubtree(document.body)
        startObserving()
    } else {
        document.addEventListener('DOMContentLoaded', () => {
            ensureSvgFilterInjected()
            enqueueSubtree(document.body)
            startObserving()
        }, { once: true })
    }
}

function deactivate() {
    document.documentElement.classList.remove(HTML_CLASS)
    stopObserving()
    pending = []
    // We deliberately leave marker classes on nodes: they're harmless when
    // the html.${HTML_CLASS} ancestor selector no longer matches, and
    // re-activating will be cheap because the WeakSet is still warm.
}

let currentlyActive = false

async function evaluate() {
    try {
        const settings = await SiteRules.getSettings()
        currentImageFilter = settings.imageFilter
        const next = SiteRules.shouldApply(window.location.host, settings)
        if (next === currentlyActive) {
            // Active-state unchanged but filter params might have moved —
            // re-render the SVG and re-balance small-image skips so live
            // slider edits take effect without a reload.
            if (currentlyActive) {
                ensureSvgFilterInjected()
                rebalanceSmallMediaSkip()
            }
            return
        }
        currentlyActive = next
        if (next) activate()
        else deactivate()
    } catch (e) {
        // storage may be unavailable on some restricted pages
    }
}

evaluate()

chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return
    if (
        changes[SiteRules.STORAGE_KEYS.mode] ||
        changes[SiteRules.STORAGE_KEYS.blacklist] ||
        changes[SiteRules.STORAGE_KEYS.whitelist] ||
        changes[SiteRules.STORAGE_KEYS.globalPaused] ||
        changes[SiteRules.STORAGE_KEYS.imageFilter]
    ) {
        evaluate()
    }
})

// Legacy reload handler kept for backwards-compat with older popup builds.
chrome.runtime.onMessage.addListener((request) => {
    if (request === 'reload') evaluate()
    return true
})

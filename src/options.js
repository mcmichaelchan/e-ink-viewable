const {
    MODES,
    STORAGE_KEYS,
    getSettings,
    setSettings,
    setImageFilter,
    DEFAULT_IMAGE_FILTER,
    normalizePattern,
    migrateLegacyIfNeeded
} = SiteRules

const SLIDERS = [
    { key: 'gamma', input: 'filter-gamma', out: 'filter-gamma-out', fmt: (v) => v.toFixed(2) },
    { key: 'brightness', input: 'filter-brightness', out: 'filter-brightness-out', fmt: (v) => v.toFixed(2) },
    { key: 'sharpness', input: 'filter-sharpness', out: 'filter-sharpness-out', fmt: (v) => v.toFixed(2) },
    { key: 'smallThreshold', input: 'filter-threshold', out: 'filter-threshold-out', fmt: (v) => `${Math.round(v)}px` }
]

let state = { mode: MODES.BLACKLIST, blacklist: [], whitelist: [] }

function flashSaved() {
    const el = document.getElementById('saved')
    el.textContent = 'Saved.'
    clearTimeout(flashSaved._t)
    flashSaved._t = setTimeout(() => {
        el.textContent = ''
    }, 1200)
}

function renderList(listId, items, listKey) {
    const ul = document.getElementById(listId)
    ul.innerHTML = ''
    if (!items.length) {
        const li = document.createElement('li')
        li.className = 'empty'
        li.textContent = '(empty)'
        ul.appendChild(li)
        return
    }
    items.forEach((pattern, idx) => {
        const li = document.createElement('li')
        const span = document.createElement('span')
        span.textContent = pattern
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.textContent = 'Remove'
        btn.addEventListener('click', () => removeAt(listKey, idx))
        li.appendChild(span)
        li.appendChild(btn)
        ul.appendChild(li)
    })
}

function renderMode() {
    document.querySelectorAll('input[name="mode"]').forEach((el) => {
        el.checked = el.value === state.mode
    })
}

function renderSliders() {
    if (!state.imageFilter) return
    SLIDERS.forEach(({ key, input, out, fmt }) => {
        const el = document.getElementById(input)
        const o = document.getElementById(out)
        if (!el || !o) return
        const v = state.imageFilter[key]
        if (typeof v !== 'number') return
        if (Number(el.value) !== v) el.value = String(v)
        o.textContent = fmt(v)
    })
}

function renderAll() {
    renderMode()
    renderSliders()
    renderList('blacklist', state.blacklist, STORAGE_KEYS.blacklist)
    renderList('whitelist', state.whitelist, STORAGE_KEYS.whitelist)
}

async function load() {
    await migrateLegacyIfNeeded()
    state = await getSettings()
    renderAll()
}

async function saveList(listKey, list) {
    state[listKey] = list
    await setSettings({ [listKey]: list })
    renderList(
        listKey === STORAGE_KEYS.blacklist ? 'blacklist' : 'whitelist',
        list,
        listKey
    )
    flashSaved()
}

async function addPattern(listKey, raw) {
    const pattern = normalizePattern(raw)
    if (!pattern) return false
    const current = state[listKey].slice()
    if (current.includes(pattern)) return false
    current.push(pattern)
    await saveList(listKey, current)
    return true
}

async function removeAt(listKey, idx) {
    const current = state[listKey].slice()
    current.splice(idx, 1)
    await saveList(listKey, current)
}

function wireAdd(inputId, buttonId, listKey) {
    const input = document.getElementById(inputId)
    const button = document.getElementById(buttonId)
    const submit = async () => {
        const ok = await addPattern(listKey, input.value)
        if (ok) input.value = ''
        input.focus()
    }
    button.addEventListener('click', submit)
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submit()
    })
}

document.addEventListener('DOMContentLoaded', () => {
    load()

    document.querySelectorAll('input[name="mode"]').forEach((el) => {
        el.addEventListener('change', async () => {
            const mode = el.value === MODES.WHITELIST ? MODES.WHITELIST : MODES.BLACKLIST
            state.mode = mode
            await setSettings({ [STORAGE_KEYS.mode]: mode })
            flashSaved()
        })
    })

    wireAdd('blacklist-input', 'blacklist-add', STORAGE_KEYS.blacklist)
    wireAdd('whitelist-input', 'whitelist-add', STORAGE_KEYS.whitelist)

    // Image filter sliders. We persist on the 'input' event so the page
    // updates live; storage.onChanged then propagates to inject.js in
    // every open tab without a reload.
    let saveTimer = null
    SLIDERS.forEach(({ key, input, out, fmt }) => {
        const el = document.getElementById(input)
        const o = document.getElementById(out)
        if (!el) return
        el.addEventListener('input', () => {
            const v = Number(el.value)
            if (!isFinite(v)) return
            o.textContent = fmt(v)
            state.imageFilter = { ...state.imageFilter, [key]: v }
            clearTimeout(saveTimer)
            saveTimer = setTimeout(async () => {
                state.imageFilter = await setImageFilter({ [key]: v })
                flashSaved()
            }, 120)
        })
    })

    const resetBtn = document.getElementById('filter-reset')
    if (resetBtn) {
        resetBtn.addEventListener('click', async () => {
            state.imageFilter = await setImageFilter(DEFAULT_IMAGE_FILTER)
            renderSliders()
            flashSaved()
        })
    }

    const openShortcuts = document.getElementById('open-shortcuts')
    if (openShortcuts) {
        openShortcuts.addEventListener('click', (e) => {
            e.preventDefault()
            chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })
        })
    }
})

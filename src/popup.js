const {
    MODES,
    getSettings,
    shouldApply,
    toggleHost,
    toggleGlobalPause,
    addPatternToActiveList,
    getMainDomain,
    isIpAddress,
    migrateLegacyIfNeeded
} = SiteRules

const $ = (id) => document.getElementById(id)

function domainPatternFor(host) {
    if (!host) return ''
    const main = getMainDomain(host)
    return isIpAddress(main) ? main : ('*.' + main)
}

function render(host, settings) {
    const banner = $('global-banner')
    banner.hidden = !settings.globalPaused

    const applies = shouldApply(host, settings)
    $('host').textContent = host || '(no host)'
    $('status').textContent = applies
        ? 'Ink style: ON for this site'
        : (settings.globalPaused
            ? 'Ink style: paused globally'
            : 'Ink style: OFF for this site')
    $('status').className = 'status ' + (applies ? 'on' : 'off')

    $('mode-label').textContent =
        settings.mode === MODES.WHITELIST ? 'Whitelist' : 'Blacklist'

    let toggleLabel
    if (settings.mode === MODES.WHITELIST) {
        toggleLabel = applies ? 'Remove from whitelist' : 'Add to whitelist'
    } else {
        // In blacklist mode, "applies" means host is NOT in blacklist.
        toggleLabel = applies ? 'Add to blacklist' : 'Remove from blacklist'
    }
    const hostBtn = $('toggle')
    hostBtn.textContent = toggleLabel
    hostBtn.disabled = !host || settings.globalPaused

    const pattern = domainPatternFor(host)
    const listName = settings.mode === MODES.WHITELIST ? 'whitelist' : 'blacklist'
    const addBtn = $('add-domain')
    addBtn.textContent = pattern
        ? `Add ${pattern} to ${listName}`
        : 'Add main domain'
    addBtn.disabled = !host || settings.globalPaused

    const globalBtn = $('global-toggle')
    globalBtn.textContent = settings.globalPaused
        ? 'Resume ink style globally'
        : 'Pause ink style globally'
}

async function init() {
    await migrateLegacyIfNeeded()

    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        const tab = tabs[0]
        let host = ''
        try {
            host = new URL(tab.url).host
        } catch (e) { host = '' }

        const reload = async () => {
            const s = await getSettings()
            render(host, s)
        }

        await reload()

        $('toggle').addEventListener('click', async () => {
            if (!host) return
            await toggleHost(host)
            await reload()
        })

        $('add-domain').addEventListener('click', async () => {
            if (!host) return
            await addPatternToActiveList(domainPatternFor(host))
            await reload()
        })

        $('global-toggle').addEventListener('click', async () => {
            await toggleGlobalPause()
            await reload()
        })
    })
}

$('manage').addEventListener('click', (e) => {
    e.preventDefault()
    if (chrome.runtime.openOptionsPage) {
        chrome.runtime.openOptionsPage()
    } else {
        chrome.tabs.create({ url: chrome.runtime.getURL('options.html') })
    }
})

$('shortcuts').addEventListener('click', (e) => {
    e.preventDefault()
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })
})

init()

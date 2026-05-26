importScripts('site-rules.js')

function getActiveTab() {
    return new Promise((resolve) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            resolve(tabs && tabs[0])
        })
    })
}

function hostFromTab(tab) {
    if (!tab || !tab.url) return ''
    try {
        return new URL(tab.url).host
    } catch (e) {
        return ''
    }
}

function flashBadge(tabId, text, color) {
    if (typeof tabId !== 'number') return
    try {
        chrome.action.setBadgeBackgroundColor({ tabId, color: color || '#000' })
        chrome.action.setBadgeText({ tabId, text: String(text).slice(0, 4) })
        setTimeout(() => {
            chrome.action.setBadgeText({ tabId, text: '' })
        }, 1500)
    } catch (e) { /* ignore */ }
}

async function refreshGlobalBadge() {
    try {
        const settings = await SiteRules.getSettings()
        if (settings.globalPaused) {
            chrome.action.setBadgeBackgroundColor({ color: '#888' })
            chrome.action.setBadgeText({ text: 'OFF' })
            chrome.action.setTitle({ title: 'E-ink Viewable (paused globally)' })
        } else {
            chrome.action.setBadgeText({ text: '' })
            chrome.action.setTitle({ title: 'E-ink Viewable' })
        }
    } catch (e) { /* ignore */ }
}

chrome.commands.onCommand.addListener(async (command) => {
    await SiteRules.migrateLegacyIfNeeded()

    if (command === 'toggle-global-pause') {
        const paused = await SiteRules.toggleGlobalPause()
        refreshGlobalBadge()
        const tab = await getActiveTab()
        if (tab && typeof tab.id === 'number') {
            flashBadge(tab.id, paused ? 'OFF' : 'ON', paused ? '#888' : '#000')
        }
        return
    }

    const tab = await getActiveTab()
    const host = hostFromTab(tab)
    if (!host) return

    if (command === 'toggle-ink-style') {
        await SiteRules.toggleHost(host)
        return
    }

    if (command === 'add-current-domain') {
        const main = SiteRules.getMainDomain(host)
        const pattern = SiteRules.isIpAddress(main) ? main : ('*.' + main)
        const result = await SiteRules.addPatternToActiveList(pattern)
        flashBadge(tab.id, result.added ? '+' : '=', result.added ? '#000' : '#888')
        return
    }
})

chrome.runtime.onInstalled.addListener(async () => {
    await SiteRules.migrateLegacyIfNeeded()
    refreshGlobalBadge()
})

chrome.runtime.onStartup.addListener(refreshGlobalBadge)

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes[SiteRules.STORAGE_KEYS.globalPaused]) {
        refreshGlobalBadge()
    }
})

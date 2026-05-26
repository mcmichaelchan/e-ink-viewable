// Shared helpers for whitelist / blacklist site rules.
// Loaded by popup.js, options.js, background.js, and inject.js.
// Designed to work both as a classic script (window.SiteRules) and
// without modules so MV3 service workers / content scripts can reuse it.

(function (root) {
    const STORAGE_KEYS = {
        mode: 'mode',
        blacklist: 'blacklist',
        whitelist: 'whitelist',
        globalPaused: 'globalPaused',
        migrated: 'legacyMigrated'
    }

    const MODES = { BLACKLIST: 'blacklist', WHITELIST: 'whitelist' }

    // Curated list of common multi-segment public suffixes. Not a full PSL,
    // but enough to make "main domain" extraction sensible in practice.
    // Each entry is the trailing labels (without leading dot).
    const MULTI_PART_TLDS = new Set([
        'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk',
        'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
        'com.tw', 'org.tw', 'net.tw', 'edu.tw', 'gov.tw',
        'com.hk', 'org.hk', 'net.hk', 'edu.hk', 'gov.hk',
        'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
        'com.br', 'com.mx', 'com.ar', 'com.co', 'com.pe',
        'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
        'co.kr', 'or.kr', 'go.kr',
        'co.in', 'co.id', 'co.th', 'co.nz', 'co.za', 'co.il',
        'com.sg', 'com.my', 'com.ph', 'com.vn', 'com.tr', 'com.sa',
        'com.ua', 'com.ru'
    ])

    function isIpAddress(host) {
        if (!host) return false
        // IPv4
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true
        // IPv6 (very loose)
        if (host.includes(':')) return true
        return false
    }

    // Extract the registrable / "main" domain from a host. Returns the host
    // unchanged for IPs, single-label hosts, or anything we can't split.
    function getMainDomain(host) {
        if (!host) return ''
        host = host.toLowerCase()
        if (isIpAddress(host)) return host
        const parts = host.split('.')
        if (parts.length <= 2) return host
        const last2 = parts.slice(-2).join('.')
        const last3 = parts.slice(-3).join('.')
        // If the last two labels form a known multi-part suffix, take 3 labels.
        if (MULTI_PART_TLDS.has(last2)) {
            return last3
        }
        return last2
    }

    function normalizePattern(input) {
        if (!input) return ''
        let p = String(input).trim().toLowerCase()
        if (!p) return ''
        // Strip protocol if user pasted a URL.
        p = p.replace(/^[a-z]+:\/\//, '')
        // Drop path / query / hash.
        p = p.split('/')[0]
        // Drop port.
        p = p.split(':')[0]
        return p
    }

    function matchesPattern(host, pattern) {
        if (!host || !pattern) return false
        host = host.toLowerCase()
        pattern = pattern.toLowerCase()
        if (pattern === host) return true
        if (pattern.startsWith('*.')) {
            const base = pattern.slice(2)
            return host === base || host.endsWith('.' + base)
        }
        return false
    }

    function matchesAny(host, patterns) {
        if (!Array.isArray(patterns)) return false
        return patterns.some((p) => matchesPattern(host, p))
    }

    function getSettings() {
        return new Promise((resolve) => {
            chrome.storage.sync.get(
                [
                    STORAGE_KEYS.mode,
                    STORAGE_KEYS.blacklist,
                    STORAGE_KEYS.whitelist,
                    STORAGE_KEYS.globalPaused
                ],
                (items) => {
                    resolve({
                        mode: items[STORAGE_KEYS.mode] === MODES.WHITELIST
                            ? MODES.WHITELIST
                            : MODES.BLACKLIST,
                        blacklist: Array.isArray(items[STORAGE_KEYS.blacklist])
                            ? items[STORAGE_KEYS.blacklist]
                            : [],
                        whitelist: Array.isArray(items[STORAGE_KEYS.whitelist])
                            ? items[STORAGE_KEYS.whitelist]
                            : [],
                        globalPaused: !!items[STORAGE_KEYS.globalPaused]
                    })
                }
            )
        })
    }

    async function toggleGlobalPause() {
        const settings = await getSettings()
        const next = !settings.globalPaused
        await setSettings({ [STORAGE_KEYS.globalPaused]: next ? 1 : 0 })
        return next
    }

    function setSettings(partial) {
        return new Promise((resolve) => {
            chrome.storage.sync.set(partial, resolve)
        })
    }

    // Should ink style be applied for this host given current settings?
    function shouldApply(host, settings) {
        if (!host) return false
        if (settings && settings.globalPaused) return false
        if (settings.mode === MODES.WHITELIST) {
            return matchesAny(host, settings.whitelist)
        }
        return !matchesAny(host, settings.blacklist)
    }

    // Add a normalized pattern to the active list (based on current mode).
    // Returns { added, pattern, listKey } where added is false if it already
    // existed (or normalized to empty).
    async function addPatternToActiveList(rawPattern) {
        const pattern = normalizePattern(rawPattern)
        if (!pattern) return { added: false, pattern: '', listKey: null }
        const settings = await getSettings()
        const listKey = settings.mode === MODES.WHITELIST
            ? STORAGE_KEYS.whitelist
            : STORAGE_KEYS.blacklist
        const list = settings[listKey].slice()
        if (list.includes(pattern)) {
            return { added: false, pattern, listKey }
        }
        list.push(pattern)
        await setSettings({ [listKey]: list })
        return { added: true, pattern, listKey }
    }

    // Toggle whether ink style applies to host. Mutates the relevant list and
    // persists it. Returns the new shouldApply value.
    async function toggleHost(host) {
        const settings = await getSettings()
        const listKey = settings.mode === MODES.WHITELIST
            ? STORAGE_KEYS.whitelist
            : STORAGE_KEYS.blacklist
        const list = settings[listKey].slice()
        const matchIndex = list.findIndex((p) => matchesPattern(host, p))
        if (settings.mode === MODES.WHITELIST) {
            // currently applies iff host is matched -> toggle removes match, else add host
            if (matchIndex >= 0) {
                list.splice(matchIndex, 1)
            } else {
                list.push(host)
            }
        } else {
            // blacklist: applies iff host NOT matched -> toggle adds host (block) or removes match
            if (matchIndex >= 0) {
                list.splice(matchIndex, 1)
            } else {
                list.push(host)
            }
        }
        await setSettings({ [listKey]: list })
        return shouldApply(host, { ...settings, [listKey]: list })
    }

    // One-time migration of legacy `i:${host}=1` keys into the new blacklist.
    function migrateLegacyIfNeeded() {
        return new Promise((resolve) => {
            chrome.storage.sync.get(null, (all) => {
                if (all[STORAGE_KEYS.migrated]) {
                    resolve(false)
                    return
                }
                const legacyHosts = []
                const legacyKeys = []
                for (const k of Object.keys(all)) {
                    if (k.startsWith('i:') && all[k]) {
                        legacyHosts.push(k.slice(2))
                        legacyKeys.push(k)
                    } else if (k.startsWith('i:')) {
                        legacyKeys.push(k)
                    }
                }
                const existing = Array.isArray(all[STORAGE_KEYS.blacklist])
                    ? all[STORAGE_KEYS.blacklist]
                    : []
                const merged = existing.slice()
                for (const h of legacyHosts) {
                    if (h && !merged.includes(h)) merged.push(h)
                }
                const update = { [STORAGE_KEYS.migrated]: 1 }
                if (merged.length !== existing.length) {
                    update[STORAGE_KEYS.blacklist] = merged
                }
                chrome.storage.sync.set(update, () => {
                    if (legacyKeys.length) {
                        chrome.storage.sync.remove(legacyKeys, () => resolve(true))
                    } else {
                        resolve(true)
                    }
                })
            })
        })
    }

    const api = {
        STORAGE_KEYS,
        MODES,
        normalizePattern,
        matchesPattern,
        matchesAny,
        getSettings,
        setSettings,
        shouldApply,
        toggleHost,
        toggleGlobalPause,
        addPatternToActiveList,
        getMainDomain,
        isIpAddress,
        migrateLegacyIfNeeded
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api
    }
    root.SiteRules = api
})(typeof self !== 'undefined' ? self : this);

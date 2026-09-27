/// <reference path="./anime-torrent-provider.d.ts" />
/// <reference path="./core.d.ts" />

interface AnimeToshoTorrent {
    anidb_aid: number;
    anidb_eid: number;
    anidb_fid: number | null;
    anidex_id: number | null;
    article_title: string;
    article_url: string;
    id: number;
    info_hash: string;
    info_hash_v2: string | null;
    leechers: number;
    link: string;
    magnet_uri: string;
    nekobt_id: number | null;
    num_files: number;
    nyaa_id: number;
    nyaa_subdom: string | null;
    nzb_url: string | null;
    seeders: number;
    status: string;
    timestamp: number;
    title: string;
    torrent_downloaded_count: number;
    torrent_name: string;
    torrent_url: string;
    tosho_id: number | null;
    total_size: number;
    tracker_updated: number;
    website_url: string | null;
}

class Provider {
    private jsonFeedUrl = "https://feed.animetosho.net/feed/json"

    public getSettings(): AnimeProviderSettings {
        return {
            type: "main",
            canSmartSearch: true,
            smartSearchFilters: ["batch", "episodeNumber", "resolution", "query"],
            supportsAdult: false,
        }
    }

    private getUserOrderPreference(preferenceName: string, fallback: string): string {
        const value = $getUserPreference(preferenceName)
        if (value && value.trim()) return value.trim()
        return fallback
    }

    private getSearchOrder(): string {
        return this.getUserOrderPreference("searchOrder", "size-d")
    }

    private getBatchSearchOrder(): string {
        return this.getUserOrderPreference("batchSearchOrder", "size-d")
    }

    private getSingleEpisodeSearchOrder(): string {
        return this.getUserOrderPreference("singleEpisodeSearchOrder", "size-d")
    }

    private getLatestTorrentsOrder(): string {
        return this.getUserOrderPreference("latestTorrentsOrder", "date-d")
    }

    private normalizeFeedUrl(value: string): string {
        let url = value.trim().split("#")[0].replace(/\/+$/, "")
        if (url && !/^https?:\/\//i.test(url)) url = "https://" + url
        return url
    }

    private getJsonFeedUrl(): string {
        return this.normalizeFeedUrl($getUserPreference("jsonURL") || "") || this.jsonFeedUrl
    }

    private getFallbackJsonFeedUrl(): string {
        return this.normalizeFeedUrl($getUserPreference("fallbackJsonURL") || "")
    }

    private buildApiUrl(
        params: Record<string, string | number | boolean | undefined>,
        base: string = this.getJsonFeedUrl(),
    ): string {
        const query = Object.entries(params)
            .filter(([, value]) => value !== undefined && value !== null && value !== "")
            .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
            .join("&")

        const separator = base.includes("?") ? (/[?&]$/.test(base) ? "" : "&") : "?"
        return `${base}${query ? separator + query : ""}`
    }

    private getMaxPages(): number {
        const value = parseInt(String($getUserPreference("maxPages") ?? ""), 10)
        if (!Number.isNaN(value)) {
            return Math.max(1, Math.min(10, value))
        }
        return 3
    }

    public async getLatest(): Promise<AnimeTorrent[]> {
        try {
            console.log("AnimeTosho (NEW): Fetching latest torrents")
            const torrents = await this.fetchTorrentsPaginated({ cat: "2020", limit: 100, order: this.getLatestTorrentsOrder() }, this.getMaxPages())
            return this.torrentSliceToAnimeTorrentSlice(torrents, false, null)
        }
        catch (error) {
            const e = error as Error
            console.error("AnimeTosho (NEW): Error fetching latest: " + e.message)
            throw e
        }
    }

    public async search(options: AnimeSearchOptions): Promise<AnimeTorrent[]> {
        try {
            const q = this.sanitizeTitle(options.query)
            console.log(`AnimeTosho (NEW): Searching for "${q}"`)
            const torrents = await this.fetchTorrentsPaginated({ cat: "2020", q, limit: 100, order: this.getSearchOrder() }, this.getMaxPages())
            return this.torrentSliceToAnimeTorrentSlice(torrents, false, options.media)
        }
        catch (error) {
            const e = error as Error
            console.error("AnimeTosho (NEW): Error searching: " + e.message)
            throw e
        }
    }

    public async smartSearch(options: AnimeSmartSearchOptions): Promise<AnimeTorrent[]> {
        try {
            if (options.batch) {
                console.log("AnimeTosho (NEW): Smart searching for batches...")
                return this.smartSearchBatch(options)
            }
            console.log(`AnimeTosho (NEW): Smart searching for episode ${options.episodeNumber}...`)
            return this.smartSearchSingleEpisode(options)
        }
        catch (error) {
            const e = error as Error
            console.error("AnimeTosho (NEW): Error in smart search: " + e.message)
            throw e
        }
    }

    private async smartSearchBatch(options: AnimeSmartSearchOptions): Promise<AnimeTorrent[]> {
        let atTorrents: AnimeToshoTorrent[] = []
        let foundByID = false
        const media = options.media

        if (options.anidbAID && options.anidbAID > 0) {
            console.log(`AnimeTosho (NEW): Searching batches by AID ${options.anidbAID}`)
            try {
                const torrents = await this.searchByAID(options.anidbAID, options.query, options.resolution || "", this.getBatchSearchOrder())

                atTorrents = torrents.filter(t => this.isBatchCandidate(t, media))

                if (atTorrents.length > 0) {
                    foundByID = true
                }
            }
            catch (e) {
                console.warn("AnimeTosho (NEW): searchByAID failed: " + (e as Error).message)
            }
        }

        if (foundByID) {
            console.log(`AnimeTosho (NEW): Found ${atTorrents.length} batches by AID`)
            return this.torrentSliceToAnimeTorrentSlice(atTorrents, true, media)
        }

        // Fallback: Search by query
        console.log("AnimeTosho (NEW): Fallback: Searching batches by query")
        const queries = this.buildSmartSearchQueries(options)
        let allTorrents: AnimeToshoTorrent[] = []

        const searchPromises = queries.map(query => {
            return this.fetchTorrentsPaginated({ cat: "2020", q: query, limit: 100, order: this.getBatchSearchOrder() }, this.getMaxPages())
        })

        try {
            const results = await Promise.all(searchPromises)
            allTorrents = results.flat()
        }
        catch (error) {
            const e = error as Error
            console.error("AnimeTosho (NEW): Batch query search failed: " + e.message)
            throw e
        }

        // Keep confirmed batches and plausible unlabeled packs.
        allTorrents = allTorrents.filter(t => this.isBatchCandidate(t, media))

        // Convert and remove duplicates
        const animeTorrents = this.torrentSliceToAnimeTorrentSlice(allTorrents, false, media)
        const uniqueTorrents = [...new Map(animeTorrents.map(t => [t.link, t])).values()]

        console.log(`AnimeTosho (NEW): Found ${uniqueTorrents.length} batches by query`)
        return uniqueTorrents
    }

    private async smartSearchSingleEpisode(options: AnimeSmartSearchOptions): Promise<AnimeTorrent[]> {
        let atTorrents: AnimeToshoTorrent[] = []
        let foundByID = false
        const media = options.media

        if (options.anidbEID && options.anidbEID > 0) {
            console.log(`AnimeTosho (NEW): Searching episode by EID ${options.anidbEID}`)
            try {
                const torrents = await this.searchByEID(options.anidbEID, options.query, options.resolution || "", this.getSingleEpisodeSearchOrder())
                // Keep single episodes even when subtitles or other sidecar files are included.
                atTorrents = torrents.filter(t => !this.isBatchTorrent(t, media))

                if (atTorrents.length > 0) {
                    foundByID = true
                }
            }
            catch (e) {
                console.warn("AnimeTosho (NEW): searchByEID failed: " + (e as Error).message)
            }
        }

        if (foundByID) {
            console.log(`AnimeTosho (NEW): Found ${atTorrents.length} episodes by EID`)
            return this.torrentSliceToAnimeTorrentSlice(atTorrents, true, media)
        }

        // Fallback: Search by query
        console.log("AnimeTosho (NEW): Fallback: Searching episode by query")
        const queries = this.buildSmartSearchQueries(options)
        let allTorrents: AnimeToshoTorrent[] = []

        const searchPromises = queries.map(query => {
            return this.fetchTorrentsPaginated({ cat: "2020", q: query, limit: 100, order: this.getSingleEpisodeSearchOrder() }, this.getMaxPages())
        })

        try {
            const results = await Promise.all(searchPromises)
            allTorrents = results.flat()
        }
        catch (error) {
            const e = error as Error
            console.error("AnimeTosho (NEW): Episode query search failed: " + e.message)
            throw e
        }

        // Use the same classification for EID, query and displayed results.
        allTorrents = allTorrents.filter(t => !this.isBatchTorrent(t, media))

        // Convert and remove duplicates
        const animeTorrents = this.torrentSliceToAnimeTorrentSlice(allTorrents, false, media)
        const uniqueTorrents = [...new Map(animeTorrents.map(t => [t.link, t])).values()]

        console.log(`AnimeTosho (NEW): Found ${uniqueTorrents.length} episodes by query`)
        if (uniqueTorrents.length > 0)
            return uniqueTorrents
        else {
            // If no torrents found, fallback to all torrent batches for AID
            console.log("AnimeTosho (NEW): Fallback: Searching episode by AID")
            if (options.anidbAID && options.anidbAID > 0) {
                const torrents = await this.searchByAID(options.anidbAID, options.query, options.resolution || "", this.getSingleEpisodeSearchOrder())
                // Habari lists both range endpoints and discrete episodes; only title ranges
                // justify including intervening episodes. Also accept absolute season numbering.
                const wanted = [options.episodeNumber]
                if (media.absoluteSeasonOffset && media.absoluteSeasonOffset > 0) {
                    wanted.push(options.episodeNumber + media.absoluteSeasonOffset)
                }
                const filteredTorrents = torrents.filter(t => {
                    const metadata = $habari.parse(t.title)
                    const episodes = (metadata.episode_number || []).filter(n => n.trim() !== "").map(Number).filter(Number.isFinite)
                    const ranges = this.getEpisodeRanges(t.title)
                    return wanted.some(ep => ep > 0 && (episodes.includes(ep) || ranges.some(([from, to]) => ep >= from && ep <= to)))
                })
                return this.torrentSliceToAnimeTorrentSlice(filteredTorrents, false, media)
            }
        }
        return this.torrentSliceToAnimeTorrentSlice(atTorrents, false, media)
    }
    public async getTorrentInfoHash(torrent: AnimeTorrent): Promise<string> {
        // InfoHash is provided directly by the API
        return torrent.infoHash ? torrent.infoHash.toLowerCase() : ""
    }

    public async getTorrentMagnetLink(torrent: AnimeTorrent): Promise<string> {
        // MagnetLink is provided directly by the API
        return torrent.magnetLink || ""
    }

    //+ --------------------------------------------------------------------------------------------------
    // Helpers
    //+ --------------------------------------------------------------------------------------------------

    private async fetchTorrents(url: string): Promise<AnimeToshoTorrent[]> {
        console.log(`AnimeTosho (NEW): Fetching from ${url}`)

        // Fetch timeout is in seconds; bound the wait before failover.
        const res = await fetch(url, { timeout: 20 })
        if (!res.ok) throw new Error(`Failed to fetch torrents: ${res.status} ${res.statusText}`)

        const response = await res.json() as any
        if (!Array.isArray(response) || response.some(t => !t || typeof t.title !== "string")) {
            throw new Error("Invalid feed response: expected an array of torrents")
        }
        const torrents = response as AnimeToshoTorrent[]

        // Clean up impossibly high seeder/leecher counts
        return torrents.map(t => {
            if (t.seeders > 100000) t.seeders = 0
            if (t.leechers > 100000) t.leechers = 0
            return t
        })
    }

    private async fetchTorrentsPaginated(
        params: Record<string, string | number | boolean | undefined>,
        maxPages: number = 10,
    ): Promise<AnimeToshoTorrent[]> {
        const pageSize = 100
        const results: AnimeToshoTorrent[] = []
        const seen = new Set<string>()
        const feedUrls = [...new Set([this.getJsonFeedUrl(), this.getFallbackJsonFeedUrl()].filter(Boolean))]
        const failures: string[] = []
        let feedIndex = 0

        for (let page = 1; page <= maxPages; page++) {
            console.log(`AnimeTosho (NEW): Fetching page ${page} of ${maxPages}`)
            let pageTorrents: AnimeToshoTorrent[]
            while (true) {
                try {
                    const url = this.buildApiUrl({ ...params, page, limit: pageSize }, feedUrls[feedIndex])
                    pageTorrents = await this.fetchTorrents(url)
                    break
                }
                catch (error) {
                    const reason = error instanceof Error ? error.message : String(error)
                    failures.push(`${feedIndex === 0 ? "Primary" : "Fallback"} feed: ${reason}`)
                    feedIndex++
                    if (feedIndex >= feedUrls.length) throw new Error(failures.join("; "))
                    console.warn(`AnimeTosho (NEW): Primary feed failed; retrying page ${page} with the fallback feed`)
                }
            }

            if (pageTorrents.length === 0) break

            console.log(`AnimeTosho (NEW): Found ${pageTorrents.length} torrents on page ${page}`)

            for (const torrent of pageTorrents) {
                const key = torrent.id ? String(torrent.id) : torrent.info_hash || torrent.torrent_url
                if (!key || seen.has(key)) continue
                seen.add(key)
                results.push(torrent)
            }

            if (pageTorrents.length < pageSize) break
        }

        return results
    }

    private searchByAID(aid: number, query: string, quality: string, order: string): Promise<AnimeToshoTorrent[]> {
        const res = this.formatQuality(quality)
        const q = query ? this.sanitizeTitle(query) : ""
        const qCombined = [q, res].filter(Boolean).join(" ").trim()

        return this.fetchTorrentsPaginated({
            cat: "2020",
            aid,
            q: qCombined,
            order,
            limit: 100,
        }, this.getMaxPages())
    }

    private searchByEID(eid: number, query: string, quality: string, order: string): Promise<AnimeToshoTorrent[]> {
        const res = this.formatQuality(quality)
        const q = query ? this.sanitizeTitle(query) : ""
        const qCombined = [q, res].filter(Boolean).join(" ").trim()

        return this.fetchTorrentsPaginated({
            cat: "2020",
            eid,
            q: qCombined,
            order,
            limit: 100,
        }, this.getMaxPages())
    }

    private buildSmartSearchQueries(opts: AnimeSmartSearchOptions): string[] {
        const { media, batch, episodeNumber, resolution } = opts
        const hasSingleEpisode = media.episodeCount === 1 || media.format === "MOVIE"

        let queryStr: string[] = []
        const allTitles = this.getAllTitles(media)
        const userQuery = this.sanitizeTitle(opts.query)

        if (hasSingleEpisode) {
            let str = ""
            const qTitles = `(${allTitles.map(t => this.sanitizeTitle(t)).join(" | ")})`
            str += qTitles

            if (userQuery) {
                str += " " + userQuery
            }
            if (resolution) {
                str += " " + this.formatQuality(resolution)
            }

            queryStr = [str]

        } else {
            if (!batch) { // Single episode search
                const qTitles = this.buildTitleString(opts)
                const qEpisodes = this.buildEpisodeString(opts)

                let str = ""
                str += qTitles
                if (userQuery) {
                    str += " " + userQuery
                }
                if (qEpisodes) {
                    str += " " + qEpisodes
                }
                if (resolution) {
                    str += " " + this.formatQuality(resolution)
                }

                queryStr.push(str)

                if (media.absoluteSeasonOffset && media.absoluteSeasonOffset > 0) {
                    const metadata = $habari.parse(media.romajiTitle || "")
                    let absoluteQueryStr = metadata.title || ""

                    if (userQuery) {
                        absoluteQueryStr += " " + userQuery
                    }
                    const ep = episodeNumber + media.absoluteSeasonOffset
                    absoluteQueryStr += ` ("${ep}"|"e${ep}"|"ep${ep}"|"${this.zeropad(ep)}")`

                    if (resolution) {
                        absoluteQueryStr += " " + this.formatQuality(resolution)
                    }

                    queryStr = [`(${absoluteQueryStr}) | (${str})`]
                }
            } else { // Batch search
                let str = `(${media.romajiTitle})`
                if (media.englishTitle) {
                    str = `(${media.romajiTitle} | ${media.englishTitle})`
                }
                if (userQuery) {
                    str += " " + userQuery
                }
                if (resolution) {
                    str += " " + this.formatQuality(resolution)
                }
                queryStr = [str]
            }
        }

        // NEW API DOESN'T SUPPORT S0 SEARCHING
        // Add "-S0" variant for each query (as in Go code)
        // const finalQueries: string[] = []
        // for (const q of queryStr) {
        //     finalQueries.push(q)
        //     finalQueries.push(q + " -S0")
        // }
        const finalQueries: string[] = []
        for (const q of queryStr) finalQueries.push(q)

        return finalQueries
    }

    private formatQuality(quality: string): string {
        if (!quality) return ""
        const resNum = quality.replace(/[^\d]/g, "") // "1080p" -> "1080"
        if (!resNum) return quality

        // q = "1080 1080p WEB1080 WEB1080p BD1080 BD1080p"
        return `(${resNum}|${resNum}p|WEB${resNum}|WEB${resNum}p|BD${resNum}|BD${resNum}p)`
    }

    private sanitizeTitle(t: string): string {
        t = t.replace(/-/g, " ") // Replace hyphens with spaces
        t = t.replace(/[^a-zA-Z0-9\s]/g, "") // Remove non-alphanumeric/space chars
        t = t.replace(/\s+/g, " ") // Trim large spaces
        return t.trim()
    }

    private getAllTitles(media: AnimeSmartSearchOptions["media"]): string[] {
        return [
            media.romajiTitle,
            media.englishTitle,
            ...(media.synonyms || []),
        ].filter(Boolean) as string[] // Filter out null/undefined/empty strings
    }

    private zeropad(v: number | string): string {
        return String(v).padStart(2, "0")
    }

    private normalizeTorrentTitle(title: string): string {
        return (title || "").normalize("NFKC")
            .replace(/[‐‑‒–—―−﹘﹣－]/g, "-")
            .replace(/[〜～]/g, "~")
            .replace(/_/g, " ").replace(/\s+/g, " ").trim()
    }

    private hasSingleEpisodeMarker(title: string): boolean {
        // Years in release metadata are not episode numbers.
        title = title.replace(/[\[({]\s*(?:19|20)\d{2}(?:\s*-\s*(?:19|20)\d{2})?\s*[\])}]/g, " ")
            .replace(/\b(?:19|20)\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\b/g, " ")
            .replace(/\b\d{1,2}[-/.]\d{1,2}[-/.](?:\d{2}|(?:19|20)\d{2})\b/g, " ")
        return /\b(?:Season|Part|Cour)\s+\d{1,2}\s*-\s*\d{1,4}(?:v\d+)?\b/i.test(title) ||
            /\bS\d{1,2}[\s.-]*(?:E(?:P(?:ISODE)?)?|x)[\s.#-]*\d{1,4}(?:\.\d+)?(?:v\d+)?\b/i.test(title) ||
            /\b(?:Episode|EP|E)[\s.#-]*\d{1,4}(?:\.\d+)?(?:v\d+)?\b/i.test(title) ||
            /\bS\d{1,2}[\s.-]+\d{1,4}(?:\.\d+)?(?:v\d+)?\b/i.test(title) ||
            /(?:^|[\s\])}])-\s*\d{1,4}(?:\.\d+)?(?:v\d+)?\b/i.test(title) ||
            /[\[({]\s*\d{1,4}(?:\.\d+)?(?:v\d+)?\s*[\])}]/i.test(title) ||
            /(?:第\s*\d{1,4}(?:\.\d+)?\s*[話话集]|\d{1,4}\s*[話话])/u.test(title) ||
            // Padded releases also use "Title 01 [1080p]" without a dash.
            /\s0\d{1,3}(?:\.\d+)?(?:v\d+)?(?=\s*(?:[\[({]|$|\.(?:mkv|mp4|avi)$))/i.test(
                title.replace(/\b(?:Season|Part|Cour|Vol(?:ume)?\.?|Disc)\s*\d{1,4}\b/gi, ""),
            )
    }

    /** Only ascending episode ranges, with dates, technical data and season labels excluded. */
    private getEpisodeRanges(rawTitle: string): [number, number][] {
        const title = this.normalizeTorrentTitle(rawTitle)
            .replace(/\b(?:19|20)\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\b/g, " ")
            .replace(/\b\d{1,2}[-/.]\d{1,2}[-/.](?:\d{2}|(?:19|20)\d{2})\b/g, " ")
            // "Season 2 - 12" and "Part 2 - 03" are not ranges.
            .replace(/\b(?:Season|Part|Cour|Vol(?:ume)?\.?|Disc)\s*\d{1,4}\b/gi, " ")
        const ranges: [number, number][] = []
        const repeatedSeason = /\bS(\d{1,2})[\s.-]*E(\d{1,4})(?:v\d+)?\s*(?:-|~|\.\.|to|through|thru)\s*S(\d{1,2})[\s.-]*E(\d{1,4})(?:v\d+)?\b/gi
        for (const match of title.matchAll(repeatedSeason)) {
            if (Number(match[1]) === Number(match[3]) && Number(match[4]) > Number(match[2])) ranges.push([Number(match[2]), Number(match[4])])
        }
        const number = "(\\d{1,4}(?:\\.\\d+)?)(?:v\\d+)?"
        const join = "\\s*(?:-|~|\\.\\.|to|through|thru|から)\\s*"
        const marked = new RegExp("\\b(?:S\\d{1,2}[\\s.-]*)?E(?:P(?:ISODES?)?|S)?[\\s.#-]*" + number +
            join + "(?:E(?:P(?:ISODES?)?|S)?[\\s.#-]*)?" + number + "(?![\\p{L}\\p{N}])", "giu")
        for (const match of title.matchAll(marked)) {
            const from = Number(match[1]), to = Number(match[2])
            if (to > from) ranges.push([from, to])
        }
        const eastAsian = /(?:第\s*)?(\d{1,4})\s*[話话集]?\s*(?:-|~|\.\.|から)\s*(?:第\s*)?(\d{1,4})\s*[話话集]/gu
        for (const match of title.matchAll(eastAsian)) {
            if (Number(match[2]) > Number(match[1])) ranges.push([Number(match[1]), Number(match[2])])
        }
        // Lookahead permits overlapping candidates, e.g. "86 - 01-12".
        const bare = new RegExp("(?=(^|[^\\p{L}\\p{N}.])" + number + join + number + "(?=$|[^\\p{L}\\p{N}.]|TV\\b))", "giu")
        const technical = new Set([144, 240, 360, 480, 540, 576, 720, 900, 1080, 1440, 2160, 4320])
        for (const match of title.matchAll(bare)) {
            const from = Number(match[2]), to = Number(match[3])
            if (to <= from) continue
            const start = (match.index || 0) + match[1].length
            const tail = title.slice(start)
            const span = tail.match(new RegExp("^" + number + join + number))![0]
            const prefix = title.slice(0, start)
            const suffix = title.slice(start + span.length)
            if (from >= 1900 && from <= 2099 && to >= 1900 && to <= 2099) continue
            if (technical.has(from) && technical.has(to)) continue
            if (/^\s*-?\s*(?:bits?|fps|hz|khz|mhz|mb|gb|kb|ch(?:annels?)?|audio|AAC|FLAC|AC3|EAC3|DTS|Opus)\b/i.test(suffix)) continue
            if (/\b(?:audio|AAC|FLAC|AC3|EAC3|DTS|Opus)\s*$/i.test(prefix)) continue
            if (/\b(?:Season|Part|Cour|Vol(?:ume)?\.?|Disc)\s*$/i.test(prefix)) continue
            // Numbers in the title itself ("86 - 100", "7 - 12") need an episode label.
            if (!prefix.replace(/^\s*(?:\[[^\]]*\]\s*)+/, "").trim() && !/^0\d/.test(match[2])) continue
            ranges.push([from, to])
        }
        return ranges
    }

    private isBatchTorrent(t: AnimeToshoTorrent, media: Media | null = null): boolean {
        const title = this.normalizeTorrentTitle(t.title)
        if (!title) return false

        // Explicit ranges and batch labels take precedence over individual episode markers.
        if (this.getEpisodeRanges(title).length > 0) return true
        const multiSeason = /\bS(\d{1,2})(?:E\d{1,4})?\s*(-|~|\.\.|to|through|thru|\+|&)\s*S(\d{1,2})(?:E\d{1,4})?\b/gi
        for (const match of title.matchAll(multiSeason)) {
            if (/[+&]/.test(match[2]) ? Number(match[3]) !== Number(match[1]) : Number(match[3]) > Number(match[1])) return true
        }
        const seasons = /\bSeasons?\s+(\d{1,2})\s*(-|~|to|through|thru|\+|&)\s*(Seasons?\s+)?(\d{1,2})\b/gi
        for (const match of title.matchAll(seasons)) {
            if (!/^Seasons\b/i.test(match[0]) && !match[3]) continue
            if (/[+&]/.test(match[2]) ? Number(match[4]) !== Number(match[1]) : Number(match[4]) > Number(match[1])) return true
        }

        const list = /\b(?:S\d{1,2}[\s.-]*)?E(?:P(?:ISODES?)?|S)?[\s.#-]*(\d{1,4}(?:\.\d+)?)(?:v\d+)?\s*(?:,|\+|&|\/(?=\s*(?:S\d{1,2})?E))\s*(?:(?:S\d{1,2}[\s.-]*)?E(?:P(?:ISODES?)?|S)?[\s.#-]*)?(\d{1,4}(?:\.\d+)?)(?:v\d+)?\b/gi
        let match: RegExpExecArray | null
        while ((match = list.exec(title)) !== null) {
            if (Number(match[1]) !== Number(match[2])) return true
            // Revisit the second item so "E01, E01, E02" still finds E02.
            list.lastIndex = match.index + 1
        }
        const bareLists = /(?:^|[\s[(])(\d{1,4}(?:v\d+)?(?:\s*(?:,|\+|&)\s*\d{1,4}(?:v\d+)?)+)(?=$|[\s)\]])/gi
        for (const match of title.matchAll(bareLists)) {
            const prefix = title.slice(0, (match.index || 0) + match[0].indexOf(match[1]))
            const suffix = title.slice((match.index || 0) + match[0].length)
            if (/\b(?:audio|AAC|FLAC|AC3|EAC3|DTS|Opus)\s*$/i.test(prefix)) continue
            if (/^\s*(?:bits?|ch(?:annels?)?|audio|fps)\b/i.test(suffix)) continue
            if (new Set(match[1].split(/[,\+&]/).map(n => Number(n.trim().replace(/v\d+$/i, "")))).size > 1) return true
        }

        // A complete edition of a known one-episode work is still one episode.
        if (media && (media.format === "MOVIE" || media.episodeCount === 1)) return false

        // A bracketed release tag is stronger evidence than a word in the anime/episode title.
        if (/[\[({]\s*(?:batch|complete(?:d)?(?:\s+(?:series|season|collection))?|collection|pack|box\s*set)\s*[\])}]/i.test(title) ||
            /\b(?:batch|box\s*set|boxset|all\s+(?:episodes?|eps?|seasons?)|full\s+(?:series|season))\b/i.test(title) ||
            /(?:全集|合集|全巻|全編|一挙|まとめ|완결|전편|全\s*\d{1,4}\s*(?:話|话|集))/u.test(title)) return true
        for (const match of title.matchAll(/[\[({]\s*(\d{1,4})\s*(?:episodes|eps)\s*[\])}]/gi)) {
            if (Number(match[1]) > 1) return true
        }
        for (const match of title.matchAll(/[\[({]\s*(\d{1,3})[\s-]+(?:movie|film)\s+collection\s*[\])}]/gi)) {
            if (Number(match[1]) > 1) return true
        }

        const single = this.hasSingleEpisodeMarker(title)
        if (single) return false

        // A source-tagged whole-season release is conventional pack notation.
        // A season word alone can be an anime name; numbered movies/specials also need care.
        if (/\b(?:S\d{1,2}|Season\s+\d{1,2}|\d{1,2}(?:st|nd|rd|th)\s+Season)\b/i.test(title) &&
            /\b(?:BD|BDRip|Blu[ .-]?Ray|DVD|DVDRip|WEB|WEBRip|WEB[ .-]?DL)\b/i.test(title) &&
            !/\b(?:movies?|films?|specials?|OVAs?|ONAs?)\b/i.test(title)) return true

        // Bare "collection", "season", "part" and "final" can be part of an anime name.
        if (/\b(?:complete(?:d)?(?:\s+(?:series|season|collection))?|(?:series|season|episode)\s+(?:collection|pack))\b/i.test(title) ||
            /\b(?:S\d{1,2}|Season\s+\d{1,2}|TV)\s*(?:\+|&|,)\s*(?:OVAs?|ONAs?|Specials?|Movies?|Films?|Extras?)\b/i.test(title) ||
            /\b(?:Vol(?:ume)?s?|Discs?|Parts?|Cours?)\.?\s*\d{1,3}\s*(?:-|~|to|\+|&)\s*(?:(?:Vol(?:ume)?s?|Discs?|Parts?|Cours?)\.?\s*)?\d{1,3}\b/i.test(title)) return true

        // num_files includes subtitles, fonts, artwork and NFOs. It is not proof of a batch.
        // Ambiguous names stay available to episode searches; batch search can retain them separately.
        return false
    }

    private isBatchCandidate(t: AnimeToshoTorrent, media: Media): boolean {
        if (media.format === "MOVIE" || media.episodeCount === 1 || this.isBatchTorrent(t, media)) return true
        let title = this.normalizeTorrentTitle(t.title)
        // Compact "Season 1-3" / "S1-2" can mean a season range or an episode.
        // Retain these ambiguous multi-file results without asserting that they are batches.
        if (t.num_files > 1 && /\b(?:S|Season\s+|Part\s+)\d{1,2}-[1-9]\d?\b/i.test(title)) return true
        // Do not mistake numbers in known anime names ("Gundam 00") for episodes.
        for (const name of this.getAllTitles(media)) {
            const escaped = this.normalizeTorrentTitle(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
            if (escaped) title = title.replace(new RegExp("(^|[^\\p{L}\\p{N}])" + escaped + "(?=$|[^\\p{L}\\p{N}])", "giu"), "$1Anime")
        }
        // Preserve unlabeled packs without labeling an identified episode as a batch.
        return t.num_files > 1 && !this.hasSingleEpisodeMarker(title)
    }

    private buildEpisodeString(opts: AnimeSmartSearchOptions): string {
        if (opts.episodeNumber === -1) return ""
        const pEp = this.zeropad(opts.episodeNumber)
        // e.g. ("05"|"e5"|"ep5"|"05")
        return `("${pEp}"|"e${opts.episodeNumber}"|"ep${opts.episodeNumber}"|"${this.zeropad(opts.episodeNumber)}")`
    }

    private buildTitleString(opts: AnimeSmartSearchOptions): string {
        const media = opts.media
        const romTitle = this.sanitizeTitle(media.romajiTitle || "")
        const engTitle = this.sanitizeTitle(media.englishTitle || "")

        let season = 0
        let titles: string[] = []

        // create titles by extracting season/part info
        this.getAllTitles(media).forEach(title => {
            const [s, cTitle] = this.extractSeasonNumber(title)
            if (s !== 0) season = s
            if (cTitle) titles.push(this.sanitizeTitle(cTitle))
        })

        // Check season from synonyms, only update season if it's still 0
        if (season === 0) {
            (media.synonyms || []).forEach(synonym => {
                const [s, _] = this.extractSeasonNumber(synonym)
                if (s !== 0) season = s
            })
        }

        // add romaji and english titles to the title list
        titles.push(romTitle)
        if (engTitle) titles.push(engTitle)

        // convert III and II to season
        if (season === 0) {
            if (/\siii\b/i.test(romTitle) || (engTitle && /\siii\b/i.test(engTitle))) season = 3
            else if (/\sii\b/i.test(romTitle) || (engTitle && /\sii\b/i.test(engTitle))) season = 2
        }

        // also, split titles by colon
        [romTitle, engTitle].filter(Boolean).forEach(title => {
            const split = title.split(":")
            if (split.length > 1 && split[0].length > 8) {
                titles.push(split[0])
            }
        })

        // clean titles
        titles = titles.map(title => {
            let clean = title.replace(/:/g, " ").replace(/-/g, " ").trim()
            clean = clean.replace(/\s+/g, " ").toLowerCase()
            if (season !== 0) {
                clean = clean.replace(/\siii\b/gi, "").replace(/\sii\b/gi, "")
            }
            return clean.trim()
        })

        titles = [...new Set(titles.filter(Boolean))] // Unique, non-empty titles

        let shortestTitle = titles.reduce((shortest, current) =>
            current.length < shortest.length ? current : shortest, titles[0] || "")

        // Season part
        let seasonBuff = ""
        if (season > 0) {
            const pS = this.zeropad(season)
            seasonBuff = [
                `"${shortestTitle} season ${season}"`,
                `"${shortestTitle} season ${pS}"`,
                `"${shortestTitle} s${season}"`,
                `"${shortestTitle} s${pS}"`,
            ].join(" | ")
        }

        let qTitles = `(${titles.map(t => `"${t}"`).join(" | ")}`
        if (seasonBuff) {
            qTitles += ` | ${seasonBuff}`
        }
        qTitles += ")"

        return qTitles
    }

    private extractSeasonNumber(title: string): [number, string] {
        const match = title.match(/\b(season|s)\s*(\d{1,2})\b/i)
        if (match && match[2]) {
            const cleanTitle = title.replace(match[0], "").trim()
            return [parseInt(match[2]), cleanTitle]
        }
        return [0, title]
    }

    private torrentSliceToAnimeTorrentSlice(torrents: AnimeToshoTorrent[],
        confirmed: boolean,
        media: AnimeSmartSearchOptions["media"] | null,
    ): AnimeTorrent[] {
        return torrents.map(torrent => {
            const t = this.toAnimeTorrent(torrent, media)
            t.confirmed = confirmed
            return t
        })
    }

    private toAnimeTorrent(t: AnimeToshoTorrent, media: AnimeSmartSearchOptions["media"] | null): AnimeTorrent {
        const metadata = $habari.parse(t.title)

        // Convert UNIX timestamp to ISO string
        const formattedDate = new Date(t.timestamp * 1000).toISOString()

        const isBatch = this.isBatchTorrent(t, media)
        let episode = -1

        if (metadata.episode_number && metadata.episode_number.length === 1) {
            const parsedEpisode = Number(metadata.episode_number[0])
            episode = metadata.episode_number[0].trim() && Number.isFinite(parsedEpisode) ? parsedEpisode : -1
        }

        // Force set episode number to 1 if it's a movie or single-episode and the torrent isn't a batch
        if (!isBatch && episode === -1 && media && (media.episodeCount === 1 || media.format === "MOVIE")) {
            episode = 1
        }

        // If it's a batch, don't assign an episode number
        if (isBatch) {
            episode = -1
        }

        return {
            name: t.title,
            date: formattedDate,
            size: t.total_size,
            formattedSize: this.bytesToHuman(t.total_size),
            seeders: t.seeders,
            leechers: t.leechers,
            downloadCount: t.torrent_downloaded_count,
            link: t.link,
            downloadUrl: t.torrent_url,
            magnetLink: t.magnet_uri,
            infoHash: t.info_hash,
            resolution: metadata.video_resolution || "",
            isBatch: isBatch,
            episodeNumber: episode,
            releaseGroup: metadata.release_group || "",
            isBestRelease: false,
            confirmed: false,     // Will be set in torrentSliceToAnimeTorrentSlice
        }
    }

    private bytesToHuman(bytes: number): string {
        if (bytes === 0) return "0 Bytes"
        const k = 1024
        const sizes = ["Bytes", "KiB", "MiB", "GiB", "TiB"]
        const i = Math.floor(Math.log(bytes) / Math.log(k))
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i]
    }
}

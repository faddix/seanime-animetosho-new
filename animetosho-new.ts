/// <reference path="./anime-torrent-provider.d.ts" />
/// <reference path="./core.d.ts" />

interface AnimeToshoTorrent {
    date_added: string;
    ddl_mirrors: Array<{ label?: string; provider?: string; url?: string }>;
    downloads: number;
    file_count: number;
    id: number;
    info_hash: string;
    is_batch: boolean;
    is_multisub_release: boolean;
    leechers: number;
    magnet: string;
    metadata_fetched: boolean;
    nyaa_id?: number;
    nzb_url: string | null;
    release_group: string;
    resolution: string;
    seeders: number;
    series: {
        anidb_aid: number;
        anidb_eid: number;
        anidb_gid: number | null;
        episode_number: number;
        key: string;
        title: string;
    };
    size_bytes: number;
    source: string;
    source_id: string | number;
    source_label: string;
    title: string;
    torrent_url: string;
    updated_at: string;
    urls: { source: string; view: string };
}

class Provider {
    private jsonFeedUrl = "https://feed.animetosho.xyz/json/v1"

    public getSettings(): AnimeProviderSettings {
        return {
            type: "main",
            canSmartSearch: true,
            smartSearchFilters: ["batch", "episodeNumber", "resolution", "query"],
            supportsAdult: false,
        }
    }

    private getJsonFeedUrl() {
        let url = $getUserPreference("jsonUrl") || this.jsonFeedUrl
        if (url.endsWith("/")) url = url.slice(0, -1)
        if (!url.startsWith("http")) url = "https://" + url
        return url
    }

    public async getLatest(): Promise<AnimeTorrent[]> {
        try {
            console.log("AnimeTosho (NEW): Fetching latest torrents")
            const base = this.getJsonFeedUrl()
            const url = `${base}/releases?limit=100`
            const torrents = await this.fetchTorrents(url)
            return this.torrentSliceToAnimeTorrentSlice(torrents, false, null)
        }
        catch (error) {
            console.error("AnimeTosho (NEW): Error fetching latest: " + (error as Error).message)
            return []
        }
    }

    public async search(options: AnimeSearchOptions): Promise<AnimeTorrent[]> {
        try {
            const q = this.sanitizeTitle(options.query)
            console.log(`AnimeTosho (NEW): Searching for "${q}"`)
            const base = this.getJsonFeedUrl()
            const url = `${base}/search?q=${encodeURIComponent(q)}&limit=100`
            const torrents = await this.fetchTorrents(url)
            return this.torrentSliceToAnimeTorrentSlice(torrents, false, options.media)
        }
        catch (error) {
            console.error("AnimeTosho (NEW): Error searching: " + (error as Error).message)
            return []
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
            console.error("AnimeTosho (NEW): Error in smart search: " + (error as Error).message)
            return []
        }
    }

    private async smartSearchBatch(options: AnimeSmartSearchOptions): Promise<AnimeTorrent[]> {
        let atTorrents: AnimeToshoTorrent[] = []
        let foundByID = false
        const media = options.media

        const isMovieOrSingle = media.format === "MOVIE" || media.episodeCount === 1

        if (options.anidbAID && options.anidbAID > 0) {
            console.log(`AnimeTosho (NEW): Searching batches by AID ${options.anidbAID}`)
            try {
                const torrents = await this.searchByAID(options.anidbAID, options.query, options.resolution || "")

                // If it's a movie/single-ep, all torrents are considered "batches"
                if (isMovieOrSingle) {
                    atTorrents = torrents
                } else {
                    // Otherwise, filter for actual batches (multi-file)
                    // Also include titles that don't contain episode markers.
                    const batchTorrents = torrents.filter(t => (t.file_count ?? 1) > 1 || t.is_batch || /batch|complete|full|pack|~|season/i.test(t.title) || !/(?:(?:S\d{1,2}E\d{1,3}(?:v\d+)?|S\d{1,2}x\d{1,3}(?:v\d+)?|EP?\.?\s*\d{1,3}(?:v\d+)?|E\d{1,3}(?:v\d+)?|episode)\b|-\s*\d{1,3}\b)/i.test(t.title))

                    // If we found batches, use them. If not, use all torrents (e.g., for OVAs released as single files)
                    if (batchTorrents.length == 0) console.log("AnimeTosho (NEW): No batches found by AID, falling back to all releases for this AID")
                    atTorrents = batchTorrents.length > 0 ? batchTorrents : torrents
                }

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
        console.log("AnimeTosho (NEW): Searching batches by query")
        const queries = this.buildSmartSearchQueries(options)
        let allTorrents: AnimeToshoTorrent[] = []

        const searchPromises = queries.map(query => {
            const base = this.getJsonFeedUrl()
            const url = `${base}/search?q=${encodeURIComponent(query)}&limit=100&only_tor=1&order=size-d`
            return this.fetchTorrents(url)
        })

        try {
            const results = await Promise.all(searchPromises)
            allTorrents = results.flat()
        }
        catch (error) {
            console.error("AnimeTosho (NEW): Batch query search failed: " + (error as Error).message)
            return []
        }

        // Filter out single-file torrents unless it's a movie/single-ep.
        // Also include titles that don't contain episode markers.
        allTorrents = allTorrents.filter(t => isMovieOrSingle || (t.file_count ?? 1) > 1 || t.is_batch || /batch|complete|full|pack|~|season/i.test(t.title) || !/(?:(?:S\d{1,2}E\d{1,3}(?:v\d+)?|S\d{1,2}x\d{1,3}(?:v\d+)?|EP?\.?\s*\d{1,3}(?:v\d+)?|E\d{1,3}(?:v\d+)?|episode)\b|-\s*\d{1,3}\b)/i.test(t.title))

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

        const isMovieOrSingle = media.format === "MOVIE" || media.episodeCount === 1

        if (options.anidbEID && options.anidbEID > 0) {
            console.log(`AnimeTosho (NEW): Searching episode by EID ${options.anidbEID}`)
            try {
                const torrents = await this.searchByEID(options.anidbEID, options.query, options.resolution || "")
                // Filter for single-file torrents
                atTorrents = torrents.filter(t => (t.file_count ?? 1) === 1 || !t.is_batch)

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
        console.log("AnimeTosho (NEW): Searching episode by query")
        const queries = this.buildSmartSearchQueries(options)
        let allTorrents: AnimeToshoTorrent[] = []

        const searchPromises = queries.map(query => {
            const base = this.getJsonFeedUrl()
            const url = `${base}/search?q=${encodeURIComponent(query)}&limit=100&only_tor=1&qx=1`
            return this.fetchTorrents(url)
        })

        try {
            const results = await Promise.all(searchPromises)
            allTorrents = results.flat()
        }
        catch (error) {
            console.error("AnimeTosho (NEW): Episode query search failed: " + (error as Error).message)
            return []
        }

        // Filter for single-file torrents, unless it's a movie (which might be multi-file)
        allTorrents = allTorrents.filter(t => isMovieOrSingle || (t.file_count ?? 1) === 1 || !t.is_batch)

        // Convert and remove duplicates
        const animeTorrents = this.torrentSliceToAnimeTorrentSlice(allTorrents, false, media)
        const uniqueTorrents = [...new Map(animeTorrents.map(t => [t.link, t])).values()]

        console.log(`AnimeTosho (NEW): Found ${uniqueTorrents.length} episodes by query`)
        return uniqueTorrents
    }

    // public async getTorrentInfoHash(torrent: AnimeTorrent): Promise<string> {
    //     // InfoHash is provided directly by the API
    //     return torrent.infoHash || ""
    // }

    // public async getTorrentMagnetLink(torrent: AnimeTorrent): Promise<string> {
    //     // MagnetLink is provided directly by the API
    //     return torrent.magnetLink || ""
    // }

    //+ --------------------------------------------------------------------------------------------------
    // Helpers
    //+ --------------------------------------------------------------------------------------------------

    private async fetchTorrents(url: string): Promise<AnimeToshoTorrent[]> {
        console.log(`AnimeTosho (NEW): Fetching from ${url}`)

        const res = await fetch(url)
        if (!res.ok) throw new Error(`Failed to fetch torrents: ${res.status} ${res.statusText}`)

        const response = await res.json() as any

        const torrents = response.data as AnimeToshoTorrent[]

        // Clean up impossibly high seeder/leecher counts
        return torrents.map(t => {
            if (t.seeders > 100000) t.seeders = 0
            if (t.leechers > 100000) t.leechers = 0
            return t
        })
    }

    private searchByAID(aid: number, query: string, quality: string): Promise<AnimeToshoTorrent[]> {
        const base = this.getJsonFeedUrl()

        const res = this.formatQuality(quality)
        const q = query ? this.sanitizeTitle(query) : ""
        const qCombined = [q, res].filter(Boolean).join(" ").trim()

        const url =
            `${base}/releases?aid=${encodeURIComponent(String(aid))}` +
            (qCombined ? `&q=${encodeURIComponent(qCombined)}` : "") +
            `&order=size-d&limit=100`

        return this.fetchTorrents(url)
    }

    private searchByEID(eid: number, query: string, quality: string): Promise<AnimeToshoTorrent[]> {
        const base = this.getJsonFeedUrl()

        const res = this.formatQuality(quality)
        const q = query ? this.sanitizeTitle(query) : ""
        const qCombined = [q, res].filter(Boolean).join(" ").trim()

        const url =
            `${base}/releases?eid=${encodeURIComponent(String(eid))}` +
            (qCombined ? `&q=${encodeURIComponent(qCombined)}` : "") +
            `&limit=100`

        return this.fetchTorrents(url)
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
                str += " " + this.buildBatchGroup(media)
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

    private buildEpisodeString(opts: AnimeSmartSearchOptions): string {
        if (opts.episodeNumber === -1) return ""
        const pEp = this.zeropad(opts.episodeNumber)
        // e.g. ("05"|"e5"|"ep5"|"05")
        return `("${pEp}"|"e${opts.episodeNumber}"|"ep${opts.episodeNumber}"|"${this.zeropad(opts.episodeNumber)}")`
    }

    private buildBatchGroup(media: AnimeSmartSearchOptions["media"]): string {
        const epCount = media.episodeCount || 0
        const parts = [
            `"${this.zeropad(1)} - ${this.zeropad(epCount)}"`,
            `"${this.zeropad(1)} ~ ${this.zeropad(epCount)}"`,
            `"Batch"`,
            `"Full"`,
            `"Pack"`,
            `"Complete"`,
            `"+ OVA"`,
            `"+ Specials"`,
            `"+ Special"`,
            `"Seasons"`,
            `"Season"`,
            `"Parts"`,
        ]
        return `(${parts.join("|")})`
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
        const metadata = $habari.parse(t.series.title)

        const formattedDate = t.date_added || new Date(0).toISOString()

        const isBatch = (t.file_count ?? 1) > 1 || t.is_batch || /batch|complete|full|pack|~/i.test(t.title)
        let episode = -1

        if (metadata.episode_number && metadata.episode_number.length === 1) {
            episode = parseInt(metadata.episode_number[0]) || -1
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
            size: t.size_bytes,
            formattedSize: this.bytesToHuman(t.size_bytes),
            seeders: t.seeders,
            leechers: t.leechers,
            downloadCount: t.downloads,
            link: t.urls.view,
            downloadUrl: t.torrent_url,
            magnetLink: t.magnet,
            infoHash: t.info_hash,
            resolution: metadata.video_resolution || t.resolution || "",
            isBatch: isBatch,
            episodeNumber: episode,
            releaseGroup: metadata.release_group || t.release_group || "",
            isBestRelease: false,
            confirmed: false, // Will be set in torrentSliceToAnimeTorrentSlice
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
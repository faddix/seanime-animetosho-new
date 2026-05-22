/// <reference path="./anime-torrent-provider.d.ts" />
/// <reference path="./core.d.ts" />

interface AnimeToshoTorrent {
    id: number;
    title: string;
    link: string;
    timestamp: number;
    status: string;
    tosho_id?: number;
    nyaa_id?: number;
    nyaa_subdom?: any;
    anidex_id?: number;
    torrent_url: string;
    info_hash: string;
    info_hash_v2?: string;
    magnet_uri: string;
    seeders: number;
    leechers: number;
    torrent_download_count: number;
    tracker_updated?: any;
    nzb_url?: string;
    total_size: number;
    num_files: number;
    anidb_aid: number;
    anidb_eid: number;
    anidb_fid: number;
    article_url: string;
    article_title: string;
    website_url: string;
}

class Provider {
    private jsonFeedUrl = "https://feed.animetosho.xyz/json/v1"

    public getSettings(): AnimeProviderSettings {
        return {
            type: "main",
            canSmartSearch: true,
            smartSearchFilters: ["batch", "episodeNumber", "resolution"],
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
                const torrents = await this.searchByAID(options.anidbAID, options.resolution || "")

                // If it's a movie/single-ep, all torrents are considered "batches"
                if (isMovieOrSingle) {
                    atTorrents = torrents
                } else {
                    // Otherwise, filter for actual batches (multi-file)
                    const batchTorrents = torrents.filter(t => t.num_files > 1)
                    // If we found batches, use them. If not, use all torrents (e.g., for OVAs released as single files)
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
        console.log("AnimeTosho (NEW): Searching batches by query (JSON)")
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

        // Filter out single-file torrents unless it's a movie/single-ep
        allTorrents = allTorrents.filter(t => isMovieOrSingle || t.num_files > 1)

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
                const torrents = await this.searchByEID(options.anidbEID, options.resolution || "")
                // Filter for single-file torrents
                atTorrents = torrents.filter(t => t.num_files === 1)

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
        console.log("AnimeTosho (NEW): Searching episode by query (JSON)")
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
        allTorrents = allTorrents.filter(t => isMovieOrSingle || t.num_files === 1)

        // Convert and remove duplicates
        const animeTorrents = this.torrentSliceToAnimeTorrentSlice(allTorrents, false, media)
        const uniqueTorrents = [...new Map(animeTorrents.map(t => [t.link, t])).values()]

        console.log(`AnimeTosho (NEW): Found ${uniqueTorrents.length} episodes by query`)
        return uniqueTorrents
    }

    public async getTorrentInfoHash(torrent: AnimeTorrent): Promise<string> {
        // InfoHash is provided directly by the API
        return torrent.infoHash || ""
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
        const headers: any = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }

        const res = await fetch(url, { headers })
        if (!res.ok) throw new Error(`Failed to fetch torrents: ${res.status} ${res.statusText}`)

        // Try to detect JSON content
        const contentType = this.getHeader(res, "content-type") ?? ""
        if (contentType.includes('application/json') || url.includes('/json/')) {
            const obj = await res.json()
            // Normalize to array of results
            let items: any[] = []
            if (!obj) items = []
            else if (Array.isArray(obj)) items = obj
            else if (obj.data) {
                if (Array.isArray(obj.data)) items = obj.data
                else if (Array.isArray((obj.data as any).results)) items = (obj.data as any).results
                else if (Array.isArray((obj.data as any).results || obj.data)) items = (obj.data as any).results || obj.data
            }
            else if (Array.isArray(obj.results)) items = obj.results
            else items = []

            const mapped: AnimeToshoTorrent[] = items.map((r: any, idx: number) => {
                const id = r.id || r.nyaa_id || (r.nyaa_id === 0 ? 0 : (idx + 1))
                const title = r.title || r.name || ""
                const link = r.urls && r.urls.length ? r.urls[0] : (r.link || r.source_url || "")
                const torrent_url = r.torrent_url || r.download || r.nzb_url || r.torrent || ""
                const info_hash = (r.info_hash || r.infohash || r.hash || "")
                const magnet_uri = r.magnet || r.magnet_uri || r.magnet_url || ""
                const seeders = Number(r.seeders || r.seeder || 0)
                const leechers = Number(r.leechers || r.leecher || 0)
                const total_size = Number(r.size_bytes || r.total_size || r.size || 0)
                const num_files = Number(r.num_files || 1)
                let timestamp = 0
                const dateStr = r.date_added || r.updated_at || r.pubDate || r.timestamp
                if (dateStr) {
                    const parsed = Date.parse(dateStr)
                    timestamp = Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000)
                }

                return {
                    id: Number(id || idx + 1),
                    title: String(title),
                    link: String(link || ""),
                    timestamp: Number(timestamp || 0),
                    status: String(r.status || ""),
                    tosho_id: r.tosho_id || 0,
                    nyaa_id: r.nyaa_id || 0,
                    nyaa_subdom: r.nyaa_subdom || null,
                    anidex_id: r.anidex_id || 0,
                    torrent_url: String(torrent_url || ""),
                    info_hash: String(info_hash || ""),
                    info_hash_v2: r.info_hash_v2 || "",
                    magnet_uri: String(magnet_uri || ""),
                    seeders: seeders || 0,
                    leechers: leechers || 0,
                    torrent_download_count: Number(r.downloads || r.torrent_download_count || 0),
                    tracker_updated: r.tracker_updated || null,
                    nzb_url: r.nzb_url || "",
                    total_size: total_size || 0,
                    num_files: num_files || 1,
                    anidb_aid: r.anidb_aid || 0,
                    anidb_eid: r.anidb_eid || 0,
                    anidb_fid: r.anidb_fid || 0,
                    article_url: r.article_url || link || "",
                    article_title: r.article_title || title || "",
                    website_url: r.website_url || r.source || "",
                }
            })

            // Sanity clamp seeders/leechers
            return mapped.map(t => {
                if (t.seeders > 100000) t.seeders = 0
                if (t.leechers > 100000) t.leechers = 0
                return t
            })
        }

        // If we expected JSON but got something else, log a warning and return empty
        console.warn('AnimeTosho (NEW): Non-JSON response received. Skipping...')
        return []
    }

    private searchByAID(aid: number, quality: string): Promise<AnimeToshoTorrent[]> {
        const q = this.formatQuality(quality)
        const base = this.getJsonFeedUrl()
        const url = `${base}/releases?aid=${encodeURIComponent(String(aid))}&q=${encodeURIComponent(q)}&order=size-d&limit=100`
        return this.fetchTorrents(url)
    }

    private searchByEID(eid: number, quality: string): Promise<AnimeToshoTorrent[]> {
        const q = this.formatQuality(quality)
        const base = this.getJsonFeedUrl()
        const url = `${base}/releases?eid=${encodeURIComponent(String(eid))}&q=${encodeURIComponent(q)}&limit=100`
        return this.fetchTorrents(url)
    }

    private buildSmartSearchQueries(opts: AnimeSmartSearchOptions): string[] {
        const { media, batch, episodeNumber, resolution } = opts
        const hasSingleEpisode = media.episodeCount === 1 || media.format === "MOVIE"

        let queryStr: string[] = []
        const allTitles = this.getAllTitles(media)

        if (hasSingleEpisode) {
            let str = ""
            // 1. Build a query string
            const qTitles = `(${allTitles.map(t => this.sanitizeTitle(t)).join(" | ")})`
            str += qTitles

            // 2. Add resolution
            if (resolution) {
                str += " " + resolution
            }
            queryStr = [str]

        } else {
            if (!batch) { // Single episode search
                const qTitles = this.buildTitleString(opts)
                const qEpisodes = this.buildEpisodeString(opts)

                let str = ""
                // 1. Add titles
                str += qTitles
                // 2. Add episodes
                if (qEpisodes) {
                    str += " " + qEpisodes
                }
                // 3. Add resolution
                if (resolution) {
                    str += " " + resolution
                }

                queryStr.push(str)

                // If we can also search for absolute episodes
                if (media.absoluteSeasonOffset && media.absoluteSeasonOffset > 0) {
                    const metadata = $habari.parse(media.romajiTitle || "")
                    let absoluteQueryStr = metadata.title || ""

                    const ep = episodeNumber + media.absoluteSeasonOffset
                    absoluteQueryStr += ` ("${ep}"|"e${ep}"|"ep${ep}")`

                    if (resolution) {
                        absoluteQueryStr += " " + resolution
                    }
                    // Combine original query with absolute query
                    queryStr = [`(${absoluteQueryStr}) | (${str})`]
                }

            } else { // Batch search
                let str = `(${media.romajiTitle})`
                if (media.englishTitle) {
                    str = `(${media.romajiTitle} | ${media.englishTitle})`
                }
                str += " " + this.buildBatchGroup(media)
                if (resolution) {
                    str += " " + resolution
                }
                queryStr = [str]
            }
        }

        // Add "-S0" variant for each query (as in Go code)
        const finalQueries: string[] = []
        for (const q of queryStr) {
            finalQueries.push(q)
            finalQueries.push(q + " -S0")
        }

        return finalQueries
    }

    private formatQuality(quality: string): string {
        if (!quality) return ""
        return quality.replace(/p$/i, "")
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
        // e.g. ("01"|"e1") -S0
        return `("${pEp}"|"e${opts.episodeNumber}") -S0`
    }

    private buildBatchGroup(media: AnimeSmartSearchOptions["media"]): string {
        const epCount = media.episodeCount || 0
        const parts = [
            `"${this.zeropad(1)} - ${this.zeropad(epCount)}"`,
            `"${this.zeropad(1)} ~ ${this.zeropad(epCount)}"`,
            `"Batch"`,
            `"Complete"`,
            `"+ OVA"`,
            `"+ Specials"`,
            `"+ Special"`,
            `"Seasons"`,
            `"Parts"`,
        ]
        return `(${parts.join("|")})`
    }

    private extractSeasonNumber(title: string): [number, string] {
        const match = title.match(/\b(season|s)\s*(\d{1,2})\b/i)
        if (match && match[2]) {
            const cleanTitle = title.replace(match[0], "").trim()
            return [parseInt(match[2]), cleanTitle]
        }
        return [0, title]
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
        const formattedDate = t.timestamp ? new Date(t.timestamp * 1000).toISOString() : new Date(0).toISOString()

        const isBatch = t.num_files > 1
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
            size: t.total_size,
            formattedSize: this.bytesToHuman(t.total_size),
            seeders: t.seeders,
            leechers: t.leechers,
            downloadCount: t.torrent_download_count,
            link: t.link,
            downloadUrl: t.torrent_url,
            magnetLink: t.magnet_uri,
            infoHash: t.info_hash,
            resolution: metadata.video_resolution || "",
            isBatch: isBatch,
            episodeNumber: episode,
            releaseGroup: metadata.release_group || "",
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

    private getHeader(res: any, name: string): string | undefined {
        if (!res || !res.headers) return undefined;
        const h: any = res.headers;
        if (typeof h.get === "function") return h.get(name);
        // header names may be lowercase or as properties
        return h[name] ?? h[name.toLowerCase()];
    }
}
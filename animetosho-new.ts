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
    private jsonFeedUrl = "https://feed.animetosho.xyz/feed/json"

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

    private getJsonFeedUrl() {
        let url = $getUserPreference("jsonUrl") || this.jsonFeedUrl
        if (url.endsWith("/")) url = url.slice(0, -1)
        if (!url.startsWith("http")) url = "https://" + url
        return url
    }

    private buildApiUrl(params: Record<string, string | number | boolean | undefined>): string {
        const base = this.getJsonFeedUrl()
        const query = Object.entries(params)
            .filter(([, value]) => value !== undefined && value !== null && value !== "")
            .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
            .join("&")

        return `${base}${query ? `?${query}` : ""}`
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

        const isMovieOrSingle = media.format === "MOVIE" || media.episodeCount === 1

        if (options.anidbAID && options.anidbAID > 0) {
            console.log(`AnimeTosho (NEW): Searching batches by AID ${options.anidbAID}`)
            try {
                const torrents = await this.searchByAID(options.anidbAID, options.query, options.resolution || "", this.getBatchSearchOrder())

                // If it's a movie/single-ep, all torrents are considered "batches"
                if (isMovieOrSingle) {
                    atTorrents = torrents
                } else {
                    // Otherwise, filter for actual batches (multi-file)
                    // Also filter out titles that contain episode markers.
                    const batchTorrents = torrents.filter(t => isMovieOrSingle || this.isBatchTorrent(t))

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

        // Filter out single-file torrents unless it's a movie/single-ep.
        // Also filter out titles that contain episode markers.
        allTorrents = allTorrents.filter(t => isMovieOrSingle || this.isBatchTorrent(t))

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
                const torrents = await this.searchByEID(options.anidbEID, options.query, options.resolution || "", this.getSingleEpisodeSearchOrder())
                // Filter for single-file torrents
                atTorrents = torrents.filter(t => (!this.isBatchTorrent(t)))

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

        // Filter for single-file torrents, unless it's a movie (which might be multi-file)
        allTorrents = allTorrents.filter(t => isMovieOrSingle || (t.num_files ?? 1) === 1)

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
                // Use the habari parser to filter for the correct episode number
                const filteredTorrents = torrents.filter(t => {
                    const metadata = $habari.parse(t.title)
                    // Check if the episode number is included in the range
                    if (metadata.episode_number && metadata.episode_number.length > 0) {
                        const epNum = options.episodeNumber
                        if (epNum && epNum > 0) {
                            const epRange = metadata.episode_number.map(n => parseInt(n)).filter(n => !isNaN(n))
                            if (epRange.length > 0) {
                                const minEp = Math.min(...epRange)
                                const maxEp = Math.max(...epRange)
                                if (epNum >= minEp && epNum <= maxEp) {
                                    return true
                                }
                            }
                        }
                    }
                    return false
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

        const res = await fetch(url)
        if (!res.ok) throw new Error(`Failed to fetch torrents: ${res.status} ${res.statusText}`)

        const response = await res.json() as any
        const torrents = Array.isArray(response) ? response : []

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

        for (let page = 1; page <= maxPages; page++) {
            console.log(`AnimeTosho (NEW): Fetching page ${page} of ${maxPages}`)
            const url = this.buildApiUrl({ ...params, page, limit: pageSize })
            const pageTorrents = await this.fetchTorrents(url)

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

    private isBatchTorrent(t: AnimeToshoTorrent): boolean {
        const title = (t.title ?? "")
            .normalize("NFKC")
            // Normalize Unicode dashes and tildes.
            .replace(/[‐-‒–—―−﹘﹣－]/g, "-")
            .replace(/[〜～]/g, "~")
            .replace(/\s+/g, " ")
            .trim();

        if (!title)
            return false;

        /*
         * Definite single-episode formats.
         *
         * Used later to prevent season notation from being interpreted as a batch:
         *   Season 4-04
         *   S01E01
         *   S01 - 01
         */
        const hasSingleEpisode =
            // Season 4-04, Season 4 - 04, Season 04-004
            /\bSeason\s+\d{1,2}\s*-\s*0\d{1,3}(?:v\d+)?\b/i.test(title) ||

            // S01E01, S01 EP01, S01 Episode 01, S01x01
            /\bS\d{1,2}[\s._-]*(?:E(?:P(?:ISODE)?)?|x)\s*\d{1,4}(?:v\d+)?\b/i.test(
                title,
            ) ||

            // Episode 01, Episode #01, EP01
            /\b(?:Episode|EP)\s*#?\s*\d{1,4}(?:v\d+)?\b/i.test(title) ||

            // S01 - 01, S01.01, S01_01
            /\bS\d{1,2}[\s._-]+\d{1,4}(?:v\d+)?\b/i.test(title) ||

            // Generic release notation: Show Name - 01
            /(?:^|[\s\])}])-\s*\d{1,4}(?:v\d+)?\b/i.test(title);

        /*
         * Explicit batch wording.
         *
         * Bare "full" and bare "season" are excluded because they frequently
         * occur in normal single-episode titles.
         */
        const hasExplicitBatchWording =
            /\b(?:batch|complete(?:d)?|collection|box\s*set|boxset|all\s+(?:episodes?|eps?|seasons?)|full\s+(?:series|season)|(?:series|season|episode)\s+(?:collection|pack))\b/i.test(
                title,
            ) ||
            /[\[({]\s*(?:batch|collection|pack)\s*[\])}]/i.test(title) ||
            /(?:全集|合集|全巻|全編|完結|完结|一挙|まとめ|완결|전편|全\s*\d{1,4}\s*(?:話|话|集))/u.test(
                title,
            );

        if (hasExplicitBatchWording)
            return true;

        const definiteBatchPatterns: readonly RegExp[] = [
            /*
             * Season/episode ranges:
             *   S01E01-E12
             *   S01E01-12
             *   S01 E01 ~ E12
             *   S01E01-S02E03
             *   S01E1144-E1155
             */
            /\bS\d{1,2}[\s._-]*E(?:P(?:ISODE)?)?\s*\d{1,4}(?:v\d+)?\s*(?:-|~|\.\.|to|through|thru)\s*(?:S\d{1,2}[\s._-]*)?E?(?:P(?:ISODE)?)?\s*\d{1,4}(?:v\d+)?\b/i,

            // E01-E12, EP01-EP12, Episode01-Episode12
            /\bE(?:P(?:ISODE)?)?\s*\d{1,4}(?:v\d+)?\s*(?:-|~|\.\.|to|through|thru)\s*E?(?:P(?:ISODE)?)?\s*\d{1,4}(?:v\d+)?\b/i,

            // Episodes 1-12, EPs 01 through 24
            /\b(?:Episodes?|EPs?)\s*#?\s*\d{1,4}(?:v\d+)?\s*(?:-|~|\.\.|to|through|thru)\s*(?:(?:Episodes?|EPs?)\s*#?\s*)?\d{1,4}(?:v\d+)?\b/i,

            // 第1話-第12話, 1話~12話
            /(?:第\s*)?\d{1,4}\s*話?\s*(?:-|~|\.\.|から)\s*(?:第\s*)?\d{1,4}\s*話/u,

            /*
             * Explicit season ranges:
             *   S01-S03
             *   S01~S03
             *   S01 + S02
             */
            /\bS\d{1,2}\s*(?:-|~|\.\.|to|through|thru|\+|&)\s*S\d{1,2}\b/i,

            // Seasons 1-3, Seasons 1 through 3
            /\bSeasons\s+\d{1,2}\s*(?:-|~|\.\.|to|through|thru|\+|&)\s*(?:Seasons?\s*)?\d{1,2}\b/i,

            // Season 1 - Season 3
            /\bSeason\s+\d{1,2}\s*(?:-|~|\.\.|to|through|thru|\+|&)\s*Season\s+\d{1,2}\b/i,

            /*
             * Compact singular season range:
             *   Season 1-3  => batch
             *   Season 4-04 => single episode, excluded by leading-zero guard
             */
            /\bSeason\s+\d{1,2}-(?!0\d+\b)\d{1,2}\b/i,

            // Vol.1-6, Volumes 1~6, Discs 1-4, Parts 1-3, Cours 1-2
            /\b(?:Vol(?:ume)?s?|Discs?|Parts?|Cours?)\.?\s*\d{1,3}\s*(?:-|~|\.\.|to|through|thru|\+|&)\s*(?:(?:Vol(?:ume)?s?|Discs?|Parts?|Cours?)\.?\s*)?\d{1,3}\b/i,

            // S01 + Specials, Season 1 & OVAs
            /\b(?:S\d{1,2}|Season\s+\d{1,2})\s*(?:\+|&|,)\s*(?:OVAs?|ONAs?|Specials?|Movies?|Films?|Extras?)\b/i,

            // TV + OVA
            /\bTV\s*(?:\+|&)\s*(?:OVAs?|ONAs?|Specials?|Movies?|Films?|Extras?)\b/i,

            // S01E01+E02, EP01, EP02, E01 & E02
            /\b(?:S\d{1,2}[\s._-]*)?E(?:P(?:ISODE)?)?\s*\d{1,4}(?:v\d+)?(?:\s*(?:,|\+|&)\s*(?:(?:S\d{1,2}[\s._-]*)?E(?:P(?:ISODE)?)?)?\s*\d{1,4}(?:v\d+)?)+\b/i,

            // S01E01/E02; slash requires a second explicit episode prefix
            /\b(?:S\d{1,2}[\s._-]*)?E(?:P(?:ISODE)?)?\s*\d{1,4}(?:v\d+)?\s*\/\s*(?:(?:S\d{1,2}[\s._-]*)?E(?:P(?:ISODE)?)?)\s*\d{1,4}(?:v\d+)?\b/i,

            // Episodes 01, 02, 03
            /\b(?:Episodes?|EPs?)\s*[:#]?\s*\d{1,4}(?:v\d+)?(?:\s*(?:,|\+|&)\s*\d{1,4}(?:v\d+)?)+\b/i,

            // (01+02), [01, 02], 01 & 02
            /(?:^|[\s[(])0\d{1,3}(?:v\d+)?(?:\s*(?:,|\+|&)\s*0?\d{1,4}(?:v\d+)?)+(?=$|[\s)\]])/i,
        ];

        if (definiteBatchPatterns.some((pattern) => pattern.test(title)))
            return true;

        /*
         * Completed count:
         *   12/12
         *   37/37 + OST
         *
         * 12/13 is not complete and therefore is not treated as a batch.
         */
        const completedFraction = title.match(/\b(\d{1,4})\s*\/\s*(\d{1,4})\b/);

        if (completedFraction) {
            const current = Number(completedFraction[1]);
            const total = Number(completedFraction[2]);

            if (current > 1 && current === total)
                return true;
        }

        /*
         * Bare episode ranges:
         *   01-12
         *   001~024
         *   1-37
         *   1123~1133
         *
         * Numeric/context guards prevent technical metadata, dates, years and
         * season-episode notation from being classified as batches.
         */
        const technicalNumbers = new Set([
            144,
            240,
            360,
            480,
            540,
            576,
            720,
            900,
            1080,
            1440,
            2160,
            4320,
        ]);

        const bareRangePattern =
            /(?:^|[^\p{L}\p{N}])(\d{1,4})(?:v\d+)?\s*(-|~|\.\.|to|through|thru)\s*(\d{1,4})(?:v\d+)?(?=$|[^\p{L}\p{N}])/giu;

        for (const match of title.matchAll(bareRangePattern)) {
            const fromText = match[1];
            const separator = match[2];
            const toText = match[3];

            const from = Number(fromText);
            const to = Number(toText);

            if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from)
                continue;

            // Exclude year ranges such as 1999-2000.
            if (
                from >= 1900 &&
                from <= 2099 &&
                to >= 1900 &&
                to <= 2099
            ) {
                continue;
            }

            // Exclude resolution ranges such as 480-1080.
            if (technicalNumbers.has(from) && technicalNumbers.has(to))
                continue;

            const matchedText = match[0];
            const matchStart = match.index ?? 0;
            const fromOffset = matchedText.indexOf(fromText);
            const absoluteFromStart = matchStart + fromOffset;
            const absoluteRangeEnd = matchStart + matchedText.length;

            const prefix = title.slice(
                Math.max(0, absoluteFromStart - 32),
                absoluteFromStart,
            );

            const suffix = title.slice(
                absoluteRangeEnd,
                absoluteRangeEnd + 32,
            );

            // Exclude 8-10 bit, 24-60 fps, 2-6 channels, etc.
            if (
                /^\s*(?:bits?|fps|hz|khz|mhz|mb|gb|kb|ch(?:annels?)?)\b/i.test(
                    suffix,
                )
            ) {
                continue;
            }

            // Exclude dates such as 04-05-2024 and 12-05-24.
            if (
                separator === "-" &&
                from <= 31 &&
                to <= 31 &&
                /^\s*-\s*(?:\d{1,2}|(?:19|20)\d{2})\b/.test(suffix)
            ) {
                continue;
            }

            /*
             * Exclude long season/episode notation:
             *   Season 4-04
             *   Season 4 - 04
             *
             * A zero-padded value after the hyphen is treated as an episode.
             */
            if (
                separator === "-" &&
                /\bSeason\s*$/i.test(prefix) &&
                /^0\d+$/.test(toText)
            ) {
                continue;
            }

            return true;
        }

        /*
         * Season-only releases:
         *   S01
         *   Season 1
         *   1st Season
         *
         * A definite episode marker overrides this classification.
         */
        const hasSeasonMarker =
            /\b(?:S\d{1,2}|Season\s+\d{1,2}|\d{1,2}(?:st|nd|rd|th)\s+Season)\b/i.test(
                title,
            );

        if (hasSeasonMarker && !hasSingleEpisode)
            return true;
        return false;
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
        const metadata = $habari.parse(t.title)

        // Convert UNIX timestamp to ISO string
        const formattedDate = new Date(t.timestamp * 1000).toISOString()

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
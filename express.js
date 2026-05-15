const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const SCRAPER_ORIGIN = 'https://cdn-bubbles.xyz';

app.use(cors({
    origin: '*',
    methods: ['GET', 'OPTIONS'],
    allowedHeaders: ['*']
}));

app.options('/{*path}', cors());

const ALLOWED_HOSTS = [
    'vidup.to',
    'vidfast.pro',
    'workers.dev',
    'stream-balancer',
    'cdn-bubbles.xyz',
    'cardlawgive.workers.dev'
];

function isAllowedUrl(urlString) {
    try {
        const parsed = new URL(urlString);

        if (
            parsed.protocol !== 'https:' &&
            parsed.protocol !== 'http:'
        ) {
            return false;
        }

        if (parsed.hostname.endsWith('.live')) {
            return true;
        }

        return ALLOWED_HOSTS.some(host =>
            parsed.hostname === host ||
            parsed.hostname.endsWith(`.${host}`)
        );

    } catch {
        return false;
    }
}

function getHeaders(targetUrl) {
    let origin = 'https://vidfast.pro';
    let referer = 'https://vidfast.pro/';

    if (
        targetUrl.includes('vidup.to') ||
        targetUrl.includes('workers.dev')
    ) {
        origin = 'https://vidup.to';
        referer = 'https://vidup.to/';
    }

    return {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        'Origin': origin,
        'Referer': referer,
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'cross-site',
        'Accept-Encoding': 'identity'
    };
}

async function rewriteManifest(text, manifestUrl) {
    const baseUrl = new URL(manifestUrl);

    return text
        .split('\n')
        .map(line => {
            const trimmed = line.trim();

            if (!trimmed) return line;

            // rewrite AES key URIs to absolute
            if (trimmed.startsWith('#EXT-X-KEY')) {
                return trimmed.replace(
                    /URI="([^"]+)"/g,
                    (_, uri) => `URI="${new URL(uri, baseUrl).href}"`
                );
            }

            // leave other tags alone
            if (trimmed.startsWith('#')) return line;

            // resolve relative → absolute
            const absolute = new URL(trimmed, baseUrl).href;

            // chunklists (.m3u8) go through /proxy so they get rewritten too
            if (absolute.endsWith('.m3u8') || absolute.includes('.m3u8?')) {
                return `/proxy?url=${encodeURIComponent(absolute)}`;
            }

            // segments go direct to CDN — no proxying
            return absolute;
        })
        .join('\n');
}

// Proxy route for chunklists (secondary .m3u8 files)
app.get('/proxy', async (req, res) => {
    const target = req.query.url;

    if (!target) {
        return res.status(400).send('Missing url param');
    }

    if (!isAllowedUrl(target)) {
        return res.status(403).send('Blocked domain');
    }

    try {
        const response = await fetch(target, {
            headers: getHeaders(target)
        });

        if (!response.ok) {
            return res
                .status(response.status)
                .send(`Upstream error: ${response.status}`);
        }

        const text = await response.text();
        const rewritten = await rewriteManifest(text, target);

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.send(rewritten);

    } catch (err) {
        return res.status(500).send(err.message);
    }
});

app.get('/movie/:id/:slug', async (req, res) => {
    handleRoute(req, res);
});

app.get('/tv/:id/:season/:episode', async (req, res) => {
    handleRoute(req, res);
});

async function handleRoute(req, res) {
    try {
        const path = req.originalUrl;

        // fetch stream URL from scraper
        const scraperResponse = await fetch(`${SCRAPER_ORIGIN}${path}`);
        const scraperData = await scraperResponse.json();

        if (!scraperData.stream) {
            return res.status(404).send('No stream found');
        }

        const manifestUrl = scraperData.stream;

        if (!isAllowedUrl(manifestUrl)) {
            return res.status(403).send('Blocked domain');
        }

        // fetch master manifest
        const manifestResponse = await fetch(manifestUrl, {
            headers: getHeaders(manifestUrl)
        });

        if (!manifestResponse.ok) {
            return res
                .status(manifestResponse.status)
                .send(`Manifest failed: ${manifestResponse.status}`);
        }

        const manifestText = await manifestResponse.text();
        const rewritten = await rewriteManifest(manifestText, manifestUrl);

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.send(rewritten);

    } catch (err) {
        return res.status(500).send(err.message);
    }
}

app.listen(PORT, () => {
    console.log(`Manifest server running on port ${PORT}`);
});
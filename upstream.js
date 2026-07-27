import { gotScraping } from 'got-scraping';
import { CONFIG } from './config.js';

let active = 0;
const waiters = [];

function acquire() {
    if (active < CONFIG.UPSTREAM_CONCURRENCY) {
        active++;
        return Promise.resolve();
    }
    return new Promise((resolve) => waiters.push(resolve));
}

function release() {
    const next = waiters.shift();
    if (next) {
        next();
    } else {
        active = Math.max(0, active - 1);
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => Math.floor(Math.random() * CONFIG.UPSTREAM_RETRY_JITTER_MS);

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

const HEADER_GEN = {
    browsers: [{ name: 'chrome', minVersion: 120 }],
    devices: ['desktop'],
    operatingSystems: ['windows'],
    locales: ['en-US', 'en'],
};

const KEEP_HEADERS = new Set([
    'referer', 'origin', 'cookie', 'range', 'authorization',
    'if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since',
]);

function pickHeaders(headers = {}) {
    const out = {};
    for (const [k, v] of Object.entries(headers)) {
        if (v == null) continue;
        if (KEEP_HEADERS.has(k.toLowerCase())) out[k.toLowerCase()] = v;
    }
    return out;
}

async function doFetch(options) {
    const resp = await gotScraping({
        method: options.method || 'GET',
        url: options.url,
        headers: pickHeaders(options.headers),
        responseType: 'buffer',
        decompress: true,
        throwHttpErrors: false,
        followRedirect: true,
        timeout: { request: options.timeout || 20000 },
        https: { rejectUnauthorized: options.strictSSL !== false },
        retry: { limit: 0 },
        headerGeneratorOptions: HEADER_GEN,
    });
    return { statusCode: resp.statusCode, headers: resp.headers, body: resp.body };
}

function isNetworkError(err) {
    const code = err && err.code;
    return code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EAI_AGAIN' ||
        code === 'ECONNREFUSED' || code === 'ESOCKETTIMEDOUT' || /timeout/i.test(err?.message || '');
}

function backoffMs(attempt, resp) {
    const retryAfter = resp && resp.headers && resp.headers['retry-after'];
    if (retryAfter) {
        const secs = parseInt(retryAfter, 10);
        if (!Number.isNaN(secs)) return Math.min(secs * 1000, CONFIG.UPSTREAM_RETRY_MAX_MS) + jitter();
    }
    return Math.min(CONFIG.UPSTREAM_RETRY_BASE_MS * 2 ** attempt, CONFIG.UPSTREAM_RETRY_MAX_MS) + jitter();
}

async function runWithRetry(options) {
    let lastErr;
    for (let attempt = 0; attempt <= CONFIG.UPSTREAM_RETRY; attempt++) {
        try {
            const resp = await doFetch(options);
            if (RETRYABLE_STATUS.has(resp.statusCode) && attempt < CONFIG.UPSTREAM_RETRY) {
                await sleep(backoffMs(attempt, resp));
                continue;
            }
            return resp;
        } catch (err) {
            lastErr = err;
            const status = err && err.response && err.response.statusCode;
            const retryable = (status && RETRYABLE_STATUS.has(status)) || isNetworkError(err);
            if (retryable && attempt < CONFIG.UPSTREAM_RETRY) {
                await sleep(backoffMs(attempt, err.response));
                continue;
            }
            throw err;
        }
    }
    throw lastErr;
}

const inflight = new Map();

export function fetchUpstream(options, dedupeKey = null) {
    if (dedupeKey && inflight.has(dedupeKey)) {
        return inflight.get(dedupeKey);
    }

    const p = (async () => {
        await acquire();
        try {
            return await runWithRetry(options);
        } finally {
            release();
        }
    })();

    if (dedupeKey) {
        inflight.set(dedupeKey, p);
        const cleanup = () => { if (inflight.get(dedupeKey) === p) inflight.delete(dedupeKey); };
        p.then(cleanup, cleanup);
    }

    return p;
}

export function upstreamStats() {
    return { active, queued: waiters.length, inflight: inflight.size };
}

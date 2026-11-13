// Minimal REST client shared by every platform adapter, plus the Weblate
// flavour of it. Works in browsers and in Node 18+.

export class RateLimitError extends Error {
  constructor(message, retryAfterSeconds) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfterSeconds;
  }
}

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
  }
}

// Thrown when the request never produced a readable response. In a browser
// this almost always means the instance does not send CORS headers.
export class NetworkError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NetworkError';
  }
}

const DEFAULT_RETRY_SECONDS = 3600;

export function normalizeBaseUrl(url) {
  let u = String(url || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u.replace(/\/+$/, '').replace(/\/api$/i, '');
}

export class HttpClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl   e.g. https://hosted.weblate.org
   * @param {string} [opts.apiRoot] path prefix of the API below baseUrl, e.g. /api
   * @param {string} [opts.token]   optional API token
   * @param {Function} [opts.auth]  token -> headers; default is "Authorization: Token …"
   * @param {string} [opts.accept]  Accept header
   * @param {Function} [opts.fetch] fetch implementation
   * @param {object} [opts.headers] extra headers (Node only: User-Agent)
   * @param {Function} [opts.onRequest] called after every request with rate info
   */
  constructor({
    baseUrl,
    apiRoot,
    token,
    auth,
    accept,
    fetch: fetchImpl,
    headers,
    onRequest,
  } = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.apiRoot = apiRoot || '';
    this.token = token || '';
    this.auth = auth || ((t) => ({ Authorization: `Token ${t}` }));
    this.accept = accept || 'application/json';
    this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
    this.headers = headers || {};
    this.onRequest = onRequest || (() => {});
    this.requests = 0;
    this.rate = { limit: null, remaining: null, reset: null };
  }

  url(path, params) {
    const base = /^https?:\/\//i.test(path)
      ? path
      : `${this.baseUrl}${this.apiRoot}/${String(path).replace(/^\/+/, '')}`;
    const u = new URL(base);
    for (const [key, value] of Object.entries(params || {})) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) value.forEach((v) => u.searchParams.append(key, v));
      else u.searchParams.set(key, value);
    }
    return u.toString();
  }

  async get(path, params) {
    const url = this.url(path, params);
    const headers = { Accept: this.accept, ...this.headers };
    if (this.token) Object.assign(headers, this.auth(this.token));

    let res;
    try {
      res = await this.fetch(url, { headers });
    } catch (err) {
      throw new NetworkError(`Could not reach ${this.baseUrl} (${err.message})`);
    }
    this.requests += 1;

    const num = (name) => {
      const v = res.headers.get(name);
      return v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v);
    };
    // Cross-origin responses only expose these if the server allows it.
    this.rate = {
      limit: num('X-RateLimit-Limit') ?? this.rate.limit,
      remaining: num('X-RateLimit-Remaining'),
      reset: num('X-RateLimit-Reset'),
    };
    this.onRequest(this);

    if (res.status === 429) {
      const retry = num('Retry-After') ?? this.rate.reset ?? DEFAULT_RETRY_SECONDS;
      throw new RateLimitError(`Rate limit reached on ${this.baseUrl}`, retry);
    }
    if (res.status === 404) throw new NotFoundError(`Not found: ${url}`);
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        this.token
          ? `${this.baseUrl} rejected the API token (HTTP ${res.status})`
          : `${this.baseUrl} requires authentication (HTTP ${res.status})`,
      );
    }
    if (!res.ok) throw new Error(`${this.baseUrl} answered HTTP ${res.status}`);
    return res.json();
  }
}

export class WeblateClient extends HttpClient {
  constructor(opts = {}) {
    super({ ...opts, apiRoot: '/api' });
  }

  /** Follow `next` links, up to maxPages. Returns { results, complete }. */
  async getPaged(path, params, maxPages = 1) {
    const results = [];
    let next = this.url(path, params);
    let pages = 0;
    while (next && pages < maxPages) {
      const data = await this.get(next);
      results.push(...(data.results || []));
      next = data.next;
      pages += 1;
    }
    return { results, complete: !next };
  }
}

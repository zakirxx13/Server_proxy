const ALLOWED_METHODS = "GET, HEAD, OPTIONS";

export default {
  async fetch(request) {
    const requestUrl = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    // Only GET / HEAD
    if (request.method !== "GET" && request.method !== "HEAD") {
      return json(
        {
          error: "Method Not Allowed"
        },
        405
      );
    }

    // Read target URL
    const target = requestUrl.searchParams.get("url");

    if (!target) {
      return json(
        {
          error: "Missing url parameter"
        },
        400
      );
    }

    let targetUrl;

    try {
      targetUrl = new URL(target);
    } catch {
      return json(
        {
          error: "Invalid URL",
          target
        },
        400
      );
    }

    // Only HTTPS
    if (targetUrl.protocol !== "https:") {
      return json(
        {
          error: "Only HTTPS URLs are allowed"
        },
        400
      );
    }

    try {
      /*
       * Build upstream headers.
       * Do not send an empty Range header.
       */
      const upstreamHeaders = new Headers();

      upstreamHeaders.set(
        "User-Agent",
        request.headers.get("User-Agent") ||
          "Mozilla/5.0"
      );

      upstreamHeaders.set(
        "Accept",
        request.headers.get("Accept") ||
          "*/*"
      );

      const range = request.headers.get("Range");

      if (range) {
        upstreamHeaders.set("Range", range);
      }

      /*
       * Fetch upstream.
       */
      const upstream = await fetch(targetUrl.href, {
        method: request.method,
        headers: upstreamHeaders,
        redirect: "follow"
      });

      /*
       * Copy basic response headers.
       */
      const responseHeaders = new Headers(
        corsHeaders()
      );

      copyHeader(
        upstream,
        responseHeaders,
        "content-type"
      );

      copyHeader(
        upstream,
        responseHeaders,
        "content-length"
      );

      copyHeader(
        upstream,
        responseHeaders,
        "content-range"
      );

      copyHeader(
        upstream,
        responseHeaders,
        "accept-ranges"
      );

      copyHeader(
        upstream,
        responseHeaders,
        "etag"
      );

      copyHeader(
        upstream,
        responseHeaders,
        "last-modified"
      );

      /*
       * Detect M3U8.
       */
      const contentType =
        upstream.headers.get("content-type") || "";

      const isPlaylist =
        targetUrl.pathname
          .toLowerCase()
          .endsWith(".m3u8") ||
        contentType
          .toLowerCase()
          .includes("mpegurl") ||
        contentType
          .toLowerCase()
          .includes("mpeg-url");

      /*
       * HEAD request.
       */
      if (request.method === "HEAD") {
        if (isPlaylist) {
          responseHeaders.set(
            "Content-Type",
            "application/vnd.apple.mpegurl"
          );
        }

        return new Response(null, {
          status: upstream.status,
          headers: responseHeaders
        });
      }

      /*
       * Upstream HTTP error.
       */
      if (!upstream.ok) {
        let errorBody = "";

        try {
          errorBody = await upstream.text();
        } catch {
          errorBody = "";
        }

        return json(
          {
            error: "Upstream request failed",
            status: upstream.status,
            statusText: upstream.statusText,
            contentType,
            body: errorBody.substring(0, 1000)
          },
          upstream.status
        );
      }

      /*
       * Handle M3U8 playlist.
       */
      if (isPlaylist) {
        const playlist = await upstream.text();

        /*
         * Sometimes a URL ending in .m3u8 may return
         * HTML or another non-playlist response.
         */
        if (
          !playlist
            .trimStart()
            .startsWith("#EXTM3U")
        ) {
          responseHeaders.set(
            "Content-Type",
            contentType ||
              "application/octet-stream"
          );

          return new Response(
            playlist,
            {
              status: upstream.status,
              headers: responseHeaders
            }
          );
        }

        /*
         * Rewrite playlist URLs.
         */
        const rewritten = rewritePlaylist(
          playlist,
          targetUrl,
          requestUrl
        );

        responseHeaders.set(
          "Content-Type",
          "application/vnd.apple.mpegurl"
        );

        responseHeaders.set(
          "Cache-Control",
          "no-cache, no-store"
        );

        return new Response(
          rewritten,
          {
            status: 200,
            headers: responseHeaders
          }
        );
      }

      /*
       * Non-playlist response:
       * TS / M4S / MP4 / key / other media.
       */
      return new Response(
        upstream.body,
        {
          status: upstream.status,
          headers: responseHeaders
        }
      );

    } catch (error) {
      /*
       * This makes Worker runtime errors visible
       * instead of producing an unexplained response.
       */
      return json(
        {
          error: "Worker proxy exception",
          name: error?.name || "Error",
          message:
            error?.message ||
            String(error)
        },
        502
      );
    }
  }
};


/*
 * Rewrite M3U8 playlist.
 */
function rewritePlaylist(
  playlist,
  targetUrl,
  requestUrl
) {
  return playlist
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();

      /*
       * Empty lines.
       */
      if (!trimmed) {
        return line;
      }

      /*
       * HLS tag.
       *
       * Examples:
       *
       * #EXT-X-KEY:URI="..."
       * #EXT-X-MAP:URI="..."
       * #EXT-X-MEDIA:URI="..."
       */
      if (trimmed.startsWith("#")) {
        return line.replace(
          /(URI\s*=\s*["'])([^"']+)(["'])/gi,
          (match, prefix, uri, suffix) => {
            try {
              const absolute =
                new URL(
                  uri,
                  targetUrl.href
                ).href;

              return (
                prefix +
                makeProxyUrl(
                  requestUrl,
                  absolute
                ) +
                suffix
              );
            } catch {
              return match;
            }
          }
        );
      }

      /*
       * Media segment or child playlist.
       *
       * Example:
       *
       * segment001.ts
       * 720p/index.m3u8
       * https://example.com/video.ts
       */
      try {
        const absolute =
          new URL(
            trimmed,
            targetUrl.href
          ).href;

        return makeProxyUrl(
          requestUrl,
          absolute
        );
      } catch {
        return line;
      }
    })
    .join("\n");
}


/*
 * Create another proxy URL.
 */
function makeProxyUrl(
  workerRequestUrl,
  target
) {
  const proxyUrl =
    new URL(
      workerRequestUrl.origin +
        workerRequestUrl.pathname
    );

  proxyUrl.searchParams.set(
    "url",
    target
  );

  return proxyUrl.toString();
}


/*
 * CORS headers.
 */
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",

    "Access-Control-Allow-Methods":
      ALLOWED_METHODS,

    "Access-Control-Allow-Headers":
      "Content-Type, Range",

    "Access-Control-Expose-Headers":
      "Content-Length, Content-Range, Accept-Ranges, Content-Type, ETag",

    "Vary": "Origin",

    "X-Content-Type-Options":
      "nosniff"
  };
}


/*
 * Copy a response header.
 */
function copyHeader(
  source,
  target,
  name
) {
  const value =
    source.headers.get(name);

  if (value) {
    target.set(name, value);
  }
}


/*
 * JSON response helper.
 */
function json(data, status) {
  return new Response(
    JSON.stringify(
      data,
      null,
      2
    ),
    {
      status,
      headers: {
        "Content-Type":
          "application/json; charset=utf-8",

        ...corsHeaders()
      }
    }
  );
      }

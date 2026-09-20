export default {
  async fetch(request) {
    const requestUrl = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: corsHeaders()
      });
    }

    const target = requestUrl.searchParams.get("url");

    if (!target) {
      return json(
        { error: "Missing url parameter" },
        400
      );
    }

    let targetUrl;

    try {
      targetUrl = new URL(target);
    } catch {
      return json(
        { error: "Invalid URL" },
        400
      );
    }

    // Allow only HTTPS targets.
    if (targetUrl.protocol !== "https:") {
      return json(
        { error: "Only HTTPS URLs are allowed" },
        400
      );
    }

    try {
      const upstream = await fetch(targetUrl.href, {
        method: request.method,
        headers: {
          "User-Agent":
            request.headers.get("User-Agent") ||
            "Mozilla/5.0",
          "Accept":
            request.headers.get("Accept") ||
            "*/*",
          "Range":
            request.headers.get("Range") || ""
        },
        redirect: "follow"
      });

      const contentType =
        upstream.headers.get("content-type") || "";

      const isPlaylist =
        targetUrl.pathname.toLowerCase().endsWith(".m3u8") ||
        contentType.toLowerCase().includes("mpegurl") ||
        contentType.toLowerCase().includes("mpeg-url");

      const headers = new Headers(
        corsHeaders()
      );

      if (isPlaylist) {
        if (request.method === "HEAD") {
          headers.set(
            "Content-Type",
            "application/vnd.apple.mpegurl"
          );

          return new Response(null, {
            status: upstream.status,
            headers
          });
        }

        const playlist = await upstream.text();

        if (!playlist.trimStart().startsWith("#EXTM3U")) {
          headers.set(
            "Content-Type",
            contentType ||
              "application/octet-stream"
          );

          return new Response(playlist, {
            status: upstream.status,
            headers
          });
        }

        const rewritten = playlist
          .split("\n")
          .map(line => {
            const trimmed = line.trim();

            if (!trimmed) {
              return line;
            }

            /*
             * Rewrite URI="..." values such as:
             *
             * #EXT-X-KEY:URI="key.key"
             * #EXT-X-MAP:URI="init.mp4"
             */
            if (trimmed.startsWith("#")) {
              return line.replace(
                /(URI\s*=\s*["'])([^"']+)(["'])/gi,
                (match, prefix, uri, suffix) => {
                  try {
                    const absolute =
                      new URL(uri, targetUrl.href).href;

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
             * Rewrite media segments and child playlists.
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

        headers.set(
          "Content-Type",
          "application/vnd.apple.mpegurl"
        );

        headers.set(
          "Cache-Control",
          "no-cache"
        );

        return new Response(rewritten, {
          status: 200,
          headers
        });
      }

      /*
       * Forward non-playlist content such as
       * authorized HLS media segments.
       */
      copyHeader(
        upstream,
        headers,
        "content-type"
      );

      copyHeader(
        upstream,
        headers,
        "content-length"
      );

      copyHeader(
        upstream,
        headers,
        "content-range"
      );

      copyHeader(
        upstream,
        headers,
        "accept-ranges"
      );

      copyHeader(
        upstream,
        headers,
        "etag"
      );

      copyHeader(
        upstream,
        headers,
        "last-modified"
      );

      return new Response(
        request.method === "HEAD"
          ? null
          : upstream.body,
        {
          status: upstream.status,
          headers
        }
      );

    } catch (error) {
      return json(
        {
          error: "Proxy request failed",
          message: error.message
        },
        502
      );
    }
  }
};

function makeProxyUrl(workerUrl, target) {
  const url = new URL(
    workerUrl.origin + workerUrl.pathname
  );

  url.searchParams.set("url", target);

  return url.toString();
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods":
      "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Range",
    "Access-Control-Expose-Headers":
      "Content-Length, Content-Range, Accept-Ranges, Content-Type, ETag",
    "Vary": "Origin"
  };
}

function copyHeader(upstream, target, name) {
  const value = upstream.headers.get(name);

  if (value) {
    target.set(name, value);
  }
}

function json(data, status) {
  return new Response(
    JSON.stringify(data, null, 2),
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

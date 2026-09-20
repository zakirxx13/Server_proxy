export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: cors()
      });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ error: "Method Not Allowed" }, 405);
    }

    const target = url.searchParams.get("url");

    if (!target) {
      return json({ error: "Missing url parameter" }, 400);
    }

    let targetUrl;

    try {
      targetUrl = new URL(target);
    } catch {
      return json({ error: "Invalid URL" }, 400);
    }

    if (targetUrl.protocol !== "https:") {
      return json({ error: "HTTPS required" }, 400);
    }

    try {
      const headers = new Headers({
        "User-Agent": env.STREAM_USER_AGENT || "Mozilla/5.0",
        "Accept": "*/*"
      });

      // Only for your own/authorized upstream.
      if (env.STREAM_COOKIE) {
        headers.set("Cookie", env.STREAM_COOKIE);
      }

      const range = request.headers.get("Range");

      if (range) {
        headers.set("Range", range);
      }

      const upstream = await fetch(targetUrl.href, {
        method: request.method,
        headers,
        redirect: "follow"
      });

      if (!upstream.ok) {
        return json({
          error: "Upstream request failed",
          status: upstream.status,
          statusText: upstream.statusText
        }, upstream.status);
      }

      const contentType =
        upstream.headers.get("content-type") || "";

      const isM3U8 =
        targetUrl.pathname.toLowerCase().endsWith(".m3u8") ||
        contentType.toLowerCase().includes("mpegurl");

      const responseHeaders = new Headers(cors());

      if (isM3U8) {
        if (request.method === "HEAD") {
          responseHeaders.set(
            "Content-Type",
            "application/vnd.apple.mpegurl"
          );

          return new Response(null, {
            status: upstream.status,
            headers: responseHeaders
          });
        }

        const playlist = await upstream.text();

        if (!playlist.trimStart().startsWith("#EXTM3U")) {
          return new Response(playlist, {
            status: upstream.status,
            headers: responseHeaders
          });
        }

        const rewritten = playlist
          .split(/\r?\n/)
          .map(line => {
            const trimmed = line.trim();

            if (!trimmed) return line;

            if (trimmed.startsWith("#")) {
              return line.replace(
                /(URI\s*=\s*["'])([^"']+)(["'])/gi,
                (match, prefix, uri, suffix) => {
                  try {
                    const absolute =
                      new URL(uri, targetUrl.href).href;

                    return prefix +
                      makeProxyUrl(url, absolute) +
                      suffix;
                  } catch {
                    return match;
                  }
                }
              );
            }

            try {
              const absolute =
                new URL(trimmed, targetUrl.href).href;

              return makeProxyUrl(url, absolute);
            } catch {
              return line;
            }
          })
          .join("\n");

        responseHeaders.set(
          "Content-Type",
          "application/vnd.apple.mpegurl"
        );

        responseHeaders.set(
          "Cache-Control",
          "no-cache"
        );

        return new Response(rewritten, {
          status: 200,
          headers: responseHeaders
        });
      }

      copyHeader(upstream, responseHeaders, "content-type");
      copyHeader(upstream, responseHeaders, "content-length");
      copyHeader(upstream, responseHeaders, "content-range");
      copyHeader(upstream, responseHeaders, "accept-ranges");
      copyHeader(upstream, responseHeaders, "etag");

      return new Response(
        request.method === "HEAD"
          ? null
          : upstream.body,
        {
          status: upstream.status,
          headers: responseHeaders
        }
      );

    } catch (error) {
      return json({
        error: "Worker exception",
        message: error?.message || String(error)
      }, 502);
    }
  }
};

function makeProxyUrl(workerUrl, target) {
  const proxy = new URL(
    workerUrl.origin + workerUrl.pathname
  );

  proxy.searchParams.set("url", target);

  return proxy.toString();
}

function copyHeader(source, target, name) {
  const value = source.headers.get(name);

  if (value) {
    target.set(name, value);
  }
}

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Range",
    "Access-Control-Expose-Headers":
      "Content-Length, Content-Range, Accept-Ranges, Content-Type, ETag"
  };
}

function json(data, status) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        ...cors()
      }
    }
  );
}

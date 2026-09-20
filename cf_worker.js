export default {
  async fetch(request) {
    return new Response(
      JSON.stringify({
        ok: true,
        worker: "server-proxy",
        method: request.method
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      }
    );
  }
};

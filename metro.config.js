const http = require('http');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const ROUTES = {
  '/api/detector': 8000,
  '/api/face': 8001,
  '/api/glasses': 8002,
  '/api/assistant': 8003,
};

config.server.enhanceMiddleware = (metroMiddleware) => {
  return (request, response, next) => {
    const prefix = Object.keys(ROUTES).find(
      (candidate) =>
        request.url === candidate || request.url.startsWith(`${candidate}/`)
    );
    if (!prefix) return metroMiddleware(request, response, next);

    const proxy = http.request(
      {
        hostname: '127.0.0.1',
        port: ROUTES[prefix],
        path: request.url.slice(prefix.length) || '/',
        method: request.method,
        headers: {
          ...request.headers,
          host: `127.0.0.1:${ROUTES[prefix]}`,
        },
      },
      (upstream) => {
        response.writeHead(upstream.statusCode || 502, upstream.headers);
        upstream.pipe(response);
      }
    );
    proxy.on('error', (error) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      response.writeHead(502, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: `Backend proxy failed: ${error.message}` }));
    });
    request.pipe(proxy);
  };
};

module.exports = config;

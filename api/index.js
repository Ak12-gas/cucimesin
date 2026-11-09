const handler = require('../serverless-handler');

module.exports = (req, res) => {
  const requestUrl = new URL(req.url, 'http://localhost');
  const route = typeof req.query?.__route === 'string'
    ? req.query.__route
    : requestUrl.searchParams.get('__route');

  if (route !== null) {
    const apiPath = route.startsWith('/') ? route : `/${route}`;
    requestUrl.pathname = `/api${apiPath}`;
    requestUrl.searchParams.delete('__route');
    req.url = `${requestUrl.pathname}${requestUrl.search}`;
    if (req.query && typeof req.query === 'object') delete req.query.__route;
  }

  return handler(req, res);
};

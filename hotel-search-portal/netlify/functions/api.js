const serverless = require('serverless-http');
const { app, initPromise } = require('../../server');
const handler = serverless(app);

exports.handler = async (event, context) => {
  await initPromise;
  return handler(event, context);
};

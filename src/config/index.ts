// import fs from 'fs';
// import path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

// const certFile =
//   process.env.HTTPS_CERT ||
//   path.join(__dirname, '..', 'certs', 'fullchain.pem');
// const keyFile =
//   process.env.HTTPS_KEY || path.join(__dirname, '..', 'certs', 'privkey.pem');

const config = {
  nodeId: `snode-1`,
  env: process.env.NODE_ENV,
  cors: {
    origin: process.env.NODE_ENV === 'production' ? ['https://mitsi.app'] : '*',
    methods: ['GET', 'POST'],
  },
  // httpsServerOptions: {
  //   key: fs.readFileSync(keyFile, 'utf8'),
  //   cert: fs.readFileSync(certFile, 'utf8'),
  // },
  port: process.env.PORT || 8000,
  apiServerUrl: process.env.API_SERVER_URL,
  apiServerApiKey: process.env.API_SERVER_API_KEY,
  recordingServerUrl: process.env.RECORDING_SERVER_URL,
  redisServerUrl: process.env.REDIS_SERVER_URL || 'redis://localhost:6379',
};

export default config;

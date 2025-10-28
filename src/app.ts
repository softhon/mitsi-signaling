import { createServer } from 'http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';

import config from './config';
// import { redisServer } from './servers/redis-server';
import { SocketServer } from './servers/socket-server';
import { Routes } from './routes';
import { SignalnodeData } from './types';
import { getRedisKey, registerSignalNode } from './lib/utils';
import { ioRedisServer } from './servers/ioredis-server';
// import { publicIpv4 } from 'public-ip';

const app = express();
app.use(cors(config.cors));
app.use(helmet());
app.use(express.json());
app.use('/', Routes);

// const httpsServer = createServer(config.httpsServerOptions, app);
const httpServer = createServer(app);

let signalnodeData: SignalnodeData;

(async (): Promise<void> => {
  try {
    // await redisServer.connect();

    await ioRedisServer.connect();

    SocketServer.getInstance(httpServer);

    httpServer.listen(config.port, () => {
      console.log(`Server running on port ${config.port}`);
    });

    // register signalnode
    signalnodeData = await registerSignalNode();

    console.log('Register signalnode');

    // MediaNode.connectToRunningNodes();
  } catch (err) {
    console.error('Initialization error:', err);
    process.exit(1);
  }
})();

// register/unregister signalnode

const shutdown = async (): Promise<void> => {
  try {
    // remove signal node
    await ioRedisServer.del(getRedisKey['signalnodes']());
    console.log('Delete signalnode');
    await SocketServer.getInstance().close();
    await ioRedisServer.disconnect();
    httpServer.close();
    console.log('Application shut down gracefully');
    process.exit(0);
  } catch (err) {
    console.error('Error during shutdown:', err);
    process.exit(1);
  }
};

// Graceful shutdown
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

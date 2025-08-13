import { createServer } from 'https';
import express from 'express';
import fs from 'fs';
import cors from 'cors';
import helmet from 'helmet';

import config from './config';
import { redisServer } from './servers/redis-server';
import { SocketServer } from './servers/socket-server';
import { Routes } from './routes';
import MediaNode from './services/medianode';

const serverOption = {
  key: fs.readFileSync(config.tls.key, 'utf8'),
  cert: fs.readFileSync(config.tls.cert, 'utf8'),
};

const app = express();
app.use(cors(config.cors));
app.use(helmet());
app.use(express.json());
app.use('/', Routes);

const httpsServer = createServer(serverOption, app);

(async (): Promise<void> => {
  try {
    await redisServer.connect();
    SocketServer.getInstance(httpsServer);

    httpsServer.listen(config.port, () => {
      console.log(`Server running on port ${config.port}`);
    });

    new MediaNode({ ip: '0.0.0.0', host: '', id: '' });
  } catch (err) {
    console.error('Initialization error:', err);
    process.exit(1);
  }
})();

const shutdown = async (): Promise<void> => {
  try {
    await SocketServer.getInstance().close();
    await redisServer.disconnect();
    httpsServer.close();
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

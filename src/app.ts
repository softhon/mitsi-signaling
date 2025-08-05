import cluster from 'cluster';
import os from 'os';
import express, { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import https from 'https';

import config from './config/config';
import { HTTPSTATUS } from './types/interfaces';

import { setupPrimary } from '@socket.io/cluster-adapter';
import { setupMaster, setupWorker } from '@socket.io/sticky';
import SocketServer, { serverOption } from './servers/socket-server';
import RedisServer from './servers/redis-server';

class App {
  app: express.Application;

  constructor() {
    this.app = express();

    this.initializeMiddlewares();
    this.initializeRoutes();
  }

  private initializeMiddlewares = () => {
    this.app.use(helmet());
    this.app.use(cors(config.cors));
    this.app.use(express.json());
  };

  private initializeRoutes = () => {
    // Default Route
    this.app.get('/', (_req: Request, res: Response) => {
      return res
        .status(HTTPSTATUS.OK)
        .send('<h1>Mitsi Signaling Service Running</h1>');
    });
    // Health check
    this.app.get('/health', (_req: Request, res: Response) => {
      return res.status(HTTPSTATUS.OK).json({
        status: 'Healthy',
        date: Date.now(),
      });
    });
  };

  public listen = () => {
    SocketServer.init(this.app); // Initialize signaling server here
    SocketServer.https.listen(config.https.listenPort, () => {
      console.info(`Server running on port ${config.https.listenPort}`);
    });
  };
}

// Cluster Implementation
const startCluster = async () => {
  try {
    if (cluster.isPrimary) {
      const numCPUs = os.cpus().length;

      const httpsServer = https.createServer(serverOption);

      // Setup sticky sessions and cluster adapter
      setupMaster(httpsServer, {
        loadBalancingMethod: 'least-connection',
      });

      setupPrimary();

      cluster.setupPrimary({
        serialization: 'advanced',
      });

      // Fork workers for each CPU core
      for (let i = 0; i < numCPUs; i++) {
        cluster.fork();
      }

      // Restart a worker if it exits unexpectedly
      cluster.on('exit', (worker, code, signal) => {
        console.log({ code, signal });
        console.error(`Worker ${worker.process.pid} died. Restarting...`);
        cluster.fork();
      });
    } else {
      // Worker processes
      const app = new App();

      // Initialise redis  and socket server
      await RedisServer.init();
      SocketServer.init(app.app);

      // await connectMediaNodes();

      // Bind worker to sticky session
      setupWorker(SocketServer.io);

      app.listen();

      console.info(`Worker process ${process.pid} is running`);
    }
  } catch (error) {
    console.error('failed to start cluster', error);
  }
};

// Start the cluster
startCluster().catch(err => {
  console.error('Failed to start cluster', { error: err });
  process.exit(1);
});

import { Server as HttpServer } from 'http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-streams-adapter';

import config from '../config';
import { redisServer } from './redis-server';
import ClientNode from '../services/clientnode';

export class SocketServer {
  private static instance: SocketServer | null = null;
  private io: Server;

  private constructor(httpServer: HttpServer) {
    this.io = new Server(httpServer, {
      cors: config.cors,
      // adapter: createAdapter(redisServer.getPubClient()),
    });
    this.setupConnectionHandlers();
  }

  static getInstance(httpServer?: HttpServer): SocketServer {
    if (!SocketServer.instance && !httpServer)
      throw new Error(
        'SocketServer instance not initialized. Provide httpServer for first initialization.'
      );
    if (!SocketServer.instance) {
      SocketServer.instance = new SocketServer(httpServer!);
    }
    console.log('socket intialized');
    return SocketServer.instance;
  }

  private setupConnectionHandlers(): void {
    this.io.on('connection', socket => {
      new ClientNode(socket);
    });
  }

  getIo(): Server {
    return this.io;
  }

  async close(): Promise<void> {
    this.io.close();
  }
}

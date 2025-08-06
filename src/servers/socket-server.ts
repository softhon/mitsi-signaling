import { Server as HttpServer } from 'https';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-streams-adapter';

import config from '../config/config';
import { redisServer } from './redis-server';
import ClientNode from '../services/clientnode-service';

export class SocketServer {
  private static instance: SocketServer | null = null;
  private io: Server;
  // private httpServer: HttpServer;

  private constructor(httpServer: HttpServer) {
    console.log(redisServer);
    this.io = new Server(httpServer, {
      cors: config.cors,
      adapter: createAdapter(redisServer.getPubClient()),
    });

    // handle connection
    this.setupConnectionHandlers();
  }

  static getInstance(httpServer?: HttpServer) {
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

  private setupConnectionHandlers() {
    console.log('setupConnectionHandlers');

    this.io.on('connection', socket => {
      console.log(`Client connected: ${socket.id}`);

      new ClientNode(socket);

      socket.on('disconnect', reason => {
        console.log(`Client disconnected ${socket.id}`, reason);
      });
    });
  }

  getIo() {
    return this.io;
  }

  async close() {
    this.io.close();
  }
}

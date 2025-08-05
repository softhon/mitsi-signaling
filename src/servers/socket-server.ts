import fs from 'fs';
import https from 'https';
import express from 'express';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-streams-adapter';

import config from '../config/config';
import RedisServer from './redis-server';

export const serverOption = {
  key: fs.readFileSync(config.https.tls.key, 'utf8'),
  cert: fs.readFileSync(config.https.tls.cert, 'utf8'),
};

export default class SocketServer {
  static https: https.Server;
  static io: Server;

  static init(app: express.Application) {
    try {
      if (!RedisServer.client) {
        throw new Error('Redis client not initialized');
      }
      // Create https and socket io server
      this.https = https.createServer(serverOption, app);
      this.io = new Server(this.https, {
        cors: config.cors,
        adapter: createAdapter(RedisServer.client!),
      });

      // Connection Authentication middleware
      this.io.use(async (socket, next) => {
        try {
          const { key } = socket.handshake.auth;
          if (!key) {
            return next(new Error('Authentication key is missing.'));
          }
          // TODO: implement api key verification

          next();
        } catch (error) {
          console.error(error);
          next(new Error('Authentication failed'));
        }
      });

      // Handle client connections
      this.io.on('connection', socket => {
        const { roomId } = socket.handshake.query;
        if (!roomId) {
          console.warn(`Client disconnected due to missing meetingId`);
          socket.disconnect(true);
          return;
        }

        // new ClientNode(socket);

        socket.on('error', err => {
          console.error(`Socket error for client ${socket.id}:`, {
            error: err,
          });
        });

        socket.on('disconnect', reason => {
          console.info(`Client disconnected: ${socket.id}, Reason: ${reason}`);
          // clientNode.cleanup();
        });
      });

      console.info('Socket server initialized succesfully.');
    } catch (error) {
      console.error('Error initializing Signaller', { error });
      throw error; // Rethrow the error to handle gracefully in the calling context
    }
  }
}

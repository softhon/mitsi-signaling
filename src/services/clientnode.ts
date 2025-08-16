import EventEmitter from 'events';
import { Socket } from 'socket.io';

import { ServiceEvents, SignallingEvents } from '../types/events';
import {
  AckCallback,
  MessageData,
  PeerData,
  RoomInstanceData,
} from '../types/interfaces';
import Lobby from './lobby';
import Visitor from './visitor';
import Room from './room';
import { redisServer } from '../servers/redis-server';
import { getRedisKey } from '../lib/utils';
import Waiter from './waiter';
import { ValidationSchema } from '../lib/schema';

class ClientNode extends EventEmitter {
  connectionId: string;
  connection: Socket;
  closed: boolean;

  private static clientNodes = new Map<string, ClientNode>();

  constructor(connection: Socket) {
    super();
    this.connectionId = connection.id;
    this.connection = connection;
    this.closed = false;

    ClientNode.clientNodes.set(this.connectionId, this);
    this.handleConnections();
    console.info(
      'clientnode connected with connectionId - ',
      this.connectionId
    );
  }

  handleConnections(): void {
    this.connection.on('connect_error', error => {
      console.error('client connection error', error);
    });
    this.connection.on('disconnect', error => {
      console.info('client connection disconnect', error);
    });
    this.connection.on(
      'message',
      (data: MessageData, callback: AckCallback) => {
        const { event, args } = data;
        const handler = this.eventHandlers[event as SignallingEvents];
        if (handler) handler(args, callback);
      }
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.connection.disconnect(true);
    ClientNode.clientNodes.delete(this.connectionId);
    this.emit(ServiceEvents.Close);
    this.removeAllListeners();
  }

  private eventHandlers: {
    [key in SignallingEvents]?: (
      args: { [key: string]: unknown },
      callback: AckCallback
    ) => void;
  } = {
    'join-visitors': async (args, callback) => {
      try {
        const data = ValidationSchema.roomIdPeerId.parse(args);
        const { roomId, peerId } = data;

        const lobby = Lobby.getLobby(roomId) || new Lobby({ roomId });
        const visitor = new Visitor({
          peerId,
          roomId,
          connection: this.connection,
        });
        lobby.addVisitor(visitor);
        this.connection.join(getRedisKey['lobby'](roomId));
        let room = Room.getRoom(roomId);

        if (!room) {
          // room could be running in another instance
          // find room in redis
          const roomInstance = await redisServer.get(
            getRedisKey['room'](roomId)
          );

          if (roomInstance) {
            room = await Room.create(roomId);
          }
        }
        // return no peers as room is yet to start
        if (!room)
          return callback({
            status: 'success',
            response: {
              peers: [],
            },
          });

        // check if visitor was a participant
        const wasAParticipant = await redisServer.sIsMember(
          getRedisKey['roomPeerIds'](roomId),
          peerId
        );
        const peers = await room.getPeersOnline();
        const roomData = await room.getData();
        return callback({
          status: 'success',
          response: {
            peers,
            room: roomData,
            wasAParticipant,
          },
        });
      } catch (error) {
        console.error(`Error from join-visitors`, error);
        callback({
          status: 'error',
          error,
        });
      }
    },

    'join-waiters': async (args, callback) => {
      try {
        const data = ValidationSchema.roomIdPeerIdPeerData.parse(args);
        const { roomId, peerId, peerData } = data;

        const wasAParticipant = await redisServer.sIsMember(
          getRedisKey['roomPeerIds'](roomId),
          peerId
        );

        if (!wasAParticipant) {
          const lobby = Lobby.getLobby(roomId) || new Lobby({ roomId });
          const waiter = new Waiter({
            roomId,
            peerId,
            connection: this.connection,
            data: peerData as PeerData,
          });
          lobby.addWaiter(waiter);
        }

        callback({
          status: 'success',
          response: {
            wasAParticipant,
          },
        });
      } catch (error) {
        console.error(`Error from join-waiters`, error);
        callback({
          status: 'error',
          error,
        });
      }
    },

    'get-room-data': async (args, callback) => {
      try {
        const data = ValidationSchema.roomId.parse(args);
        const { roomId } = data;

        const room = Room.getRoom(roomId);
        if (room) {
          const roomData = await room.getData();
          return callback({
            status: 'success',
            response: {
              roomData,
            },
          });
        }
        const redisData = await redisServer.get(getRedisKey['room'](roomId));

        if (redisData) {
          const roomData: RoomInstanceData = JSON.parse(redisData);
          return callback({
            status: 'success',
            response: {
              roomData,
            },
          });
        }

        return callback({ status: 'success' });
      } catch (error) {
        console.error(`Error from get-room-data`, error);
        callback({
          status: 'error',
          error,
        });
      }
    },

    'get-rtp-capabilities': (args, callback) => {
      try {
        // Todo implement medianode to complete
        return callback({ status: 'success' });
      } catch (error) {
        console.error(`Error to join-waiters`, error);
        callback({
          status: 'error',
          error,
        });
      }
    },

    'join-room': (args, callback) => {
      try {
        // Todo implement medianode to complete
        return callback({ status: 'success' });
      } catch (error) {
        console.error(`Error to join-room`, error);
        callback({
          status: 'error',
          error,
        });
      }
    },
  };
}
export default ClientNode;

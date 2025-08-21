import EventEmitter from 'events';
import { Socket } from 'socket.io';

import {
  AckCallback,
  MessageData,
  PeerData,
  Role,
  RoomInstanceData,
  Tag,
} from '../types';
import Lobby from './lobby';
import Visitor from './visitor';
import Room from './room';
import { redisServer } from '../servers/redis-server';
import { getPubSubChannel, getRedisKey, parseArgs } from '../lib/utils';
import Waiter from './waiter';
import { ValidationSchema } from '../lib/schema';
import { Actions } from '../types/actions';
import MediaNode from './medianode';
import Peer from './peer';

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
        const { action, args } = data;
        const handler = this.actionHandlers[action as Actions];
        if (handler) handler(args, callback);
      }
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.connection.disconnect(true);
    ClientNode.clientNodes.delete(this.connectionId);
    this.emit(Actions.Close);
    this.removeAllListeners();
  }

  private actionHandlers: {
    [key in Actions]?: (
      args: { [key: string]: unknown },
      callback: AckCallback
    ) => void;
  } = {
    [Actions.JoinVisitors]: async (args, callback) => {
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

    [Actions.JoinWaiters]: async (args, callback) => {
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

    [Actions.GetRoomData]: async (args, callback) => {
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

    [Actions.GetRouterRtpCapabilities]: (args, callback) => {
      try {
        const medianode = MediaNode.getleastLoadedNode();
        if (!medianode) throw 'No media services connected';
        return callback({
          status: 'success',
          response: {
            routerRtpCapabilities: medianode.getRouterRtpCapabilities(),
          },
        });
      } catch (error) {
        console.error(`Error to ${Actions.GetRouterRtpCapabilities}`, error);
        callback({
          status: 'error',
          error,
        });
      }
    },

    [Actions.JoinRoom]: async (args, callback) => {
      try {
        const data = ValidationSchema.joinMeeting.parse(args);
        const { roomId, peerData, deviceRtpCapabilities } = data;
        const room = Room.getRoom(roomId) ?? (await Room.create(roomId));

        const peerExistingHere = room.getPeer(peerData.id);
        if (peerExistingHere) {
          peerExistingHere.close();
        } else {
          const peerExistingElseWhere = (await room.getPeersOnline()).find(
            peer => peer.id === peerData.id
          );
          if (peerExistingElseWhere) {
            await redisServer.publish({
              channel: getPubSubChannel['room'](roomId),
              action: Actions.RemovePeer,
              args: {
                roomId,
                peerId: peerData.id,
                silent: true,
              },
            });
          }
        }
        const medianode = MediaNode.getleastLoadedNode();
        if (!medianode) throw 'No medianode found';

        const messageRes = await medianode.sendMessageForResponse(
          Actions.CreatePeer,
          {
            peerId: peerData.id,
            roomId,
            deviceRtpCapabilities,
            peerType: peerData.isRecorder ? 'Recorder' : 'Participant',
          }
        );

        if (!messageRes) throw 'No router res';

        const value = parseArgs(messageRes.args);

        const newPeer = new Peer({
          roomId,
          data: peerData as PeerData,
          connection: this.connection,
          routerId: value.routerId as string,
          roles: [Role.Moderator],
          tag: Tag.Host,
        });

        this.connection.join(`room-${roomId}`);
        this.connection.data.roomId = roomId;
        this.connection.data.peerId = newPeer.id;
        this.connection.data.isRecorder = peerData.isRecorder || false;

        const peersOnline = await room.getPeersOnline();
        room.addPeer(newPeer);

        const roomData = await room.getData();

        const peers = newPeer.isRecorder
          ? peersOnline
          : [newPeer.getData(), ...peersOnline];

        callback({
          status: 'success',
          response: {
            peers,
            roomData,
          },
        });
        // return callback({ status: 'success' });
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

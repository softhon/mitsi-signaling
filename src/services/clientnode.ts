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
import { ioRedisServer } from '../servers/ioredis-server';
import { getPubSubChannel, getRedisKey } from '../lib/utils';
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
    this.handleConnection();
    console.info(
      'clientnode connected with connectionId - ',
      this.connectionId
    );
  }

  handleConnection(): void {
    this.connection.on('connect_error', error => {
      console.error('client connection error:', error);
    });
    this.connection.on('disconnect', reason => {
      console.info('client disconnect: => ', reason);
      if (
        reason === 'client namespace disconnect' ||
        reason === 'server namespace disconnect'
      ) {
        this.close();
      } else {
        this.emit(Actions.Reconnecting);
        // this.close();
      }
    });
    this.connection.on(
      'message',
      (data: MessageData, callback: AckCallback) => {
        const { action, args = {} } = data;

        const handler = this.actionHandlers[action as Actions];
        if (handler)
          handler(args, callback).catch(error => {
            console.error(`Error from ${action}`, error);
            callback({
              status: 'error',
              error,
            });
          });
      }
    );
  }

  close(silent?: boolean): void {
    console.log('closing client node');

    if (this.closed) return;
    this.closed = true;

    // console.log('closing client node');

    this.emit(Actions.Close, { silent });
    this.connection.disconnect(true);
    ClientNode.clientNodes.delete(this.connectionId);
    this.removeAllListeners();
    console.log('clientnode Closed');
    if (!silent) this.connection.disconnect(true);
  }

  private actionHandlers: {
    [key in Actions]?: (
      args: { [key: string]: unknown },
      callback: AckCallback
    ) => Promise<void>;
  } = {
    [Actions.JoinVisitors]: async (args, callback) => {
      const data = ValidationSchema.roomIdPeerId.parse(args);
      const { roomId, peerId } = data;

      console.log(data);

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
        const roomInstance = await ioRedisServer.get(
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
      const wasAParticipant = await ioRedisServer.sIsMember(
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
    },

    [Actions.JoinWaiters]: async (args, callback) => {
      const data = ValidationSchema.roomIdPeerIdPeerData.parse(args);
      const { roomId, peerId, peerData } = data;

      const wasAParticipant = await ioRedisServer.sIsMember(
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
    },

    [Actions.GetRoomData]: async (args, callback) => {
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
      const redisData = await ioRedisServer.get(getRedisKey['room'](roomId));

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
    },

    [Actions.GetRouterRtpCapabilities]: async (args, callback) => {
      const medianode = MediaNode.getleastLoadedNode();
      if (!medianode) throw 'No media services connected';
      return callback({
        status: 'success',
        response: {
          routerRtpCapabilities: medianode.getRouterRtpCapabilities(),
        },
      });
    },

    [Actions.JoinRoom]: async (args, callback) => {
      const data = ValidationSchema.joinMeeting.parse(args);
      const { roomId, peerData, deviceRtpCapabilities } = data;
      const room = Room.getRoom(roomId) ?? (await Room.create(roomId));

      const peerExistingHere = room.getPeer(peerData.id);
      if (peerExistingHere) {
        console.log('Peer is existing here');
        peerExistingHere.close();
        console.log('close Peer  existing here');
      } else {
        const peerExistingElseWhere = (await room.getPeersOnline()).find(
          peer => peer.id === peerData.id
        );
        if (peerExistingElseWhere) {
          await ioRedisServer.publish({
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
      const response = await medianode.sendMessageForResponse(
        Actions.CreatePeer,
        {
          peerId: peerData.id,
          roomId,
          deviceRtpCapabilities,
          peerType: peerData.isRecorder ? 'Recorder' : 'Participant',
        }
      );

      const newPeer = new Peer({
        roomId,
        data: peerData as PeerData,
        connection: this.connection,
        medianode,
        routerId: response.routerId as string,
        roles: [Role.Moderator],
        tag: Tag.Host,
      });

      this.connection.join(getRedisKey['room'](roomId));
      this.connection.data.roomId = roomId;
      this.connection.data.peerId = newPeer.id;
      this.connection.data.isRecorder = peerData.isRecorder || false;

      const peersOnline = await room.getPeersOnline();

      await room.addPeer(newPeer);

      const roomData = await room.getData();

      callback({
        status: 'success',
        response: {
          you: newPeer.getData(),
          peers: peersOnline,
          roomData,
        },
      });
      // return callback({ status: 'success' });
    },
  };
}
export default ClientNode;

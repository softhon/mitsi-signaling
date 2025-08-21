import { Socket } from 'socket.io';

import Base from './base';
import { HEARTBEAT_TIMEOUT } from '../lib/contants';
import {
  AckCallback,
  HandState,
  MessageData,
  PeerData,
  Role,
  Tag,
} from '../types';
import { Actions } from '../types/actions';
import MediaNode from './medianode';
import { getPubSubChannel, parseArgs } from '../lib/utils';
import { ValidationSchema } from '../lib/schema';
import { redisServer } from '../servers/redis-server';
import Room from './room';

class Peer extends Base {
  private isRecorder: boolean;
  private reconnecting?: boolean;
  private data: PeerData;
  private hand?: HandState;
  private joined: number;
  private tag: Tag;
  private roles: Role[];
  private lastHeartbeat: number;
  private heartBeatInterval: NodeJS.Timeout;
  private medianode: MediaNode;
  private routerId: string;
  closed: boolean;

  // static peers = new Map<string, Peer>();

  constructor({
    data,
    roomId,
    connection,
    medianode,
    tag,
    roles,
    routerId,
  }: {
    data: PeerData;
    roomId: string;
    connection: Socket;
    medianode: MediaNode;
    tag: Tag;
    roles: Role[];
    routerId: string;
  }) {
    super({ roomId, peerId: data.id, connection });
    this.routerId = routerId;
    this.data = data;
    this.isRecorder = data.isRecorder || false;
    this.hand = data.hand ? data.hand : { raised: false };
    this.roles = roles;
    this.tag = tag;
    this.joined = Date.now();
    this.closed = false;
    this.lastHeartbeat = Date.now();
    this.routerId = routerId;
    this.reconnecting = false;
    this.medianode = medianode;

    this.heartBeatInterval = setInterval(() => {
      if (Date.now() - this.lastHeartbeat > HEARTBEAT_TIMEOUT) {
        this.close();
      }
    }, HEARTBEAT_TIMEOUT);
  }

  getData(): PeerData {
    return {
      ...this.data,
      roles: this.roles,
      hand: this.hand,
      tag: this.tag,
      joined: this.joined,
      reconnecting: this.reconnecting,
    };
  }

  handleConnection(): void {
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

  private actionHandlers: {
    [key in Actions]?: (
      args: { [key: string]: unknown },
      callback: AckCallback
    ) => void;
  } = {
    [Actions.CreateWebrtcTransports]: async (args, callback) => {
      try {
        const { roomId, peerId } = this.connection.data;

        const messageRes = await this.medianode.sendMessageForResponse(
          Actions.CreateWebrtcTransports,
          {
            peerId,
            roomId,
          }
        );
        if (!messageRes) throw 'sendMessageForResponse returned null';

        const transportParams = parseArgs(messageRes.args);
        callback({
          status: 'success',
          response: transportParams,
        });
      } catch (error) {
        console.log(error);
        callback({
          status: 'error',
          error,
        });
      }
    },
    [Actions.ConnectWebrtcTransports]: async (args, callback) => {
      try {
        const { roomId, peerId } = this.connection.data;
        const data = ValidationSchema.connectWebRtcTransport.parse(args);
        const { dtlsParameters, transportId } = data;

        this.medianode.sendMessage(Actions.ConnectWebrtcTransports, {
          peerId,
          roomId,
          dtlsParameters,
          transportId,
        });

        callback({
          status: 'success',
        });
      } catch (error) {
        console.log(error);

        callback({
          status: 'error',
          error,
        });
      }
    },
    [Actions.CreateConsumersOfAllProducers]: async (args, callback) => {
      try {
        const { roomId, peerId } = this.connection.data;

        this.medianode.sendMessage(Actions.CreateConsumersOfAllProducers, {
          peerId,
          roomId,
        });

        callback({
          status: 'success',
        });
      } catch (error) {
        console.log(error);
        callback({
          status: 'error',
          error,
        });
      }
    },

    [Actions.CreateProducer]: async (args, callback) => {
      try {
        const { roomId, peerId } = this.connection.data;
        const data = ValidationSchema.createProducer.parse(args);
        const { transportId, kind, rtpParameters, appData } = data;

        const messageRes = await this.medianode.sendMessageForResponse(
          Actions.CreateProducer,
          {
            peerId,
            roomId,
            rtpParameters,
            transportId,
            kind,
            appData: { peerName: this.data.name, ...appData },
          }
        );
        if (!messageRes) throw 'sendMessageForResponse returned null';

        const { producerId } = parseArgs(messageRes.args);

        callback({
          status: 'success',
          response: { producerId },
        });
      } catch (error) {
        console.log(error);
        callback({
          status: 'error',
          error,
        });
      }
    },

    [Actions.CloseProducer]: async (args, callback) => {
      try {
        const { roomId, peerId } = this.connection.data;
        const data = ValidationSchema.producer.parse(args);
        const { producerId, source } = data;

        this.medianode.sendMessage(Actions.CloseProducer, {
          peerId,
          roomId,
          producerId,
          source,
        });

        callback({
          status: 'success',
        });
      } catch (error) {
        console.log(error);
        callback({
          status: 'error',
          error,
        });
      }
    },

    [Actions.PauseProducer]: async (args, callback) => {
      try {
        const { roomId, peerId } = this.connection.data;
        const data = ValidationSchema.producer.parse(args);
        const { producerId, source } = data;

        this.medianode.sendMessage(Actions.PauseProducer, {
          peerId,
          roomId,
          producerId,
          source,
        });

        callback({
          status: 'success',
        });
      } catch (error) {
        console.log(error);
        callback({
          status: 'error',
          error,
        });
      }
    },

    [Actions.ResumeProducer]: async (args, callback) => {
      try {
        const { roomId, peerId } = this.connection.data;
        const data = ValidationSchema.producer.parse(args);
        const { producerId, source } = data;

        this.medianode.sendMessage(Actions.ResumeProducer, {
          peerId,
          roomId,
          producerId,
          source,
        });

        callback({
          status: 'success',
        });
      } catch (error) {
        console.log(error);
        callback({
          status: 'error',
          error,
        });
      }
    },

    [Actions.ResumeConsumer]: async (args, callback) => {
      try {
        const { roomId, peerId } = this.connection.data;
        const data = ValidationSchema.consumer.parse(args);
        const { consumerId, source } = data;

        this.medianode.sendMessage(Actions.ResumeConsumer, {
          peerId,
          roomId,
          consumerId,
          source,
        });

        callback({
          status: 'success',
        });
      } catch (error) {
        console.log(error);
        callback({
          status: 'error',
          error,
        });
      }
    },

    [Actions.PauseConsumer]: async (args, callback) => {
      try {
        const { roomId, peerId } = this.connection.data;
        const data = ValidationSchema.consumer.parse(args);
        const { consumerId, source } = data;

        this.medianode.sendMessage(Actions.PauseConsumer, {
          peerId,
          roomId,
          consumerId,
          source,
        });

        callback({
          status: 'success',
        });
      } catch (error) {
        console.log(error);
        callback({
          status: 'error',
          error,
        });
      }
    },

    [Actions.Mute]: async (args, callback) => {
      try {
        const { roomId } = this.connection.data;
        const data = ValidationSchema.peerIds.parse(args);
        const { peerIds } = data;

        redisServer.publish({
          channel: getPubSubChannel['room'](roomId),
          action: Actions.Mute,
          args: {
            peerIds,
          },
        });

        const room = Room.getRoom(roomId);

        if (room) {
          const peers = room.getPeers();
          peerIds.forEach(id => {
            const peer = peers.find(peer => id === peer.id);
            if (peer)
              peer.message({
                message: {
                  action: Actions.Mute,
                  args: {},
                },
              });
          });
        }

        callback({
          status: 'success',
        });
      } catch (error) {
        console.log(error);
        callback({
          status: 'error',
          error,
        });
      }
    },

    [Actions.OffCamera]: async (args, callback) => {
      try {
        const { roomId } = this.connection.data;
        const data = ValidationSchema.peerIds.parse(args);
        const { peerIds } = data;

        redisServer.publish({
          channel: getPubSubChannel['room'](roomId),
          action: Actions.OffCamera,
          args: {
            peerIds,
          },
        });

        const room = Room.getRoom(roomId);

        if (room) {
          const peers = room.getPeers();
          peerIds.forEach(id => {
            const peer = peers.find(peer => id === peer.id);
            if (peer)
              peer.message({
                message: {
                  action: Actions.OffCamera,
                  args: {},
                },
              });
          });
        }

        callback({
          status: 'success',
        });
      } catch (error) {
        console.log(error);
        callback({
          status: 'error',
          error,
        });
      }
    },

    [Actions.StopScreen]: async (args, callback) => {
      try {
        const { roomId } = this.connection.data;
        const data = ValidationSchema.peerIds.parse(args);
        const { peerIds } = data;

        redisServer.publish({
          channel: getPubSubChannel['room'](roomId),
          action: Actions.StopScreen,
          args: {
            peerIds,
          },
        });

        const room = Room.getRoom(roomId);

        if (room) {
          const peers = room.getPeers();
          peerIds.forEach(id => {
            const peer = peers.find(peer => id === peer.id);
            if (peer)
              peer.message({
                message: {
                  action: Actions.StopScreen,
                  args: {},
                },
              });
          });
        }

        callback({
          status: 'success',
        });
      } catch (error) {
        console.log(error);
        callback({
          status: 'error',
          error,
        });
      }
    },

    [Actions.RaiseHand]: async (args, callback) => {
      try {
        // set hand
        callback({
          status: 'success',
        });
      } catch (error) {
        console.log(error);
        callback({
          status: 'error',
          error,
        });
      }
    },

    [Actions.LowerHands]: async (args, callback) => {
      try {
        const { roomId } = this.connection.data;
        const data = ValidationSchema.peerIds.parse(args);
        const { peerIds } = data;

        redisServer.publish({
          channel: getPubSubChannel['room'](roomId),
          action: Actions.LowerHands,
          args: {
            peerIds,
          },
        });

        callback({
          status: 'success',
        });
      } catch (error) {
        console.log(error);
        callback({
          status: 'error',
          error,
        });
      }
    },

    [Actions.SendChat]: async (args, callback) => {
      try {
        console.log('Send Chat', args);
        callback({
          status: 'success',
        });
      } catch (error) {
        console.log(error);
        callback({
          status: 'error',
          error,
        });
      }
    },

    [Actions.SendReaction]: async (args, callback) => {
      try {
        console.log('Send Reaction', args);

        callback({
          status: 'success',
        });
      } catch (error) {
        console.log(error);
        callback({
          status: 'error',
          error,
        });
      }
    },

    [Actions.Record]: async (args, callback) => {
      try {
        console.log('Record', args);

        callback({
          status: 'success',
        });
      } catch (error) {
        console.log(error);
        callback({
          status: 'error',
          error,
        });
      }
    },

    [Actions.EndMeeting]: async (args, callback) => {
      try {
        console.log('EndMeeting', args);

        callback({
          status: 'success',
        });
      } catch (error) {
        console.log(error);
        callback({
          status: 'error',
          error,
        });
      }
    },
  };
}

export default Peer;

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
import { getPubSubChannel } from '../lib/utils';
import { ValidationSchema } from '../lib/schema';
import { ioRedisServer } from '../servers/ioredis-server';
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
        console.log('Peer heart beat failed --- closing peer');
        this.close();
      }
    }, HEARTBEAT_TIMEOUT);
    this.handleEvents();
    this.handleConnection();
  }

  getMedianode(): MediaNode {
    return this.medianode;
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
  updateLastHeartBeat(): void {
    this.lastHeartbeat = Date.now();
  }

  handleEvents(): void {
    this.on(Actions.Close, () => {
      this.cleanUp();
    });
  }
  cleanUp(): void {
    clearInterval(this.heartBeatInterval);
  }

  handleConnection(): void {
    // this.connection.on('connect_error', error => {
    //   console.error('client connection error', error);
    // });
    // this.connection.on('disconnect', error => {
    //   console.info('client connection disconnect', error);
    // });
    this.connection.on(
      'message',
      (data: MessageData, callback: AckCallback) => {
        const { action, args } = data;
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

  private actionHandlers: {
    [key in Actions]?: (
      args: { [key: string]: unknown },
      callback: AckCallback
    ) => Promise<void>;
  } = {
    [Actions.CreateWebrtcTransports]: async (args, callback) => {
      const { roomId, peerId } = this.connection.data;
      const response = await this.medianode.sendMessageForResponse(
        Actions.CreateWebrtcTransports,
        {
          peerId,
          roomId,
        }
      );
      //todo return response not message response
      callback({
        status: 'success',
        response: response as {
          [key: string]: unknown;
        },
      });
    },
    [Actions.ConnectWebrtcTransports]: async (args, callback) => {
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
    },
    [Actions.CreateConsumersOfAllProducers]: async (args, callback) => {
      const { roomId, peerId } = this.connection.data;
      this.medianode.sendMessage(Actions.CreateConsumersOfAllProducers, {
        peerId,
        roomId,
      });

      callback({
        status: 'success',
      });
    },

    [Actions.CreateProducer]: async (args, callback) => {
      const { roomId, peerId } = this.connection.data;
      const data = ValidationSchema.createProducer.parse(args);
      const { transportId, kind, rtpParameters, appData } = data;

      const response = await this.medianode.sendMessageForResponse(
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

      callback({
        status: 'success',
        response,
      });
    },

    [Actions.CloseProducer]: async (args, callback) => {
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
    },

    [Actions.PauseProducer]: async (args, callback) => {
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
    },

    [Actions.ResumeProducer]: async (args, callback) => {
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
    },

    [Actions.ResumeConsumer]: async (args, callback) => {
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
    },

    [Actions.PauseConsumer]: async (args, callback) => {
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
    },

    [Actions.Mute]: async (args, callback) => {
      const { roomId } = this.connection.data;
      const data = ValidationSchema.peerIds.parse(args);
      const { peerIds } = data;

      ioRedisServer.publish({
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
            peer.sendMessage({
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
    },

    [Actions.OffCamera]: async (args, callback) => {
      const { roomId } = this.connection.data;
      const data = ValidationSchema.peerIds.parse(args);
      const { peerIds } = data;

      ioRedisServer.publish({
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
            peer.sendMessage({
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
    },

    [Actions.StopScreen]: async (args, callback) => {
      const { roomId } = this.connection.data;
      const data = ValidationSchema.peerIds.parse(args);
      const { peerIds } = data;

      ioRedisServer.publish({
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
            peer.sendMessage({
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
    },

    [Actions.Heartbeat]: async (args, callback) => {
      this.updateLastHeartBeat();
      callback({
        status: 'success',
      });
    },

    [Actions.RaiseHand]: async (args, callback) => {
      // set hand
      callback({
        status: 'success',
      });
    },

    [Actions.LowerHands]: async (args, callback) => {
      const { roomId } = this.connection.data;
      const data = ValidationSchema.peerIds.parse(args);
      const { peerIds } = data;

      ioRedisServer.publish({
        channel: getPubSubChannel['room'](roomId),
        action: Actions.LowerHands,
        args: {
          peerIds,
        },
      });

      callback({
        status: 'success',
      });
    },

    [Actions.SendChat]: async (args, callback) => {
      const data = ValidationSchema.sendChat.parse(args);
      this.sendMessage({
        message: {
          action: Actions.SendChat,
          args: data,
        },
        broadcast: true,
      });
      callback({
        status: 'success',
      });
    },

    [Actions.SendReaction]: async (args, callback) => {
      console.log('Send Reaction', args);

      callback({
        status: 'success',
      });
    },

    [Actions.Record]: async (args, callback) => {
      callback({
        status: 'success',
      });
    },

    [Actions.LeaveRoom]: async (args, callback) => {
      this.close();
      callback({
        status: 'success',
      });
    },

    [Actions.EndRoom]: async (args, callback) => {
      console.log('EndMeeting', args);

      callback({
        status: 'success',
      });
    },
  };
}

export default Peer;

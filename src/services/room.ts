import EventEmitter from 'events';
import Peer from './peer';
import { ioRedisServer } from '../servers/ioredis-server';
import {
  ChatData,
  MessageData,
  PeerData,
  RoomData,
  RoomInstanceData,
} from '../types';
import { getPubSubChannel, getRedisKey } from '../lib/utils';
import { Actions } from '../types/actions';
import { ROOM_TIMEOUT } from '../lib/contants';
import { SocketServer } from '../servers/socket-server';

class Room extends EventEmitter {
  roomId: string;
  hostId: string;
  coHostEmails: string[];
  started: number;
  maxDuration: number;
  maxPeers: number;
  allowRecording: boolean;
  allowWaiting: boolean;
  timeLeft: number;

  selfDestructTimeout: NodeJS.Timeout | undefined;
  endCountDownInterval: NodeJS.Timeout | undefined;

  private peers: Map<string, Peer>;
  recorder: Peer | null;

  closed: boolean;

  private static rooms = new Map<string, Room>();

  constructor({
    roomId,
    hostId,
    coHostEmails,
    started,
    maxDuration,
    maxPeers,
    allowRecording,
    allowWaiting,
  }: {
    roomId: string;
    hostId: string;
    coHostEmails: string[];
    started: number;
    maxDuration: number;
    maxPeers: number;
    allowRecording: boolean;
    allowWaiting: boolean;
  }) {
    super();
    this.roomId = roomId;
    this.hostId = hostId;
    this.coHostEmails = coHostEmails;
    this.started = started;
    this.maxDuration = maxDuration;
    this.maxPeers = maxPeers;
    this.allowRecording = allowRecording;
    this.allowWaiting = allowWaiting;
    this.timeLeft = Math.round(
      (started + maxDuration * 60 * 1000 - Date.now()) / (1000 * 60)
    );
    this.peers = new Map();

    this.selfDestructTimeout = undefined;
    this.endCountDownInterval = undefined;

    this.recorder = null;
    this.closed = false;

    this.handleEvents();
    this.handleCountDown();
    Room.rooms.set(roomId, this);
  }

  async close(end?: boolean): Promise<void> {
    if (this.closed) return;
    if (end) this.emit(Actions.EndRoom);

    for (const peer of this.peers.values()) {
      peer.close();
    }

    clearInterval(this.selfDestructTimeout);
    clearTimeout(this.endCountDownInterval);

    // unsubscribe from room pubsub
    await ioRedisServer.unsubscribe(getPubSubChannel['room'](this.roomId));

    this.removeAllListeners();
  }

  static async create(roomId: string): Promise<Room> {
    try {
      // get room from redis if ongoing
      const activeRoom = await ioRedisServer.get(getRedisKey['room'](roomId));

      let roomInstanceData: RoomInstanceData;

      if (activeRoom) {
        roomInstanceData = JSON.parse(activeRoom);
      } else {
        // Todo Get room data from api

        // For now use domi data for now
        const roomData: RoomData = {
          id: crypto.randomUUID(),
          name: `room-${roomId}`,
          roomId,
          host: {
            id: crypto.randomUUID(),
            name: `host-${roomId}`,
          },
          coHostEmails: [],
          guestEmails: [],
          allowWaiting: false,
        };

        roomInstanceData = {
          roomId: roomData.roomId,
          hostId: roomData.host.id,
          coHostEmails: roomData.coHostEmails,
          started: Date.now(),
          maxPeers: 50,
          maxDuration: 60, // minutes
          allowRecording: false,
          allowWaiting: false,
          recording: false,
        };
      }
      const room = new Room(roomInstanceData);
      // set room if it doesn't exist
      await ioRedisServer.setnx(
        getRedisKey['room'](roomId),
        JSON.stringify(roomInstanceData)
      );

      // subcribe to room pubsubchannel
      await ioRedisServer.subscribe(getPubSubChannel['room'](roomId));

      return room;
    } catch (error) {
      console.log(error);
      throw error;
    }
  }

  static getRoom(roomId: string): Room | undefined {
    return Room.rooms.get(roomId);
  }

  async addPeer(peer: Peer): Promise<void> {
    try {
      this.peers.set(peer.id, peer);
      // close lobby associates
      if (this.selfDestructTimeout) clearTimeout(this.selfDestructTimeout);
      this.handlePeerEvents(peer);
      const peerData = peer.getData();
      peer.sendMessage({
        message: {
          action: Actions.PeerAdded,
          args: { ...peerData },
        },
        broadcast: true,
      });
      await this.savePeer(peer);
    } catch (error) {
      console.log(error);
    }
  }

  getPeer(peerId: string): Peer | undefined {
    return this.peers.get(peerId);
  }
  // peers in this room instance
  getPeers(): Peer[] {
    return Array.from(this.peers.values());
  }

  async removePeer(peerId: string): Promise<void> {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this.peers.delete(peerId);
    await this.updatePeerInDB(peer, { online: false });
    if (this.isEmpty()) this.selfDestructCountDown();
  }

  async getPeersFromDB(): Promise<PeerData[]> {
    const members = await ioRedisServer.hVals(
      getRedisKey['roomPeers'](this.roomId)
    );

    const peers: PeerData[] = [];

    members.forEach(peer => {
      peers.push(JSON.parse(peer));
    });

    return peers;
  }

  async getPeersOnline(): Promise<PeerData[]> {
    const peers = await this.getPeersFromDB();
    return peers.filter(peer => peer.online);
  }
  async getPeerByIdFromDB(peerId: string): Promise<PeerData | null> {
    const data = await ioRedisServer.hGet(
      getRedisKey['roomPeers'](this.roomId),
      peerId
    );

    if (!data) return null;

    return JSON.parse(data);
  }

  async updatePeerInDB(peer: Peer, value?: Partial<PeerData>): Promise<void> {
    const peerData = ioRedisServer.hGet(
      getRedisKey['roomPeers'](this.roomId),
      peer.id
    );
    if (!peerData) return;
    await ioRedisServer.hSet(
      getRedisKey['roomPeers'](this.roomId),
      peer.id,
      JSON.stringify({
        ...peer.getData(),
        ...value,
      })
    );
  }

  async savePeer(peer: Peer): Promise<void> {
    await ioRedisServer.hSet(
      getRedisKey['roomPeers'](this.roomId),
      peer.id,
      JSON.stringify({
        ...peer.getData(),
        online: true,
      })
    );
  }

  async getActiveSpeakerPeerId(): Promise<string | null> {
    const data = await ioRedisServer.get(
      getRedisKey['roomActiveSpeakerPeerId'](this.roomId)
    );
    return data;
  }

  isEmpty(): boolean {
    return Array.from(this.peers.keys()).length === 0;
  }

  async getData(): Promise<RoomInstanceData | undefined> {
    const data = await ioRedisServer.get(getRedisKey['room'](this.roomId));
    if (!data) return;
    const activeSpeakerPeerId = await this.getActiveSpeakerPeerId();
    return {
      ...JSON.parse(data),
      activeSpeakerPeerId,
      timeLeft: this.timeLeft,
    };
  }

  async saveChat(chat: ChatData): Promise<void> {
    await ioRedisServer.hSet(
      getRedisKey['roomChats'](this.roomId),
      chat.id,
      JSON.stringify(chat)
    );
  }

  async getChats(): Promise<ChatData[]> {
    const data = await ioRedisServer.hVals(
      getRedisKey['roomChats'](this.roomId)
    );
    const chats: ChatData[] = [];

    data.forEach(value => {
      chats.push(JSON.parse(value));
    });

    return chats;
  }

  broadcast(messageData: MessageData, room?: string): void {
    SocketServer.getInstance()
      .getIo()
      .to(room || getRedisKey['room'](this.roomId))
      .emit(Actions.Message, messageData);
  }

  private handleCountDown(): void {
    console.log('time- out', this.timeLeft);
    if (this.endCountDownInterval) clearInterval(this.endCountDownInterval);
    this.endCountDownInterval = setInterval(() => {
      this.timeLeft -= 1;
      // console.log("timeLeft", this.timeLeft)
      if (this.timeLeft < 1) {
        this.close(true);
      }
    }, 60000); // 1minute interval
  }

  private async selfDestructCountDown(): Promise<void> {
    try {
      if (this.closed || !this.isEmpty())
        return console.log('Room self destruct did not continue');

      if (this.selfDestructTimeout) clearTimeout(this.selfDestructTimeout);

      this.selfDestructTimeout = setTimeout(async () => {
        const peersOnline = await this.getPeersOnline();
        this.close(peersOnline.length === 0);
        console.log('Room self destruct closed room');
      }, ROOM_TIMEOUT);
    } catch (error) {
      console.error('selfDestructCountDown Failed', error);
    }
  }

  private handlePeerEvents(peer: Peer): void {
    peer.on(Actions.Close, ({ silent }) => {
      console.log('Room handle Close Peer-', peer.getData().name);
      this.removePeer(peer.id).catch(err => console.log(err));
      if (!silent)
        peer.sendMessage({
          message: {
            action: Actions.PeerLeft,
            args: {
              id: peer.id,
              name: peer.getData().name,
            },
          },
          broadcast: true,
        });
    });
  }

  private handleEvents(): void {
    this.on(Actions.EndRoom, () => {
      console.log('handle end room');
      //notify visitors/waiter end room
      this.broadcast(
        {
          action: Actions.EndRoom,
          args: {},
        },
        getRedisKey['lobby'](this.roomId)
      );

      ioRedisServer.publish({
        channel: getPubSubChannel['room'](this.roomId),
        action: Actions.EndRoom,
        args: {
          roomId: this.roomId,
        },
      });
      //clear redis memory
      console.log('clear redis memoryu');
      ioRedisServer
        .del(getRedisKey['roomPeers'](this.roomId))
        .then(value => console.log('Deleted roomPeers', value))
        .catch(reason =>
          console.log('delete roomPeers failed reaon -> ', reason)
        );
      ioRedisServer
        .del(getRedisKey['room'](this.roomId))
        .then(value => console.log('Deleted room', value))
        .catch(reason => console.log('delete room failed reaon -> ', reason));
      ioRedisServer
        .del(getRedisKey['roomActiveSpeakerPeerId'](this.roomId))
        .then(value => console.log('Deleted roomActiveSpeakerPeerId', value))
        .catch(reason =>
          console.log('delete roomActiveSpeakerPeerId failed reaon -> ', reason)
        );
    });
  }
}

export default Room;

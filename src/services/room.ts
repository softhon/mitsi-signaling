import EventEmitter from 'events';
import Peer from './peer';
import { redisServer } from '../servers/redis-server';
import { PeerData, RoomData, RoomInstanceData } from '../types';
import { getPubSubChannel, getRedisKey } from '../lib/utils';

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

    Room.rooms.set(roomId, this);
  }

  async close(end?: boolean): Promise<void> {
    if (this.closed) return;
    if (end) console.log('End meeting');

    for (const peer of this.peers.values()) {
      peer.close();
    }

    clearInterval(this.selfDestructTimeout);
    clearTimeout(this.endCountDownInterval);

    // unsubscribe from room pubsub
    await redisServer.unsubscribe(getPubSubChannel['room'](this.roomId));

    this.removeAllListeners();
  }

  static async create(roomId: string): Promise<Room> {
    try {
      // get room from redis if ongoing
      const activeRoom = await redisServer.get(getRedisKey['room'](roomId));

      let roomInstanceData: RoomInstanceData;

      if (activeRoom) {
        roomInstanceData = JSON.parse(activeRoom);
      } else {
        // get room data from api

        // use domi data for now
        const roomData: RoomData = {
          id: crypto.randomUUID(),
          title: 'Hello Room',
          roomId: 'rty-rex-rrt',
          host: {
            id: crypto.randomUUID(),
            name: 'Favour Grace',
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
          maxDuration: 180, // minutes
          allowRecording: false,
          allowWaiting: false,
          recording: false,
        };
      }
      const room = new Room(roomInstanceData);
      await redisServer.set(
        getRedisKey['room'](roomId),
        JSON.stringify(roomInstanceData),
        { NX: true }
      );

      // subcribe to room pubsubchannel
      await redisServer.subscribe(getPubSubChannel['room'](roomId));

      return room;
    } catch (error) {
      console.log(error);
      throw error;
    }
  }

  static getRoom(roomId: string): Room | undefined {
    return Room.rooms.get(roomId);
  }

  addPeer(peer: Peer): void {
    this.peers.set(peer.id, peer);
  }

  getPeer(peerId: string): Peer | undefined {
    return this.peers.get(peerId);
  }
  removePeer(peerId: string): void {
    this.peers.delete(peerId);
  }

  async getPeersFromDB(): Promise<PeerData[]> {
    const members = await redisServer.sMembers(
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

  async updatePeerInDB(peer: Peer, value?: Partial<PeerData>): Promise<void> {
    const peers = await this.getPeersFromDB();
    const peerData = peers.find(value => value.id === peer.id);
    if (!peerData) return;
    await redisServer.sRem(
      getRedisKey['roomPeers'](this.roomId),
      JSON.stringify(peerData)
    );

    await redisServer.sAdd(
      getRedisKey['roomPeers'](this.roomId),
      JSON.stringify({
        ...peer.getData(),
        ...value,
      })
    );
  }

  async getActiveSpeakerPeerId(): Promise<string | null> {
    const data = await redisServer.get(
      getRedisKey['roomActiveSpeakerPeerId'](this.roomId)
    );
    return data;
  }

  async getData(): Promise<RoomInstanceData | undefined> {
    const data = await redisServer.get(getRedisKey['room'](this.roomId));
    if (!data) return;
    const activeSpeakerPeerId = await this.getActiveSpeakerPeerId();
    return {
      ...JSON.parse(data),
      activeSpeakerPeerId,
      timeLeft: this.timeLeft,
    };
  }
}

export default Room;

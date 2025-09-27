import EventEmitter from 'events';
import Peer from './peer';
import { redisServer } from '../servers/redis-server';
import { PeerData, RoomData, RoomInstanceData } from '../types';
import { getPubSubChannel, getRedisKey } from '../lib/utils';
import { Actions } from '../types/actions';
import { ROOM_TIMEOUT } from '../lib/contants';

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
          roomId,
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
          maxDuration: 60, // minutes
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

  async savePeer(peer: Peer): Promise<void> {
    const wasSaved = await redisServer.sIsMember(
      getRedisKey['roomPeerIds'](this.roomId),
      peer.id
    );
    if (wasSaved) {
      //remove
      const savedPeers = await this.getPeersFromDB();
      const foundPeerData = savedPeers.find(value => value.id === peer.id);
      if (foundPeerData) {
        await redisServer.sRem(
          getRedisKey['roomPeers'](this.roomId),
          JSON.stringify(foundPeerData)
        );
      }
    }

    await redisServer.sAdd(
      getRedisKey['roomPeers'](this.roomId),
      JSON.stringify({
        ...peer.getData(),
        online: true,
      })
    );
    await redisServer.sAdd(getRedisKey['roomPeerIds'](this.roomId), peer.id);

    console.log('Saved Peer');
  }

  async getActiveSpeakerPeerId(): Promise<string | null> {
    const data = await redisServer.get(
      getRedisKey['roomActiveSpeakerPeerId'](this.roomId)
    );
    return data;
  }

  isEmpty(): boolean {
    return Array.from(this.peers.keys()).length === 0;
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

  private handleCountDown(): void {
    console.log(this.timeLeft);
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

      console.log('Room self destruct called ');

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
      console.log('Close Peer:', { silent });
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
    console.log('Register peer events');
  }

  private handleEvents(): void {}
}

export default Room;

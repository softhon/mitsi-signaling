import EventEmitter from 'events';
import Peer from './peer';
import { redisServer } from '../servers/redis-server';
import { RoomData, RoomInstanceData } from '../types/interfaces';

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

  static rooms = new Map<string, Room>();

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

    this.removeAllListeners();
  }

  static async create(roomId: string): Promise<Room> {
    try {
      // get room from redis if ongoing
      const activeRoom = await redisServer.getValue(`room:${roomId}`);

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
      await redisServer.setValue(
        `room:${roomId}`,
        JSON.stringify(roomInstanceData),
        { NX: true }
      );

      return room;
    } catch (error) {
      console.log(error);
      throw error;
    }
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
}

export default Room;

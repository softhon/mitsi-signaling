import { Socket } from 'socket.io';

import Base from './base';
import { HEARTBEAT_TIMEOUT } from '../lib/contants';
import { HandState, PeerData, Role, Tag } from '../types/interfaces';

class Peer extends Base {
  isRecorder: boolean;
  reconnecting?: boolean;
  data: PeerData;
  hand?: HandState;
  joined: number;
  tag: Tag;
  roles: Role[];
  lastHeartbeat: number;
  heartBeatInterval: NodeJS.Timeout;
  // mediaNode: MediaNode;
  routerId: string;
  closed: boolean;

  // static peers = new Map<string, Peer>();

  constructor({
    data,
    roomId,
    hand,
    peerId,
    connection,
    tag,
    roles,
    routerId,
    isRecorder,
  }: {
    data: PeerData;
    roomId: string;
    peerId: string;
    hand?: HandState;
    connection: Socket;
    tag: Tag;
    roles: Role[];
    routerId: string;
    isRecorder: boolean;
  }) {
    super({ roomId, peerId, connection });
    this.routerId = routerId;
    this.data = data;
    this.isRecorder = isRecorder;
    this.hand = hand ? hand : { raised: false };
    this.roles = roles;
    this.tag = tag;
    this.joined = Date.now();
    this.closed = false;
    this.lastHeartbeat = Date.now();
    this.routerId = routerId;
    this.reconnecting = false;

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
}

export default Peer;

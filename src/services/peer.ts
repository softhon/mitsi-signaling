import { Socket } from 'socket.io';

import Base from './base';
import { HEARTBEAT_TIMEOUT } from '../lib/contants';
import { HandState, PeerData, Role, Tag } from '../types';

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
    connection,
    tag,
    roles,
    routerId,
  }: {
    data: PeerData;
    roomId: string;
    connection: Socket;
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

import { Socket } from 'socket.io';

import Base from './base';
import { PeerData } from '../types';

class Waiter extends Base {
  data: PeerData;
  constructor({
    roomId,
    peerId,
    data,
    connection,
  }: {
    roomId: string;
    peerId: string;
    data: PeerData;
    connection: Socket;
  }) {
    super({
      roomId,
      peerId,
      connection,
    });
    this.data = data;
  }
}

export default Waiter;

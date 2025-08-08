import { Socket } from 'socket.io';
import Base from './base';

class Waiter extends Base {
  constructor({
    roomId,
    peerId,
    connection,
  }: {
    roomId: string;
    peerId: string;
    connection: Socket;
  }) {
    super({
      roomId,
      peerId,
      connection,
    });
  }
}

export default Waiter;

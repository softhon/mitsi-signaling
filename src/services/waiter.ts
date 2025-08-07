import { Socket } from 'socket.io';
import ServiceBase from './servicebase';

class Waiter extends ServiceBase {
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
